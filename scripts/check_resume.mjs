/**
 * 「退出后继续练习」端到端验收。
 *
 * 为什么不用 dist 单文件：单文件里模块被打包，外部无法注入题库；
 * 而且本地构建没有 .env（Supabase 变量为空）。
 * 所以这里起一个本地 vite dev server，借 engine.js / store.js 里的
 * `import.meta.env.DEV` 调试钩子（window.__exam / window.__store）注入 3 道假题，
 * 全程走真实 UI 点击，验证：进度快照 → 首页双按钮 → 继续练习恢复到原题号/原选项。
 *
 * 用法：node scripts/check_resume.mjs
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PW_CORE = process.env.PW_CORE
  || 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;
const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5199;
const URL_APP = `http://localhost:${PORT}/ks/`;

/* ---------- 1. 起 dev server ---------- */
const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((res, rej) => {
  // 不靠解析 vite 输出（带 ANSI 颜色码，正则容易踩空），直接轮询 HTTP 是否就绪
  const t0 = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - t0 > 40000) { clearInterval(timer); rej(new Error('vite dev server 启动超时')); return; }
    try {
      const r = await fetch(URL_APP);
      if (r.ok) { clearInterval(timer); res(); }
    } catch (e) { /* 还没起来 */ }
  }, 400);
  srv.stderr.on('data', d => process.stderr.write(d));
});

/* ---------- 2. 打开页面并注入测试环境 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());          // 退出练习的 confirm 一律确认

await page.goto(URL_APP);
await page.waitForTimeout(1000);
await page.setViewportSize({ width: 375, height: 812 });

const FAKE = [
  { id: 1, type: 'single', stem: '测试题一：1+1=?', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'C', text: '3' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null },
  { id: 2, type: 'single', stem: '测试题二：2+2=?', options: [{ key: 'A', text: '3' }, { key: 'B', text: '4' }, { key: 'C', text: '5' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null },
  { id: 3, type: 'single', stem: '测试题三：3+3=?', options: [{ key: 'A', text: '5' }, { key: 'B', text: '6' }, { key: 'C', text: '7' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null }
];

await page.evaluate(async (fake) => {
  if (!window.__exam || !window.__store) throw new Error('调试钩子未注入（dev 模式吗？）');
  Object.keys(localStorage)
    .filter(k => k.startsWith('ce_') || k.startsWith('credit_exam'))
    .forEach(k => localStorage.removeItem(k));
  await window.__store.loadBankState(null, false);   // 未登录：走本地存储
  window.__exam.setQuestions(fake);
  window.__exam.initEngine();
  window.__store.clearProgress();
  document.getElementById('auth').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  document.getElementById('topBankName').textContent = '续做测试库';
  for (const s of ['banks', 'home', 'practice', 'result']) {
    document.getElementById(s).classList.toggle('hide', s !== 'home');
  }
  window.__exam.refreshHomeUI();
}, FAKE);

/* ---------- 3. 断言 ---------- */
const fails = [];
let n = 0;
const chk = (cond, name, extra) => { n++; if (!cond) fails.push(`T${n} ${name}${extra ? ' → ' + extra : ''}`); };

/** 首页按钮区快照 */
const homeState = () => page.evaluate(() => {
  const vis = id => {
    const el = document.getElementById(id);
    return !!el && !el.classList.contains('hide') && el.offsetParent !== null;
  };
  const c = document.getElementById('continueBtn');
  return {
    start: vis('startBtn'), restart: vis('restartBtn'), cont: vis('continueBtn'),
    contBg: getComputedStyle(c).backgroundColor,
    hint: document.getElementById('startHint').classList.contains('hide') ? '' : document.getElementById('startHint').textContent.trim(),
    homeShown: !document.getElementById('home').classList.contains('hide'),
    practiceShown: !document.getElementById('practice').classList.contains('hide')
  };
});
/** 当前题号 + 选项选中情况 */
const qState = () => page.evaluate(() => ({
  pcount: document.getElementById('pcount').textContent,
  sel: [...document.querySelectorAll('#opts .opt.sel')].map(e => e.dataset.i),
  optCount: document.querySelectorAll('#opts .opt').length
}));

// T1：无进度 → 单个「开始练习」
let h = await homeState();
chk(h.start && !h.restart && !h.cont, '无进度时只显示「开始练习」', JSON.stringify(h));
chk(h.hint === '', '无进度时不显示进度提示');

// T2：开始练习 → 第 1/3 题
await page.click('#startBtn');
await page.waitForTimeout(200);
let q = await qState();
chk(q.pcount === '第 1 / 3 题', '点开始练习进入第 1 题', q.pcount);

