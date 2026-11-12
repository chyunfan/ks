/**
 * 「每种练习模式都各自记住进度」端到端验收。
 *
 * 背景：原来的 progress 是个单值，在顺序练习练到一半、切去组卷模拟再存一次，
 * 前者就被覆盖没了。现在按模式各存一份（sequential / exam / wrong / fav）。
 * 这个脚本要证明的就是「互不覆盖」和「完成某模式只清它自己」——
 * 这两件事光读代码看不出来，必须真的在浏览器里走一遍。
 *
 * 用法：node scripts/check_modeprog.mjs
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const PW_CORE = process.env.PW_CORE
  || 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;
const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5213;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

/* ---------- 1. 起 dev server ---------- */
const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((res, rej) => {
  const t0 = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - t0 > 40000) { clearInterval(timer); rej(new Error('vite dev server 启动超时')); return; }
    try { const r = await fetch(URL_APP); if (r.ok) { clearInterval(timer); res(); } } catch (e) { /* 还没起来 */ }
  }, 400);
  srv.stderr.on('data', d => process.stderr.write(d));
});

/* ---------- 2. 打开页面、注入题库 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());   // 退出练习的 confirm 一律确认

await page.goto(URL_APP);
await page.waitForTimeout(1000);

// 6 道单选（全部答 B）：题量够撑起"各模式不同题号"，且不受「去除多选全选/去除正确判断题」影响
const FAKE = [1, 2, 3, 4, 5, 6].map(i => ({
  id: i, type: 'single', stem: '进度验收题 ' + i + '：' + i + '+' + i + ' = ?',
  options: [{ key: 'A', text: String(i * 2 - 1) }, { key: 'B', text: String(i * 2) }, { key: 'C', text: String(i * 2 + 1) }],
  answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null
}));

await page.evaluate(async (fake) => {
  if (!window.__exam || !window.__store) throw new Error('调试钩子未注入（dev 模式吗？）');
  Object.keys(localStorage)
    .filter(k => k.startsWith('ce_') || k.startsWith('credit_exam'))
    .forEach(k => localStorage.removeItem(k));
  await window.__store.loadBankState(null, false);
  window.__store.saveArr(window.__store.LS.wrong, [1, 2, 3]);   // 错题集 3 题
  window.__store.saveArr(window.__store.LS.fav, [4, 5]);        // 收藏 2 题
  window.__exam.setQuestions(fake);
  window.__exam.initEngine();
  document.getElementById('auth').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  document.getElementById('topBankName').textContent = '进度验收库';
  for (const s of ['banks', 'home', 'practice', 'result']) {
    document.getElementById(s).classList.toggle('hide', s !== 'home');
  }
  window.__exam.refreshHomeUI();
}, FAKE);

/* ---------- 3. 断言 ---------- */
const fails = [];
let n = 0;
const chk = (cond, name, extra) => { n++; if (!cond) fails.push(`T${n} ${name}${extra ? ' → ' + extra : ''}`); };

/** 当前会话/按钮状态 */
const snap = () => page.evaluate(() => ({
  mode: window.__exam.S.mode,
  idx: window.__exam.S.idx,
  pool: window.__exam.S.pool ? window.__exam.S.pool.length : 0,
  pcount: document.getElementById('pcount').textContent.trim(),
  homeShown: !document.getElementById('home').classList.contains('hide'),
  practiceShown: !document.getElementById('practice').classList.contains('hide'),
  start: !document.getElementById('startBtn').classList.contains('hide'),
  cont: !document.getElementById('continueBtn').classList.contains('hide'),
  restart: !document.getElementById('restartBtn').classList.contains('hide'),
  hint: document.getElementById('startHint').classList.contains('hide') ? '' : document.getElementById('startHint').textContent.trim()
}));

/** 四种模式各自存了什么（题号/总题数/已答） */
const prog = () => page.evaluate(() => {
  const m = window.__store.loadProgressMap(); const o = {};
  Object.keys(m).forEach(k => {
    o[k] = { idx: m[k].idx, total: Array.isArray(m[k].ids) ? m[k].ids.length : 0, answered: m[k].answered };
  });
  return o;
});

