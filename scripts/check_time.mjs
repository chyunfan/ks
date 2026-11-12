/**
 * 「做题用时」的验收。
 *
 * 需求：练习结果页要显示这道卷子花了多少时间（用户在结果页截图上要求「把做题用时也显示出来」）。
 *
 * 关键在于"用时"必须是**真正在做题的时间**，所以本脚本不只验证"有个数字显示出来"，还验证：
 *   · 练习进行中就有小时钟在走（非考试模式）
 *   · 退出 → 等一会儿 → 继续练习：**空档不计入**，用时接着累计（而不是从 0 重来、也不是把空档算进去）
 *   · 结果页显示的秒数 ≈ 全程墙钟时间 − 空档时间
 *   · 考试模式不叠第二个表（已有倒计时）
 *
 * 同 check_lock：起本地 vite dev server，借 DEV 钩子注入假题，全程真实 UI 点击。
 * 用法：node scripts/check_time.mjs
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
const PORT = 5233;
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
  { id: 1, type: 'single', stem: '用时验收 1：1+1=?', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'C', text: '3' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null },
  // 判断题答案必须是「错误」，否则被「去除正确判断题」剔出池 → 题序错位
  { id: 2, type: 'judge', stem: '用时验收 2：2+2=5。', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerKeys: ['B'], answerText: '错误', correctIdx: [1], analysis: null },
  { id: 3, type: 'single', stem: '用时验收 3：3+3=?', options: [{ key: 'A', text: '5' }, { key: 'B', text: '6' }, { key: 'C', text: '7' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null }
];

/** 回到首页（恢复整条外层壳：藏 #auth、放 #app，否则里面按钮都点不动） */
async function resetHome(fake, opts = {}) {
  await page.evaluate(async ({ fake, mode }) => {
    // 先把模式切回目标模式：首页主按钮是按**当前模式**那一份进度决定的。
    // 上一段测试若停在 exam 模式，exam 的进度还在 → 主按钮会变成「继续练习」、startBtn 被藏掉。
    const mc = document.querySelector('.mode[data-mode="' + mode + '"]');
    if (mc && !mc.classList.contains('active')) mc.click();
    await window.__store.clearProgress(mode);
    window.__exam.setQuestions(fake);
    window.__exam.initEngine();
    document.getElementById('auth').classList.add('hide');
    document.getElementById('app').classList.remove('hide');
    document.getElementById('topBankName').textContent = '用时验收库';
    for (const s of ['banks', 'home', 'practice', 'result']) {
      document.getElementById(s).classList.toggle('hide', s !== 'home');
    }
    window.__exam.refreshHomeUI();
  }, { fake, mode: opts.mode || 'sequential' });
  await page.waitForTimeout(150);
  const vis = await page.evaluate(() => {
    const b = document.getElementById('startBtn');
    return { hidden: b.classList.contains('hide'), w: b.getBoundingClientRect().width };
  });
  if (vis.hidden || vis.w === 0) throw new Error('首页「开始练习」按钮不可见：' + JSON.stringify(vis));
}

/** 练习页小时钟读数 */
const clock = () => page.evaluate(() => {
  const el = document.getElementById('elapsedSpan');
  const t = document.getElementById('timerSpan');
  const box = el.getBoundingClientRect();
  const m = /用时\s*(\d+):(\d\d)/.exec(el.textContent || '');
  return {
    hidden: el.classList.contains('hide'),
    text: el.textContent.trim(),
    secs: m ? (+m[1]) * 60 + (+m[2]) : -1,
    width: Math.round(box.width),
    timerHidden: t.classList.contains('hide'),
    timerText: t.textContent.trim(),
    usedMs: Math.round(window.__exam.usedMs())
  };
});

