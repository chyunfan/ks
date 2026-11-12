/**
 * 「展示解析」设置项的验收。
 *
 * 需求：练习选项里增加一个开关「展示解析」，开了以后答题回显答案时，在下方显示该题解析。
 *
 * 本脚本要守住的核心边界（比"能显示"重要得多）：
 *   · **答案没回显时，解析一个字都不能露** —— 解析里通常写着答案，提前显示等于剧透；
 *   · 多选题**点「确定」之前**不显示解析（同一条道理）；
 *   · 题目本身没写解析时**不留空壳**（不是渲染一个空 div，而是整块不出现）；
 *   · 解析文本必须**转义后**当纯文本渲染（题库是用户上传的 Excel，不能当 HTML 解析）。
 *
 * 用法：node scripts/check_analysis.mjs
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
const PORT = 5251;
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
const page = await browser.newPage({ viewport: { width: 420, height: 1000 } });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());
await page.goto(URL_APP);
await page.waitForTimeout(1000);

const ANA1 = '两个 1 相加等于 2，所以选 B。';
const ANA_J = '2+2=4，因此该说法错误。';
const ANA_M = '2、4、8 都能被 2 整除；5 不能。';
const ANA_HTML = '<b>不能当标签解析</b> & 5 < 9 这种写法';
const ANA_CASE = '案例解析：根据材料第一段可知……';

const FAKE = [
  { id: 1, type: 'single', stem: '解析验收 1：1+1=?', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'C', text: '3' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: ANA1 },
  { id: 2, type: 'judge', stem: '解析验收 2：2+2=5。', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerKeys: ['B'], answerText: '错误', correctIdx: [1], analysis: ANA_J },
  { id: 3, type: 'multiple', stem: '解析验收 3：下列哪些是偶数？', options: [{ key: 'A', text: '2' }, { key: 'B', text: '4' }, { key: 'C', text: '5' }, { key: 'D', text: '8' }], answerKeys: ['A', 'B', 'D'], answerText: 'A. 2；B. 4；D. 8', correctIdx: [0, 1, 3], analysis: ANA_M },
  // 没写解析的题：验证"不留空壳"
  { id: 4, type: 'single', stem: '解析验收 4：这道题没写解析', options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }], answerKeys: ['A'], answerText: 'A', correctIdx: 0, analysis: null },
  // 解析里带 HTML 与裸斜括号：必须原样当文本显示
  { id: 5, type: 'single', stem: '解析验收 5：解析里带特殊字符', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKeys: ['A'], answerText: 'A', correctIdx: 0, analysis: ANA_HTML },
  // 案例题（isCase）：解析同样要能显示
  { id: 6, type: 'single', isCase: true, caseId: 900, caseBackground: '案例背景：某支行……', stem: '解析验收 6（案例）：下列说法正确的是', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKeys: ['A'], answerText: 'A', correctIdx: 0, analysis: ANA_CASE }
];
/** 只有第 1、5 题有解析，用来验首页那行"X / Y 题有解析"的计数 */
const FAKE_FEW = FAKE.map(q => Object.assign({}, q, { analysis: (q.id === 1 || q.id === 5) ? q.analysis : null }));
/** 整本题库都没有解析 */
const FAKE_NONE = FAKE.map(q => Object.assign({}, q, { analysis: null }));

