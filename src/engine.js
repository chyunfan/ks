import {
  LS, loadArr, saveArr, addId, removeId, hasId, countId,
  clearProgress, saveProgress, loadProgress, loadProgressMap,
  markOf, setMark, markCount, clearMarks
} from './store.js';
import { supabase, getUserId } from './supabase.js';

// ---------- data source (set per bank) ----------
let QUESTIONS = [];
export function setQuestions(arr) { QUESTIONS = Array.isArray(arr) ? arr : []; }

// ---------- state ----------
const EXAM_DEFAULT_COUNTS = { single: 60, multiple: 40, judge: 20, case: 5 };
const EXAM_TYPES = ['single', 'multiple', 'judge', 'case'];
const EXAM_DEFAULT_TOTAL = 100;        // 组卷目标总分默认值（可改）
// ------------------------------------------------------------
// 练习选项的「出厂默认值」——只此一处定义，三处引用：
//   ① S 的初值；② applySettings() 遇到旧快照缺字段时的兜底；③ 账号首次进入（本机+云端都无记录）时套用。
//   ⚠ 改这里必须同步改 index.html 里对应 input 的 checked 属性：两处必须一致，
//     否则页面首帧会按 HTML 画出旧状态、等 JS 跑完再跳成新状态（肉眼可见的"闪一下"）。
// ------------------------------------------------------------
const DEFAULT_PREFS = {
  showAns: false,          // 默认显示答案：关（先作答，再对答案）
  rmAll: false,            // 去除多选全选题目：关
  rmCorrectJudge: false,   // 去除正确的判断题：关
  revealAfter: true,       // 选完展示正确答案：开（单选/判断选完即回显，多选点「确定」核对）
  showAnalysis: true,      // 展示解析：开（回显答案后在下方显示该题解析）
  autoRemoveWrong: true    // 答对自动移出错题集：开
};
/** 布尔练习选项统一兜底：字段缺失（旧版快照/旧行）→ 用出厂默认，而不是一律当 false */
function prefBool(v, key) { return v === undefined ? DEFAULT_PREFS[key] : !!v; }
// 四种练习模式（进度按模式各存一份，首页四张卡片也靠这张表取名字）
const MODE_NAME = { sequential: '顺序练习', exam: '组卷模拟考试', wrong: '错题练习', fav: '收藏练习' };
const MODE_NAME_SHORT = { sequential: '顺序练习', exam: '模拟考试', wrong: '错题练习', fav: '收藏练习' };
const MODES = ['sequential', 'exam', 'wrong', 'fav'];

const S = {
  mode: 'sequential', types: { single: true, multiple: true, judge: true, case: true },
  showAns: DEFAULT_PREFS.showAns, rmAll: DEFAULT_PREFS.rmAll,
  rmCorrectJudge: DEFAULT_PREFS.rmCorrectJudge,
  revealAfter: DEFAULT_PREFS.revealAfter, showAnalysis: DEFAULT_PREFS.showAnalysis,
  autoRemoveWrong: DEFAULT_PREFS.autoRemoveWrong,
  examCounts: Object.assign({}, EXAM_DEFAULT_COUNTS),
  examPoints: { single: 0.5, multiple: 1, judge: 0.5, case: 4 },
  examTotal: EXAM_DEFAULT_TOTAL,   // 组卷目标总分：用户可以改，题量按它自动配
  examMin: 90,
  bankId: null,
  examCfgByBank: {},        // { [题库id]: { counts, total, min, updatedAt } } —— 组卷配置按题库各存一份
  fullScore: 100,           // 本次组卷的理论满分（自选题量后不再是固定 100）
  pool: [], idx: 0, userAns: [], revealed: [], correctCount: 0, questionPts: [],
  timer: null, deadline: 0, finished: false,
  // 做题用时：elapsedMs = 已结算的毫秒数，elapsedAt = 本段起算时刻（0 表示「已停表」），
  // etick = 练习页那个每秒刷新的小时钟句柄，lastUsedMs = 本次结果页要显示的最终用时
  elapsedMs: 0, elapsedAt: 0, etick: null, lastUsedMs: 0
};
const TYPE_NAME = { single: '单选题', multiple: '多选题', judge: '判断题', case: '案例题' };
const TYPE_CLS = { single: 'b-single', multiple: 'b-multi', judge: 'b-judge', case: 'b-case' };
const TYPE_UNIT = { single: '题', multiple: '题', judge: '题', case: '组' };
// 答题卡上的标记笔：0 = 擦除，'jump' = 不标记、只跳题
const MARK_COLORS = { 1: '存疑', 2: '重点', 3: '待查' };
const SHEET_TYPES = ['single', 'multiple', 'judge', 'case'];

function $(id) { return document.getElementById(id); }

// ============================================================
// 练习设置（练习选项 / 模式 / 组卷参数）：保存与恢复
// ------------------------------------------------------------
// 两层存储：
//   ① 本地 localStorage —— 每次一改立即写入，离线也可用，刷新/退出后立刻还在；
//   ② 云端 exam_user_prefs —— 登录后按账号跟随，换手机、换浏览器也是同一套设置。
// 冲突判定：比较 updatedAt，谁新用谁。这样"离线时改过"的设置不会被云端旧值抹掉。
// ============================================================
const PREFS_KEY = 'credit_exam_cfg';        // v2.16 之前的旧键：全机共用一份，已被下面按账号隔离的键取代
// v2.16：本机缓存**按账号隔离**（credit_exam_cfg:<uid>，未登录用 :guest）。
// 为什么必须隔离：同一台设备换了账号登录时，新账号不该继承上一个账号的设置 ——
// 否则"第一次进入"看到的不是出厂默认，而是上一个人的选项（云端没记录时尤其明显）。
function prefsKey() {
  return PREFS_KEY + ':' + (getUserId() || 'guest');
}
/** 读本机缓存：新键为空时，尝试把老版本的全局键搬过来（只搬一次，见 migrateLegacyPrefs） */
function readLocalPrefsRaw() {
  try { const v = localStorage.getItem(prefsKey()); if (v !== null) return v; } catch (e) { }
  return migrateLegacyPrefs();
}
/** v2.16 一次性搬迁：老版本把设置存在全局键上，登录后搬进本账号的键；未登录不搬（免得把 A 的设置塞给 guest） */
function migrateLegacyPrefs() {
  if (!getUserId()) return null;
  try {
    const old = localStorage.getItem(PREFS_KEY);
    if (old === null) return null;
    localStorage.setItem(prefsKey(), old);
    localStorage.removeItem(PREFS_KEY);
    return old;
  } catch (e) { return null; }
}

function settingsSnapshot() {
  return {
    mode: S.mode, types: S.types, showAns: S.showAns, rmAll: S.rmAll,
    rmCorrectJudge: S.rmCorrectJudge, revealAfter: S.revealAfter, showAnalysis: S.showAnalysis,
    autoRemoveWrong: S.autoRemoveWrong,
    examCounts: S.examCounts, examPoints: S.examPoints, examTotal: S.examTotal, examMin: S.examMin,
    examCfgByBank: S.examCfgByBank,
    updatedAt: Date.now()
  };
}

function applySettings(c) {
  S.mode = c.mode || 'sequential'; S.types = Object.assign(S.types, c.types || {});
  S.showAns = prefBool(c.showAns, 'showAns'); S.rmAll = prefBool(c.rmAll, 'rmAll');
  S.rmCorrectJudge = prefBool(c.rmCorrectJudge, 'rmCorrectJudge');
  S.revealAfter = prefBool(c.revealAfter, 'revealAfter');
  S.showAnalysis = prefBool(c.showAnalysis, 'showAnalysis');
  S.autoRemoveWrong = prefBool(c.autoRemoveWrong, 'autoRemoveWrong');
  if (c.examPoints) S.examPoints = Object.assign(S.examPoints, c.examPoints);
  S.examCounts = Object.assign({}, EXAM_DEFAULT_COUNTS, c.examCounts || {});
  S.examTotal = Number(c.examTotal) > 0 ? Number(c.examTotal) : EXAM_DEFAULT_TOTAL;
  S.examMin = c.examMin || 90;
  if (c.examCfgByBank && typeof c.examCfgByBank === 'object') S.examCfgByBank = Object.assign({}, c.examCfgByBank);
  loadBankExamCfg();          // 题库级配置优先于"上次用过的配置"
}

/** 恢复出厂默认：账号**第一次进入**（本机+云端都没有记录）与**登出**时调用 */
function applyDefaultPrefs() {
  applySettings(Object.assign({}, DEFAULT_PREFS));
  applyUIFromState();
}

/**
 * 登出时调用：把内存里的练习设置收回出厂默认。
 * 本机缓存已按账号隔离（credit_exam_cfg:<uid>），下一个账号进来读不到上一个人的键 → 看到的就是默认值；
 * 这里再显式清一次内存，是为了覆盖"云端不可用、拿不到新账号记录"的情况（否则 S 会一直留着上一个人的设置）。
 */
export function resetPrefsToDefault() { applyDefaultPrefs(); }

// ---------- 组卷配置：按题库各存一份 ----------
/** 切题库时调用：把该题库上次的组卷配置带回首页 */
export function setBankKey(id) {
  S.bankId = id || null;
  loadBankExamCfg();
  _ecSig = '';                 // 题库变了，题型行必须重建
  renderExamCfg(true);
}

/**
 * 载入当前题库的组卷配置。
 *  · 该题库存过配置 → 原样带出（含用户改大的量，超量时由黄色提醒说明）；
 *  · 没存过（新导入的题库）→ 按「标准配置的题型比例」自动配到目标总分（默认 100 分），
 *    题库里没有的题型直接归零、它的份额让给其它题型，免得刚进来就满屏"题库不足"。
 */