/** 结果页读数 */
const result = () => page.evaluate(() => {
  const st = document.getElementById('stTime');
  const cell = st.closest('.stat');
  const box = cell.getBoundingClientRect();
  const m = /(?:(\d+)小时)?(?:(\d+)分)?(\d+)秒$/.exec(st.textContent.trim());
  const secs = m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) : -1;
  return {
    cells: document.querySelectorAll('#result .stat').length,
    label: cell.querySelector('.l').textContent.trim(),
    text: st.textContent.trim(),
    secs: secs,
    cellW: Math.round(box.width),
    scrollW: document.documentElement.scrollWidth,
    viewW: document.documentElement.clientWidth,
    shown: !document.getElementById('result').classList.contains('hide')
  };
});

const fails = [];
let n = 0;
const chk = (cond, name, extra) => { n++; if (!cond) fails.push(`T${n} ${name}${extra ? ' → ' + extra : ''}`); };

/* ============ A. 练习中：小时钟在走 ============ */
await resetHome(FAKE, { mode: 'sequential' });
await page.click('#startBtn');
await page.waitForTimeout(300);
let c = await clock();
chk(!c.hidden && c.secs >= 0, 'A1 非考试模式进入练习后出现「⏱ 用时」小时钟', JSON.stringify(c));
chk(c.timerHidden, 'A1 练习模式不显示考试倒计时', 'timerHidden=' + c.timerHidden);
const t0 = c.secs;
await page.waitForTimeout(2200);
c = await clock();
chk(c.secs >= t0 + 2, 'A2 小时钟每秒在走（等 2.2 秒后读数 +2）', `t0=${t0} → ${c.secs}`);
const usedBeforeQuit = c.usedMs;
await page.screenshot({ path: path.join(SHOTS, 'time-practice.png'), clip: { x: 0, y: 0, width: 420, height: 420 } });

/* ============ B. 作答 → 退出：落盘 + 停表 ============ */
await page.click('#opts .opt[data-i="1"]');          // 第 1 题答对
await page.click('#nextBtn');
await page.waitForTimeout(200);
await page.click('#opts .opt[data-i="0"]');          // 第 2 题答错
await page.click('#nextBtn');
await page.waitForTimeout(300);
await page.click('#quitBtn');                        // dialog 自动确认 → 回首页
await page.waitForTimeout(300);
const snap = await page.evaluate(() => {
  const p = window.__store.loadProgress('sequential');
  return {
    has: !!p,
    elapsedMs: p ? p.elapsedMs : null,
    homeShown: !document.getElementById('home').classList.contains('hide')
  };
});
chk(snap.homeShown, 'B1 退出后回到首页', JSON.stringify(snap));
chk(typeof snap.elapsedMs === 'number' && snap.elapsedMs >= 2000,
  'B2 快照里存了 elapsedMs（用时落盘，≥ 刚才实际的 2 秒）', 'elapsedMs=' + snap.elapsedMs);

/* ============ C. 退出期间的空档不计入 ============ */
await page.waitForTimeout(2200);                     // 挂着不练的 2.2 秒
await page.click('#continueBtn');                    // 继续练习
await page.waitForTimeout(120);
const afterResume = await clock();
const gate = snap.elapsedMs + 900;                   // 恢复后立刻读：只允许 +0.9s 的调度误差
chk(afterResume.usedMs <= gate,
  'C1 「继续练习」恢复后，退出期间的空档没有被算进用时',
  `恢复前快照 ${snap.elapsedMs}ms + 空档 2200ms，恢复后读到 ${afterResume.usedMs}ms（上限 ${gate}）`);
chk(afterResume.usedMs >= snap.elapsedMs - 200,
  'C1 恢复后的用时接着上次累计（不是从 0 重来）', `${snap.elapsedMs} → ${afterResume.usedMs}`);
await page.waitForTimeout(1600);
const afterRun = await clock();
chk(afterRun.usedMs >= afterResume.usedMs + 1200,
  'C2 恢复后时钟继续在走', `${afterResume.usedMs} → ${afterRun.usedMs}`);
const usedAtFinish = afterRun.usedMs;

