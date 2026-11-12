import { supabase, getUserId } from './supabase.js';

export const LS = {
  wrong: 'credit_exam_wrong',
  fav: 'credit_exam_fav',
  progress: 'credit_exam_progress'
};

// ============================================================
// 练习进度：**按模式各存一份**
// ------------------------------------------------------------
// 历史问题：progress 是个单值，在「顺序练习」练到一半、切去「组卷模拟」再存一次，
// 前者的进度就被覆盖没了 —— 用户的原话是「不管切换了哪种模式，都需要记住每种模式的练习进度」。
// 所以现在存成 map：{ sequential|exam|wrong|fav: 完整快照 }，各模式互不影响。
// 云端 exam_bank_progress.progress（jsonb）与本地镜像用同一形状，读的时候自动迁移旧格式。
// ============================================================
const PROGRESS_V = 4;
const MODES = ['sequential', 'exam', 'wrong', 'fav'];
const MARK_MAX = 3;                 // 标记色数：1 存疑 / 2 重点 / 3 待查
const EXAM_MAX = 50;                // 模拟考试历次成绩最多留 50 场（新的在前）

/**
 * 模拟考试场次表归一。
 * 每条只记汇总（得分/对错/用时），**不存逐题作答** —— 目的是「回看历次成绩」，
 * 存逐题作答会让 50 场 × 100 题的数据把 jsonb 撑大几十倍，而那些题目的对错
 * 已经由累计作答表 answers 记着了，没必要重复。
 */
function normalizeExams(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach(e => {
    if (!e || typeof e !== 'object') return;
    const total = parseInt(e.total, 10);
    const right = parseInt(e.right, 10);
    const at = Number(e.at);
    if (!(total > 0) || !(right >= 0) || !(at > 0)) return;
    out.push({
      at,
      total,
      right: Math.min(right, total),
      score: Number(e.score) || 0,
      full: Number(e.full) || 100,
      ms: Math.max(0, Number(e.ms) || 0),
      auto: e.auto ? 1 : 0
    });
  });
  out.sort((a, b) => b.at - a.at);            // 新的在前
  return out.slice(0, EXAM_MAX);
}

/** 合并两份场次表：同一毫秒视为同一场（离线期间与云端的重复记录只留一条） */
function mergeExams(a, b) {
  const seen = new Map();
  [...(a || []), ...(b || [])].forEach(e => { if (e && e.at) seen.set(e.at, e); });
  return normalizeExams([...seen.values()]);
}

/**
 * 题目标记表归一成 `{ [题目id]: 1..3 }`。
 * 键一律按字符串存（题目 id 可能是数字，对象键本来也会被转成字符串），越界的颜色直接丢掉。
 */
function normalizeMarks(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.keys(raw).forEach(k => {
      const v = parseInt(raw[k], 10);
      if (v >= 1 && v <= MARK_MAX) out[k] = v;
    });
  }
  return out;
}

/** 作答值归一：空选/未答 → null；数组复制一份并排序（顺序不影响判分，排序后比较更稳） */
function cleanAns(a) {
  if (a === null || a === undefined) return null;
  if (Array.isArray(a)) return a.length ? a.slice().sort((x, y) => x - y) : null;
  return a;
}

/** 两个作答是否等价（数组已排序，直接逐项比） */
function sameAns(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** 累计作答表归一：`{ [题目id]: 作答 }`，丢掉空值 */
function normalizeAnswers(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.keys(raw).forEach(k => {
      const v = cleanAns(raw[k]);
      if (v !== null) out[k] = v;
    });
  }
  return out;
}

/** 把一份快照里的作答并入累计表（返回是否有变化） */
function mergeSnapshotAnswers(answers, ids, userAns) {
  if (!Array.isArray(ids) || !Array.isArray(userAns)) return false;
  let touched = false;
  ids.forEach((id, i) => {
    const v = cleanAns(userAns[i]);
    if (v === null) return;
    const k = String(id);
    if (!sameAns(answers[k], v)) { answers[k] = v; touched = true; }
  });
  return touched;
}