/** 回到首页并清掉顺序练习的进度，方便重新开一轮 */
async function resetHome(fake, opts = {}) {
  await page.evaluate(async ({ fake, revealAfter, showAns, showAnalysis }) => {
    await window.__store.clearProgress('sequential');
    window.__exam.setQuestions(fake);
    window.__exam.initEngine();
    // 别漏掉这一层壳：#auth 不藏起来、#app 不放出来，里面的按钮都是不可见元素，点不动
    document.getElementById('auth').classList.add('hide');
    document.getElementById('app').classList.remove('hide');
    document.getElementById('topBankName').textContent = '解析验收库';
    const set = (id, on) => {
      const el = document.getElementById(id);
      el.checked = !!on;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('showAns', showAns);
    set('revealAfter', revealAfter);
    set('showAnalysis', showAnalysis);      // 顺序有讲究：三个都显式设一遍，别依赖出厂默认
    for (const s of ['banks', 'home', 'practice', 'result']) {
      document.getElementById(s).classList.toggle('hide', s !== 'home');
    }
    window.__exam.refreshHomeUI();
  }, { fake, revealAfter: !!opts.revealAfter, showAns: !!opts.showAns, showAnalysis: !!opts.showAnalysis });
  await page.waitForTimeout(150);
  const vis = await page.evaluate(() => {
    const b = document.getElementById('startBtn');
    return { hidden: b.classList.contains('hide'), w: b.getBoundingClientRect().width };
  });
  if (vis.hidden || vis.w === 0) throw new Error('首页「开始练习」按钮不可见：' + JSON.stringify(vis));
}

/** 当前题的解析块状态快照 */
const snap = () => page.evaluate(() => {
  const line = document.querySelector('#qBody .fb-line.show');
  const ana = document.querySelector('#qBody .ana');
  const head = ana ? ana.querySelector('.ana-h') : null;
  const body = ana ? ana.querySelector('.ana-b') : null;
  const box = ana ? ana.getBoundingClientRect() : null;
  const host = document.getElementById('qBody').getBoundingClientRect();
  return {
    idx: window.__exam.S.idx,
    fbShown: !!line,
    fbText: line ? line.textContent.trim() : '',
    hasAna: !!ana,
    anaHtml: ana ? ana.outerHTML : '',
    anaHead: head ? head.textContent.trim() : '',
    anaText: body ? body.textContent : '',
    anaInnerTags: body ? [...body.children].map(e => e.tagName).join(',') : '',
    anaW: box ? Math.round(box.width) : 0,
    anaInside: box ? (box.right <= host.right + 1 && box.left >= host.left - 1) : null,
    docW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    nextBtn: document.getElementById('nextBtn').textContent.trim()
  };
});

const fails = [];
let n = 0;
const chk = (cond, name, extra) => { n++; if (!cond) fails.push(`T${n} ${name}${extra !== undefined && extra !== '' ? ' → ' + extra : ''}`); };

/* ================= A 开关开 · 回显答案时显示解析（主场景） ================= */
await resetHome(FAKE, { revealAfter: true, showAns: false, showAnalysis: true });
await page.evaluate(() => window.__exam.start());
await page.waitForTimeout(250);

let s = await snap();
chk(s.idx === 0 && !s.hasAna, 'A1 未作答时既不显示答案、也不显示解析', JSON.stringify({ idx: s.idx, hasAna: s.hasAna }));

await page.click('#opts .opt[data-i="0"]');            // 故意选错（答案 B）
await page.waitForTimeout(200);
s = await snap();
chk(s.fbShown && s.hasAna, 'A1 单选回显答案的同时显示解析', JSON.stringify({ fb: s.fbShown, ana: s.hasAna }));
chk(s.anaHead === '解析', 'A1 解析块带「解析」小标题', s.anaHead);
chk(s.anaText.trim() === ANA1, 'A1 解析内容与题库里的一致', JSON.stringify(s.anaText));
await page.screenshot({ path: path.join(SHOTS, 'ana-single.png'), clip: { x: 0, y: 0, width: 420, height: 640 } });

// 判断题
await page.click('#nextBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(200);
s = await snap();
chk(s.idx === 1 && s.hasAna && s.anaText.trim() === ANA_J, 'A2 判断题同样显示解析', JSON.stringify({ idx: s.idx, ana: s.hasAna, txt: s.anaText }));

// 多选题：确定前不显示，确定后显示
await page.click('#nextBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.click('#opts .opt[data-i="1"]');
await page.waitForTimeout(200);
s = await snap();
chk(s.idx === 2 && s.nextBtn === '确定', 'A3 多选题未核对时主按钮是「确定」', JSON.stringify({ idx: s.idx, nextBtn: s.nextBtn }));
chk(!s.hasAna, 'A3 多选题在点「确定」之前不显示解析（否则等于剧透答案）', JSON.stringify({ hasAna: s.hasAna, fb: s.fbShown }));
await page.click('#nextBtn');                          // 点「确定」核对
await page.waitForTimeout(250);
s = await snap();
chk(s.fbShown && s.hasAna && s.anaText.trim() === ANA_M, 'A3 多选点「确定」后显示解析', JSON.stringify({ fb: s.fbShown, ana: s.hasAna }));
await page.screenshot({ path: path.join(SHOTS, 'ana-multi.png'), clip: { x: 0, y: 0, width: 420, height: 720 } });

// 没写解析的题：整块不出现，不留空壳
await page.click('#nextBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(200);
s = await snap();
chk(s.idx === 3 && s.fbShown, 'A4 走到没写解析的那道题并已回显答案', JSON.stringify({ idx: s.idx, fb: s.fbShown }));
chk(!s.hasAna, 'A4 题目没写解析 → 解析块整块不出现（不留空壳）', JSON.stringify({ hasAna: s.hasAna, html: s.anaHtml.slice(0, 60) }));
chk(!/class="ana/.test(await page.evaluate(() => document.getElementById('qBody').innerHTML)), 'A4 题面 HTML 里也没有残留的空解析块', '');

// 解析里的特殊字符：按纯文本渲染
await page.click('#nextBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(200);
s = await snap();
chk(s.idx === 4 && s.hasAna, 'A5 走到解析含特殊字符的题并显示了解析', JSON.stringify({ idx: s.idx, ana: s.hasAna }));
chk(s.anaText === ANA_HTML, 'A5 解析按纯文本原样显示（尖括号没被吞掉）', JSON.stringify(s.anaText));
chk(s.anaInnerTags === '' && !/<b>/.test(s.anaHtml), 'A5 解析里的 HTML 标签被转义，没有生成真实标签节点', JSON.stringify({ inner: s.anaInnerTags, html: s.anaHtml.slice(0, 120) }));

// 案例题
await page.click('#nextBtn');
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(200);
s = await snap();
chk(s.idx === 5 && s.hasAna && s.anaText.trim() === ANA_CASE, 'A6 案例题也显示解析', JSON.stringify({ idx: s.idx, ana: s.hasAna }));

/* ================= B 关掉开关 → 一个字都不显示 ================= */
await resetHome(FAKE, { revealAfter: true, showAns: false, showAnalysis: false });
await page.evaluate(() => window.__exam.start());
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(200);
s = await snap();
chk(s.fbShown, 'B1 开关关着时，答案照常回显', JSON.stringify({ fb: s.fbShown }));
chk(!s.hasAna, 'B1 开关关着时不显示解析（其它选项不受影响）', JSON.stringify({ hasAna: s.hasAna }));

/* ================= C 答案没回显 → 解析绝不能露（防剧透，最要紧的一条） ================= */
await resetHome(FAKE, { revealAfter: false, showAns: false, showAnalysis: true });
await page.evaluate(() => window.__exam.start());
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(200);
s = await snap();
chk(!s.fbShown, 'C1 顺序练习默认设置下，作答后不显示答案', JSON.stringify({ fb: s.fbShown }));
chk(!s.hasAna, 'C1 没回显答案时解析也不出现（否则解析里的答案会被提前看到）', JSON.stringify({ hasAna: s.hasAna }));
await page.click('#opts .opt[data-i="1"]');            // 改选正确答案
await page.waitForTimeout(200);
s = await snap();
chk(!s.hasAna, 'C1 改选答案后（仍未回显）依旧不露解析', JSON.stringify({ hasAna: s.hasAna }));

/* ================= D 「看答案」全程显示 → 解析跟着常显 ================= */
await resetHome(FAKE, { revealAfter: false, showAns: true, showAnalysis: true });
await page.evaluate(() => window.__exam.start());
await page.waitForTimeout(250);
s = await snap();
chk(s.fbShown && s.hasAna, 'D1 开着「看答案」时答案常显，解析也一并常显（浏览姿势）', JSON.stringify({ fb: s.fbShown, ana: s.hasAna }));

/* ================= E 「继续练习」进来时按当前开关渲染 ================= */
await resetHome(FAKE, { revealAfter: true, showAns: false, showAnalysis: true });
await page.evaluate(() => window.__exam.start());
await page.waitForTimeout(250);
await page.click('#opts .opt[data-i="0"]');
await page.waitForTimeout(200);
chk((await snap()).hasAna, 'E0 先答一道题（进度里带着已回显状态）', '');
await page.click('#quitBtn');                          // 退出 → 进度落盘、回首页
await page.waitForTimeout(350);
await page.evaluate(() => {                            // 回首页把「展示解析」关掉
  const el = document.getElementById('showAnalysis');
  el.checked = false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(150);
// 走真实入口（点首页的「继续练习」），而不是手工构造快照 —— 顺带验证按钮确实出来了
const cont = await page.evaluate(() => {
  const b = document.getElementById('continueBtn');
  return { hidden: b.classList.contains('hide'), w: Math.round(b.getBoundingClientRect().width) };
});
chk(!cont.hidden && cont.w > 0, 'E1 退出后首页出现「继续练习」按钮', JSON.stringify(cont));
await page.click('#continueBtn');
await page.waitForTimeout(400);
s = await snap();
chk(s.fbShown, 'E2 继续练习后答案仍按进度回显', JSON.stringify({ fb: s.fbShown, idx: s.idx }));
chk(!s.hasAna, 'E2 继续练习进来的解析按「当前设置」渲染，而不是沿用退出前的状态', JSON.stringify({ hasAna: s.hasAna }));
await page.evaluate(() => {
  const el = document.getElementById('showAnalysis');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});

/* ================= F 首页那行小字：本题库有多少题有解析 ================= */
const anaStatOf = async (fake) => {
  await resetHome(fake, { revealAfter: true, showAns: false, showAnalysis: true });
  return page.evaluate(() => {
    const el = document.getElementById('anaStat');
    return { text: el ? el.textContent.trim() : '(元素缺失)', warn: el ? el.classList.contains('warn') : null };
  });
};
/** 拍一张「练习选项」区块，留档给用户看开关与那行小字 */
const shotPrefs = async (name) => {
  const clip = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('#home .section')].find(s => s.textContent.includes('练习选项'));
    sec.scrollIntoView({ block: 'center' });
    const r = sec.getBoundingClientRect();
    const w = document.documentElement.clientWidth;
    return { x: 0, y: Math.max(0, Math.round(r.top - 10)), width: w, height: Math.round(Math.min(r.height + 20, 900)) };
  });
  await page.screenshot({ path: path.join(SHOTS, name), clip });
};
const stNone = await anaStatOf(FAKE_NONE);
chk(/暂无解析/.test(stNone.text), 'F1 整本都没解析时明确提示「本题库暂无解析」', JSON.stringify(stNone));
chk(stNone.warn === true, 'F1 该提示带 warn 样式（提示用户开关开了也看不到东西）', String(stNone.warn));
await shotPrefs('ana-prefs-none.png');
const stFew = await anaStatOf(FAKE_FEW);
chk(/2 \/ 6 题有解析/.test(stFew.text), 'F2 只有部分题有解析时给出真实计数（2 / 6）', JSON.stringify(stFew));
chk(stFew.warn === false, 'F2 有解析时不带 warn 样式', String(stFew.warn));
const stAll = await anaStatOf(FAKE);
chk(/5 \/ 6 题有解析/.test(stAll.text), 'F3 换题库后计数跟着变（5 / 6，只剩第 4 题没解析）', JSON.stringify(stAll));
await shotPrefs('ana-prefs-count.png');

/* ================= G 首页开关本体的状态 / 首帧不闪 ================= */
const ui = await page.evaluate(() => {
  const el = document.getElementById('showAnalysis');
  return { exists: !!el, checked: el.checked, defaultChecked: el.defaultChecked, type: el.type };
});
chk(ui.exists && ui.type === 'checkbox', 'G1 练习选项里存在「展示解析」开关', JSON.stringify(ui));
chk(ui.checked === true, 'G1 出厂默认是开着的', String(ui.checked));
chk(ui.defaultChecked === true, 'G1 HTML 的 checked 属性与默认值一致（首帧不会先画出关闭状态再跳）', String(ui.defaultChecked));

/* ================= H 手机宽度：解析块不溢出、长文本断行 ================= */
const mobile = [];
for (const w of [375, 320]) {
  await page.setViewportSize({ width: w, height: 812 });
  await resetHome(FAKE, { revealAfter: true, showAns: false, showAnalysis: true });
  await page.evaluate(() => window.__exam.start());
  await page.waitForTimeout(250);
  await page.click('#opts .opt[data-i="0"]');
  await page.waitForTimeout(250);
  const g = await snap();
  mobile.push({ w, ...g });
  if (w === 375) await page.screenshot({ path: path.join(SHOTS, 'ana-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 700 } });
}
for (const m of mobile) {
  chk(m.hasAna, `H1 ${m.w}px 宽：解析正常显示`, '');
  chk(m.scrollW <= m.docW, `H1 ${m.w}px 宽：无横向溢出`, m.scrollW + ' > ' + m.docW);
  chk(m.anaInside === true, `H1 ${m.w}px 宽：解析块没有超出题面容器`, JSON.stringify({ inside: m.anaInside, w: m.anaW }));
  chk(m.anaW > 0 && m.anaW <= m.docW, `H1 ${m.w}px 宽：解析块宽度合理（${m.anaW}px）`, '');
}

/* ================= I 静态核对（源码 + 交付产物） ================= */
const eng = fs.readFileSync(path.join(ROOT, 'src/engine.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

chk(/showAnalysis: true/.test(eng) && /showAnalysis: DEFAULT_PREFS\.showAnalysis/.test(eng),
  'I1 engine.js：出厂默认与 S 初值都带上了 showAnalysis', '');
chk(/if \(!S\.showAnalysis \|\| !mode\) return '';/.test(eng),
  'I2 engine.js：解析的显示条件与「答案是否回显」绑定（mode 为空就不显示）', '');
chk(/html \+= analysisHtml\(q, mode\);/.test(eng), 'I3 engine.js：renderQuestion 里确实调用了 analysisHtml', '');
chk(/escapeHtml\(txt\)/.test(eng), 'I4 engine.js：解析文本经 escapeHtml 转义后再渲染', '');
// 偏好类不进进度快照：否则「继续练习」会把用户刚改的开关拖回去
const snapBody = (eng.match(/function snapshotProgress[\s\S]*?\n\}/) || [''])[0];
chk(snapBody.length > 0 && !/showAnalysis/.test(snapBody),
  'I5 engine.js：showAnalysis 不写进进度快照（偏好跟用户，不跟快照）', '');
chk(/id="showAnalysis" checked/.test(html), 'I6 index.html：开关带 checked 属性（首帧一致）', '');
chk(/id="anaStat"/.test(html), 'I6 index.html：带「本题库有多少题有解析」的小字容器', '');
chk(/\.ana\{/.test(css) && /\.ana-h\{/.test(css) && /\.ana-b\{/.test(css),
  'I7 styles.css：解析块三件套样式都在', '');
chk(/\.ana-stat\.warn\{/.test(css), 'I7 styles.css：无解析时的 warn 样式在', '');

const distPath = path.join(ROOT, 'dist/index.html');
if (fs.existsSync(distPath)) {
  const dist = fs.readFileSync(distPath, 'utf8');
  chk(dist.includes('showAnalysis'), 'J1 单文件产物内含新开关', '');
  chk(dist.includes('anaStat') && dist.includes('本题库暂无解析'), 'J1 产物内含解析计数与空解析提示文案', '');
  chk(dist.includes('.ana-b{'), 'J1 产物内含解析块样式', '');
  chk(!dist.includes('__exam'), 'J2 产物内已剔除调试钩子', '');
}

chk(jsErrors.length === 0, 'K1 全程无 JS 报错', jsErrors.join(' | '));

await browser.close();
srv.kill();

console.log(`\n展示解析：${n - fails.length} / ${n} 通过`);
if (fails.length) {
  console.log('未通过：');
  fails.forEach(f => console.log('   · ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过（截图见 shots/ana-*.png）');
}
