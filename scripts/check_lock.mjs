/**
 * 「回显答案后不得再次选择」的验收。
 *
 * 需求：练习模式下 —— 单选/判断选完回显正确答案后、多选点「确定」回显答案后，
 *       该题选项不得再被改选（否则等于看着答案改答案）。
 *
 * 同 check_fbline：起本地 vite dev server，借 DEV 调试钩子注入假题，
 * 全程走真实 UI 点击（点选项 / 点「确定」/ 上一题下一题），再读 DOM 与 store 状态，
 * 不靠读代码猜行为。反向用例同样重要：**没回显答案时必须仍可改选**，
 * 否则"锁"会误伤顺序练习的正常作答流程。
 *
 * 用法：node scripts/check_lock.mjs
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
const PORT = 5222;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

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

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());
await page.goto(URL_APP);
await page.waitForTimeout(1000);

const FAKE = [
  { id: 1, type: 'single', stem: '锁定验收 1：1+1=?', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'C', text: '3' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null },
  // 判断题答案必须是「错误」：默认开着「去除正确判断题」，答案为「正确」的题会被剔出池，题序会错位
  { id: 2, type: 'judge', stem: '锁定验收 2：2+2=5。', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerKeys: ['B'], answerText: '错误', correctIdx: [1], analysis: null },
  { id: 3, type: 'multiple', stem: '锁定验收 3：下列哪些是偶数？', options: [{ key: 'A', text: '2' }, { key: 'B', text: '4' }, { key: 'C', text: '5' }, { key: 'D', text: '8' }], answerKeys: ['A', 'B', 'D'], answerText: 'A. 2；B. 4；D. 8', correctIdx: [0, 1, 3], analysis: null }
];

/** 回到首页并清掉顺序练习的进度，方便重新开一轮 */
async function resetHome(fake, opts = {}) {
  await page.evaluate(async ({ fake, revealAfter, showAns }) => {
    await window.__store.clearProgress('sequential');
    window.__exam.setQuestions(fake);
    window.__exam.initEngine();
    // 别漏掉这一层壳：#auth 不藏起来、#app 不放出来，里面的按钮都是不可见元素，点不动（第一版就卡在这）
    document.getElementById('auth').classList.add('hide');
    document.getElementById('app').classList.remove('hide');
    document.getElementById('topBankName').textContent = '锁定验收库';
    const ra = document.getElementById('revealAfter');
    ra.checked = !!revealAfter;
    ra.dispatchEvent(new Event('change', { bubbles: true }));
    const sa = document.getElementById('showAns');
    sa.checked = !!showAns;
    sa.dispatchEvent(new Event('change', { bubbles: true }));
    for (const s of ['banks', 'home', 'practice', 'result']) {
      document.getElementById(s).classList.toggle('hide', s !== 'home');
    }
    window.__exam.refreshHomeUI();
  }, { fake, revealAfter: !!opts.revealAfter, showAns: !!opts.showAns });
  await page.waitForTimeout(150);
  // 有残留进度时首页主按钮会变成「继续练习」，这里一律走「开始练习」，所以断言一下它的可见性
  const vis = await page.evaluate(() => {
    const b = document.getElementById('startBtn');
    return { hidden: b.classList.contains('hide'), w: b.getBoundingClientRect().width };
  });
  if (vis.hidden || vis.w === 0) throw new Error('首页「开始练习」按钮不可见：' + JSON.stringify(vis));
}

/** 当前题的作答状态快照 */
const snap = () => page.evaluate(() => {
  const o = document.getElementById('opts');
  const line = document.querySelector('#qBody .fb-line.show');
  const lk = document.querySelector('#qBody .fb-lock');
  return {
    idx: window.__exam.S.idx,
    ans: JSON.stringify(window.__exam.S.userAns[window.__exam.S.idx]),
    revealed: JSON.stringify(window.__exam.S.revealed),
    hasOpts: !!o,
    optsCls: o ? o.className : '',
    optCls: o ? [...o.querySelectorAll('.opt')].map(e => e.className.replace('opt', '').trim()).join('|') : '',
    locked: !!(o && o.className.split(/\s+/).includes('lock')),
    lockOpts: o ? o.querySelectorAll('.opt.lock').length : 0,
    selIdxs: o ? [...o.querySelectorAll('.opt')].map((e, i) => e.classList.contains('sel') ? i : -1).filter(i => i >= 0) : [],
    fbShown: !!line,
    lockIcon: !!lk,
    lockTag: lk ? lk.textContent.trim() : '',
    nextBtn: document.getElementById('nextBtn').textContent.trim()
  };
});