/** 首页四张卡片的进度行 */
const rsText = () => page.evaluate(() => {
  const o = {};
  ['sequential', 'exam', 'wrong', 'fav'].forEach(m => {
    const el = document.querySelector('.mode[data-mode="' + m + '"] .rs');
    o[m] = el ? { hide: el.classList.contains('hide'), text: el.textContent.replace(/\s+/g, ' ').trim() } : null;
  });
  return o;
});

const pickMode = async m => { await page.click('.mode[data-mode="' + m + '"]'); await page.waitForTimeout(180); };
const quit = async () => { await page.click('#quitBtn'); await page.waitForTimeout(250); };

/* ================= S1 顺序练习：练到第 4 题 ================= */
await pickMode('sequential');
await page.click('#startBtn');
await page.waitForTimeout(200);
await page.click('#nextBtn'); await page.waitForTimeout(100);
await page.click('#nextBtn'); await page.waitForTimeout(100);
await page.click('#nextBtn'); await page.waitForTimeout(150);
let s = await snap();
chk(s.mode === 'sequential' && s.idx === 3 && s.pcount === '第 4 / 6 题', 'S1 顺序练习走到第 4 题', JSON.stringify({ mode: s.mode, idx: s.idx, pcount: s.pcount }));
await quit();

let p = await prog();
chk(p.sequential && p.sequential.idx === 3 && p.sequential.total === 6, 'S1 顺序练习进度已按模式存下（第 4 / 6 题）', JSON.stringify(p.sequential));
let rs = await rsText();
chk(rs.sequential && !rs.sequential.hide && /第 4 \/ 6 题/.test(rs.sequential.text), 'S1 首页卡片显示顺序练习自己的进度', rs.sequential.text);
chk(rs.exam.hide && rs.wrong.hide && rs.fav.hide, 'S1 另外三种模式卡片暂无进度（不会张冠李戴）', JSON.stringify(rs));

/* ================= S2 错题练习：练到第 2 题，顺序练习不受影响 ================= */
await pickMode('wrong');
s = await snap();
chk(s.start && !s.cont, 'S2 切到错题练习：按钮是「开始练习」，没被顺序练习的进度顶掉', JSON.stringify({ start: s.start, cont: s.cont, hint: s.hint }));
await page.click('#startBtn');
await page.waitForTimeout(250);
s = await snap();
chk(s.mode === 'wrong' && s.pool === 3, 'S2 错题练习 pool = 错题集 3 题', JSON.stringify({ mode: s.mode, pool: s.pool }));
await page.click('#nextBtn');
await page.waitForTimeout(150);
await quit();

p = await prog();
chk(p.wrong && p.wrong.idx === 1, 'S2 错题练习自己的进度（第 2 题）', JSON.stringify(p.wrong));
chk(p.sequential && p.sequential.idx === 3, 'S2 ⭐ 顺序练习的进度没被覆盖（仍是第 4 题）', JSON.stringify(p.sequential));

/* ================= S3 切回顺序练习 → 继续练习恢复第 4 题 ================= */
await pickMode('sequential');
s = await snap();
chk(s.cont && s.restart && !s.start, 'S3 切回顺序练习：主按钮变「继续练习 / 从头开始」', JSON.stringify({ cont: s.cont, restart: s.restart, start: s.start }));
chk(/第 4 \/ 6 题/.test(s.hint) && /顺序练习/.test(s.hint), 'S3 提示写明「顺序练习 · 第 4 / 6 题」', s.hint);
await page.click('#continueBtn');
await page.waitForTimeout(300);
s = await snap();
chk(s.mode === 'sequential' && s.idx === 3 && s.pcount === '第 4 / 6 题', 'S3 继续练习恢复到该模式自己的第 4 题（不是从头）', JSON.stringify({ mode: s.mode, idx: s.idx, pcount: s.pcount }));
await quit();

