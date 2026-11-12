import { createClient } from '@supabase/supabase-js';
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

// ============================================================
// 判分：**必须与 src/engine.js 的 isCorrect() 完全一致**
// ------------------------------------------------------------
// engine.js 是浏览器模块（含 import.meta.env），api 不能直接 import，
// 所以这里复刻一份。scripts/check_stats.mjs 里有一组交叉比对用例：
// 同一批题目分别喂给浏览器的 window.__exam.isCorrect 和这里的 isAnswerCorrect，
// 结果不一致就红 —— 防止以后只改了一边。
//
// 口径要点：
//  · 判断题正确答案存成 correctIdx（0/1），没有时退回 answerText 在选项里的位置；
//  · 单选 / 多选 / 案例子题都按 correctIdx 数组比对（排序后逐项相等，不看顺序）。
// ============================================================
export function isAnswerCorrect(q, a) {
  if (a === null || a === undefined) return false;

  if (q.type === 'judge') {
    let ci = -1;
    if (Array.isArray(q.correctIdx) && q.correctIdx.length) ci = q.correctIdx[0];
    else if (q.answerText) {
      const choices = (q.options || []).map(o => o.text);
      ci = choices.indexOf(q.answerText);
    }
    return a === ci;
  }

  const ci = Array.isArray(q.correctIdx) ? q.correctIdx : [q.correctIdx];
  const sa = Array.isArray(a) ? a : [a];
  if (sa.length !== ci.length) return false;
  const s1 = [...sa].sort();
  const s2 = [...ci].sort();
  return s1.every((v, k) => v === s2[k]);
}

/** 进度 jsonb → 各模式快照数组（兼容 v4 的 byMode 与旧版单快照） */
function modesOf(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return [];
  if (progress.byMode && typeof progress.byMode === 'object' && !Array.isArray(progress.byMode)) {
    return Object.values(progress.byMode).filter(p => p && typeof p === 'object');
  }
  if (Array.isArray(progress.ids)) return [progress];
  return [];
}

/** 空作答（未答 / 多选一个都没勾）不算「做过」 */
function isBlank(a) {
  return a === null || a === undefined || (Array.isArray(a) && a.length === 0);
}

/** 累计作答表（store.js 的 progress.answers）：`{ [题目id]: 作答 }`，只有非空值 */
function answersOf(progress) {
  const out = {};
  const raw = progress && typeof progress === 'object' ? progress.answers : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(k => { if (!isBlank(raw[k])) out[k] = raw[k]; });
  return out;
}

/** 考试场次表（store.js 的 progress.exams） */
function examsOf(progress) {
  const raw = progress && typeof progress === 'object' ? progress.exams : null;
  return Array.isArray(raw) ? raw : [];
}

const round1 = n => Math.round((Number(n) || 0) * 10) / 10;

/**
 * 汇总模拟考试场次。
 * **按得分率（折百分制）算平均 / 最高**，不按绝对分 —— 组卷满分可以调，
 * 满 100 分和满 60 分的两场直接比绝对分没有意义。
 * `list` 是逐场明细（新的在前，最多 20 场），供「做题情况」弹层展示历次成绩。
 */
export function summarizeExams(list) {
  const arr = (Array.isArray(list) ? list : []).filter(e => e && Number(e.total) > 0);
  if (!arr.length) return { count: 0, best: 0, avg: 0, lastAt: null, lastScore: null, list: [] };
  let sum = 0, best = 0, lastAt = 0, lastScore = null;
  arr.forEach(e => {
    const full = Number(e.full) || 100;
    const pct = full > 0 ? (Number(e.score) || 0) / full * 100 : 0;
    sum += pct;
    if (pct > best) best = pct;
    const at = Number(e.at) || 0;
    if (at > lastAt) { lastAt = at; lastScore = Number(e.score) || 0; }
  });
  const sorted = [...arr].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return {
    count: arr.length,
    best: round1(best),
    avg: round1(sum / arr.length),
    lastAt: lastAt ? new Date(lastAt).toISOString() : null,
    lastScore,
    list: sorted.slice(0, 20).map(e => ({
      at: Number(e.at) || 0,
      total: Number(e.total) || 0,
      right: Number(e.right) || 0,
      score: Number(e.score) || 0,
      full: Number(e.full) || 100,
      ms: Number(e.ms) || 0,
      auto: e.auto ? 1 : 0
    }))
  };
}