/* ============ D. 结果页：4 格 + 用时数值对得上 ============ */
await page.evaluate(() => document.getElementById('nextBtn').click());   // 最后一题之后 → 完成
await page.waitForTimeout(500);
let r = await result();
chk(r.shown, 'D1 进入结果页', JSON.stringify({ shown: r.shown }));
chk(r.cells === 4, 'D1 统计格变成 4 格（总题数 / 答对 / 答错 / 做题用时）', 'n=' + r.cells);
chk(r.label === '做题用时', 'D1 第 4 格标签是「做题用时」', r.label);
chk(r.secs >= 0, 'D1 用时是「X分Y秒」这类可读格式', r.text);
// 全程墙钟 ≈ (2.2 + 作答 + 0.3) + (0.12 + 1.6) ≈ 6.0 秒，其中空档 2.2 秒不该算
chk(r.secs >= 3 && r.secs <= 8, 'D2 用时量级合理（读数 3~8 秒，不含 2.2 秒空档）', r.text);
const domSecs = r.secs;
chk(Math.abs(domSecs * 1000 - usedAtFinish) <= 2200,
  'D2 结果页显示值 ≈ DOM 计时器在完成前的读数（误差 ≤2.2s，允许点完成那一下的耗时）',
  `页面 ${domSecs}s vs 计时器 ${Math.round(usedAtFinish / 1000)}s`);
const frozen = await page.evaluate(() => window.__exam.S.elapsedAt === 0);
chk(frozen, 'D2 交卷后停表（elapsedAt=0，不会在结果页继续涨）', 'elapsedAt=' + frozen);
await page.screenshot({ path: path.join(SHOTS, 'time-result.png'), clip: { x: 0, y: 0, width: 420, height: 560 } });
await page.setViewportSize({ width: 1060, height: 760 });
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(SHOTS, 'time-result-wide.png'), clip: { x: 0, y: 0, width: 1060, height: 560 } });
await page.setViewportSize({ width: 420, height: 900 });

/* ============ E. 「从头开始」要归零 ============ */
await page.evaluate(() => document.getElementById('againBtn').click());
await page.waitForTimeout(200);
const homeInfo = await page.evaluate(() => ({
  startHidden: document.getElementById('startBtn').classList.contains('hide'),
  contHidden: document.getElementById('continueBtn').classList.contains('hide')
}));
chk(!homeInfo.startHidden && homeInfo.contHidden, 'E1 完成后回首页只剩「开始练习」（进度已清）', JSON.stringify(homeInfo));
await page.click('#startBtn');
await page.waitForTimeout(200);
c = await clock();
chk(c.usedMs < 1500, 'E1 重新开始后用时归零（不是接着上一轮）', 'usedMs=' + c.usedMs);

/* ============ F. 考试模式：只显示倒计时，不叠第二个表 ============ */
await page.evaluate(async () => {
  document.getElementById('quitBtn').click();          // dialog 自动确认 → 回首页
});
await page.waitForTimeout(300);
await page.evaluate(async () => {
  document.querySelector('.mode[data-mode="exam"]').click();
});
await page.waitForTimeout(250);
await page.click('#startBtn');
await page.waitForTimeout(400);
c = await clock();
chk(c.hidden, 'F1 考试模式不显示练习用的「用时」小时钟（已有倒计时，避免两个表打架）', JSON.stringify({ hidden: c.hidden, text: c.text }));
chk(!c.timerHidden && /\d+:\d\d/.test(c.timerText), 'F1 考试模式照常显示倒计时', c.timerText);
await page.evaluate(() => document.getElementById('quitBtn').click());
await page.waitForTimeout(300);

