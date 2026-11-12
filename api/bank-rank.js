import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import { summarizeBank } from './admin-stats.js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function client() {
  return createClient(URL, KEY, { auth: { persistSession: false } });
}

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function authUser(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  if (!m) return null;
  try { return jwt.verify(m[1].trim(), JWT_SECRET, { algorithms: ['HS256'] }); }
  catch { return null; }
}

/**
 * 这个账号能不能看这份题库 —— 必须与 supabase/admin.sql 的 exam_banks_select 策略一致。
 * 本接口用 service_role 读库、绕过 RLS，所以这道判定不能让前端来做（前端改个变量就进去了）。
 *   本人 / 管理员 / public / visibility=scope 且部门或角色命中
 */
export function canSeeBank(bank, me) {
  if (!bank || !me) return false;
  if (bank.user_id && bank.user_id === me.id) return true;
  if (me.is_admin) return true;
  const vis = bank.visibility || 'public';
  if (vis === 'public') return true;
  if (vis === 'scope') {
    const depts = Array.isArray(bank.allow_depts) ? bank.allow_depts : [];
    const roles = Array.isArray(bank.allow_roles) ? bank.allow_roles : [];
    if (me.dept && depts.indexOf(me.dept) >= 0) return true;
    if (me.role && roles.indexOf(me.role) >= 0) return true;
  }
  return false;
}

/** 进度 jsonb → 各模式快照（与 api/admin-stats.js 同口径） */
function modesOf(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return [];
  if (progress.byMode && typeof progress.byMode === 'object' && !Array.isArray(progress.byMode)) {
    return Object.values(progress.byMode).filter(p => p && typeof p === 'object');
  }
  if (Array.isArray(progress.ids)) return [progress];
  return [];
}

/** 累计作答表（store.js 的 progress.answers） */
function answersOf(progress) {
  const out = {};
  const raw = progress && typeof progress === 'object' ? progress.answers : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(k => {
    const v = raw[k];
    if (v === null || v === undefined) return;
    if (Array.isArray(v) && !v.length) return;
    out[k] = v;
  });
  return out;
}

/**
 * 纯函数：把「每人的聚合数字」排成名次表。抽出来是为了能单测
 * （并列名次、截断、我不在前 N、隐私字段剥离都不该靠连真库才能验）。
 *
 * 排序：已做题量降序 → 答对数降序 → 账号名（中文排序，保证结果稳定可复现）
 * 名次：按**已做题量**并列（32 题并列 → 都是第 3 名，下一位第 5 名）
 */
export function buildRank({ rows, nameOf, meId, limit }) {
  const arr = rows.map(r => ({ ...r }));
  arr.sort((a, b) =>
    (b.answered - a.answered) || (b.correct - a.correct) ||
    String(nameOf.get(a.userId) || '').localeCompare(String(nameOf.get(b.userId) || ''), 'zh-Hans-CN')
  );

  let prevAnswered = null;
  let prevRank = 0;
  arr.forEach((r, i) => {
    r.rank = (prevAnswered !== null && r.answered === prevAnswered) ? prevRank : i + 1;
    prevAnswered = r.answered;
    prevRank = r.rank;
  });

  // 只下发账号名 + 聚合数字：userId 是内部标识，没必要给前端
  const shaped = arr.map(r => ({
    rank: r.rank,
    username: nameOf.get(r.userId) || '（账号已删除）',
    answered: r.answered,
    correct: r.correct,
    rate: r.rate,
    coverage: r.coverage,
    lastAt: r.lastAt,
    mine: r.userId === meId
  }));

  const mine = shaped.find(x => x.mine) || null;
  const list = shaped.slice(0, limit);
  return { list, me: mine, count: shaped.length, truncated: shaped.length > list.length };
}