/**
 * 把任意历史格式的进度归一成 `{ v:4, byMode:{...}, marks:{...}, answers:{...} }`。
 *  · marks（答题卡上的彩色标记）与进度平级放在同一个 jsonb 里 —— 不新增列、不用改表结构，
 *    但它**不属于任何模式**：练完一遍 clearProgress 清掉的是进度，标记要留下来。
 *  · answers（**累计作答表**）同理平级存放，用途不同：练完一遍进度被清掉后，
 *    「做过哪些题、答得对不对」还得留下 —— 做题排行、管理员的做题情况统计都靠它。
 *    没有它的话，用户练完整库、进度一清，榜单上就会从「100/100」掉回 0，明显荒谬。
 *  · exams（**模拟考试场次**）同样平级：交卷时快照被清掉，但「历次成绩」要能回看。
 *    与 answers 的区别是它按场次存（含得分与用时），answers 按题存。
 *  · 旧版（v2.11 及之前）存的是**单个**快照：`{ v:2, mode:'sequential', ids:[...], idx, ... }`，
 *    这里按它的 `mode` 字段归到 byMode 下对应模式 —— 升级后已有的进度不会丢。
 */
export function normalizeProgress(raw) {
  const empty = { v: PROGRESS_V, byMode: {}, marks: {}, answers: {}, answersAt: 0, exams: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const marks = normalizeMarks(raw.marks);
  const answers = normalizeAnswers(raw.answers);
  const exams = normalizeExams(raw.exams);
  let answersAt = Number(raw.answersAt) || 0;

  if (raw.byMode && typeof raw.byMode === 'object' && !Array.isArray(raw.byMode)) {
    const byMode = {};
    Object.keys(raw.byMode).forEach(m => {
      const p = raw.byMode[m];
      if (p && typeof p === 'object' && !p.finished) byMode[m] = p;
    });
    // 老数据里没有 answers：从现有快照里补一遍，避免升级后榜单全是 0
    if (!Object.keys(answers).length) {
      Object.keys(byMode).forEach(m => {
        const p = byMode[m];
        if (mergeSnapshotAnswers(answers, p.ids, p.userAns) && !answersAt) answersAt = Number(p.updatedAt) || 0;
      });
    }
    return { v: PROGRESS_V, byMode, marks, answers, answersAt, exams };
  }

  if (Array.isArray(raw.ids) && raw.ids.length) {   // 旧格式：单个快照
    mergeSnapshotAnswers(answers, raw.ids, raw.userAns);
    if (!answersAt) answersAt = Number(raw.updatedAt) || 0;
    return { v: PROGRESS_V, byMode: { [raw.mode || 'sequential']: raw }, marks, answers, answersAt, exams };
  }
  return { v: PROGRESS_V, byMode: {}, marks, answers, answersAt, exams };
}

const state = {
  cloud: false,
  bankId: null,
  wrong: [],
  fav: [],
  progressByMode: {},     // { [mode]: 快照 } —— 每种模式各记一份
  marks: {},              // { [题目id]: 1|2|3 } —— 答题卡彩色标记（跨模式共用，不随进度清）
  answers: {},            // { [题目id]: 作答 } —— 累计作答（跨轮次累积，不随进度清）
  answersAt: 0,           // 累计作答最后一次更新时间
  exams: [],              // 模拟考试历次成绩（新的在前，最多 EXAM_MAX 场，不随进度清）
  _timer: null
};

function mirrorKey() {
  return state.cloud ? 'ce_cloud_' + state.bankId : null;
}

/** 序列化用：进度、标记、累计作答、考试场次都为空时写 null（语义清晰，也省空间） */
function progressPayload() {
  const byMode = state.progressByMode;
  const marks = marksTable();
  const answers = state.answers || {};
  const exams = state.exams || [];
  if (!Object.keys(byMode).length && !Object.keys(marks).length &&
      !Object.keys(answers).length && !exams.length) return null;
  return {
    v: PROGRESS_V, byMode, marks, answers, answersAt: state.answersAt || 0,
    exams: exams.slice(0, EXAM_MAX)
  };
}

function persistLocal() {
  try {
    if (state.cloud) {
      localStorage.setItem(mirrorKey(), JSON.stringify({ wrong: state.wrong, fav: state.fav, progress: progressPayload() }));
    } else {
      localStorage.setItem(LS.wrong, JSON.stringify(state.wrong));
      localStorage.setItem(LS.fav, JSON.stringify(state.fav));
      localStorage.setItem(LS.progress, JSON.stringify(progressPayload()));
    }
  } catch (e) { /* quota */ }
}

function readLocal() {
  try {
    let raw;
    if (state.cloud) {
      const t = localStorage.getItem(mirrorKey());
      raw = (t ? JSON.parse(t) : null) || { wrong: [], fav: [], progress: null };
    } else {
      raw = {
        wrong: JSON.parse(localStorage.getItem(LS.wrong) || '[]'),
        fav: JSON.parse(localStorage.getItem(LS.fav) || '[]'),
        progress: JSON.parse(localStorage.getItem(LS.progress) || 'null')
      };
    }
    return { wrong: raw.wrong, fav: raw.fav, progress: normalizeProgress(raw.progress) };
  } catch (e) {
    return { wrong: [], fav: [], progress: normalizeProgress(null) };
  }
}
function scheduleFlush() {
  if (!state.cloud || !state.bankId) return;
  if (state._timer) clearTimeout(state._timer);
  state._timer = setTimeout(flushNow, 400);
}

export async function flushNow() {
  if (!state.cloud || !state.bankId) return;
  const userId = getUserId();
  if (!userId) return;
  try {
    await supabase.from('exam_bank_progress').upsert({
      user_id: userId,
      bank_id: state.bankId,
      wrong: state.wrong,
      fav: state.fav,
      progress: progressPayload()
    }, { onConflict: 'user_id,bank_id' });
  } catch (e) { /* 离线时忽略，本地镜像仍有效 */ }
}

// 切换题库时调用：加载该题库的错题/收藏/进度（云端优先，本地镜像兜底）
export async function loadBankState(bankId, cloud) {
  // 切换前：先把上一题库的待写入数据立即落库，避免防抖定时器把旧题库的数据写到新题库
  if (state.cloud && state.bankId && state.bankId !== bankId) {
    if (state._timer) { clearTimeout(state._timer); state._timer = null; }
    await flushNow();
  }
  state.cloud = cloud;
  state.bankId = bankId;
  state.wrong = [];
  state.fav = [];
  state.progressByMode = {};
  state.marks = {};
  state.answers = {};
  state.answersAt = 0;
  state.exams = [];
  // 先读本地镜像（离线可用）
  const local = readLocal();
  state.wrong = Array.isArray(local.wrong) ? local.wrong : [];
  state.fav = Array.isArray(local.fav) ? local.fav : [];
  state.progressByMode = Object.assign({}, local.progress.byMode);
  state.marks = Object.assign({}, local.progress.marks);
  state.answers = Object.assign({}, local.progress.answers);   // 累计作答：本地镜像先垫着
  state.answersAt = local.progress.answersAt || 0;
  state.exams = (local.progress.exams || []).slice();          // 考试场次：同样先垫着
  // 云端：拉取服务端权威数据覆盖
  if (cloud && bankId) {
    try {
      const { data } = await supabase
        .from('exam_bank_progress')
        .select('wrong,fav,progress')
        .eq('bank_id', bankId)
        .maybeSingle();
      if (data) {
        state.wrong = Array.isArray(data.wrong) ? data.wrong : [];
        state.fav = Array.isArray(data.fav) ? data.fav : [];
        const np = normalizeProgress(data.progress);
        state.progressByMode = np.byMode;
        state.marks = np.marks;
        // 累计作答取并集：云端为准，本地多出来的（离线期间答的）补进去，别丢
        state.answers = Object.assign({}, state.answers, np.answers);
        state.answersAt = Math.max(state.answersAt, np.answersAt || 0);
        // 考试场次同样取并集（离线考的几场不能被云端覆盖掉）
        state.exams = mergeExams(np.exams, state.exams);
        persistLocal();
      }
    } catch (e) { /* 离线：保持本地镜像 */ }
  }
}

function getArr(key) {
  return key === LS.wrong ? state.wrong : state.fav;
}
function setArr(key, arr) {
  if (key === LS.wrong) state.wrong = arr; else state.fav = arr;
  persistLocal();
  scheduleFlush();
}

export function loadArr(key) {
  const a = getArr(key);
  return Array.isArray(a) ? a.slice() : [];
}
export function saveArr(key, arr) {
  setArr(key, Array.isArray(arr) ? [...new Set(arr)] : []);
}
export function addId(key, id) {
  const a = getArr(key);
  if (!a.includes(id)) { a.push(id); setArr(key, a); }
}
export function removeId(key, id) {
  setArr(key, getArr(key).filter(x => x !== id));
}
export function hasId(key, id) {
  return getArr(key).includes(id);
}
export function countId(key) {
  return getArr(key).length;
}

// ============================================================
// 答题卡标记：{ [题目id]: 1|2|3 }（1 存疑 / 2 重点 / 3 待查）
// ------------------------------------------------------------
// 和错题/收藏一样按题库存，但**跨模式共用**：同一个题目在顺序练习里打的黄标，
// 到组卷模拟的答题卡上照样看得见（否则「标记」就失去了复习索引的意义）。
// 也不随进度被清 —— 练完一遍只是把进度清了，标记要留着下次重点看。
// ============================================================
/** 标记表兜底取值：任何情况下都返回一个对象，别让一格标记把整张答题卡搞崩 */
function marksTable() {
  if (!state.marks || typeof state.marks !== 'object') state.marks = {};
  return state.marks;
}
/** 取某题的标记色（0 = 没标记）。读的是内存里的表，答题卡逐格渲染时不会有拷贝开销 */
export function markOf(id) {
  return marksTable()[String(id)] || 0;
}
/** 上色（color 传 0 或空 = 取消标记） */
export function setMark(id, color) {
  const k = String(id);
  const c = parseInt(color, 10) || 0;
  const t = marksTable();
  if (c >= 1 && c <= MARK_MAX) t[k] = c; else delete t[k];
  persistLocal();
  scheduleFlush();
}
export function markCount() {
  return Object.keys(marksTable()).length;
}
export function clearMarks() {
  state.marks = {};
  persistLocal();
  scheduleFlush();
}
/** 整个标记表的副本（验收脚本用） */
export function loadMarks() {
  return Object.assign({}, marksTable());
}

/**
 * 清进度。
 *  · 传 mode → 只清该模式的进度（练习完成、点了「从头开始」都是这个语义）；
 *  · 不传   → 清全部模式的进度。
 * 注意：**不清累计作答表 answers** —— 那是「做过多少题」的长期账本，
 * 练完一遍就把它清零的话，做题排行会从 100/100 掉回 0，用户会以为数据丢了。
 */
export function clearProgress(mode) {
  if (mode) delete state.progressByMode[mode];
  else state.progressByMode = {};
  persistLocal();
  scheduleFlush();
}

/** 存进度：按快照自带的 mode 归档，各模式互不覆盖 */
export function saveProgress(obj) {
  if (!obj || !obj.mode) return;
  state.progressByMode[obj.mode] = obj;
  // 顺手把这份快照里的作答并入累计表：交卷时 clearProgress 会删快照，但账本要留下
  if (mergeSnapshotAnswers(state.answers, obj.ids, obj.userAns)) state.answersAt = Date.now();
  persistLocal();
  scheduleFlush();
}

/**
 * 取进度。
 *  · 传 mode → 该模式那一份（新逻辑都用这个）；
 *  · 不传   → 最近更新的一份（兼容旧调用，避免外面漏改时拿到 null）。
 */
export function loadProgress(mode) {
  if (mode) return state.progressByMode[mode] || null;
  let best = null;
  Object.keys(state.progressByMode).forEach(m => {
    const p = state.progressByMode[m];
    if (p && (!best || (p.updatedAt || 0) > (best.updatedAt || 0))) best = p;
  });
  return best;
}

/** 整个 map（首页四张卡片各自显示进度时用） */
export function loadProgressMap() {
  return Object.assign({}, state.progressByMode);
}

export function resetState() {
  state.cloud = false;
  state.bankId = null;
  state.wrong = [];
  state.fav = [];
  state.progressByMode = {};
  state.marks = {};
  state.answers = {};
  state.answersAt = 0;
  state.exams = [];
}

/**
 * 记一场模拟考试。**交卷那一刻调用**（finishExam），此时 S 里的分数与用时都是定格值。
 * 只记汇总，不记逐题作答；超过 EXAM_MAX 场自动挤掉最旧的。
 */
export function pushExam(rec) {
  if (!rec || !(Number(rec.total) > 0)) return;
  state.exams = normalizeExams([
    Object.assign({}, rec, { at: Number(rec.at) || Date.now() }),
    ...(state.exams || [])
  ]);
  persistLocal();
  scheduleFlush();
}

/** 考试场次副本（新的在前） */
export function loadExams() {
  return (state.exams || []).slice();
}

/** 本机看到的「已作答题目数」（去重）。首页「做题排行」入口的副标题用它，
 *  只是提示，权威数字以服务端算的为准。 */
export function answeredCount() {
  return Object.keys(state.answers || {}).length;
}

/** 累计作答表副本（验收脚本与调试用） */
export function loadAnswers() {
  return Object.assign({}, state.answers);
}

// 本地开发调试钩子（生产构建会被剔除），供 scripts/check_resume.mjs、check_modeprog.mjs 验收使用
if (import.meta.env.DEV) {
  window.__store = {
    loadBankState, saveProgress, loadProgress, loadProgressMap, clearProgress,
    normalizeProgress, saveArr, loadArr, LS, MODES,
    markOf, setMark, markCount, clearMarks, loadMarks,
    answeredCount, loadAnswers, pushExam, loadExams, normalizeExams
  };
}