/**
 * 汇总一个用户在某题库上的做题情况。
 *
 * 口径（重要，别随手改）：
 *   · 已做题量 = 该用户在**任何模式**下答过的不重复题目数（按题目 id 去重，同一题多轮取最新作答）
 *   · 分母     = 该题库的题目总数
 *   · 正确率   = 答对数 / 已做题量（不是除以题库总数 —— 没做的题不算错）
 *
 * answers 是跨轮次的累计作答（progress.answers）。**必须传**：
 * 练完一遍进度快照会被清掉（第 1124 行 clearProgress），只看 modes 的话
 * 「练完整库」的人会显示 0 题 —— 做题排行与管理员统计都会失真。
 * 合并顺序：先铺累计账本，再用模式快照覆盖（快照是当前这轮，通常是更新的作答）。
 */
export function summarizeBank(bank, modes, answers, answersAt, exams) {
  const qmap = new Map();
  (bank.questions || []).forEach(q => { if (q && q.id !== undefined) qmap.set(String(q.id), q); });

  // 按 updatedAt 升序铺开：后写覆盖先写，即「同一题以最近一次的作答为准」
  const sorted = [...modes].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

  const answeredMap = new Map();       // qid -> ans
  const perMode = {};                  // 模式 -> 该模式答过的不重复题数
  let lastAt = 0;

  // ① 长期账本（不受「练完清进度」影响）
  const book = answers && typeof answers === 'object' ? answers : {};
  Object.keys(book).forEach(k => { if (!isBlank(book[k])) answeredMap.set(String(k), book[k]); });

  // ② 各模式当前快照（覆盖账本里的旧作答）
  sorted.forEach(p => {
    const ids = Array.isArray(p.ids) ? p.ids : [];
    const arr = Array.isArray(p.userAns) ? p.userAns : [];
    const touched = new Set();
    ids.forEach((qid, i) => {
      const ans = arr[i];
      if (isBlank(ans)) return;
      const k = String(qid);
      answeredMap.set(k, ans);
      touched.add(k);
    });
    if (p.mode) perMode[p.mode] = (perMode[p.mode] || 0) + touched.size;
    if (p.updatedAt && p.updatedAt > lastAt) lastAt = p.updatedAt;
  });

  let answered = 0;
  let correct = 0;
  let orphan = 0;                      // 题库后来被改过、这些题已不存在
  answeredMap.forEach((ans, qid) => {
    const q = qmap.get(qid);
    if (!q) { orphan++; return; }
    answered++;
    if (isAnswerCorrect(q, ans)) correct++;
  });

  const total = (bank.questions || []).length;
  const ex = summarizeExams(exams);
  const exLastMs = ex.lastAt ? new Date(ex.lastAt).getTime() : 0;
  const lastMs = Math.max(lastAt, Number(answersAt) || 0, exLastMs);
  return {
    bankId: bank.id,
    bankName: bank.name || '(未命名题库)',
    total,
    answered,
    correct,
    rate: answered ? Math.round(correct / answered * 100) : 0,
    coverage: total ? Math.round(answered / total * 100) : 0,
    orphan,
    modes: perMode,
    lastAt: lastMs ? new Date(lastMs).toISOString() : null,
    // 模拟考试：考了几次、平均分/最高分（折百分制）、最近一场的分数与时间
    examCount: ex.count,
    examBest: ex.best,
    examAvg: ex.avg,
    examLastAt: ex.lastAt,
    examLastScore: ex.lastScore,
    examList: ex.list
  };
}

