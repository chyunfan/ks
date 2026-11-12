/**
 * 「对错 + 正确答案」合并成一行的验收。
 *
 * 为什么不用 dist 单文件：单文件里模块被打包，外部无法注入题库；本地构建也没有 .env。
 * 所以这里起本地 vite dev server，借 engine.js / store.js 的 DEV 调试钩子注入假题，
 * 全程走真实 UI 点击（选答案 / 下一题 / 确定），再回到 DOM 量几何位置 —— 不靠读代码猜。
 *
 * 用法：node scripts/check_fbline.mjs
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
const PORT = 5211;
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

/* ---------- 2. 打开页面并注入测试环境 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());

await page.goto(URL_APP);
await page.waitForTimeout(1000);

const FAKE = [
  { id: 1, type: 'single', stem: '合并行验收 1：1+1=?', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'C', text: '3' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null },
  // ⚠️ 判断题答案必须是「错误」：默认开着「去除正确判断题」，答案为「正确」的题会被剔除出池，
  //    池子就只剩 2 题，后续题号断言全部错位（第一版测试就是这么踩的）。
  { id: 2, type: 'judge', stem: '合并行验收 2：2+2=5。', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerKeys: ['B'], answerText: '错误', correctIdx: [1], analysis: null },
  { id: 3, type: 'multiple', stem: '合并行验收 3：下列哪些是偶数？', options: [{ key: 'A', text: '2' }, { key: 'B', text: '4' }, { key: 'C', text: '5' }, { key: 'D', text: '8' }], answerKeys: ['A', 'B', 'D'], answerText: 'A. 2；B. 4；D. 8', correctIdx: [0, 1, 3], analysis: null }
];

await page.evaluate(async (fake) => {
  if (!window.__exam || !window.__store) throw new Error('调试钩子未注入（dev 模式吗？）');
  Object.keys(localStorage)
    .filter(k => k.startsWith('ce_') || k.startsWith('credit_exam'))
    .forEach(k => localStorage.removeItem(k));
  await window.__store.loadBankState(null, false);
  window.__exam.setQuestions(fake);
  window.__exam.initEngine();
  window.__store.clearProgress();
  document.getElementById('auth').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  document.getElementById('topBankName').textContent = '合并行验收库';
  for (const s of ['banks', 'home', 'practice', 'result']) {
    document.getElementById(s).classList.toggle('hide', s !== 'home');
  }
  window.__exam.refreshHomeUI();
}, FAKE);

/* ---------- 3. 断言 ---------- */
const fails = [];
let n = 0;
const chk = (cond, name, extra) => { n++; if (!cond) fails.push(`T${n} ${name}${extra ? ' → ' + extra : ''}`); };

/** 反馈条的几何 + 文案快照 */
const fb = () => page.evaluate(() => {
  const line = document.querySelector('#qBody .fb-line');
  const pill = line && line.querySelector('.fb-pill');
  const ans = line && line.querySelector('.ans-key');
  const r = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height, cy: b.top + b.height / 2 }; };
  const lr = line ? r(line) : null, pr = pill ? r(pill) : null, ar = ans ? r(ans) : null;
  return {
    shown: !!(line && lr.h > 0),
    lineH: lr ? Math.round(lr.h) : 0,
    // 两元素是否在同一视觉行：垂直中心差 < 6px，且横向不重叠、左边那个在右边那个之左
    sameRow: !!(pr && ar) ? (Math.abs(pr.cy - ar.cy) < 6 && ar.l >= pr.r - 1) : false,
    pillText: pill ? pill.textContent.trim() : '',
    pillBg: pill ? getComputedStyle(pill).backgroundColor : '',
    ansText: ans ? ans.textContent.trim() : '',
    // 旧的两块结构必须消失
    oldAnswerLine: document.querySelectorAll('#qBody .answer-line').length,
    oldFeedback: document.querySelectorAll('#qBody .feedback').length,
    lineCount: document.querySelectorAll('#qBody .fb-line').length,
    // 反馈条下方不应还有别的兄弟块（旧结构会多一行）
    siblingsAfter: line ? [...line.parentNode.children].slice([...line.parentNode.children].indexOf(line) + 1).filter(e => e.getBoundingClientRect().height > 0).length : -1
  };
});

const TOTAL_OK = '✓ 回答正确', TOTAL_NO = '✗ 回答错误';