function loadBankExamCfg() {
  if (!S.bankId) return;
  const c = S.examCfgByBank[S.bankId];
  if (c && c.counts) {
    S.examCounts = Object.assign({ single: 0, multiple: 0, judge: 0, case: 0 }, c.counts);
    if (c.total) S.examTotal = clampTotal(c.total);
    if (c.min) S.examMin = c.min;
    return;
  }
  if (!QUESTIONS.length) { S.examCounts = Object.assign({}, EXAM_DEFAULT_COUNTS); return; }
  applyDefaultPlan();
}

/**
 * 目标总分收敛到 1..999 的整数。
 * 填 0 / 负数 / 清空 / 非法输入 → 回到默认 100 分（总分 0 的卷子没有意义，多半是误操作）。
 */
function clampTotal(v) {
  const n = Math.round(parseFloat(v));
  if (!isFinite(n) || n < 1) return EXAM_DEFAULT_TOTAL;
  return Math.min(999, n);
}

/**
 * 回到「标准 100 分整卷」。
 * 新题库（该题库没存过配置）与「恢复默认（100 分）」都走这里：
 * 目标总分回到默认值 —— **不沿用上一个题库的总分**，这样"每个题库各有一套组卷配置"的行为才一致。
 */
function applyDefaultPlan(total) {
  S.examTotal = clampTotal(total === undefined ? EXAM_DEFAULT_TOTAL : total);
  S.examCounts = Object.assign({}, EXAM_DEFAULT_COUNTS);
  const avail = availByType();
  EXAM_TYPES.forEach(t => { if (!(avail[t] > 0)) S.examCounts[t] = 0; });
  fitToTotal(S.examTotal);
}

/**
 * 按目标总分自动配题。
 * ------------------------------------------------------------
 * 权重取「当前各题型的分值占比」（= 用户现在的配题意图），整体等比缩放到目标总分；
 * 当前配置全为 0 时退化为「标准配置」的占比，再退化为等分。
 * 只处理题库里**真实存在**的题型 —— 题库没有的题型一律归 0、不参与组卷，
 * 它原本占的份额会被让给其它题型（这就是"没有案例题的题库默认也能满 100 分"的原因）。
 * 题库题量不够时收敛到上限，由汇总行如实说明"本卷最多多少分"。
 */
function fitToTotal(target) {
  const want = clampTotal(target);
  const avail = availByType();
  const present = EXAM_TYPES.filter(t => (avail[t] || 0) > 0);
  if (!present.length) { EXAM_TYPES.forEach(t => { S.examCounts[t] = 0; }); return want; }
  const pts = t => S.examPoints[t] || 1;

  // 1) 权重：当前配置的分值占比（= 用户现在的配题意图）→ 全 0 时用标准配置的占比 → 再不行等分
  const w = {};
  let wsum = 0;
  present.forEach(t => { w[t] = (S.examCounts[t] || 0) * pts(t); wsum += w[t]; });
  if (wsum <= 0) present.forEach(t => { w[t] = (EXAM_DEFAULT_COUNTS[t] || 0) * pts(t); wsum += w[t]; });
  if (wsum <= 0) present.forEach(t => { w[t] = 1; wsum += 1; });

  // 2) 初值：把目标分按权重分摊给各题型，再折算成题数（四舍五入，并收敛到可用量）
  const ideal = {}, n = {};
  present.forEach(t => {
    ideal[t] = want * w[t] / wsum;
    n[t] = Math.max(0, Math.min(avail[t], Math.round(ideal[t] / pts(t))));
  });

  // 3) 双向局部搜索：每步只做「+1 题 / −1 题」，接受让总分更接近目标的走法；
  //    总分差打平时挑「离理想分值最近」的，配比才不会被 1 分/题的题型带偏。
  const scoreOf = () => present.reduce((s, t) => s + n[t] * pts(t), 0);
  const errOf = () => present.reduce((s, t) => s + Math.abs(ideal[t] - n[t] * pts(t)), 0);
  for (let guard = 0; guard < 2000; guard++) {
    const cur = scoreOf();
    const gap0 = Math.abs(want - cur);
    if (gap0 < 1e-9) break;
    let best = null;
    present.forEach(t => {
      [-1, 1].forEach(d => {
        const nv = n[t] + d;
        if (nv < 0 || nv > avail[t]) return;
        const g = Math.abs(want - (cur + d * pts(t)));
        if (g > gap0 - 1e-9) return;                       // 只走"更接近目标"的那一步
        const saved = n[t]; n[t] = nv;
        const e = errOf();
        n[t] = saved;
        if (!best || g < best.g - 1e-9 || (Math.abs(g - best.g) < 1e-9 && e < best.e - 1e-9)) {
          best = { t, d, g, e };
        }
      });
    });
    if (!best) break;                                      // 题库给不了更接近的分数了
    n[best.t] += best.d;
  }

  // 4) 写回：题库没有的题型一律归 0
  EXAM_TYPES.forEach(t => { S.examCounts[t] = present.includes(t) ? n[t] : 0; });
  return want;
}

/**
 * 按题型统计可用量（只看题库本身与「题目类型 / 去除」开关，与当前练习模式无关）。
 * 用于给新题库生成默认配置，避免"当前模式是错题本"时把配置算成 0。
 */
function availByType() {
  const avail = { single: 0, multiple: 0, judge: 0, case: 0 };
  const cases = {};
  QUESTIONS.forEach(q => {
    const t = q.isCase ? 'case' : q.type;
    if (!S.types[t]) return;                                   // 受「题目类型」勾选影响
    if (q.isCase) { cases[q.caseId] = 1; return; }
    if (t === 'multiple' && S.rmAll && isAllSelected(q)) return;
    if (t === 'judge' && S.rmCorrectJudge && q.answerText === '正确') return;
    avail[t]++;
  });
  avail.case = Object.keys(cases).length;
  return avail;
}
function saveBankExamCfg() {
  if (!S.bankId) return;
  S.examCfgByBank[S.bankId] = { counts: Object.assign({}, S.examCounts), total: S.examTotal, min: S.examMin, updatedAt: Date.now() };
  showEcSaved();
}
function showEcSaved() {
  const el = $('ecSaved');
  if (!el) return;
  const g = $('topBankName');
  const bank = g && g.textContent && g.textContent !== '—' ? '题库「' + g.textContent + '」' : '当前题库';
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0');
  el.textContent = '✓ 组卷配置已保存到 ' + bank + '（' + hh + ':' + mm + '），下次进入自动带出，并跟随账号同步';
}

/** 改了就存：本地立即写，云端防抖 800ms */
function saveSettings() {
  const snap = settingsSnapshot();
  try { localStorage.setItem(prefsKey(), JSON.stringify(snap)); } catch (e) { }
  scheduleCloudSave(snap);
}

function loadSettings() {
  try {
    const c = JSON.parse(readLocalPrefsRaw() || 'null');
    if (c) applySettings(c);
  } catch (e) { }
}

let _cloudTimer = null;
function scheduleCloudSave(snap) {
  if (!getUserId()) return;                    // 未登录（本地练习）只写本地
  if (_cloudTimer) clearTimeout(_cloudTimer);
  _cloudTimer = setTimeout(() => { _cloudTimer = null; pushPrefs(snap); }, 800);
}

/** 让用户一眼看出设置存到了哪里（跟随账号 / 仅本机） */
function setPrefsHint(text, ok) {
  const el = $('prefsHint');
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? 'var(--ok)' : 'var(--sub)';
}

async function pushPrefs(snap) {
  try {
    const { error } = await supabase.from('exam_user_prefs')
      .upsert({ user_id: getUserId(), prefs: snap }, { onConflict: 'user_id' });
    if (error) throw error;
    setPrefsHint('改完自动记住（跟随账号）', true);
  } catch (e) {
    // 离线、或 exam_user_prefs 表还没建：本地已保存，不打断用户
    setPrefsHint('改完自动记住（仅本机）', false);
  }
}

/**
 * 登录进入题库后调用：把「本机该账号的缓存」与「云端该账号的记录」对齐（谁新用谁）。
 * 两个都空 = 这个账号**第一次进入** → 套出厂默认（DEFAULT_PREFS）。
 */
export async function syncPrefsFromCloud() {
  const uid = getUserId();
  if (!uid) return;
  let cloud = null;
  try {
    const { data, error } = await supabase.from('exam_user_prefs').select('prefs').eq('user_id', uid).maybeSingle();
    if (error) throw error;
    cloud = (data && data.prefs) || null;
  } catch (e) {
    // 拉不到（离线 / exam_user_prefs 表还没建）→ 用本机**这个账号**的缓存兜底，没有才是出厂默认，
    // 并如实告诉用户"只存本机"。注意不能直接 return：换账号时内存里可能还留着上一个账号的设置。
    let local2 = null;
    try { local2 = JSON.parse(readLocalPrefsRaw() || 'null'); } catch (err) { }
    if (local2) { applySettings(local2); applyUIFromState(); }
    else applyDefaultPrefs();
    setPrefsHint('改完自动记住（仅本机）', false);
    return;
  }
  let local = null;
  try { local = JSON.parse(readLocalPrefsRaw() || 'null'); } catch (e) { }

  const cloudAt = (cloud && cloud.updatedAt) || 0;
  const localAt = (local && local.updatedAt) || 0;

  if (cloud && cloudAt >= localAt) {
    applySettings(cloud);                       // 云端较新 → 覆盖本地
    try { localStorage.setItem(prefsKey(), JSON.stringify(cloud)); } catch (e) { }
    applyUIFromState();
    setPrefsHint('改完自动记住（跟随账号）', true);
  } else if (local && localAt > cloudAt) {
    pushPrefs(local);                           // 本地较新（如离线改过）→ 推上云
  } else {
    // 本机与本账号云端都没有记录 = 第一次进入 → 出厂默认
    applyDefaultPrefs();
    setPrefsHint('改完自动记住（跟随账号）', true);
  }
}

