import { WUBI } from './wubi.js';
import { supabase, getUserId } from './supabase.js';
import { getUsername } from './auth.js';

// ============================================================
// 打字练习引擎（云题库内置版）
// ------------------------------------------------------------
// 与独立单文件版（typing-practice/打字练习.html）同一套交互：
//   · 上行原文、下行跟打，逐字对齐（每字一个等宽格子，上下共用同一套宽度）
//   · 光标停在「下一个待打字的前面」闪；打错标红划线，退格可逐字删改重打
//   · 五笔编码提示可勾选、限时默认 5 分钟、暂停不计时、已打正确字数实时显示
// 差别在于字库来自云端（exam_hzk）、成绩写入云端（exam_typing_records）。
//
// 本模块只管「练习」本身；字库的增删改查在 hzk.js，屏幕切换在 main.js。
// ============================================================

const $ = id => document.getElementById(id);

const FONTS = {
  simsun: '"SimSun","宋体",serif',
  kaiti: '"KaiTi","楷体","STKaiti",serif',
  heiti: '"SimHei","黑体",sans-serif',
  yahei: '"Microsoft YaHei","微软雅黑",sans-serif'
};
const PER_LINES = [16, 20, 24, 28, 35, 40];

/* ---------- 练习参数（跟设备走，不进云端） ---------- */
const PKEY = 'ce_typing_prefs';
const PDEFAULTS = { font: 'simsun', view: 'all', perLine: 35, hintOn: true, limitOn: true, limitMin: 5 };
function loadPrefs() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(PKEY)) || {}; } catch (e) { }
  return Object.assign({}, PDEFAULTS, s);
}
function savePrefs() {
  try {
    localStorage.setItem(PKEY, JSON.stringify({
      font: $('tpFontSel').value,
      view: $('tpViewSel').value,
      perLine: parseInt($('tpPerLine').value, 10) || 35,
      hintOn: $('tpHintOn').checked,
      limitOn: $('tpLimitOn').checked,
      limitMin: parseInt($('tpLimitMin').value, 10) || 5
    }));
  } catch (e) { }
}
export function resetTypingPrefs() {
  try { localStorage.removeItem(PKEY); } catch (e) { }
}
/** 供字库导入弹窗取默认「每行字数」 */
export function getTypingPrefs() { return Object.assign({}, prefs); }

/* ---------- 状态 ---------- */
let lines = [];              // [{ chars: [...], typed: [null | {ch, ok}] }]
let lineIdx = 0, charIdx = 0;
let totalChars = 0, okCount = 0, errCount = 0, typedCount = 0, errMap = {};
let startTime = null, endTime = null, paused = false, pauseStart = 0, pausedTotal = 0;
let timerId = null, started = false, finished = false;
let curHz = null;            // { id, name, perLine }
let prefs = loadPrefs();
let inited = false;
let onExit = null;

const ghost = () => $('tpGhost');
const articleEl = () => $('tpArticle');
const linesEl = () => $('tpLines');

/* ============================================================
   ｜ 载入与布局
   ============================================================ */
export function startTyping(hzk) {
  if (!inited) initTyping({});
  curHz = { id: hzk.id, name: hzk.name, perLine: parseInt(hzk.perLine, 10) || 35 };
  curHzText = String(hzk.text || '');
  $('tpHzkName').textContent = hzk.name + (hzk.source === 'admin' ? ' · 管理员上传' : '');
  // 每行字数下拉：常用档位 + 该字库自己那一档（老数据里可能是别的值，别让它选不出来）
  const opts = PER_LINES.slice();
  if (opts.indexOf(curHz.perLine) < 0) { opts.push(curHz.perLine); opts.sort((a, b) => a - b); }
  $('tpPerLine').innerHTML = opts.map(n => '<option value="' + n + '">' + n + '</option>').join('');
  $('tpPerLine').value = String(curHz.perLine);
  loadText(curHzText, curHz.perLine);
  // 刚切到本屏时容器宽度可能还没量到，下一帧按真实宽度重排一次
  requestAnimationFrame(() => { layout(); render(); });
}