const fails = [];
let n = 0;
const chk = (cond, name, extra) => { n++; if (!cond) fails.push(`T${n} ${name}${extra ? ' → ' + extra : ''}`); };

/* ============ 场景 A：「选完展示正确答案」开启（本轮需求的主场景） ============ */
await resetHome(FAKE, { revealAfter: true, showAns: false });
chk(await page.evaluate(() => window.__exam.S.revealAfter === true), 'A0 「选完展示正确答案」已打开', '');
await page.click('#startBtn');
await page.waitForTimeout(250);
const pi = await page.evaluate(() => ({ n: window.__exam.S.pool.length, t: window.__exam.S.pool.map(q => q.type).join() }));
chk(pi.n === 3 && pi.t === 'single,judge,multiple', 'A0 池子正好 3 题（单选/判断/多选），题序正确', JSON.stringify(pi));

// --- 单选：选完即回显 → 锁 ---
let s0 = await snap();
chk(!s0.locked && s0.lockOpts === 0, 'A1 未作答时单选选项不锁定', JSON.stringify(s0));
await page.click('#opts .opt[data-i="0"]');           // 故意选错（正确答案 B）
await page.waitForTimeout(200);
let s = await snap();
chk(s.fbShown && s.locked, 'A1 单选作答后回显答案，整组选项转为锁定', JSON.stringify(s));
chk(s.lockOpts === 3, 'A1 单选 3 个选项都带锁定标记', 'locked=' + s.lockOpts);
chk(s.lockIcon, 'A1 反馈行右侧给出锁定标识', JSON.stringify({ icon: s.lockIcon }));
chk(!/已锁定/.test(s.lockTag), 'A1 锁定标识只留图标，不再显示「已锁定」字样', JSON.stringify(s.lockTag));
const afterA1 = s.ans;
await page.click('#opts .opt[data-i="1"]');           // 试图改成正确答案
await page.click('#opts .opt[data-i="2"]');
await page.waitForTimeout(200);
s = await snap();
chk(s.ans === afterA1 && s.ans === '0', 'A1 锁定后点其它选项无效（单选答案未被改写）', s.ans);
chk(s.selIdxs.join() === '0', 'A1 选中态仍停在原来的 A，没有被点走', 'sel=' + s.selIdxs.join());
await page.screenshot({ path: path.join(SHOTS, 'lock-single.png'), clip: { x: 0, y: 0, width: 420, height: 560 } });

// --- 判断题：同上 ---
await page.click('#nextBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');           // 选「正确」（答案其实是「错误」）
await page.waitForTimeout(200);
s = await snap();
chk(s.locked && s.lockOpts === 2 && s.lockIcon, 'A2 判断题作答后同样锁定（2 个按钮）', JSON.stringify({ locked: s.locked, n: s.lockOpts, icon: s.lockIcon }));
const afterA2 = s.ans;
await page.click('#opts .opt[data-i="1"]');
await page.waitForTimeout(200);
s = await snap();
chk(s.ans === afterA2 && s.selIdxs.join() === '0', 'A2 锁定后判断选项不可改选', JSON.stringify({ ans: s.ans, sel: s.selIdxs.join() }));

