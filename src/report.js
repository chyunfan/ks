import { loadAnswers, loadExams } from './store.js';
import { getQuestions, judgeAnswer } from './engine.js';

// ============================================================
// 我的报告（个人视角）
// ------------------------------------------------------------
// 两块内容：
//   ① 本库练习正确率：做过多少题、还有多少题没做到过、正确率多少
//   ② 模拟考试历次成绩：每一场考了多少分、对了几题、用了多久
//
// 数据全在本机 → **不发任何请求**：
//   · answers（累计作答账本）是跨轮次累积的，练完清进度也不会掉数；
//   · exams（考试场次账本）是 v2.31 新加的，交卷那一刻写一条。
//
// 判分不在这里另写一份：直接用 engine 的 judgeAnswer —— 练习页、个人报告、
// 服务端统计（api/admin-stats.js）三处口径必须一致，任何一处漂移都会让用户
// 看到「我自己算的对，系统算的不对」。
// ============================================================

let getBank = () => ({ id: '', name: '' });
let curBank = { id: '', name: '' };

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 正确率配色，与管理员「做题情况」、做题排行保持一致 */
function rateCls(rate, n) {
  if (!n) return 'muted';
  if (rate >= 80) return 'rate-good';
  if (rate >= 60) return 'rate-mid';
  return 'rate-bad';
}

/** 单场用时：mm:ss（超过 1 小时显示 h:mm:ss，考试通常不会这么长） */
function shortDur(ms) {
  const t = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const p = n => (n < 10 ? '0' : '') + n;
  return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
}

function fmtWhen(at) {
  const d = new Date(Number(at) || 0);
  if (!(d.getTime() > 0)) return '—';
  const p = n => (n < 10 ? '0' : '') + n;
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 本库练习统计（纯本地）。
 *  · total    = 当前题库题目总数
 *  · answered = 累计账本里**且仍在题库中**的不重复题数（题库重新导入过时，
 *               账本里会残留已不存在的题号，那些不算「做过」）
 *  · notDone  = total − answered（还没做到过的题）
 *  · rate     = 答对 ÷ answered（没做的题不进分母 —— 与管理员统计同口径）
 */
export function localStats() {
  const qs = getQuestions() || [];
  const ans = loadAnswers() || {};
  let answered = 0, correct = 0;
  qs.forEach(q => {
    if (!q || q.id === undefined) return;
    const k = String(q.id);
    if (!Object.prototype.hasOwnProperty.call(ans, k)) return;
    answered++;
    if (judgeAnswer(q, ans[k])) correct++;
  });
  const total = qs.length;
  return {
    total,
    answered,
    correct,
    notDone: Math.max(0, total - answered),
    rate: answered ? Math.round(correct / answered * 100) : 0,
    coverage: total ? Math.round(answered / total * 100) : 0
  };
}

/**
 * 考试场次汇总。
 * **按得分率（折百分制）比较**，不按绝对分 —— 组卷满分可以调，满 100 分和满 60 分的
 * 两场直接比绝对分没有意义。
 */
export function examSummary(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return { count: 0, avg: 0, best: 0, last: null };
  let sum = 0, best = 0;
  arr.forEach(e => {
    const full = Number(e.full) || 100;
    const pct = full > 0 ? (Number(e.score) || 0) / full * 100 : 0;
    sum += pct;
    if (pct > best) best = pct;
  });
  return {
    count: arr.length,
    avg: Math.round(sum / arr.length * 10) / 10,
    best: Math.round(best * 10) / 10,
    last: arr[0] || null            // loadExams 新的在前
  };
}

export function initReport(cb) {
  if (cb && typeof cb.getBank === 'function') getBank = cb.getBank;
  const entry = $('reportEntry');
  if (entry) entry.addEventListener('click', openReport);
  const c = $('reportClose'); if (c) c.addEventListener('click', closeReport);
  const m = $('reportMask'); if (m) m.addEventListener('click', closeReport);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeReport(); });
  refreshReportEntry();
}

/** 切换题库时调用（幂等）：换库要关掉旧弹层，并刷新入口副标题 */
export function setReportBank(id, name) {
  const next = { id: id || '', name: name || '' };
  if (curBank.id && curBank.id !== next.id) closeReport();
  curBank = next;
  refreshReportEntry();
}