/**
 * /api/admin-stats
 *   GET ?userId=<uuid>  → 某个用户的做题情况（用户管理页「做题情况」）
 *   GET                 → 全部用户（可选，供以后做汇总看板）
 *
 * 权限：Bearer 令牌验签通过 **且** 调用者 is_admin = true（服务端回查，令牌有效 ≠ 管理员）。
 * 数据：service_role 读 exam_bank_progress / exam_banks，绕过 RLS —— 管理员本就要看全员数据，
 *       但绝不下发题目正文与答案，只回聚合数字。
 */
export default async function handler(req, res) {
  const claims = authUser(req);
  if (!claims) return json(res, 401, { error: '未登录或登录已过期，请重新登录' });
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

  try {
    const supa = client();

    const { data: me, error: meErr } = await supa
      .from('exam_accounts').select('id,is_admin').eq('id', claims.sub).maybeSingle();
    if (meErr) return json(res, 500, { error: '校验权限失败：' + meErr.message });
    if (!me) return json(res, 404, { error: '账号不存在，请重新登录' });
    if (!me.is_admin) return json(res, 403, { error: '需要管理员权限' });

    const q = req.query || {};
    const userId = String(q.userId || '').trim();
    const bankId = String(q.bankId || '').trim();

    // ① 题库清单：给前端「分题库统计」的下拉当选项。
    //    question_count 是 v2.29 加的列（perf.sql）。没跑过 SQL 就退回只取 id/name，
    //    total 给 null（前端显示「—」）—— 不能为了拿题数去拉 questions 大字段。
    if (String(q.list || '') === '1') {
      let banks = null;
      const r1 = await supa.from('exam_banks').select('id,name,question_count,created_at')
        .order('created_at', { ascending: false });
      if (r1.error) {
        const r2 = await supa.from('exam_banks').select('id,name,created_at')
          .order('created_at', { ascending: false });
        if (r2.error) return json(res, 500, { error: '读取题库失败：' + r2.error.message });
        banks = (r2.data || []).map(b => ({ id: b.id, name: b.name, total: null }));
      } else {
        banks = (r1.data || []).map(b => ({ id: b.id, name: b.name, total: b.question_count == null ? null : b.question_count }));
      }
      return json(res, 200, {
        ok: true,
        banks: banks.map(b => ({ id: b.id, name: b.name || '(未命名题库)', total: b.total }))
      });
    }

    // ② 分题库视角：某个题库里**所有人**的练习正确率 + 模拟考试汇总。
    //    与「按用户看」相反的方向，管理员用它横向比较同一份题库里谁练得多、谁考得好。
    if (bankId) {
      const { data: bank, error: bErr } = await supa
        .from('exam_banks').select('id,name,questions').eq('id', bankId).maybeSingle();
      if (bErr) return json(res, 500, { error: '读取题库失败：' + bErr.message });
      if (!bank) return json(res, 404, { error: '该题库不存在' });

      const { data: progs, error: pErr } = await supa
        .from('exam_bank_progress').select('user_id,progress').eq('bank_id', bankId);
      if (pErr) return json(res, 500, { error: '读取进度失败：' + pErr.message });

      const uids = [...new Set((progs || []).map(p => p.user_id))];
      const metaOf = new Map();
      if (uids.length) {
        const { data: us } = await supa
          .from('exam_accounts').select('id,username,dept,role').in('id', uids);
        (us || []).forEach(u => metaOf.set(u.id, u));
      }

      const rows = [];
      (progs || []).forEach(p => {
        const s = summarizeBank(bank, modesOf(p.progress), answersOf(p.progress),
          p.progress && p.progress.answersAt, examsOf(p.progress));
        // 既没做过题、也没考过试 → 这个库他真的没碰过，不上榜（否则全员一长串 0）
        if (!s.answered && !s.examCount) return;
        const m = metaOf.get(p.user_id) || {};
        const row = Object.assign({}, s, {
          username: m.username || '（账号已删除）',
          dept: m.dept || '',
          role: m.role || ''
        });
        // 分题库视图只要汇总：逐场明细按人看才有意义，N 个人各带 20 场会让响应大几十倍
        delete row.examList;
        rows.push(row);
      });

      // 已做量降序；题数一样时考得好的在前（与做题排行的并列规则一致）
      rows.sort((a, b) => (b.answered - a.answered) || (b.examAvg - a.examAvg));

      return json(res, 200, {
        ok: true,
        bank: { id: bank.id, name: bank.name || '(未命名题库)', total: (bank.questions || []).length },
        count: rows.length,
        rows
      });
    }

    // 目标用户（不传就取全员）
    let targets = [];
    if (userId) {
      const { data: u } = await supa
        .from('exam_accounts').select('id,username').eq('id', userId).maybeSingle();
      if (!u) return json(res, 404, { error: '该账号不存在' });
      targets = [u];
    } else {
      const { data: us, error: uErr } = await supa
        .from('exam_accounts').select('id,username').order('created_at', { ascending: true });
      if (uErr) return json(res, 500, { error: '读取账号失败：' + uErr.message });
      targets = us || [];
    }

    if (!targets.length) return json(res, 200, { ok: true, users: [] });

    // 进度：只取必要列（不拉 wrong / fav 两个数组，省流量）
    const { data: progs, error: pErr } = await supa
      .from('exam_bank_progress')
      .select('user_id,bank_id,progress')
      .in('user_id', targets.map(u => u.id));
    if (pErr) return json(res, 500, { error: '读取进度失败：' + pErr.message });

    const byUser = new Map();
    (progs || []).forEach(p => {
      if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
      byUser.get(p.user_id).push(p);
    });

    // 题库：只取有进度的那几个（questions 是大字段，不做全表扫）
    const bankIds = [...new Set((progs || []).map(p => p.bank_id))];
    let bankMap = new Map();
    if (bankIds.length) {
      const { data: banks, error: bErr } = await supa
        .from('exam_banks').select('id,name,questions').in('id', bankIds);
      if (bErr) return json(res, 500, { error: '读取题库失败：' + bErr.message });
      bankMap = new Map((banks || []).map(b => [b.id, b]));
    }

    const buildOne = (u) => {
      const items = [];
      (byUser.get(u.id) || []).forEach(p => {
        const bank = bankMap.get(p.bank_id);
        if (!bank) return;                       // 题库已删（理论上会级联删进度）
        const modes = modesOf(p.progress);
        const answers = answersOf(p.progress);
        // 只有错题/收藏、既没快照也没累计账本 → 真的没做过题
        if (!modes.length && !Object.keys(answers).length) return;
        items.push(summarizeBank(bank, modes, answers, p.progress && p.progress.answersAt, examsOf(p.progress)));
      });
      items.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));

      const sum = items.reduce((acc, it) => {
        acc.answered += it.answered;
        acc.correct += it.correct;
        acc.examCount += it.examCount || 0;      // 全部题库加起来的模拟考试场次
        return acc;
      }, { answered: 0, correct: 0, examCount: 0 });

      const lastAt = items.reduce((m, it) => (it.lastAt && (!m || it.lastAt > m)) ? it.lastAt : m, null);

      return {
        user: { id: u.id, username: u.username },
        summary: {
          bankCount: items.length,               // 做过的题库数
          answered: sum.answered,
          correct: sum.correct,
          rate: sum.answered ? Math.round(sum.correct / sum.answered * 100) : 0,
          lastAt
        },
        items
      };
    };

    const out = targets.map(buildOne);
    if (userId) return json(res, 200, { ok: true, ...out[0] });
    return json(res, 200, { ok: true, users: out });
  } catch (e) {
    return json(res, 500, { error: '服务器错误：' + e.message });
  }
}