// --- 多选题：确定前可改，确定后锁 ---
await page.click('#nextBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.click('#opts .opt[data-i="1"]');
await page.click('#opts .opt[data-i="2"]');           // 加上 C
await page.click('#opts .opt[data-i="2"]');           // 再点掉 C（未确定 → 可自由增减）
await page.waitForTimeout(200);
s = await snap();
chk(s.nextBtn === '确定', 'A3 多选题未核对时，主按钮是「确定」', s.nextBtn);
chk(!s.locked && s.ans === '[0,1]', 'A3 多选题在点「确定」之前可以自由增减（不算锁定）', JSON.stringify({ locked: s.locked, ans: s.ans }));

await page.click('#nextBtn');                          // 点「确定」→ 回显答案
await page.waitForTimeout(250);
s = await snap();
chk(s.fbShown && s.locked && s.lockOpts === 4, 'A3 多选点「确定」后回显答案并锁定全部选项', JSON.stringify({ fb: s.fbShown, locked: s.locked, n: s.lockOpts }));
chk(/正确答案：A、B、D/.test(await page.evaluate(() => (document.querySelector('#qBody .fb-line .ans-key') || {}).textContent || '')),
  'A3 确定的题目给出了正确答案 A、B、D', '');
const afterA3 = s.ans;
await page.click('#opts .opt[data-i="3"]');            // 想补上 D
await page.click('#opts .opt[data-i="0"]');            // 想取消 A
await page.waitForTimeout(200);
s = await snap();
chk(s.ans === afterA3 && s.ans === '[0,1]', 'A3 锁定后多选答案无法再改（补选、取消都无效）', s.ans);
chk(s.selIdxs.join() === '0,1', 'A3 多选选中态保持 A、B', 'sel=' + s.selIdxs.join());
await page.screenshot({ path: path.join(SHOTS, 'lock-multi.png'), clip: { x: 0, y: 0, width: 420, height: 620 } });

// --- 翻页回来仍然锁定（锁定状态跟着题目走，不是一次性的） ---
await page.click('#prevBtn');
await page.waitForTimeout(200);
s = await snap();
chk(s.idx === 1 && s.locked, 'A4 回到上一题（判断）仍是锁定态', JSON.stringify({ idx: s.idx, locked: s.locked }));
await page.click('#prevBtn');
await page.waitForTimeout(200);
s = await snap();
chk(s.idx === 0 && s.locked && s.ans === '0', 'A4 再回到第 1 题（单选）仍锁定且作答保持', JSON.stringify({ idx: s.idx, ans: s.ans }));

/* ============ 场景 B：未回显答案（顺序练习默认）必须仍可改选 ============ */
await resetHome(FAKE, { revealAfter: false, showAns: false });
await page.click('#startBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(150);
s = await snap();
chk(!s.fbShown, 'B1 顺序练习默认设置下，作答后不显示答案', JSON.stringify({ fb: s.fbShown }));
chk(!s.locked && s.lockOpts === 0, 'B1 没回显答案时不锁定', JSON.stringify({ locked: s.locked, n: s.lockOpts }));
await page.click('#opts .opt[data-i="1"]');            // 改选 B（正确答案）
await page.waitForTimeout(150);
s = await snap();
chk(s.ans === '1' && s.selIdxs.join() === '1', 'B1 没回显答案时仍可改选（保住原来"想清楚再定"的自由）', JSON.stringify({ ans: s.ans, sel: s.selIdxs.join() }));

/* ============ 场景 C：「看答案」全程显示 → 不锁（浏览姿势，不算提交） ============ */
await resetHome(FAKE, { revealAfter: false, showAns: true });
await page.click('#startBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(200);
s = await snap();
chk(s.fbShown && !s.locked, 'C1 开着「看答案」时答案常显，但不判定为提交 → 不锁', JSON.stringify({ fb: s.fbShown, locked: s.locked }));
chk(!s.lockIcon, 'C1 此时不显示锁定标识', 'icon=' + s.lockIcon);
await page.click('#opts .opt[data-i="1"]');
await page.waitForTimeout(150);
s = await snap();
chk(s.ans === '1', 'C1 「看答案」下仍可改选（否则整个练习会点不动）', s.ans);

/* ============ 场景 D：手机宽度下反馈行不因为多了「已锁定」而溢出 ============ */
const mobile = [];
for (const w of [375, 320]) {
  await page.setViewportSize({ width: w, height: 812 });
  await resetHome(FAKE, { revealAfter: true, showAns: false });
  await page.click('#startBtn');
  await page.waitForTimeout(250);
  await page.click('#opts .opt[data-i="0"]');
  await page.waitForTimeout(250);
  const g = await page.evaluate(() => {
    const line = document.querySelector('#qBody .fb-line.show');
    const box = line.getBoundingClientRect();
    const tag = line.querySelector('.fb-lock');
    const tb = tag.getBoundingClientRect();
    return {
      w: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      lineH: Math.round(box.height),
      tagInside: tb.right <= box.right + 1 && tb.left >= box.left - 1,
      tagText: tag.textContent.trim(),
      tagW: Math.round(tb.width),
      locked: !!document.querySelector('#opts.lock')
    };
  });
  mobile.push({ w, ...g });
  if (w === 375) await page.screenshot({ path: path.join(SHOTS, 'lock-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 620 } });
}
for (const m of mobile) {
  chk(m.scrollW <= m.w, `D1 ${m.w}px 宽：无横向溢出`, m.scrollW + ' > ' + m.w);
  chk(m.tagInside, `D1 ${m.w}px 宽：锁定标识没有跑出反馈行`, JSON.stringify({ tag: m.tagText, inside: m.tagInside }));
  chk(!/已锁定/.test(m.tagText), `D1 ${m.w}px 宽：锁定标识不含「已锁定」文字（宽度 ${m.tagW}px）`, JSON.stringify(m.tagText));
  chk(m.lineH <= 52, `D1 ${m.w}px 宽：反馈行仍然只占一行（≤52px）`, m.lineH + 'px');
  chk(m.locked, `D1 ${m.w}px 宽：锁定态照常生效`, '');
}

/* ============ 静态核对 ============ */
const eng = fs.readFileSync(path.join(ROOT, 'src/engine.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
chk(/function isLocked\(/.test(eng), 'E1 engine.js 里有 isLocked() 判定', '');
chk(/function onPick[\s\S]{0,200}isLocked\(q, S\.idx\)/.test(eng), 'E2 onPick 的入口就拦掉了锁定后的点击（不是只靠 UI 样式）', '');
chk(/\.opt\.lock\{/.test(css), 'E3 styles.css 有 .opt.lock 规则', '');
chk(/\.fb-lock\{/.test(css), 'E3 styles.css 有 .fb-lock 规则', '');
// 本轮需求：反馈行右侧不再出现「已锁定」**可见文字**，只留一个图标兜底（带 title 说明）
// 注：aria-label 里的「已锁定」是给读屏用的，不算可见文字，不影响本断言
chk(/>🔒<\/span>/.test(eng), 'E3 engine.js 的锁定标识只含图标、无可见文字', (eng.match(/fb-lock[^<]*>[^<]*/) || [''])[0]);
chk(!/class="fb-lock"[^>]*>\s*[^<]*已锁定/.test(eng), 'E3 锁定标识不再渲染「已锁定」字样', '');
chk(/class="fb-lock" title=/.test(eng), 'E3 锁定标识带 title 说明（鼠标悬停可见）+ aria-label（读屏可读）', '');
chk(jsErrors.length === 0, 'E4 全程无 JS 报错', jsErrors.join(' | '));

/* ============ F 交付产物核对（真正上传的那个单文件） ============ */
const distPath = path.join(ROOT, 'dist/index.html');
if (fs.existsSync(distPath)) {
  const dist = fs.readFileSync(distPath, 'utf8');
  chk(/>🔒<\/span>/.test(dist), 'F1 单文件产物内含新的锁定标识（纯图标）', '');
  const hits = dist.match(/.{0,34}已锁定.{0,12}/g) || [];
  chk(hits.length > 0, 'F2 产物里能找到锁定标识代码（说明产物是最新的）', 'hits=' + hits.length);
  chk(hits.every(h => /aria-label="已锁定"/.test(h)),
    'F2 产物里「已锁定」只出现在 aria-label（不可见），没有可见文字', hits.join(' || '));
  chk(!dist.includes('__exam'), 'F3 产物内已剔除调试钩子', '');
}

await browser.close();
srv.kill();

console.log(`\n作答锁定（回显答案后不可改选）：${n - fails.length} / ${n} 通过`);
if (fails.length) {
  console.log('未通过：');
  fails.forEach(f => console.log('   · ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过（截图见 shots/lock-*.png）');
}