/* ================= S4 收藏练习 ================= */
await pickMode('fav');
s = await snap();
chk(s.start && !s.cont, 'S4 收藏练习同样从「开始练习」起（它还没进度）', JSON.stringify({ start: s.start, cont: s.cont }));
await page.click('#startBtn');
await page.waitForTimeout(250);
s = await snap();
chk(s.mode === 'fav' && s.pool === 2, 'S4 收藏练习 pool = 收藏的 2 题', JSON.stringify({ mode: s.mode, pool: s.pool }));
await page.click('#nextBtn');
await page.waitForTimeout(150);
await quit();

/* ================= S5 组卷模拟考试 ================= */
await pickMode('exam');
await page.click('#startBtn');
await page.waitForTimeout(400);
s = await snap();
chk(s.mode === 'exam' && s.pool > 0, 'S5 组卷模拟考试能开考', JSON.stringify({ mode: s.mode, pool: s.pool }));
await quit();

p = await prog();
chk(Object.keys(p).sort().join() === 'exam,fav,sequential,wrong', 'S5 ⭐ 四种模式各存一份进度，互不覆盖', Object.keys(p).sort().join());
chk(p.fav && p.fav.idx === 1, 'S5 收藏练习进度仍在（第 2 题）', JSON.stringify(p.fav));
rs = await rsText();
chk(['sequential', 'exam', 'wrong', 'fav'].every(m => rs[m] && !rs[m].hide), 'S5 首页四张卡片各自显示进度', JSON.stringify(rs));

/* ================= S6 错题集 / 收藏回顾弹窗也显示该模式的进度 ================= */
await page.click('#wrongLibBtn');
await page.waitForTimeout(250);
let lib = await page.evaluate(() => {
  const el = document.querySelector('#libBody .lib-resume');
  return { text: el ? el.textContent.replace(/\s+/g, ' ').trim() : '', title: document.getElementById('libTitle').textContent.trim() };
});
chk(/第 2 \/ 3 题/.test(lib.text), 'S6 错题集回顾弹窗顶部提示该模式的进度', JSON.stringify(lib));
await page.click('#libClose');
await page.waitForTimeout(200);

await page.click('#favLibBtn');
await page.waitForTimeout(250);
lib = await page.evaluate(() => {
  const el = document.querySelector('#libBody .lib-resume');
  return { text: el ? el.textContent.replace(/\s+/g, ' ').trim() : '' };
});
chk(/第 2 \/ 2 题/.test(lib.text), 'S6 收藏回顾弹窗同样显示自己的进度（第 2 / 2 题）', lib.text);
await page.click('#libClose');
await page.waitForTimeout(200);

/* ================= S7 走完顺序练习：只清它自己那一份 ================= */
await pickMode('sequential');
await page.click('#continueBtn');
await page.waitForTimeout(300);
await page.click('#nextBtn'); await page.waitForTimeout(150);   // 第 5 题
await page.click('#nextBtn'); await page.waitForTimeout(150);   // 第 6 题
await page.click('#nextBtn'); await page.waitForTimeout(500);   // 完成 → 结果页
const resShown = await page.evaluate(() => !document.getElementById('result').classList.contains('hide'));
chk(resShown, 'S7 顺序练习走完进入结果页', String(resShown));

p = await prog();
chk(!p.sequential, 'S7 ⭐ 顺序练习完成后只清它自己那份进度', Object.keys(p).join());
chk(!!p.wrong && !!p.fav && !!p.exam, 'S7 错题 / 收藏 / 组卷三种模式的进度都还在', Object.keys(p).sort().join());

await page.click('#quitBtn2');
await page.waitForTimeout(300);
rs = await rsText();
chk(rs.sequential.hide && !rs.wrong.hide && !rs.fav.hide && !rs.exam.hide, 'S7 首页：只有顺序练习卡片的进度被清掉', JSON.stringify(rs));
s = await snap();
chk(s.start && !s.cont, 'S7 当前是顺序练习且无进度 → 按钮回到「开始练习」', JSON.stringify({ start: s.start, cont: s.cont }));

await pickMode('wrong');
s = await snap();
chk(s.cont && /错题练习/.test(s.hint), 'S7 切到错题练习：它的进度还在，主按钮是「继续练习」', s.hint);