function loadText(text, perLine) {
  const clean = String(text || '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean).join('');
  lines = [];
  for (let i = 0; i < clean.length; i += perLine) {
    const chars = Array.from(clean.slice(i, i + perLine));
    lines.push({ chars, typed: new Array(chars.length).fill(null) });
  }
  resetSession();
  layout();
  render();
}

function resetSession() {
  lineIdx = 0; charIdx = 0;
  totalChars = lines.reduce((s, l) => s + l.chars.length, 0);
  lines.forEach(l => l.typed.fill(null));
  okCount = 0; errCount = 0; typedCount = 0; errMap = {};
  startTime = null; endTime = null; started = false; finished = false;
  paused = false; pauseStart = 0; pausedTotal = 0;
  clearInterval(timerId); timerId = null;
  const p = $('tpPause');
  if (p) p.textContent = '⏸ 暂停';
  updateStats();
}

/** 按最长行自适应单字宽度：上下两行共用 --cw，逐字对齐 */
function layout() {
  const n = Math.max(1, ...lines.map(l => l.chars.length));
  const avail = Math.max(320, (articleEl() ? articleEl().clientWidth : 900) - 90);
  const cw = Math.max(15, Math.min(30, Math.floor(avail / n)));
  const el = linesEl();
  if (!el) return;
  el.style.setProperty('--cw', cw + 'px');
  el.style.setProperty('--fs', Math.round(cw * 0.92) + 'px');
}

/* ============================================================
   ｜ 渲染
   ============================================================ */
function render() {
  const el = linesEl();
  if (!el) return;
  const single = $('tpViewSel').value === 'single';
  el.innerHTML = '';
  const show = single ? [lineIdx] : lines.map((_, i) => i);

  show.forEach(li => {
    const L = lines[li];
    if (!L) return;
    const block = document.createElement('div');
    block.className = 'tp-block' + (li === lineIdx ? ' active' : (li < lineIdx ? ' passed' : ''));
    block.dataset.li = li;

    const src = document.createElement('div');
    src.className = 'tp-row src';
    const inp = document.createElement('div');
    inp.className = 'tp-row inp';

    L.chars.forEach((ch, i) => {
      const t = L.typed[i];
      const cs = document.createElement('span');
      cs.className = 'tp-cell' + (li === lineIdx && t && !t.ok ? ' err' : '');
      cs.textContent = ch;
      src.appendChild(cs);

      const ci = document.createElement('span');
      if (li === lineIdx && i === charIdx) {
        ci.className = 'tp-cell caret';
        ci.id = 'tpCaretCell';
        const bar = document.createElement('i');
        bar.className = 'tp-caret-bar';
        ci.appendChild(bar);
      } else if (t) {
        ci.className = 'tp-cell ' + (t.ok ? 'ok' : 'err');
        ci.textContent = t.ch;
      } else {
        ci.className = 'tp-cell blank';
        ci.textContent = '　';
      }
      inp.appendChild(ci);
    });

    block.appendChild(src);
    block.appendChild(inp);
    block.addEventListener('click', () => { if (!finished) jumpToLine(li); });
    el.appendChild(block);

    if (single && li + 1 < lines.length) {
      const hint = document.createElement('div');
      hint.className = 'tp-next-hint';
      hint.textContent = '下一行：' + lines[li + 1].chars.join('');
      el.appendChild(hint);
    }
  });

  positionGhost();
  updateHint();
  if (!paused) ghost().focus({ preventScroll: true });
}

/** 隐形输入框（中文输入法候选窗的锚点）贴在光标格上 */
function positionGhost() {
  const cell = $('tpCaretCell');
  const g = ghost(), art = articleEl();
  if (!cell || !g || !art) return;
  const cr = cell.getBoundingClientRect(), ar = art.getBoundingClientRect();
  g.style.left = (cr.left - ar.left + art.scrollLeft) + 'px';
  g.style.top = (cr.top - ar.top + art.scrollTop) + 'px';
  g.style.height = (cell.offsetHeight || 34) + 'px';
}

/* ============================================================
   ｜ 编码提示
   ============================================================ */
/** 「编码提示」前的勾选框：取消勾选就把编码文字收起来（标签仍在，方便再勾回来） */
function applyHint() {
  const wrap = $('tpHintWrap');
  if (wrap) wrap.classList.toggle('off', !$('tpHintOn').checked);
}
function updateHint() {
  const L = lines[lineIdx];
  const ch = L && L.chars[charIdx];
  const code = ch ? WUBI[ch] : null;
  $('tpHintChar').textContent = ch || '';
  $('tpHintCode').textContent = ch ? (code || '—') : '—';
  $('tpHintAlt').textContent = (ch && !code) ? '(无编码)' : '';
}

/* ============================================================
   ｜ 输入
   ============================================================ */
function handleChar(ch) {
  if (finished || paused) return;
  const L = lines[lineIdx];
  if (!L || charIdx >= L.chars.length) return;
  if (!started) startTimer();
  const target = L.chars[charIdx];
  L.typed[charIdx] = { ch, ok: ch === target };
  charIdx++;
  if (charIdx >= L.chars.length) { nextLine(); return; }
  recount(); updateStats(); render();
}

/** 退格：逐字删除重打；行首再删则退回上一行末尾 */
function backspace() {
  if (finished || paused) return;
  if (charIdx > 0) {
    charIdx--;
    lines[lineIdx].typed[charIdx] = null;
  } else if (lineIdx > 0) {
    lineIdx--;
    const L = lines[lineIdx];
    charIdx = L.chars.length - 1;
    L.typed[charIdx] = null;
  } else return;
  recount(); updateStats(); render();
}

function nextLine() {
  lineIdx++; charIdx = 0;
  if (lineIdx >= lines.length) {
    lineIdx = lines.length - 1;
    charIdx = lines[lineIdx].chars.length;   // 光标停在行尾，别弹回行首
    // 先把刚打下的最后一个字算进去再结算，否则末字会漏算（出现过 16/17）
    recount(); updateStats();
    finish(false); return;
  }
  const el = linesEl().querySelector('.tp-block[data-li="' + lineIdx + '"]');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  recount(); updateStats(); render();
}

function jumpToLine(li) {
  if (li === lineIdx) return;
  lineIdx = li; charIdx = 0;
  render();
  const el = linesEl().querySelector('.tp-block[data-li="' + li + '"]');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** 统计一律由 typed 数组全量重算：删改后数字自动回正 */
function recount() {
  okCount = 0; errCount = 0; typedCount = 0; errMap = {};
  lines.forEach(L => L.typed.forEach((t, i) => {
    if (!t) return;
    typedCount++;
    if (t.ok) okCount++;
    else { errCount++; const c = L.chars[i]; errMap[c] = (errMap[c] || 0) + 1; }
  }));
}

/* ============================================================
   ｜ 计时与状态栏
   ============================================================ */
function startTimer() { started = true; startTime = Date.now(); timerId = setInterval(tick, 300); }
function elapsedSec() {
  if (!startTime) return 0;
  const end = endTime || Date.now();
  return Math.max(0, (end - startTime - pausedTotal) / 1000);
}
function tick() {
  if (paused || finished) return;
  updateStats();
  if ($('tpLimitOn').checked) {
    const limit = (parseInt($('tpLimitMin').value, 10) || 5) * 60;
    if (elapsedSec() >= limit) finish(true);
  }
}
function fmt(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  return [h, m, s].map(x => String(x).padStart(2, '0')).join(':');
}
function updateStats() {
  const sec = elapsedSec(), min = sec / 60;
  $('tpStTime').textContent = fmt(sec);
  $('tpStSpeed').textContent = (min > 0.02 ? Math.round(okCount / min) : 0) + '字/分';
  $('tpStOk').textContent = okCount;
  $('tpStProg').textContent = totalChars ? Math.round(typedCount / totalChars * 100) + '%' : '0%';
  $('tpStAcc').textContent = typedCount ? Math.round(okCount / typedCount * 100) + '%' : '100%';
}

/* ============================================================
   ｜ 结算 + 写入云端练习记录
   ============================================================ */
async function finish(byTimeout) {
  if (finished) return;
  finished = true; endTime = Date.now();
  clearInterval(timerId);
  // 秒数至少记 1 秒：否则极短的练习会被算成 0 秒，速度除零、记录也没意义
  const sec = Math.max(1, Math.round(elapsedSec()));
  const speed = Math.round(okCount / (sec / 60));
  const acc = typedCount ? Math.round(okCount / typedCount * 100) : 100;

  $('tpResTitle').textContent = byTimeout ? '⏰ 时间到！' : '练习完成 🎉';
  $('tpResTime').textContent = fmt(sec);
  $('tpResSpeed').textContent = speed;
  $('tpResAcc').textContent = acc + '%';
  $('tpResChars').textContent = typedCount + ' / ' + totalChars;
  // 状态栏也刷成结算口径，别停在计时器最后一次 tick 的旧值上
  updateStats();
  $('tpStTime').textContent = fmt(sec);
  $('tpStSpeed').textContent = speed + '字/分';
  const errs = Object.entries(errMap).sort((a, b) => b[1] - a[1]);
  $('tpErrBox').classList.toggle('hide', !errs.length);
  $('tpErrList').textContent = errs.map(([c, n]) => c + '×' + n).join('　');
  $('tpResMsg').textContent = '正在保存练习记录…';
  $('tpResModal').classList.remove('hide');
  ghost().blur();

  if (!totalChars) { $('tpResMsg').textContent = '未产生有效数据，本次不记录。'; return; }
  const rec = {
    user_id: getUserId(),
    owner_name: getUsername() || null,
    hzk_id: curHz ? curHz.id : null,
    hzk_name: curHz ? curHz.name : null,
    per_line: curHz ? curHz.perLine : 35,
    total: totalChars,
    ok: okCount,
    wrong: typedCount - okCount,
    seconds: sec,
    speed, acc,
    timed_out: !!byTimeout
  };
  if (!rec.user_id) { $('tpResMsg').textContent = '登录状态丢失，本次成绩未保存。'; return; }
  const { error } = await supabase.from('exam_typing_records').insert(rec);
  $('tpResMsg').textContent = error ? '保存失败：' + error.message : '已保存到练习记录。';
}

/* ============================================================
   ｜ 初始化与事件
   ============================================================ */
export function initTyping(cb) {
  onExit = (cb && cb.onExit) || onExit;
  if (inited) return;
  inited = true;

  const g = $('tpGhost');
  g.addEventListener('compositionstart', () => { g.composing = true; });
  g.addEventListener('compositionend', () => {
    g.composing = false;
    const v = g.value; g.value = '';
    for (const ch of v) handleChar(ch);
  });
  g.addEventListener('input', () => {
    if (g.composing) return;
    const v = g.value; g.value = '';
    for (const ch of v) handleChar(ch);
  });
  g.addEventListener('keydown', e => {
    if (e.isComposing || g.composing) return;
    if (e.key === 'Backspace') { e.preventDefault(); backspace(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (started && !finished) { charIdx = lines[lineIdx].chars.length; nextLine(); }
    }
  });

  $('tpPause').addEventListener('click', () => {
    if (finished || !started) return;
    if (!paused) {
      paused = true; pauseStart = Date.now();
      $('tpPause').textContent = '▶ 继续';
      ghost().blur();
    } else {
      paused = false; pausedTotal += Date.now() - pauseStart;
      $('tpPause').textContent = '⏸ 暂停';
      render();
    }
  });
  $('tpRestart').addEventListener('click', () => { resetSession(); render(); });
  $('tpStop').addEventListener('click', () => {
    if (finished) return;
    if (!started) { if (onExit) onExit(); return; }
    if (confirm('结束本次练习并保存成绩？')) finish(false);
  });
  $('tpBack').addEventListener('click', () => { if (onExit) onExit(); });

  $('tpFontSel').addEventListener('change', () => {
    linesEl().style.setProperty('--font', FONTS[$('tpFontSel').value] || FONTS.simsun);
    savePrefs(); render();
  });
  $('tpViewSel').addEventListener('change', () => { savePrefs(); render(); });
  $('tpHintOn').addEventListener('change', () => { applyHint(); savePrefs(); updateHint(); ghost().focus({ preventScroll: true }); });
  $('tpLimitOn').addEventListener('change', () => { savePrefs(); tick(); });
  $('tpLimitMin').addEventListener('change', savePrefs);
  // 每行字数只影响本机本次练习，不回写字库（避免悄悄改掉别人看到的分行）
  $('tpPerLine').addEventListener('change', () => {
    savePrefs();
    if (curHz) loadText(curHzText || '', parseInt($('tpPerLine').value, 10) || 35);
  });

  $('tpResClose').addEventListener('click', () => $('tpResModal').classList.add('hide'));
  $('tpResAgain').addEventListener('click', () => { $('tpResModal').classList.add('hide'); resetSession(); render(); });

  // 点空白处把焦点还给输入框（只在练习屏、且没弹窗时）
  document.addEventListener('click', e => {
    if (!isTypingVisible()) return;
    if (e.target.closest('button,select,input,label,#tpResModal')) return;
    if (!$('tpResModal').classList.contains('hide') || paused) return;
    ghost().focus({ preventScroll: true });
  }, true);

  window.addEventListener('resize', () => {
    if (!isTypingVisible()) return;
    layout(); render();
  });

  // 应用当前保存的练习参数
  $('tpPerLine').innerHTML = PER_LINES.map(n => '<option value="' + n + '">' + n + '</option>').join('');
  $('tpFontSel').value = prefs.font;
  $('tpViewSel').value = prefs.view;
  $('tpHintOn').checked = prefs.hintOn !== false;
  applyHint();
  $('tpLimitOn').checked = prefs.limitOn !== false;
  $('tpLimitMin').value = String(prefs.limitMin || 5);
  linesEl().style.setProperty('--font', FONTS[prefs.font] || FONTS.simsun);
}

let curHzText = '';
/** 进练习屏前由 hzk.js 调用，记下原始正文（切换每行字数时重切用） */
export function setTypingText(text) { curHzText = text; }

export function isTypingVisible() {
  const el = $('typing');
  return !!el && !el.classList.contains('hide');
}

// 验收脚本用的调试出口（vite build 时整块剔除，不进生产包）
if (import.meta.env.DEV) {
  window.__typing = {
    state: () => ({
      lineIdx, charIdx, lines: lines.length, totalChars,
      okCount, errCount, typedCount, started, finished, paused,
      name: curHz && curHz.name
    }),
    finish,
    loadText
  };
}