/* ============ G. 手机端 375 / 320 不溢出 ============ */
const mobile = [];
for (const w of [375, 320]) {
  await page.setViewportSize({ width: w, height: 812 });
  await resetHome(FAKE, { mode: 'sequential' });
  await page.click('#startBtn');
  await page.waitForTimeout(250);
  const g = await page.evaluate(() => {
    const el = document.getElementById('elapsedSpan');
    const pin = el.closest('.pinfo');
    const eb = el.getBoundingClientRect(), pb = pin.getBoundingClientRect();
    return {
      w: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      inside: eb.right <= pb.right + 1 && eb.left >= pb.left - 1,
      text: el.textContent.trim(),
      pinfoH: Math.round(pb.height)
    };
  });
  mobile.push({ w, ...g });
  if (w === 375) await page.screenshot({ path: path.join(SHOTS, 'time-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 300 } });
}
for (const m of mobile) {
  chk(m.scrollW <= m.w, `G1 ${m.w}px 宽：练习页无横向溢出`, m.scrollW + ' > ' + m.w);
  chk(m.inside, `G1 ${m.w}px 宽：小时钟没有跑出那一行`, JSON.stringify({ text: m.text, inside: m.inside }));
  chk(m.pinfoH <= 40, `G1 ${m.w}px 宽：进度行仍是一行（≤40px）`, m.pinfoH + 'px');
}

/* 结果页 2×2 */
await page.setViewportSize({ width: 375, height: 812 });
await page.evaluate(() => document.getElementById('nextBtn').click());  // 第 1 题未答 → 只是切题
await page.waitForTimeout(200);
await page.evaluate(() => {
  // 直接把三题都答掉再完成，快一些：点选当前题后连点下一题
  const clickOpt = i => { const o = document.querySelector('#opts .opt[data-i="' + i + '"]'); if (o) o.click(); };
  for (let k = 0; k < 5; k++) {
    clickOpt(1);
    document.getElementById('nextBtn').click();
  }
});
await page.waitForTimeout(400);
r = await result();
chk(r.shown && r.scrollW <= r.viewW, 'G2 375px 宽：结果页无横向溢出', JSON.stringify({ shown: r.shown, scrollW: r.scrollW, viewW: r.viewW }));
if (r.shown) {
  const cols = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#result .stat')];
    const ys = cells.map(c => Math.round(c.getBoundingClientRect().top));
    return { rows: new Set(ys).size, perRow: ys.filter(y => y === ys[0]).length, cellW: Math.round(cells[3].getBoundingClientRect().width) };
  });
  chk(cols.rows === 2 && cols.perRow === 2, 'G2 375px 宽：4 格排成 2×2（不是挤成一行）', JSON.stringify(cols));
  await page.screenshot({ path: path.join(SHOTS, 'time-result-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 620 } });
}

/* ============ H. 静态核对 ============ */
const eng = fs.readFileSync(path.join(ROOT, 'src/engine.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
chk(/function usedMs\(/.test(eng) && /function pauseElapsed\(/.test(eng), 'H1 engine.js 有 usedMs / pauseElapsed', '');
chk(/elapsedMs: usedMs\(\)/.test(eng), 'H1 快照里带上 elapsedMs', '');
chk(/quitBtn'\)\.addEventListener[\s\S]{0,400}?pauseElapsed\(\)[\s\S]{0,400}?saveSnapshot\(\)/.test(eng),
  'H1 退出练习时先停表再存快照（顺序不能反，否则快照里的用时会把退出后的空档也算进去）', '');
chk(/id="elapsedSpan"/.test(html), 'H2 index.html 有练习页小时钟 #elapsedSpan', '');
chk(/id="stTime"/.test(html) && /做题用时/.test(html), 'H2 index.html 结果页有 #stTime「做题用时」', '');
chk(/\.stat \.n\.dur\{/.test(css), 'H2 styles.css 有 .stat .n.dur（用时那格降字号防挤）', '');
chk(/S\.elapsedMs = \(typeof p\.elapsedMs === 'number'/.test(eng), 'H1 恢复时读取快照里的 elapsedMs（旧快照没有该字段也不会崩）', '');
chk(jsErrors.length === 0, 'H3 全程无 JS 报错', jsErrors.join(' | '));

await browser.close();
srv.kill();

console.log(`\n做题用时：${n - fails.length} / ${n} 通过`);
if (fails.length) {
  console.log('未通过：');
  fails.forEach(f => console.log('   · ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过（截图见 shots/time-*.png）');
}