// T3：第 1 题选 B（data-i=1）→ 下一题
await page.click('#opts .opt[data-i="1"]');
await page.waitForTimeout(120);
q = await qState();
chk(q.sel.join() === '1', '第 1 题选中 B', 'sel=' + q.sel.join());
await page.click('#nextBtn');
await page.waitForTimeout(200);
q = await qState();
chk(q.pcount === '第 2 / 3 题', '下一题 → 第 2 题', q.pcount);
chk(q.sel.length === 0, '新题无残留选中');

// T4：第 2 题选 A（data-i=0）→ 下一题到第 3 题
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(120);
await page.click('#nextBtn');
await page.waitForTimeout(200);
q = await qState();
chk(q.pcount === '第 3 / 3 题', '再下一题 → 第 3 题', q.pcount);

// T5：退出练习 → 首页应变成「从头开始 + 继续练习」
await page.click('#quitBtn');
await page.waitForTimeout(300);
h = await homeState();
chk(h.homeShown && !h.practiceShown, '退出后回到首页');
chk(!h.start, '有进度时隐藏「开始练习」');
chk(h.restart, '有进度时显示「从头开始」');
chk(h.cont, '有进度时显示「继续练习」');

// T6：继续练习必须是绿色背景（--ok: #1bab63）
chk(h.contBg === 'rgb(27, 171, 99)', '「继续练习」为绿色背景', h.contBg);

// T7：进度提示文案
chk(h.hint.indexOf('第 3 / 3 题') >= 0 && h.hint.indexOf('已答 2 题') >= 0,
  '提示显示上次题号与已答数量', h.hint);

// 截图：有进度时的首页操作区
const SHOTS = path.join(ROOT, 'shots');
await page.evaluate(() => document.getElementById('startActions').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(SHOTS, 'resume-home-progress.png') });

// T8：继续练习 → 回到第 3 题；往前翻应看到第 1 题的作答还在
await page.click('#continueBtn');
await page.waitForTimeout(300);
q = await qState();
chk(q.pcount === '第 3 / 3 题', '继续练习恢复到退出时的题号', q.pcount);
await page.click('#prevBtn');
await page.waitForTimeout(150);
await page.click('#prevBtn');
await page.waitForTimeout(150);
q = await qState();
chk(q.pcount === '第 1 / 3 题', '可顺序回翻到第 1 题', q.pcount);
chk(q.sel.join() === '1', '第 1 题的作答（B）被恢复', 'sel=' + q.sel.join());
await page.screenshot({ path: path.join(SHOTS, 'resume-restored-q1.png') });

// T9：退出 → 从头开始 → 回到第 1 题且作答清空
await page.click('#quitBtn');
await page.waitForTimeout(250);
await page.click('#restartBtn');
await page.waitForTimeout(300);
q = await qState();
chk(q.pcount === '第 1 / 3 题', '「从头开始」重新从第 1 题开始', q.pcount);
chk(q.sel.length === 0, '「从头开始」不带入上次作答', 'sel=' + q.sel.join());

// T10：做完最后一题 → 结果页 → 返回首页应恢复成单个「开始练习」
await page.click('#opts .opt[data-i="1"]');
await page.waitForTimeout(120);
await page.click('#nextBtn');           // 第 1 → 第 2
await page.waitForTimeout(150);
await page.click('#opts .opt[data-i="1"]');
await page.waitForTimeout(120);
await page.click('#nextBtn');           // 第 2 → 第 3
await page.waitForTimeout(150);
await page.click('#opts .opt[data-i="1"]');
await page.waitForTimeout(120);
await page.click('#nextBtn');           // 第 3 → 结果页
await page.waitForTimeout(300);
const done = await page.evaluate(() => ({
  resultShown: !document.getElementById('result').classList.contains('hide'),
  title: document.getElementById('resTitle').textContent
}));
chk(done.resultShown, '最后一题后进入结果页', done.title);
await page.click('#quitBtn2');
await page.waitForTimeout(250);
h = await homeState();
chk(h.start && !h.cont && !h.restart, '练习完成后首页恢复为单个「开始练习」', JSON.stringify(h));

await browser.close();
srv.kill();

/* ---------- 4. 输出 ---------- */
console.log('断言 ' + (n - fails.length) + ' / ' + n + ' 通过');
if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)); }
else console.log('✅ 全部通过：退出后「继续练习」可恢复题号与作答，绿色按钮、从头开始、完成后清理均正常');
console.log('JS 错误：' + (jsErrors.length ? jsErrors.join(' | ') : '无'));