/* ================= S8 落盘结构 ================= */
const ls = await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('credit_exam_progress') || 'null');
  return {
    v: raw && raw.v,
    keys: raw && raw.byMode ? Object.keys(raw.byMode).sort() : [],
    legacyShape: !!(raw && raw.ids)
  };
});
chk(ls.v === 4, 'S8 本地落盘用的是 v4（按模式 + 标记表）结构', JSON.stringify(ls));
chk(ls.keys.join() === 'exam,fav,wrong', 'S8 落盘里正好是剩下这三种模式（顺序练习已清）', ls.keys.join());
chk(!ls.legacyShape, 'S8 落盘里不再有旧的单对象形态', String(ls.legacyShape));

/* ================= S9 旧版单对象进度能自动迁移（升级不丢进度） ================= */
const migrated = await page.evaluate(async () => {
  const legacy = {
    v: 2, mode: 'fav', ids: [4, 5], idx: 1,
    userAns: [1, null], revealed: [false, false], answered: 1, total: 2, updatedAt: Date.now()
  };
  localStorage.setItem('credit_exam_progress', JSON.stringify(legacy));
  await window.__store.loadBankState(null, false);     // 模拟重新进题库
  const m = window.__store.loadProgressMap();
  return { keys: Object.keys(m).sort(), favIdx: m.fav ? m.fav.idx : null, hasSeq: !!m.sequential };
});
chk(migrated.keys.join() === 'fav', 'S9 ⭐ 旧版单对象进度被迁移到它自己的模式（fav）', JSON.stringify(migrated));
chk(migrated.favIdx === 1, 'S9 迁移后题号保留（第 2 题）', String(migrated.favIdx));
chk(!migrated.hasSeq, 'S9 迁移不会凭空造出别的模式', String(migrated.hasSeq));

/* ================= S10 手机端：多一行进度也不溢出 ================= */
await page.setViewportSize({ width: 375, height: 812 });
await page.evaluate(async () => {
  const mk = (mode, total, idx) => ({
    v: 2, mode, ids: [1, 2, 3, 4, 5, 6].slice(0, total), idx,
    userAns: [], revealed: [], answered: idx, total, updatedAt: Date.now()
  });
  const byMode = { sequential: mk('sequential', 6, 2), exam: mk('exam', 6, 1), wrong: mk('wrong', 3, 1), fav: mk('fav', 2, 1) };
  localStorage.setItem('credit_exam_progress', JSON.stringify({ v: 3, byMode }));
  await window.__store.loadBankState(null, false);
  window.__exam.refreshHomeUI();
});
await page.waitForTimeout(300);
const mob = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.mode')];
  return {
    clientW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    shown: cards.filter(c => { const e = c.querySelector('.rs'); return e && !e.classList.contains('hide'); }).length,
    cards: cards.length,
    maxRight: Math.round(Math.max(...cards.map(c => c.getBoundingClientRect().right)))
  };
});
chk(mob.shown === 4 && mob.cards === 4, 'S10 375px：四张卡片都显示进度行', JSON.stringify(mob));
chk(mob.scrollW <= mob.clientW, 'S10 375px：多了进度行后仍无横向溢出', mob.scrollW + ' > ' + mob.clientW);
chk(mob.maxRight <= mob.clientW, 'S10 375px：卡片右边界没有越界', mob.maxRight + ' > ' + mob.clientW);
await page.screenshot({ path: path.join(SHOTS, 'modeprog-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 700 } });

await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(SHOTS, 'modeprog-desktop.png'), clip: { x: 0, y: 0, width: 1100, height: 620 } });

chk(jsErrors.length === 0, 'S11 全程无 JS 报错', jsErrors.join(' | '));

/* ---------- 收尾 ---------- */
await browser.close();
srv.kill();

console.log(`\n按模式记进度：${n - fails.length} / ${n} 通过`);
if (fails.length) {
  console.log('未通过：');
  fails.forEach(f => console.log('   · ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过（截图见 shots/modeprog-*.png）');
}