// T1：开「选完展示正确答案」，开始练习
// 注：开关是 label.switch 里被 slider 盖住的 checkbox，Playwright 点不到（is not visible），
// 所以直接置位并派发 change —— 走的是与真实点击同一条事件链。
await page.evaluate(() => {
  const el = document.getElementById('revealAfter');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(200);
chk(await page.evaluate(() => window.__exam.S.revealAfter === true), 'T1 「选完展示正确答案」开关已打开', '');
await page.click('#startBtn');
await page.waitForTimeout(250);
// 前置：池子必须正好 3 题，否则后面按题号走的断言会错位（假绿）
const poolInfo = await page.evaluate(() => ({
  n: window.__exam.S.pool.length,
  types: window.__exam.S.pool.map(q => q.type).join(),
  pcount: document.getElementById('pcount').textContent.trim()
}));
chk(poolInfo.n === 3 && poolInfo.types === 'single,judge,multiple',
  'T0 池子正好 3 题（单选/判断/多选），题序未被「去除」开关改变', JSON.stringify(poolInfo));
let s = await fb();
chk(!s.shown, 'T1 未作答时不显示反馈条', 'lineH=' + s.lineH);

// T2：单选答对（答案 B）
await page.click('#opts .opt[data-i="1"]');
await page.waitForTimeout(200);
s = await fb();
chk(s.shown && s.lineCount === 1, 'T2 答对后出现反馈条（且只有一条）', JSON.stringify({ shown: s.shown, n: s.lineCount }));
chk(s.pillText === TOTAL_OK, 'T2 左侧胶囊为「' + TOTAL_OK + '」', s.pillText);
chk(/正确答案：B$/.test(s.ansText), 'T2 同一行的右侧是「正确答案：B」', s.ansText);
chk(s.sameRow, 'T2 两者真的在同一行（垂直中心齐平、左右相邻）', JSON.stringify({ pillText: s.pillText, ansText: s.ansText, sameRow: s.sameRow }));
chk(s.oldAnswerLine === 0 && s.oldFeedback === 0, 'T2 旧的两块结构（.feedback / .answer-line）已不再出现在答题区', JSON.stringify({ a: s.oldAnswerLine, f: s.oldFeedback }));
chk(s.lineH <= 46, 'T2 反馈条总高 ≤ 46px（原两块约 96px）', 'lineH=' + s.lineH + 'px');
chk(s.siblingsAfter === 0, 'T2 反馈条之后没有多余的兄弟块（不再多占一行）', 'after=' + s.siblingsAfter);
await page.screenshot({ path: path.join(SHOTS, 'fbline-ok.png'), clip: { x: 0, y: 0, width: 420, height: 620 } });

// T3：判断题答错（正确答案是「错误」B，这里刻意选「正确」A）
await page.click('#nextBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(200);
s = await fb();
chk(s.pillText === TOTAL_NO, 'T3 答错时胶囊为「' + TOTAL_NO + '」', s.pillText);
chk(/正确答案：B$/.test(s.ansText), 'T3 答错时同一行右侧仍给出正确答案 B', s.ansText);
chk(s.sameRow, 'T3 答错状态也在同一行', JSON.stringify(s));
chk(s.lineH <= 46, 'T3 答错状态同样只占一行', 'lineH=' + s.lineH + 'px');
const noBg = s.pillBg;
await page.screenshot({ path: path.join(SHOTS, 'fbline-no.png'), clip: { x: 0, y: 0, width: 420, height: 620 } });

// T4：多选题 —— 点「确定」后合一行，且答案含多个字母
await page.click('#nextBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.click('#opts .opt[data-i="1"]');
await page.waitForTimeout(150);
const btnText = await page.evaluate(() => document.getElementById('nextBtn').textContent.trim());
chk(btnText === '确定', 'T4 多选题未核对时按钮是「确定」', btnText);
await page.click('#nextBtn');
await page.waitForTimeout(250);
s = await fb();
chk(s.pillText === TOTAL_NO, 'T4 只选 A、B（漏 D）判为答错', s.pillText);
chk(/正确答案：A、B、D$/.test(s.ansText), 'T4 多选答案以「A、B、D」形式挤在同一行', s.ansText);
chk(s.sameRow && s.lineH <= 46, 'T4 多选（3 个答案字母）仍是一行，不换行', JSON.stringify({ sameRow: s.sameRow, lineH: s.lineH }));
await page.screenshot({ path: path.join(SHOTS, 'fbline-multi.png'), clip: { x: 0, y: 0, width: 420, height: 620 } });

// T5：收尾 —— 点「完成」进入结果页，结算路径不受本次改动影响
await page.evaluate(() => document.getElementById('nextBtn').click());
await page.waitForTimeout(500);
const res = await page.evaluate(() => ({
  shown: !document.getElementById('result').classList.contains('hide'),
  sub: document.getElementById('resSub').textContent.trim(),
  wrongItems: document.querySelectorAll('#wrongList .wl-item').length,
  wlAns: document.querySelector('#wrongList .wl-item .a')
    ? document.querySelector('#wrongList .wl-item .a').textContent.trim() : ''
}));
chk(res.shown, 'T5 点「完成」正常进入结果页', JSON.stringify(res));
chk(res.wrongItems === 2, 'T5 错题列表 2 条（答错的判断题 + 漏选的多选题）', 'n=' + res.wrongItems);
chk(/正确答案：/.test(res.wlAns), 'T5 结果页错题仍正常给出正确答案', res.wlAns);

/* ---------- 4. 手机端（375 / 320）不换行、不溢出 ---------- */
const mobile = await (async () => {
  const out = [];
  for (const w of [375, 320]) {
    await page.setViewportSize({ width: w, height: 812 });
    await page.waitForTimeout(200);
    // 回到单题反馈态：清进度重开练习 → 单选答对
    await page.evaluate(async (fake) => {
      await window.__store.clearProgress();     // 有进度时首页会换成「从头开始/继续练习」，先清掉
      window.__exam.setQuestions(fake);
      window.__exam.initEngine();
      const sw = document.getElementById('revealAfter');
      sw.checked = true;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
      for (const s of ['banks', 'home', 'practice', 'result']) {
        document.getElementById(s).classList.toggle('hide', s !== 'home');
      }
      window.__exam.refreshHomeUI();
    }, FAKE);
    await page.waitForTimeout(200);
    await page.click('#startBtn');
    await page.waitForTimeout(250);
    await page.click('#opts .opt[data-i="1"]');
    await page.waitForTimeout(250);
    const g = await page.evaluate(() => {
      const line = document.querySelector('#qBody .fb-line');
      const pill = line.querySelector('.fb-pill');
      const ans = line.querySelector('.ans-key');
      const r = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, cy: b.top + b.height / 2 }; };
      const pr = r(pill), ar = r(ans), lr = r(line);
      return {
        w: document.documentElement.clientWidth,
        scrollW: document.documentElement.scrollWidth,
        sameRow: Math.abs(pr.cy - ar.cy) < 6 && ar.l >= pr.r - 1,
        insideLine: ar.r <= lr.r + 1 && pr.l >= lr.l - 1,
        lineH: Math.round(lr.b - lr.t),
        pillText: pill.textContent.trim(), ansText: ans.textContent.trim()
      };
    });
    out.push({ w, ...g });
    if (w === 375) await page.screenshot({ path: path.join(SHOTS, 'fbline-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 620 } });
  }
  return out;
})();
for (const m of mobile) {
  chk(m.sameRow && m.insideLine, `T6 ${m.w}px 宽：胶囊与答案在同一行且不越界`, JSON.stringify(m));
  chk(m.scrollW <= m.w, `T6 ${m.w}px 宽：无横向溢出`, m.scrollW + ' > ' + m.w);
  chk(m.lineH <= 46, `T6 ${m.w}px 宽：反馈条仍是单行高度（≤46px）`, m.lineH + 'px');
}

/* ---------- 5. 静态核对：旧类名已彻底移除 ---------- */
const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
const eng = fs.readFileSync(path.join(ROOT, 'src/engine.js'), 'utf8');
chk(!/\.answer-line/.test(css), 'T7 styles.css 里旧的 .answer-line 规则已删除', css.match(/\.answer-line[^\n]*/)?.[0] || '(无)');
chk(/\.fb-line/.test(css) && /\.fb-pill\.ok/.test(css) && /\.fb-pill\.no/.test(css), 'T7 styles.css 已有 .fb-line / .fb-pill.ok / .fb-pill.no', '');
chk(!/answer-line/.test(eng), 'T7 engine.js 不再输出 .answer-line 结构', '');
chk(/\.feedback\{/.test(css), 'T7 .feedback 保留（导入解析提示、后台提示仍在用）', '');

chk(jsErrors.length === 0, 'T8 全程无 JS 报错', jsErrors.join(' | '));

/* ---------- 6. 收尾 ---------- */
await browser.close();
srv.kill();

console.log(`\n对错+正确答案合一行：${n - fails.length} / ${n} 通过`);
if (fails.length) {
  console.log('未通过：');
  fails.forEach(f => console.log('   · ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过（截图见 shots/fbline-*.png）');
}