/**
 * /api/bank-rank
 *   GET ?bankId=<uuid>&limit=20
 *   → { ok, bank:{id,name,total}, count, list:[{rank,username,answered,correct,rate,coverage,mine,lastAt}],
 *       me:{rank,answered,correct,rate,coverage}|null, truncated }
 *
 * 用途：用户选定某个题库后，看「本库做题数排名」。
 *
 * 权限：登录即可（不要求管理员）—— 但**只能看自己有权限访问的题库**，
 *       判定与数据库的 exam_banks_select 策略一致（canSeeBank）。
 *
 * 隐私：只下发「账号名 + 聚合数字」，绝不下发 user_id、题目正文、答案、错题/收藏。
 *       榜上只出现**做过题的人**（answered > 0），没做过的人不会露出来。
 *
 * 口径：与管理员「做题情况」完全同源（复用 summarizeBank）。
 *       已做 = 不重复题目数，跨轮次累计（progress.answers），练完清进度不会掉数。
 */
export default async function handler(req, res) {
  const claims = authUser(req);
  if (!claims) return json(res, 401, { error: '未登录或登录已过期，请重新登录' });
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

  const q = req.query || {};
  const bankId = String(q.bankId || '').trim();
  if (!bankId) return json(res, 400, { error: '缺少 bankId' });

  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  try {
    const supa = client();

    // ① 我是谁（部门/角色/管理员 —— 可见范围判定要用）
    const { data: me, error: meErr } = await supa
      .from('exam_accounts').select('id,username,is_admin,dept,role').eq('id', claims.sub).maybeSingle();
    if (meErr) return json(res, 500, { error: '校验身份失败：' + meErr.message });
    if (!me) return json(res, 404, { error: '账号不存在，请重新登录' });

    // ② 题库（questions 要用：算正确率得知道标准答案）
    const { data: bank, error: bErr } = await supa
      .from('exam_banks')
      .select('id,name,questions,user_id,visibility,allow_depts,allow_roles')
      .eq('id', bankId).maybeSingle();
    if (bErr) return json(res, 500, { error: '读取题库失败：' + bErr.message });
    if (!bank) return json(res, 404, { error: '题库不存在或已被删除' });
    if (!canSeeBank(bank, me)) return json(res, 403, { error: '你没有这个题库的查看权限' });

    // ③ 本库的全部进度（只取这一列，不拉 wrong / fav 两个大数组）
    const { data: progs, error: pErr } = await supa
      .from('exam_bank_progress').select('user_id,progress').eq('bank_id', bankId);
    if (pErr) return json(res, 500, { error: '读取进度失败：' + pErr.message });

    const rows = [];
    (progs || []).forEach(p => {
      const modes = modesOf(p.progress);
      const answers = answersOf(p.progress);
      if (!modes.length && !Object.keys(answers).length) return;
      const s = summarizeBank(bank, modes, answers, p.progress && p.progress.answersAt);
      if (!s.answered) return;                       // 没做过题的人不上榜
      rows.push({
        userId: p.user_id,
        answered: s.answered,
        correct: s.correct,
        rate: s.rate,
        coverage: s.coverage,
        lastAt: s.lastAt
      });
    });

    // ④ 账号名（只查榜上这些人）
    const ids = rows.map(r => r.userId);
    let nameOf = new Map();
    if (ids.length) {
      const { data: accs } = await supa.from('exam_accounts').select('id,username').in('id', ids);
      nameOf = new Map((accs || []).map(a => [a.id, a.username]));
    }

    // ⑤ 排序 + 名次（纯函数，见 buildRank）
    const out = buildRank({ rows, nameOf, meId: me.id, limit });

    return json(res, 200, {
      ok: true,
      bank: { id: bank.id, name: bank.name || '(未命名题库)', total: (bank.questions || []).length },
      count: out.count,          // 本库有做题记录的人数
      list: out.list,
      me: out.me,
      truncated: out.truncated
    });
  } catch (e) {
    return json(res, 500, { error: '服务器错误：' + e.message });
  }
}
