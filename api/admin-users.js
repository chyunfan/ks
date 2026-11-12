import { randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

function client() {
  return createClient(URL, KEY, { auth: { persistSession: false } });
}

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function authUser(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  if (!m) return null;
  try { return jwt.verify(m[1].trim(), JWT_SECRET, { algorithms: ['HS256'] }); }
  catch { return null; }
}

function str(v) {
  return String(v == null ? '' : v).trim().slice(0, 40);
}

/**
 * 临时密码：8 位，剔除 0/O/1/l/I 这类肉眼易混字符（要念给本人听 / 手抄）。
 * 用 CSPRNG（randomInt）而非 Math.random —— 临时密码也是真密码。
 */
const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function genTempPassword(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += PW_CHARS[randomInt(0, PW_CHARS.length)];
  return s;
}

/** 全部用户 + 每人的题库数量（管理员专用视图） */
async function listUsers(supa) {
  const { data: users, error } = await supa
    .from('exam_accounts')
    .select('id,username,is_admin,dept,role,created_at')
    .order('created_at', { ascending: true });
  if (error) throw new Error('读取账号失败：' + error.message);

  // 题库数量：只取 user_id 一列做聚合，避免把 questions 大字段拉下来
  const counts = {};
  const { data: banks } = await supa.from('exam_banks').select('user_id,visibility');
  (banks || []).forEach(b => {
    const c = counts[b.user_id] || (counts[b.user_id] = { total: 0, shared: 0 });
    c.total++;
    if (b.visibility === 'public' || b.visibility === 'scope') c.shared++;
  });

  return (users || []).map(u => ({
    id: u.id,
    username: u.username,
    isAdmin: !!u.is_admin,
    dept: u.dept || '',
    role: u.role || '',
    createdAt: u.created_at,
    bankCount: (counts[u.id] && counts[u.id].total) || 0,
    sharedCount: (counts[u.id] && counts[u.id].shared) || 0
  }));
}

/**
 * /api/admin-users
 *   GET  → { ok, users:[...], me:{id,isAdmin} }      需要管理员
 *   POST → { action:'updateUser', userId, isAdmin?, dept?, role? }       需要管理员
 *   POST → { action:'resetPassword', userId, password? }                 需要管理员
 *          → { ok, username, tempPassword, generated }   临时密码仅此次返回
 *
 * 权限：请求头 Bearer 令牌验签通过 **且** 该账号 is_admin = true。
 * 仅此接口使用 service_role 访问 exam_accounts（该表已开启 RLS 且无策略，前端读不到）。
 */
export default async function handler(req, res) {
  const claims = authUser(req);
  if (!claims) return json(res, 401, { error: '未登录或登录已过期，请重新登录' });

  try {
    const supa = client();

    // 服务端二次确认：令牌有效 ≠ 是管理员（防止有人拿普通账号的令牌调管理接口）
    const { data: me, error: meErr } = await supa
      .from('exam_accounts').select('id,is_admin').eq('id', claims.sub).maybeSingle();
    if (meErr) return json(res, 500, { error: '校验权限失败：' + meErr.message });
    if (!me) return json(res, 404, { error: '账号不存在，请重新登录' });
    if (!me.is_admin) return json(res, 403, { error: '需要管理员权限' });

    if (req.method === 'GET') {
      const users = await listUsers(supa);
      return json(res, 200, { ok: true, users, me: { id: me.id, isAdmin: true } });
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return json(res, 400, { error: '请求体格式错误' }); }
    if (!body || (body.action !== 'updateUser' && body.action !== 'resetPassword')) {
      return json(res, 400, { error: '不支持的操作' });
    }

    const userId = str(body.userId);
    if (!userId) return json(res, 400, { error: '缺少 userId' });

    const { data: target } = await supa
      .from('exam_accounts').select('id,username,is_admin').eq('id', userId).maybeSingle();
    if (!target) return json(res, 404, { error: '该账号不存在' });

    /* ---------- 重置密码（管理员代客重置） ---------- */
    if (body.action === 'resetPassword') {
      // 管理员可以自己指定新密码；不指定则由服务端生成临时密码
      const custom = typeof body.password === 'string' ? body.password.trim() : '';
      if (custom && custom.length < 6) return json(res, 400, { error: '密码至少 6 位' });
      if (custom.length > 64) return json(res, 400, { error: '密码最多 64 位' });

      const tempPassword = custom || genTempPassword(8);
      const password_hash = await bcrypt.hash(tempPassword, 10);

      const { error: pwErr } = await supa
        .from('exam_accounts').update({ password_hash }).eq('id', userId);
      if (pwErr) return json(res, 500, { error: '重置失败：' + pwErr.message });

      // 明文只在这一个响应里出现一次，库里只有 bcrypt 哈希
      return json(res, 200, {
        ok: true,
        username: target.username,
        tempPassword,
        generated: !custom
      });
    }

    /* ---------- 修改资料（部门 / 角色 / 管理员标记） ---------- */
    const patch = {};
    if (body.dept !== undefined) patch.dept = str(body.dept);
    if (body.role !== undefined) patch.role = str(body.role);

    if (body.isAdmin !== undefined) {
      const next = !!body.isAdmin;
      if (target.is_admin && !next) {
        // 不允许把最后一名管理员降级，否则没人能再进管理界面
        const { count } = await supa
          .from('exam_accounts').select('id', { count: 'exact', head: true }).eq('is_admin', true);
        if ((count || 0) <= 1) return json(res, 400, { error: '至少要保留一名管理员' });
      }
      patch.is_admin = next;
    }

    if (!Object.keys(patch).length) return json(res, 400, { error: '没有需要修改的内容' });

    const { error: upErr } = await supa.from('exam_accounts').update(patch).eq('id', userId);
    if (upErr) return json(res, 500, { error: '保存失败：' + upErr.message });

    const users = await listUsers(supa);
    return json(res, 200, { ok: true, users, updated: target.username });
  } catch (e) {
    return json(res, 500, { error: '服务器错误：' + e.message });
  }
}