// ============================================================
// 组卷设置：题型行按「当前题库实际有的题型」动态生成
// ------------------------------------------------------------
//  · 组卷口径：先定「试卷总分」（默认 100 分，可改），题量按它自动配；
//    也可以直接微调各题型题量，满分实时回算。
//  · **题库里没有的题型不参与组卷**：不出现题型行、不参与配分、不进"题库不足"提醒。
//    用户把某题型从「题目类型」里勾掉时同样按"不参与"处理（它的份额让给其它题型）。
//  · 可用量口径与真正抽题完全一致（同一份 buildPool）：
//    受「题目类型」勾选与「去除多选全选 / 去除正确判断题」开关影响；
//  · 案例题按「组」计，可用量 = 题库里案例组数；
//  · 题量可自行定义，超量自动收敛到可用量并给出提示；
//  · 配置（题量 + 目标总分）按题库保存（examCfgByBank），下次进入该题库自动带出。
// ============================================================
/** 计划抽题量与实际可用量（与 sampleExam 同一口径） */
function examPlan() {
  const pool = buildPool();
  const avail = { single: 0, multiple: 0, judge: 0, case: 0 };
  const caseGroups = {};
  pool.forEach(q => {
    if (q.isCase) caseGroups[q.caseId] = (caseGroups[q.caseId] || 0) + 1;
    else if (avail[q.type] !== undefined) avail[q.type]++;
  });
  const caseArr = Object.values(caseGroups);
  avail.case = caseArr.length;
  const present = EXAM_TYPES.filter(t => avail[t] > 0);
  let planned = 0;
  ['single', 'multiple', 'judge'].forEach(t => { planned += Math.min(S.examCounts[t] || 0, avail[t]); });
  const wantCase = Math.min(S.examCounts.case || 0, caseArr.length);
  const avgCase = caseArr.length ? caseArr.reduce((s, n) => s + n, 0) / caseArr.length : 0;
  const caseQs = Math.round(wantCase * avgCase);
  return { avail, present, planned, caseQs, poolTotal: pool.length, caseGroups: caseArr.length };
}

/**
 * 按「配置的题量」算的满分（不收敛到可用量，用于和实际满分对照）。
 * 题库里没有的题型不参与组卷 → 也就不算进本卷配置满分
 * （否则题库没案例题时会出现"按配置应为 100 分"这种看不懂的提示）。
 */
function configFullScore() {
  const plan = examPlan(), c = S.examCounts, p = S.examPoints;
  return Math.round(EXAM_TYPES.reduce(
    (s, t) => s + (plan.avail[t] > 0 ? (c[t] || 0) * (p[t] || 0) : 0), 0) * 10) / 10;
}
/** 按「实际会抽到的题量」（min(配置, 可用)）算的满分 —— 这才是考试真正能拿到的上限 */
function examFullScore() {
  const plan = examPlan(), p = S.examPoints;
  return Math.round(EXAM_TYPES.reduce((s, t) => s + Math.min(S.examCounts[t] || 0, plan.avail[t]) * (p[t] || 0), 0) * 10) / 10;
}

/** 渲染汇总行：已选题量 + 本卷满分（对照目标总分）+ 超量提醒（不做 DOM 重建） */
function updateMaxScore() {
  const plan = examPlan();
  const cfgScore = configFullScore();
  S.fullScore = examFullScore();
  const total = EXAM_TYPES.reduce((s, t) => s + (S.examCounts[t] || 0), 0);
  // 参与组卷的只有题库里真实存在的题型
  const present = EXAM_TYPES.filter(t => plan.avail[t] > 0);
  const target = clampTotal(S.examTotal);
  const r1 = v => Math.round(v * 10) / 10;

  const sum = $('ecSummary');
  if (sum) {
    let h = '已选 <b>' + total + '</b> 项 · 本卷满分 <b id="maxScore">' + S.fullScore + '</b> 分';
    h += ' <span class="muted">· 目标 ' + target + ' 分</span>';
    if (Math.abs(S.fullScore - target) < 1e-9) {
      h += ' <span class="ec-hit">✓ 正好</span>';
    } else if (present.length && present.every(t => (S.examCounts[t] || 0) >= plan.avail[t])) {
      // 每种题型都取到题库上限了，说明是题库题量不够，而不是配置有问题
      h += ' <span class="muted">（题库题量已全部用上，本卷最多 ' + S.fullScore + ' 分）</span>';
    } else {
      h += ' <span class="muted">（' + (S.fullScore < target
        ? '还差 ' + r1(target - S.fullScore) + ' 分'
        : '超出 ' + r1(S.fullScore - target) + ' 分') + '）</span>';
    }
    if (cfgScore !== S.fullScore) h += ' <span class="muted">· 按配置应为 ' + cfgScore + ' 分，题库不足</span>';
    if (plan.caseQs > 0) h += ' <span class="muted">· 案例按组抽，实际约 ' + (plan.planned + plan.caseQs) + ' 道小题</span>';
    sum.innerHTML = h;
  }
  // 超量提醒：只针对题库里真实存在的题型 —— 题库没有的题型不参与组卷，不该在这里出现
  const short = [];
  present.forEach(t => {
    const want = S.examCounts[t] || 0;
    if (want > plan.avail[t]) short.push(TYPE_NAME[t] + ' 配置 ' + want + ' ' + TYPE_UNIT[t] + '，题库仅 ' + plan.avail[t] + ' ' + TYPE_UNIT[t]);
  });
  const warn = $('ecWarn');
  if (warn) {
    if (short.length) { warn.innerHTML = '⚠️ 以下题型题库不足，实际按可用量抽取：<br>· ' + short.join('<br>· '); warn.classList.remove('hide'); }
    else { warn.innerHTML = ''; warn.classList.add('hide'); }
  }
  // 首页「组卷模拟考试」卡片上的摘要
  const card = $('examCounts');
  if (card) {
    const list = present.map(t => TYPE_NAME[t].replace('题', '') + ' ' + (S.examCounts[t] || 0) + TYPE_UNIT[t]);
    card.textContent = list.length ? list.join(' · ') + '｜满分 ' + S.fullScore + ' 分 · ' + S.examMin + ' 分钟' : '当前题库暂无可用题目';
  }
  return S.fullScore;
}

/**
 * 让输入框显示值跟随状态。
 * @param {boolean} force 重建题型行 / 切题库时置 true：连「试卷总分」也强制同步。
 *   平时不打断正在打字的人，但切题库必须强制同步 —— 否则输入框里会留着上一个
 *   题库的旧总分，浏览器随后补发的 change 会拿旧值把刚算好的新配置又覆盖一遍。
 */
function syncEcInputs(force) {
  document.querySelectorAll('#ecRows .ec').forEach(inp => {
    const v = S.examCounts[inp.dataset.t] || 0;
    if (String(inp.value) !== String(v)) inp.value = v;
  });
  const tt = $('ecTotal');
  if (tt && (force || document.activeElement !== tt)) {
    const v = String(clampTotal(S.examTotal));
    if (tt.value !== v) tt.value = v;
  }
}

let _ecSig = '';
/**
 * 生成题型行。
 * @param {boolean} force 强制重建（题库切换时用）
 * 只有「可用题型 / 可用量」签名变化时才重建 DOM，避免把用户正在输入的内容打断。
 */
function renderExamCfg(force) {
  const box = $('ecRows');
  if (!box) return;
  const plan = examPlan();
  const sig = plan.present.join(',') + '|' + plan.present.map(t => plan.avail[t]).join(',');
  const availEl = $('ecAvail');
  if (availEl) {
    availEl.textContent = plan.poolTotal
      ? '本库当前可用 ' + plan.poolTotal + ' 题（受「题目类型」与「去除」开关影响）。题库里没有的题型不参与组卷，只会出现下面这几行：'
      : '当前题库/筛选下没有可用题目，请调整「题目类型」或「练习选项」。';
  }
  if (force || sig !== _ecSig) {
    _ecSig = sig;
    box.innerHTML = plan.present.map(t => {
      const max = plan.avail[t];
      return '<div class="opt-row ec-row" data-t="' + t + '">' +
        '<div class="ec-info"><div class="lbl">' + TYPE_NAME[t] + ' <span class="muted">× ' + S.examPoints[t] + ' 分 / ' + TYPE_UNIT[t] + '</span></div>' +
        '<div class="hint">题库可用 <b>' + max + '</b> ' + TYPE_UNIT[t] + '</div></div>' +
        '<div class="num-row">' +
        '<button type="button" class="ec-mini ec-step" data-t="' + t + '" data-step="-1" aria-label="减少">−</button>' +
        '<input type="number" class="ec ec-num" data-t="' + t + '" data-avail="' + max + '" min="0" max="' + max + '" value="' + (S.examCounts[t] || 0) + '" inputmode="numeric">' +
        '<button type="button" class="ec-mini ec-step" data-t="' + t + '" data-step="1" aria-label="增加">+</button>' +
        '<button type="button" class="ec-mini ec-max" data-t="' + t + '">全部</button>' +
        '</div></div>';
    }).join('');
  }
  syncEcInputs(force);
  updateMaxScore();
}

/** 设置某题型题量并即时保存（clamp 到 0..可用量） */
function setExamCount(t, v, opt) {
  const plan = examPlan();
  const max = plan.avail[t] || 0;
  let n = parseInt(v, 10);
  if (isNaN(n)) n = 0;
  n = Math.max(0, Math.min(max, n));
  S.examCounts[t] = n;
  if (!opt || !opt.silent) {
    saveBankExamCfg();
    saveSettings();
  }
  return n;
}


// ---------- pool building ----------
function isAllSelected(q) {
  return q.type === 'multiple' && Array.isArray(q.correctIdx) &&
    q.correctIdx.length === q.options.length && q.options.length > 0;
}
function isAnswered(a) { return a !== null && !(Array.isArray(a) && a.length === 0); }
function revealMode(q, i) {
  if (S.showAns) return 'full';
  const r = getRender(q);
  if (S.revealAfter && !r.multi && isAnswered(S.userAns[i])) return 'full';
  if (S.revealed[i]) return 'full';
  return null;
}