/** 入口副标题：已做多少 / 正确率（本机算，不发请求） */
export function refreshReportEntry() {
  const hint = $('reportHint');
  if (!hint) return;
  const s = localStats();
  if (!s.answered) {
    hint.textContent = s.total
      ? '本库共 ' + s.total + ' 题，做完就会记下正确率'
      : '做完题后可以在这里看正确率与考试成绩';
    return;
  }
  hint.textContent = '已做 ' + s.answered + ' / ' + s.total + ' · 正确率 ' + s.rate + '%';
}

function closeReport() {
  const m = $('reportModal');
  if (m && !m.classList.contains('hide')) m.classList.add('hide');
}

function openReport() {
  const bank = getBank() || {};
  if (bank.id) curBank = { id: bank.id, name: bank.name || '' };
  $('reportModal').classList.remove('hide');
  $('reportBankName').textContent = curBank.name || '当前题库';
  renderReport();
}

function renderReport() {
  const s = localStats();
  const exams = loadExams();
  const es = examSummary(exams);

  // ① 练习正确率
  $('reportStats').innerHTML =
    '<div class="stat"><b>' + s.answered + '</b><span>已做过</span></div>' +
    '<div class="stat"><b>' + s.notDone + '</b><span>没做到过</span></div>' +
    '<div class="stat"><b class="' + rateCls(s.rate, s.answered) + '">' + (s.answered ? s.rate + '%' : '—') + '</b><span>正确率</span></div>' +
    '<div class="stat"><b>' + s.total + '</b><span>题库总题数</span></div>';

  const cov = Math.max(0, Math.min(100, s.coverage));
  $('reportBarWrap').innerHTML =
    '<div class="rp-bar"><i style="width:' + cov + '%"></i></div>' +
    '<div class="rp-bar-txt">覆盖 <b>' + cov + '%</b>' +
      '<span class="muted">（' + s.answered + ' / ' + s.total + ' 题，答对 ' + s.correct + ' 题）</span></div>';

  // ② 模拟考试历次成绩
  $('reportExamSum').innerHTML =
    '<div class="rs"><b>' + es.count + '</b><span>考试次数</span></div>' +
    '<div class="rs"><b class="' + rateCls(es.avg, es.count) + '">' + (es.count ? es.avg : '—') + '</b><span>平均分</span></div>' +
    '<div class="rs"><b class="' + rateCls(es.best, es.count) + '">' + (es.count ? es.best : '—') + '</b><span>最高分</span></div>';

  if (!es.count) {
    $('reportExamList').innerHTML =
      '<div class="muted rp-msg">还没有模拟考试记录。做一次「模拟考试」，交卷后这里就会记下成绩。</div>';
    $('reportExamTip').classList.add('hide');
    return;
  }

  $('reportExamList').innerHTML = exams.map(e => {
    const full = Number(e.full) || 100;
    const pct = full > 0 ? Math.round((Number(e.score) || 0) / full * 100) : 0;
    return '<div class="rp-exam">' +
      '<div class="rp-exam-when">' + fmtWhen(e.at) +
        (e.auto ? '<span class="rp-auto">自动</span>' : '') + '</div>' +
      '<div class="rp-exam-score"><b class="' + rateCls(pct, 1) + '">' + e.score + '</b>' +
        '<span class="rp-full"> / ' + full + '</span></div>' +
      '<div class="rp-exam-meta">对 ' + e.right + ' / ' + e.total + ' 题 · 用时 ' + shortDur(e.ms) + '</div>' +
    '</div>';
  }).join('');

  $('reportExamTip').classList.remove('hide');
  $('reportExamTip').textContent = '平均分 / 最高分按得分率折算成百分制（组卷满分可调，直接比绝对分不公平）。';
}

// 本地开发调试钩子（生产构建会被剔除），供 scripts/check_report.mjs 验收
if (import.meta.env.DEV) {
  window.__report = { open: openReport, close: closeReport, localStats, examSummary, refreshEntry: refreshReportEntry };
}