/**
 * 作答锁定：这道题的答案一旦"回显"，就不允许再改选。
 * ------------------------------------------------------------
 * 触发时机（也就是用户实际会遇到的两种）：
 *  ① 单选 / 判断题：开了「选完展示正确答案」，点下去答案就回显了 → 立即锁；
 *  ② 多选题：点「确定」核对、答案回显 → 立即锁（在此之前可以自由增减，多选本来就要点好几下）。
 * 锁定后点选项不再有任何反应（onPick 直接返回），题面转成"只看不改"，避免看着正确答案改答案。
 *
 * 两个例外，都是刻意留的：
 *  ·「看答案」开关（S.showAns）是"全程显示答案"的浏览姿势，不算提交 → 不锁；
 *  · 没回显答案的题（顺序练习默认设置）仍可改选 → 不锁，保留"先想清楚再定"的自由。
 */
function isLocked(q, i) {
  const k = (i === undefined) ? S.idx : i;
  if (!q || S.showAns) return false;
  if (S.revealed[k]) return true;
  const r = getRender(q);
  return !!(S.revealAfter && !r.multi && isAnswered(S.userAns[k]));
}
function buildPool() {
  if (S.mode === 'wrong' || S.mode === 'fav') {
    const set = new Set(loadArr(S.mode === 'wrong' ? LS.wrong : LS.fav));
    return QUESTIONS.filter(q => set.has(q.id) && (q.isCase ? S.types.case : S.types[q.type]));
  }
  let pool = QUESTIONS.filter(q => {
    if (q.isCase) { if (!S.types.case) return false; }
    else if (!S.types[q.type]) return false;
    if (S.rmAll && !q.isCase && q.type === 'multiple' && isAllSelected(q)) return false;
    if (S.rmCorrectJudge && !q.isCase && q.type === 'judge' && q.answerText === '正确') return false;
    return true;
  });
  return pool;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
/**
 * 「展示解析」那一行的动态小字：直接把"本题库到底有没有解析"摆出来。
 * 没这句的话，题库整本没写解析时用户会开了开关却什么都看不到，以为功能坏了。
 */
function updateAnaStat() {
  const el = $('anaStat'); if (!el) return;
  const s = analysisStat();
  if (!s.total) { el.textContent = ''; el.classList.remove('warn'); return; }
  if (s.has > 0) {
    el.textContent = '本题库 ' + s.has + ' / ' + s.total + ' 题有解析';
    el.classList.remove('warn');
  } else {
    el.textContent = '本题库暂无解析';
    el.classList.add('warn');
  }
}
function updateFilterStat() {
  updateAnaStat();
  const el = $('filterStat'); if (!el) return;
  let base = 0, rmAllN = 0, rmJudgeN = 0;
  QUESTIONS.forEach(q => {
    if (q.isCase) { if (!S.types.case) return; }
    else if (!S.types[q.type]) return;
    base++;
    if (S.rmAll && !q.isCase && q.type === 'multiple' && isAllSelected(q)) rmAllN++;
    if (S.rmCorrectJudge && !q.isCase && q.type === 'judge' && q.answerText === '正确') rmJudgeN++;
  });
  const remain = base - rmAllN - rmJudgeN;
  const removed = [];
  if (S.rmAll && rmAllN > 0) removed.push('去多选全选 ' + rmAllN + ' 题');
  if (S.rmCorrectJudge && rmJudgeN > 0) removed.push('去正确判断题 ' + rmJudgeN + ' 题');
  const extra = removed.length ? '（' + removed.join('，') + '）' : '';
  el.innerHTML = '当前勾选下共 <b>' + base + '</b> 题' + extra + '，最终 <b class="hl">' + remain + '</b> 题';
}
function sampleExam(pool, counts) {
  const byType = { single: [], multiple: [], judge: [], case: [] };
  const caseMap = {};
  pool.forEach(q => {
    if (q.isCase) { (caseMap[q.caseId] = caseMap[q.caseId] || []).push(q); }
    else byType[q.type].push(q);
  });
  const out = [];
  ['single', 'multiple', 'judge'].forEach(t => {
    const want = Math.min(counts[t] || 0, byType[t].length);
    shuffle(byType[t]).slice(0, want).forEach(q => out.push(q));
  });
  const wantCase = Math.min(counts.case || 0, Object.keys(caseMap).length);
  shuffle(Object.values(caseMap)).slice(0, wantCase).forEach(grp => grp.forEach(q => out.push(q)));
  return out;
}
function assignPts(pool) {
  const caseSubCount = {};
  pool.forEach(q => { if (q.isCase) { caseSubCount[q.caseId] = (caseSubCount[q.caseId] || 0) + 1; } });
  return pool.map(q => {
    if (q.isCase) return Math.round(S.examPoints.case / (caseSubCount[q.caseId] || 1) * 1000) / 1000;
    return S.examPoints[q.type];
  });
}

// ---------- render helpers ----------
function getRender(q) {
  if (q.type === 'judge') {
    const choices = q.options ? q.options.map(o => o.text) : ['正确', '错误'];
    const keys = q.options ? q.options.map(o => o.key) : ['A', 'B'];
    let correctIndex = -1;
    const ci = q.correctIdx;
    if (Array.isArray(ci) && ci.length) correctIndex = ci[0];
    else if (q.answerText && choices.indexOf(q.answerText) >= 0) correctIndex = choices.indexOf(q.answerText);
    return { choices, correctIndex, keys, multi: false, judge: true };
  } else {
    const choices = q.options.map(o => o.text);
    const keys = q.options.map(o => o.key);
    return { choices, correctIndex: q.correctIdx, keys, multi: (q.type === 'multiple'), judge: false };
  }
}
function letterOf(q, i) { const r = getRender(q); return r.keys[i]; }

// ---------- progress snapshot ----------
// ⚠️ 必须存「完整快照」：题序 ids + 作答 userAns + 揭示状态 revealed + 考试剩余时间 + 当时设置。
// 历史 bug：这里只存了一个剩余时间数字，于是「继续练习」恢复出来永远是空的（等于从头开始）。
function snapshotProgress(rem) {
  if (!S.pool || !S.pool.length) return null;
  const arr = Array.isArray(S.userAns) ? S.userAns : [];
  const answered = arr.filter(a => a !== null && a !== undefined && !(Array.isArray(a) && a.length === 0)).length;
  return {
    v: 2,
    mode: S.mode,
    types: Object.assign({}, S.types),
    showAns: S.showAns, rmAll: S.rmAll, rmCorrectJudge: S.rmCorrectJudge,
    revealAfter: S.revealAfter, autoRemoveWrong: S.autoRemoveWrong,
    ids: S.pool.map(q => q.id),
    idx: S.idx,
    userAns: arr.map(a => (Array.isArray(a) ? a.slice() : a)),
    revealed: Array.isArray(S.revealed) ? S.revealed.slice() : [],
    questionPts: Array.isArray(S.questionPts) ? S.questionPts.slice() : [],
    remainingMs: (typeof rem === 'number' && rem > 0) ? rem : currentRemaining(),
    elapsedMs: usedMs(),          // 做题用时（含本段正在跑的时间），恢复时接着累计
    answered: answered,
    total: S.pool.length,
    finished: false,
    updatedAt: Date.now()
  };
}
function saveSnapshot(rem) {
  const snap = snapshotProgress(rem);
  if (snap) saveProgress(snap);
}

// ---------- start ----------
function start(p, atIdx) {
  let pool, resumed = !!p, rem = 0;
  if (resumed) {
    S.mode = p.mode || 'sequential';
    S.types = Object.assign({ single: true, multiple: true, judge: true, case: true }, p.types || {});
    // 练习选项（默认显示答案 / 去全选 / 去正确判断题 / 选完展示答案 / 答对移出错题集）**不跟随快照恢复**：
    // 它们是"账号级偏好"，永远以用户当前设置为准。旧快照里存着的历史值若在点「继续练习」时盖回来，
    // 用户会看到自己刚设好的开关莫名被改（v2.16 前就有这个副作用），而且接着的 saveSettings() 还会把旧值写回云端。
    // 题池由下面的 p.ids 原样重建，不受这几个开关影响，所以不复原也不会让题目对不上。
    applyUIFromState();
    if (Array.isArray(p.ids) && p.ids.length) {
      const idset = new Set(p.ids);
      pool = QUESTIONS.filter(q => idset.has(q.id));
    } else {
      pool = buildPool();
    }
    rem = p.remainingMs || 0;
  } else {
    pool = buildPool();
    if (pool.length === 0) { alert('当前筛选条件下没有可用题目，请调整设置。'); return; }
    if (S.mode === 'exam') pool = sampleExam(pool, S.examCounts);
  }
  if (pool.length === 0) { alert('没有可用题目，请返回首页调整设置。'); clearProgress(S.mode); return; }
  S.pool = pool;
  S.questionPts = S.mode === 'exam' ? assignPts(pool) : [];
  // 组卷满分随「自选题量」而变：开考时按实际抽到的题定死（结果页按它显示 "得分 / 满分"）
  if (S.mode === 'exam' && !resumed) S.fullScore = Math.round(S.questionPts.reduce((a, b) => a + b, 0) * 10) / 10;
  if (resumed) {
    S.idx = p.idx || 0;
    S.userAns = Array.isArray(p.userAns) ? p.userAns : new Array(pool.length).fill(null);
    S.revealed = Array.isArray(p.revealed) ? p.revealed : new Array(pool.length).fill(false);
  } else {
    S.idx = 0; S.userAns = new Array(S.pool.length).fill(null);
    S.revealed = new Array(S.pool.length).fill(false);
  }
  if (atIdx !== undefined && atIdx >= 0 && atIdx < S.pool.length) S.idx = atIdx;
  S.correctCount = 0; S.finished = false;
  // 做题用时：从头开始 = 归零重开表；继续练习 = 接着上次的累计值起表（不含退出期间的空档）
  if (resumed) {
    S.elapsedMs = (typeof p.elapsedMs === 'number' && p.elapsedMs > 0) ? p.elapsedMs : 0;
    S.elapsedAt = Date.now();
  } else resetElapsed();
  saveSettings();
  $('home').classList.add('hide');
  $('result').classList.add('hide');
  $('practice').classList.remove('hide');
  $('examCfg').classList.toggle('hide', S.mode !== 'exam');
  const modeName = MODE_NAME[S.mode] || MODE_NAME.sequential;
  $('modeTag').textContent = modeName + ' · 共 ' + S.pool.length + ' 题';
  $('sheetToggle').classList.remove('hide');    // 答题卡任何模式都能看（题型分组 + 已答未答 + 彩色标记）
  closeSheet();
  $('checkBtn').classList.toggle('hide', S.mode === 'exam' || S.showAns);
  const es = $('elapsedSpan');
  if (S.mode === 'exam') {
    // 考试已经有倒计时了，不再叠一个正计时（要看清"还剩多久"，不要两个表打架）
    startTimer(rem); stopElapsedTicker(); if (es) es.classList.add('hide');
  } else {
    stopTimer(); if (es) es.classList.remove('hide'); startElapsedTicker();
  }
  renderSheet();
  renderQuestion();
  saveSnapshot(rem);
}

function startTimer(remainingMs) {
  const ms = (remainingMs && remainingMs > 0) ? remainingMs : (S.examMin > 0 ? S.examMin : 60) * 60000;
  S.deadline = Date.now() + ms;
  $('timerSpan').classList.remove('hide');
  tick();
  S.timer = setInterval(tick, 1000);
}
function currentRemaining() { return S.timer ? Math.max(0, S.deadline - Date.now()) : 0; }
function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } $('timerSpan').classList.add('hide'); }
function tick() {
  const left = Math.max(0, S.deadline - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
  $('timerSpan').textContent = '⏱ ' + m + ':' + (s < 10 ? '0' : '') + s;
  if (left <= 0) { stopTimer(); finishExam(true); }
}

// ---------- 做题用时 ----------
// 为什么用「已结算 + 本段」两段式：练习可以中途退出、刷新、切后台，
// 只存一个开始时刻的话，恢复时会把「退出期间挂掉的那些时间」也算进去。
// 所以：退出 / 交卷 / 切后台 → pauseElapsed() 把本段结算进 elapsedMs 并停表；
// 继续练习 → 重新起表接着累计（恢复出来的用时 = 上次练到哪儿的时间，不含中间空档）。
function usedMs() {
  return (S.elapsedMs || 0) + (S.elapsedAt ? Math.max(0, Date.now() - S.elapsedAt) : 0);
}
function markElapsed() { S.elapsedMs = usedMs(); S.elapsedAt = Date.now(); }   // 结算后继续跑
function pauseElapsed() { S.elapsedMs = usedMs(); S.elapsedAt = 0; }          // 结算并停表
function resetElapsed() { S.elapsedMs = 0; S.elapsedAt = Date.now(); }        // 重新开表
/** 计时态紧凑写法：12:34 / 1:02:34 */
function clockText(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const p = n => (n < 10 ? '0' : '') + n;
  return h > 0 ? (h + ':' + p(m) + ':' + p(s)) : (m + ':' + p(s));
}
/** 给人读的时长：45秒 / 12分34秒 / 1小时02分03秒 */
function humanDuration(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const p = n => (n < 10 ? '0' : '') + n;
  if (h > 0) return h + '小时' + p(m) + '分' + p(s) + '秒';
  if (m > 0) return m + '分' + p(s) + '秒';
  return s + '秒';
}
function tickElapsed() {
  const el = $('elapsedSpan');
  if (el) el.textContent = '⏱ 用时 ' + clockText(usedMs());
}
function startElapsedTicker() { stopElapsedTicker(); tickElapsed(); S.etick = setInterval(tickElapsed, 1000); }
function stopElapsedTicker() { if (S.etick) { clearInterval(S.etick); S.etick = null; } }

// ---------- 「展示解析」 ----------
/**
 * 题末的解析块。显示规则**与参考答案完全一致**：只要答案回显了就显示（mode !== null），
 * 没回显就一个字都不露 —— 否则解析里往往写着答案，等于把答案提前剧透。
 * 于是四种模式、以及「看答案」「选完展示正确答案」各种组合都不需要额外判断。
 *
 * 两种"不出现"：① 设置关着；② 这道题本身没写解析（不占位、不留空壳）。
 */
function analysisHtml(q, mode) {
  if (!S.showAnalysis || !mode) return '';
  const txt = q && q.analysis != null ? String(q.analysis).replace(/\s+/g, ' ').trim() : '';
  if (!txt) return '';
  return '<div class="ana show"><div class="ana-h">解析</div><div class="ana-b">' + escapeHtml(txt) + '</div></div>';
}
/** 当前题库里有多少题写了解析（首页那行提示用；题库没解析时提前告知，免得用户以为开关坏了） */
function analysisStat() {
  let has = 0;
  QUESTIONS.forEach(q => { if (q.analysis != null && String(q.analysis).trim()) has++; });
  return { has: has, total: QUESTIONS.length };
}

// ---------- question render ----------
function renderQuestion() {
  const q = S.pool[S.idx];
  const total = S.pool.length;
  $('pbarFill').style.width = ((S.idx + 1) / total * 100) + '%';
  $('pcount').textContent = '第 ' + (S.idx + 1) + ' / ' + total + ' 题';
  let badgeType = q.isCase ? 'case' : q.type;
  let badge = '<span class="badge ' + TYPE_CLS[badgeType] + '">' + TYPE_NAME[badgeType] + '</span>';
  let bgHtml = '';
  const prev = S.pool[S.idx - 1];
  if (q.isCase && q.caseBackground && !(prev && prev.isCase && prev.caseId === q.caseId)) {
    bgHtml = '<div class="bg"><span class="tag">【案例背景】</span>' + escapeHtml(String(q.caseBackground).replace(/\s+/g, ' ').trim()) + '</div>';
  }
  const r = getRender(q);
  const ans = S.userAns[S.idx];
  const mode = revealMode(q, S.idx);
  const locked = isLocked(q, S.idx);          // 已回显答案 → 选项只读，不允许再改选
  const lockCls = locked ? ' lock' : '';
  const favOn = hasId(LS.fav, q.id);
  let html = '<div class="qhead">' + badge + '<button type="button" class="favBtn ' + (favOn ? 'on' : '') + '" id="favBtn" title="收藏此题">★</button></div>' + bgHtml + '<div class="stem">' + escapeHtml(String(q.stem).replace(/\s+/g, ' ').trim()) + '</div>';
  if (r.judge) {
    html += '<div class="judge-btns' + lockCls + '" id="opts">';
    r.choices.forEach((c, i) => {
      let cls = 'opt';
      if (locked) cls += ' lock';
      if (ans === i) cls += ' sel';
      if (mode === 'full') {
        if (i === r.correctIndex) cls += ' ok';
        else if (ans === i) cls += ' no';
        else cls += ' dim';
      }
      html += '<div class="' + cls + '" data-i="' + i + '">' + escapeHtml(c) + '</div>';
    });
    html += '</div>';
  } else {
    html += '<div class="opts' + lockCls + '" id="opts">';
    r.choices.forEach((c, i) => {
      let cls = 'opt';
      if (locked) cls += ' lock';
      const selHere = Array.isArray(ans) ? ans.includes(i) : ans === i;
      if (selHere) cls += ' sel';
      if (mode === 'full') {
        if (Array.isArray(r.correctIndex) ? r.correctIndex.includes(i) : r.correctIndex === i) cls += ' ok';
        else if (selHere) cls += ' no';
        else cls += ' dim';
      }
      html += '<div class="' + cls + '" data-i="' + i + '"><div class="k">' + r.keys[i] + '</div><div class="txt">' + escapeHtml(String(c).replace(/\s+/g, ' ').trim()) + '</div></div>';
    });
    html += '</div>';
  }
  // 对错与正确答案合并成一行：左侧小胶囊表对错，右侧接正确答案（省一行高度）
  let fbLine = '';
  if (mode) {
    let pill = '';
    if (mode === 'full') {
      const correct = isCorrect(q, S.idx);
      pill = '<span class="fb-pill ' + (correct ? 'ok' : 'no') + '">' + (correct ? '✓ 回答正确' : '✗ 回答错误') + '</span>';
    }
    fbLine = '<div class="fb-line show">' + pill +
      '<span class="ans-key">正确答案：<b>' + escapeHtml(answerKeysStr(q)) + '</b></span>' +
      (locked ? '<span class="fb-lock" title="本题已回显答案，不能再改选" aria-label="已锁定">🔒</span>' : '') + '</div>';
  }
  html += fbLine;
  html += analysisHtml(q, mode);      // 解析：跟着「答案是否回显」走，没回显时一个字都不露
  $('qBody').innerHTML = html;
  const optsEl = $('opts');
  if (optsEl && !S.finished) {
    optsEl.querySelectorAll('.opt').forEach(el => {
      el.addEventListener('click', () => onPick(q, parseInt(el.dataset.i), r));
    });
  }
  const favBtnEl = $('favBtn');
  if (favBtnEl && !S.finished) {
    favBtnEl.addEventListener('click', () => {
      const on = !hasId(LS.fav, q.id);
      if (on) addId(LS.fav, q.id); else removeId(LS.fav, q.id);
      favBtnEl.classList.toggle('on', on);
      updateLibStats();
    });
  }
  $('prevBtn').disabled = S.idx === 0;
  const cr2 = getRender(q);
  const revealedNow = revealMode(q, S.idx) !== null;
  const nbtn = $('nextBtn');
  if (S.mode !== 'exam' && cr2.multi && !revealedNow) {
    nbtn.textContent = '确定';
    nbtn.dataset.act = 'check';
  } else {
    nbtn.textContent = (S.idx === total - 1) ? (S.mode === 'exam' ? '交卷' : '完成') : '下一题 →';
    nbtn.dataset.act = 'next';
  }
  const cbtn = $('checkBtn');
  let showCheck = false;
  if (!S.finished && S.mode === 'exam' && S.revealAfter && cr2.multi && isAnswered(ans) && revealMode(q, S.idx) !== 'full') {
    showCheck = true;
  }
  cbtn.classList.toggle('hide', !showCheck);
  renderSheet();
}

function recordWrong(q) {
  const i = S.idx;
  if (revealMode(q, i) !== 'full') return;
  if (isCorrect(q, i)) { if (S.autoRemoveWrong) removeId(LS.wrong, q.id); }
  else { addId(LS.wrong, q.id); }
}
function onPick(q, i, r) {
  // 答案已回显（「选完展示正确答案」/ 多选点过「确定」）→ 本题作答已定格，点选项不再有任何反应
  if (isLocked(q, S.idx)) return;
  if (r.multi) {
    let a = S.userAns[S.idx];
    if (!Array.isArray(a)) a = [];
    if (a.includes(i)) a = a.filter(x => x !== i); else a.push(i);
    S.userAns[S.idx] = a;
  } else {
    S.userAns[S.idx] = i;
  }
  renderQuestion();
  recordWrong(q);
  saveSnapshot();
}

function checkCurrent() {
  const q = S.pool[S.idx];
  if (S.userAns[S.idx] === null || (Array.isArray(S.userAns[S.idx]) && S.userAns[S.idx].length === 0)) {
    alert('请先选择答案，再核对。'); return;
  }
  S.revealed[S.idx] = true;
  renderQuestion();
  recordWrong(q);
  saveSnapshot();
}

// ---------- correctness ----------
function isCorrect(q, i) {
  const r = getRender(q);
  const a = S.userAns[i];
  if (a === null || a === undefined) return false;
  if (r.judge) return a === r.correctIndex;
  const ci = Array.isArray(r.correctIndex) ? r.correctIndex : [r.correctIndex];
  const sa = Array.isArray(a) ? a : [a];
  if (sa.length !== ci.length) return false;
  const sa2 = [...sa].sort(), sc = [...ci].sort();
  return sa2.every((v, k) => v === sc[k]);
}
function answerText(q) {
  const r = getRender(q);
  if (r.judge) return r.choices[r.correctIndex];
  return Array.isArray(r.correctIndex)
    ? r.correctIndex.map(i => r.keys[i] + '. ' + r.choices[i]).join('；')
    : r.keys[r.correctIndex] + '. ' + r.choices[r.correctIndex];
}
function answerKeysStr(q) {
  const r = getRender(q);
  const ci = Array.isArray(r.correctIndex) ? r.correctIndex : [r.correctIndex];
  return ci.map(i => r.keys[i]).join('、');
}
function userText(q, i) {
  const r = getRender(q);
  const a = (i === undefined) ? S.userAns[S.idx] : S.userAns[i];
  if (r.judge) return a === null ? '' : r.choices[a];
  if (a === null) return '（未作答）';
  return Array.isArray(a) ? a.map(x => r.keys[x] + '. ' + r.choices[x]).join('；') : r.keys[a] + '. ' + r.choices[a];
}

// ---------- sheet（答题卡） ----------
// 四种信号叠在一格上，各占一个视觉通道，互不覆盖：
//  ① 底色/边框 → 未答(灰) / 已答(蓝) / 已看过答案(绿=对、红=错)
//  ② 右上角小三角 → 自己的标记色（黄 存疑 / 紫 重点 / 青 待查），所以"已答"和"标记"能同时看见
//  ③ 外描边 → 当前题
//  ④ 题型：按单选题/多选题/判断题/案例题分组，组头带题型徽标与该组已答数
// 点击行为由当前选中的工具决定：选「跳转」= 跳题；选某支笔 = 上色/取消；选「擦除」= 去掉标记。
let _markPen = 'jump';

function sheetHintText() {
  if (_markPen === 'jump') return '点题号直接跳到该题。要标记，先在上面选一支笔。';
  if (_markPen === '0') return '擦除：点题号去掉它原有的标记。';
  return '已选「' + MARK_COLORS[_markPen] + '」笔：点题号上色，再点一次取消（此时点题号不会跳题）。';
}
function isAnsweredCell(a) {
  return a !== null && a !== undefined && !(Array.isArray(a) && a.length === 0);
}

function renderSheet() {
  const el = $('sheet');
  if (!el || !S.pool) return;
  const total = S.pool.length;
  // 按题型分桶（保持题库/抽题时的原始顺序，只做分组）
  const byType = {};
  for (let i = 0; i < total; i++) {
    const q = S.pool[i];
    const t = q.isCase ? 'case' : q.type;
    if (!byType[t]) byType[t] = [];
    byType[t].push(i);
  }
  let h = '', answered = 0, marks = 0;
  SHEET_TYPES.concat(Object.keys(byType)).forEach(t => {
    const list = byType[t];
    if (!list || !list.length) return;
    byType[t] = null;                       // 防止后面的 concat 重复渲染同一个题型
    let gAns = 0;
    list.forEach(i => { if (isAnsweredCell(S.userAns[i])) gAns++; });
    answered += gAns;
    h += '<div class="sh-grp" data-t="' + t + '"><div class="sh-grp-h">' +
      '<span class="badge ' + (TYPE_CLS[t] || 'b-single') + '">' + (TYPE_NAME[t] || t) + '</span>' +
      '<span class="sh-grp-n">' + list.length + ' 题 · 已答 ' + gAns + '</span></div><div class="sheet">';
    list.forEach(i => {
      const q = S.pool[i];
      const a = S.userAns[i];
      let cls = 'c';
      if (isAnsweredCell(a)) {
        // 已经看过答案的（自己核对过 / 开了看答案）才显对错，没看过的只显"已答"
        if (revealMode(q, i) === 'full') cls += isCorrect(q, i) ? ' right' : ' wrong';
        else cls += ' ans';
      }
      if (i === S.idx) cls += ' cur';
      const mk = markOf(q.id);
      if (mk) { cls += ' mk m' + mk; marks++; }
      h += '<div class="' + cls + '" data-go="' + i + '" title="第 ' + (i + 1) + ' 题">' + (i + 1) + '</div>';
    });
    h += '</div></div>';
  });
  el.innerHTML = h;

  const sc = $('sheetCount'); if (sc) sc.textContent = '(' + answered + '/' + total + ')';
  const st = $('sheetStat');
  if (st) {
    st.innerHTML = '已答 <b>' + answered + '</b> · 未答 <b>' + (total - answered) + '</b>' +
      (marks ? ' · 标记 <b>' + marks + '</b>' : '');
  }
  const clr = $('sheetClearMarks'); if (clr) clr.classList.toggle('hide', marks === 0);
  const hint = $('sheetHint'); if (hint) hint.textContent = sheetHintText();
  document.querySelectorAll('#sheetPens .pen').forEach(b => b.classList.toggle('on', b.dataset.pen === _markPen));

  el.querySelectorAll('.c').forEach(c => c.addEventListener('click', () => {
    const i = parseInt(c.dataset.go, 10);
    const q = S.pool[i];
    if (!q) return;
    if (_markPen === 'jump') {               // 跳题：沿用原来的行为（跳过去 + 收起答题卡）
      S.idx = i; renderQuestion(); saveSnapshot();
      closeSheet();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const id = q.id;
    if (_markPen === '0') setMark(id, 0);
    else {
      const want = parseInt(_markPen, 10);
      setMark(id, markOf(id) === want ? 0 : want);
    }
    renderSheet();                            // 就地重画，不跳题、不收起，方便连着标好几题
  }));
}
function closeSheet() {
  const c = $('sheetCard'); if (c) c.classList.add('hide');
  const a = $('sheetArr'); if (a) a.textContent = '▾';
  const t = $('sheetToggle'); if (t) t.classList.remove('open');
}

// ---------- navigation ----------
function next() {
  if (S.idx < S.pool.length - 1) { S.idx++; renderQuestion(); window.scrollTo({ top: 0, behavior: 'smooth' }); saveSnapshot(); }
  else {
    if (S.mode === 'exam') { if (confirm('确定交卷吗？')) finishExam(false); }
    else finishSequential();
  }
}
function prev() { if (S.idx > 0) { S.idx--; renderQuestion(); window.scrollTo({ top: 0, behavior: 'smooth' }); saveSnapshot(); } }

// ---------- finish ----------
function finishSequential() {
  let right = 0;
  for (let i = 0; i < S.pool.length; i++) {
    if (isCorrect(S.pool[i], i)) right++;
  }
  // 答错 = 总题数 − 答对。这里面既含「作答了但错」，也含「跳过去没答」——两者同样算没做对，
  // 口径才能和结果页下方的错题清单、错题集里的条目完全对齐（三格也能对上：总 = 对 + 错）。
  // 旧写法是 pool.length − answered（只数「一个字没写」的题），全做完时未答恒为 0 → 答错永远显示 0。
  const wrong = S.pool.length - right;
  // 标题按当前模式取：错题练习/收藏练习走的是同一个函数，写死「顺序练习完成」会驴唇不对马嘴
  showResult(right, right, wrong, S.pool.length, (MODE_NAME[S.mode] || '顺序练习') + '完成', false);
}
function finishExam(auto) {
  stopTimer();
  let right = 0, score = 0;
  for (let i = 0; i < S.pool.length; i++) {
    if (isCorrect(S.pool[i], i)) { right++; score += S.questionPts[i] || 0; }
  }
  const total = S.pool.length, wrong = total - right;
  score = Math.round(score * 10) / 10;
  showResult(score, right, wrong, total, '模拟考试' + (auto ? '（时间到自动交卷）' : ''), true);
}

function showResult(scoreNum, right, wrong, total, title, isExam) {
  S.finished = true;
  // 交卷即停表：定格最终用时，并把练习页那个每秒刷新的小时钟收掉
  pauseElapsed(); S.lastUsedMs = S.elapsedMs; stopElapsedTicker();
  // 只清**当前模式**的进度：练完顺序练习不该把组卷模拟/错题练习的进度一起清掉
  clearProgress(S.mode);
  stopTimer();
  for (let i = 0; i < S.pool.length; i++) { if (!isCorrect(S.pool[i], i)) addId(LS.wrong, S.pool[i].id); }
  $('practice').classList.add('hide');
  $('result').classList.remove('hide');
  $('resTitle').textContent = title;
  if (isExam) { $('resScore').textContent = scoreNum + ' / ' + (S.fullScore || 100); }
  else { $('resScore').textContent = right; }
  $('resSub').textContent = (isExam ? ('得分 ' + scoreNum + ' 分　') : '') + (right + ' / ' + total + ' 正确');
  $('stTotal').textContent = total;
  $('stRight').textContent = right;
  $('stWrong').textContent = wrong;
  const stT = $('stTime');
  if (stT) stT.textContent = humanDuration(S.lastUsedMs);
  const wl = $('wrongList'); wl.innerHTML = '';
  for (let i = 0; i < S.pool.length; i++) {
    if (!isCorrect(S.pool[i], i)) {
      const q = S.pool[i]; const r = getRender(q);
      const div = document.createElement('div'); div.className = 'wl-item';
      let badge = '<span class="badge ' + TYPE_CLS[(q.isCase ? 'case' : q.type)] + '">' + TYPE_NAME[(q.isCase ? 'case' : q.type)] + '</span>';
      div.innerHTML = badge + '<div class="q">' + escapeHtml(String(q.stem).replace(/\s+/g, ' ').trim()) + '</div>' +
        '<div class="a">正确答案：<span class="r">' + escapeHtml(answerKeysStr(q)) + '</span></div>';
      wl.appendChild(div);
    }
  }
  $('wrongWrap').classList.add('hide');
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- 错题/收藏 分组回顾 ----------
function updateLibStats() {
  const w = $('wrongCnt'), f = $('favCnt');
  const wc = countId(LS.wrong), fc = countId(LS.fav);
  if (w) w.textContent = wc;
  if (f) f.textContent = fc;
  const wb = $('wrongLibBtn'), fb = $('favLibBtn');
  if (wb) wb.disabled = wc === 0;
  if (fb) fb.disabled = fc === 0;
  renderModeCounts('wrong', 'wrongCounts');
  renderModeCounts('fav', 'favCounts');
}
function typeCountsFor(kind) {
  const ids = loadArr(kind === 'wrong' ? LS.wrong : LS.fav);
  const set = new Set(ids);
  const byType = { single: 0, multiple: 0, judge: 0, case: 0 };
  QUESTIONS.forEach(q => { if (set.has(q.id)) byType[q.isCase ? 'case' : q.type]++; });
  return byType;
}
function renderModeCounts(kind, elId) {
  const el = $(elId); if (!el) return;
  const c = typeCountsFor(kind);
  const total = c.single + c.multiple + c.judge + c.case;
  if (total === 0) { el.innerHTML = '<span class="muted">暂无题目</span>'; return; }
  const parts = [['单选', c.single], ['多选', c.multiple], ['判断', c.judge], ['案例', c.case]]
    .map(p => p[0] + ' ' + p[1]);
  el.innerHTML = parts.join(' · ') + ' · <span class="tot">共 ' + total + '</span>';
}
function openLib(kind) {
  const key = kind === 'wrong' ? LS.wrong : LS.fav;
  const ids = loadArr(key);
  if (ids.length === 0) { alert(kind === 'wrong' ? '错题集还是空的，先去做题吧。' : '还没有收藏的题目。'); return; }
  const idset = new Set(ids);
  const pool = QUESTIONS.filter(q => idset.has(q.id));
  $('libTitle').textContent = (kind === 'wrong' ? '错题集' : '收藏') + ' · 共 ' + pool.length + ' 题';
  const order = [['single', '单选题'], ['multiple', '多选题'], ['judge', '判断题'], ['case', '案例题']];
  // 该模式若有未完成的进度，在列表最上方提示（点其中某题 = 从那一题重开这个模式的练习）
  const info = resumeInfo(kind);
  let h = info
    ? '<div class="lib-resume">上次练到第 <b>' + info.at + '</b> / ' + info.total + ' 题 · 已答 ' + info.answered + ' 题</div>'
    : '';
  order.forEach(([t, name]) => {
    const list = [];
    pool.forEach((q, i) => { if ((q.isCase ? 'case' : q.type) === t) list.push(i); });
    if (list.length === 0) return;
    h += '<div class="lib-sec"><div class="lib-sec-h">' + name + ' <span class="lib-sec-n">' + list.length + ' 题</span></div><div class="sheet">';
    list.forEach(i => { h += '<div class="c" data-kind="' + kind + '" data-idx="' + i + '">' + (i + 1) + '</div>'; });
    h += '</div></div>';
  });
  const body = $('libBody'); body.innerHTML = h;
  body.querySelectorAll('.c').forEach(c => c.addEventListener('click', () => {
    const idx = parseInt(c.dataset.idx, 10);
    S.mode = c.dataset.kind;
    S.types = { single: true, multiple: true, judge: true, case: true };
    closeLib();
    start(undefined, idx);
  }));
  $('libModal').classList.remove('hide');
}
function closeLib() { $('libModal').classList.add('hide'); }

// ---------- UI bindings ----------
function bindHome() {
  document.querySelectorAll('.mode').forEach(m => m.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach(x => x.classList.remove('active'));
    m.classList.add('active'); S.mode = m.dataset.mode;
    const exam = S.mode === 'exam';
    $('examCfg').classList.toggle('hide', !exam);
    if (exam) { renderExamCfg(true); $('examCfgBody').classList.add('hide'); $('examCfgArr').textContent = '▸'; }
    saveSettings();
    // 主按钮与卡片进度都要跟着换：每个模式各有一份进度，「继续练习」指向的是当前模式那一份
    refreshStartActions();
    renderModeResumes();
  }));
  $('examCfgHead').addEventListener('click', () => {
    const b = $('examCfgBody'); b.classList.toggle('hide');
    $('examCfgArr').textContent = b.classList.contains('hide') ? '▸' : '▾';
    if (!b.classList.contains('hide')) renderExamCfg(true);
  });
  document.querySelectorAll('#typeChips .chip').forEach(c => c.addEventListener('click', () => {
    const t = c.dataset.t; S.types[t] = !S.types[t]; c.classList.toggle('active', S.types[t]);
    updateFilterStat(); renderExamCfg(true);
    saveSettings();
  }));
  // 练习选项：每一次切换都立即落盘（本地 + 云端），退出/刷新后原样恢复
  $('showAns').addEventListener('change', e => { S.showAns = e.target.checked; saveSettings(); });
  // 「去除多选全选 / 去除正确判断题」会改变各题型的可用量，必须重算题型行与满分
  $('rmAll').addEventListener('change', e => { S.rmAll = e.target.checked; updateFilterStat(); renderExamCfg(); saveSettings(); });
  $('rmCorrectJudge').addEventListener('change', e => { S.rmCorrectJudge = e.target.checked; updateFilterStat(); renderExamCfg(); saveSettings(); });
  $('revealAfter').addEventListener('change', e => { S.revealAfter = e.target.checked; saveSettings(); });
  $('showAnalysis').addEventListener('change', e => { S.showAnalysis = e.target.checked; saveSettings(); });
  $('autoRemoveWrong').addEventListener('change', e => { S.autoRemoveWrong = e.target.checked; saveSettings(); });
  $('wrongLibBtn').addEventListener('click', () => openLib('wrong'));
  $('favLibBtn').addEventListener('click', () => openLib('fav'));
  $('libClose').addEventListener('click', closeLib);
  $('libMask').addEventListener('click', closeLib);
  // 继续练习：恢复**当前模式**那一份快照（题序 / 已作答 / 对错揭示 / 考试剩余时间都在里面）。
  // 各模式各有自己的进度，所以这里必须带上 S.mode 去取，不能取"最近一份"。
  $('continueBtn').addEventListener('click', () => {
    const p = loadProgress(S.mode);
    if (p && Array.isArray(p.ids) && p.ids.length) start(p);
    else { clearProgress(S.mode); start(); }
  });
  // 从头开始：丢掉**当前模式**的旧进度，按当前设置重新组题（其它模式的进度保留）
  $('restartBtn').addEventListener('click', () => { clearProgress(S.mode); start(); });
  // ---- 组卷设置：题型行是动态生成的，用事件委托绑定 ----
  // 输入中：只更新汇总（不 clamp、不重建 DOM），避免打断打字
  $('ecRows').addEventListener('input', e => {
    const inp = e.target.closest ? e.target.closest('.ec-num') : null;
    if (!inp) return;
    const t = inp.dataset.t;
    const v = parseInt(inp.value, 10);
    if (!isNaN(v) && v >= 0) S.examCounts[t] = Math.min(v, 9999);
    updateMaxScore();
  });
  // 失焦/回车：收敛到 0..可用量，写回输入框，并即时保存（本地 + 云端 + 题库级）
  $('ecRows').addEventListener('change', e => {
    const inp = e.target.closest ? e.target.closest('.ec-num') : null;
    if (!inp) return;
    const t = inp.dataset.t;
    inp.value = setExamCount(t, inp.value);
    updateMaxScore();
  });
  $('ecRows').addEventListener('click', e => {
    const el = e.target.closest ? e.target.closest('button') : null;
    if (!el) return;
    const t = el.dataset.t;
    if (!t) return;
    const plan = examPlan();
    if (el.classList.contains('ec-max')) setExamCount(t, plan.avail[t]);
    else if (el.classList.contains('ec-step')) setExamCount(t, (S.examCounts[t] || 0) + parseInt(el.dataset.step, 10));
    else return;
    renderExamCfg(true);
  });
  // 一键预设
  $('ecMaxAll').addEventListener('click', () => {
    const plan = examPlan();
    EXAM_TYPES.forEach(t => { S.examCounts[t] = plan.avail[t] || 0; });
    saveBankExamCfg(); saveSettings(); renderExamCfg(true);
  });
  $('ecZeroAll').addEventListener('click', () => {
    EXAM_TYPES.forEach(t => { S.examCounts[t] = 0; });
    saveBankExamCfg(); saveSettings(); renderExamCfg(true);
  });
  $('ecDefault').addEventListener('click', () => {
    // 「恢复默认（100 分）」= 标准 100 分整卷：目标总分回到 100，题量按标准配置的比例
    // 自动配平（题库里没有的题型，份额让给其它题型）；
    // 题库题量不够时由汇总行与黄色提醒如实说明实际会抽多少、本卷最多多少分
    S.examTotal = EXAM_DEFAULT_TOTAL;
    S.examMin = 90;
    $('examMin').value = S.examMin;
    applyDefaultPlan();
    saveBankExamCfg(); saveSettings(); renderExamCfg(true);
  });
  // 「试卷总分」：改目标分 → 立即按当前各题型的分值占比重配题量（改完就是一套配平的卷子）
  $('ecTotal').addEventListener('change', e => {
    const v = clampTotal(e.target.value);
    e.target.value = v;
    // 值没变就什么都不做：浏览器会在失焦/重建时补发 change，
    // 早期实现里这种"重复事件"会把刚切换题库算好的配置又按旧值覆盖一遍。
    if (v === S.examTotal) return;
    S.examTotal = v;
    fitToTotal(v);
    saveBankExamCfg(); saveSettings(); renderExamCfg(true);
  });
  // 题量被手动改乱了、想重新按目标分凑齐时点这个（幂等：重复点结果一样）
  $('ecFit').addEventListener('click', () => {
    fitToTotal(S.examTotal);
    saveBankExamCfg(); saveSettings(); renderExamCfg(true);
  });
  $('examMin').addEventListener('change', e => {
    S.examMin = Math.max(5, Math.min(240, parseInt(e.target.value, 10) || 90));
    e.target.value = S.examMin;
    saveBankExamCfg(); saveSettings(); updateMaxScore();
  });
  $('startBtn').addEventListener('click', () => start());
}
function bindPractice() {
  $('prevBtn').addEventListener('click', prev);
  $('nextBtn').addEventListener('click', () => {
    if ($('nextBtn').dataset.act === 'check') checkCurrent();
    else next();
  });
  $('checkBtn').addEventListener('click', checkCurrent);
  $('quitBtn').addEventListener('click', () => {
    if (confirm('确定退出当前练习？进度已保存，可稍后继续。')) {
      pauseElapsed();          // 先停表再存快照 —— 这样快照里的用时才是"真正做题的时间"，不含退出后的空档
      saveSnapshot(); stopTimer(); stopElapsedTicker();
      $('practice').classList.add('hide'); $('home').classList.remove('hide');
      refreshStartActions();
      renderModeResumes();
      updateLibStats();
    }
  });
  $('sheetToggle').addEventListener('click', () => {
    const c = $('sheetCard'); c.classList.toggle('hide');
    const open = !c.classList.contains('hide');
    $('sheetToggle').classList.toggle('open', open);
    $('sheetArr').textContent = open ? '▴' : '▾';
    if (open) renderSheet();
  });
  // 标记笔：选「跳转」时点题号跳题；选某支笔/擦除时点题号只改标记
  document.querySelectorAll('#sheetPens .pen').forEach(b => b.addEventListener('click', () => {
    _markPen = b.dataset.pen;
    document.querySelectorAll('#sheetPens .pen').forEach(x => x.classList.toggle('on', x === b));
    const hint = $('sheetHint'); if (hint) hint.textContent = sheetHintText();
  }));
  $('sheetClearMarks').addEventListener('click', () => {
    if (!markCount()) return;
    if (!confirm('清空本题库的全部标记？（错题与练习进度不受影响）')) return;
    clearMarks(); renderSheet();
  });
}
function bindResult() {
  // 练习完成后只有**当前模式**的进度被清掉（showResult → clearProgress(S.mode)），
  // 其它模式若有未完成的进度，回首页仍会显示「继续练习」
  const backHome = () => {
    $('result').classList.add('hide'); $('home').classList.remove('hide');
    updateLibStats(); refreshStartActions(); renderModeResumes();
  };
  $('againBtn').addEventListener('click', backHome);
  $('quitBtn2').addEventListener('click', backHome);
  $('reviewWrong').addEventListener('click', () => { $('wrongWrap').classList.toggle('hide'); });
}

function applyUIFromState() {
  document.querySelectorAll('.mode').forEach(m => m.classList.toggle('active', m.dataset.mode === S.mode));
  document.querySelectorAll('#typeChips .chip').forEach(c => c.classList.toggle('active', !!S.types[c.dataset.t]));
  $('showAns').checked = S.showAns; $('rmAll').checked = S.rmAll; $('rmCorrectJudge').checked = S.rmCorrectJudge; $('revealAfter').checked = S.revealAfter; $('showAnalysis').checked = S.showAnalysis; $('autoRemoveWrong').checked = S.autoRemoveWrong;
  $('examMin').value = S.examMin;
  renderExamCfg(true);          // 题型行按当前题库动态生成 + 同步题量输入框
  updateMaxScore();
  $('examCfg').classList.toggle('hide', S.mode !== 'exam');
  if (S.mode === 'exam') { $('examCfgBody').classList.add('hide'); $('examCfgArr').textContent = '▸'; }
  updateFilterStat();
}
/**
 * 指定模式有未完成的练习进度时返回摘要，否则 null。
 * mode 省略时看当前选中的模式（每种模式各有一份进度，所以必须指定模式）。
 */
function resumeInfo(mode) {
  const p = loadProgress(mode || S.mode);
  if (!p || p.finished) return null;
  const total = Array.isArray(p.ids) ? p.ids.length : 0;
  if (!total) return null;
  const arr = Array.isArray(p.userAns) ? p.userAns : [];
  const answered = typeof p.answered === 'number'
    ? p.answered
    : arr.filter(a => a !== null && a !== undefined && !(Array.isArray(a) && a.length === 0)).length;
  return {
    at: Math.min((p.idx || 0) + 1, total),
    total: total,
    answered: answered,
    mode: p.mode || 'sequential'
  };
}

/**
 * 主操作区状态：
 *  - 无进度 → 只显示「开始练习」
 *  - 有未完成进度 → 换成「从头开始」+「继续练习」（继续练习为绿色）
 */
function refreshStartActions() {
  const info = resumeInfo();
  const act = $('startActions'), hint = $('startHint');
  if (!act) return;
  if (info) {
    $('startBtn').classList.add('hide');
    $('restartBtn').classList.remove('hide');
    $('continueBtn').classList.remove('hide');
    act.classList.add('with-resume');
    const modeName = MODE_NAME_SHORT[info.mode] || MODE_NAME_SHORT.sequential;
    hint.textContent = '上次练到第 ' + info.at + ' / ' + info.total + ' 题，已答 ' + info.answered + ' 题（' + modeName + '）';
    hint.classList.remove('hide');
  } else {
    $('startBtn').classList.remove('hide');
    $('restartBtn').classList.add('hide');
    $('continueBtn').classList.add('hide');
    act.classList.remove('with-resume');
    hint.textContent = '';
    hint.classList.add('hide');
  }
}

/**
 * 首页四张模式卡片各显示自己的进度（如「上次到第 12 / 60 题 · 已答 8」）。
 * 这是「每种模式的进度都记住了」的可见凭据 —— 用户不必逐个点进去找进度在哪。
 */
function renderModeResumes() {
  MODES.forEach(m => {
    const el = document.querySelector('.mode[data-mode="' + m + '"] .rs');
    if (!el) return;
    const info = resumeInfo(m);
    if (!info) { el.textContent = ''; el.classList.add('hide'); return; }
    el.innerHTML = '上次到第 <b>' + info.at + '</b> / ' + info.total + ' 题 · 已答 ' + info.answered + ' 题';
    el.classList.remove('hide');
  });
}

// 切换题库后刷新首页统计（不重复绑定事件）
export function refreshHomeUI() {
  updateFilterStat();
  updateLibStats();
  refreshStartActions();
  renderModeResumes();
  applyUIFromState();
}

// 切后台 / 关标签页时结算一次用时：不然"关页面前正在做的那道题"的时间会整段丢掉。
// 注意这里是 markElapsed（结算后继续跑）而不是 pauseElapsed —— 回到前台要接着累计。
// 只在练习页可见且未完成时动手，首页/结果页不碰。
function bindTimeHooks() {
  const settle = () => {
    if (!S.pool || !S.pool.length || S.finished) return;
    const p = $('practice');
    if (!p || p.classList.contains('hide')) return;
    markElapsed(); saveSnapshot();
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
  window.addEventListener('pagehide', settle);
}

let _inited = false;
export function initEngine() {
  loadSettings();
  // 四种模式都保留上次的选择：每种模式各有自己的进度，强行回退到顺序练习会让用户找不到刚练的那条
  if (MODES.indexOf(S.mode) < 0) S.mode = 'sequential';
  applyUIFromState();
  refreshStartActions();
  renderModeResumes();
  updateLibStats();
  if (!_inited) { bindHome(); bindPractice(); bindResult(); bindTimeHooks(); _inited = true; }
}

// 本地开发调试钩子（供 scripts/check_resume.mjs 端到端验收使用）。
// import.meta.env.DEV 在 vite build 时被替换为 false，整块会被打包器剔除，不会进生产包。
if (import.meta.env.DEV) {
  window.__exam = {
    setQuestions, initEngine, refreshHomeUI, start, snapshotProgress, setBankKey, renderExamCfg,
    examPlan, examFullScore, fitToTotal, availByType, S,
    renderSheet, markOf, setMark, markCount, clearMarks,
    usedMs, clockText, humanDuration, analysisStat,
    defaultPrefs: DEFAULT_PREFS, prefsKey, syncPrefsFromCloud, applySettings,
    // 「当前装的是哪个题库的题」——切题库的验收要断言这一点（QUESTIONS 会随 setQuestions 变）
    questions: () => QUESTIONS
  };
}
