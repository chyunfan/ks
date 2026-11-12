/**
 * 「答题卡：区分题型 + 已答未答配色 + 点击题号做多色标记」端到端验收。
 *
 * 为什么必须上真浏览器：这几件事全是**视觉通道的叠加**——
 *  ① 底色（未答灰 / 已答蓝 / 已看过答案绿=对、红=错）
 *  ② 右上角小三角（标记色）
 *  ③ 外描边（当前题）
 * 三者必须能同时出现在同一格上、互不覆盖；再加"选笔后点题号不跳题"。
 * 光读代码只能证明类名拼对了，证明不了它们真的能共存、也没法证明标记真的落了盘。
 *
 * 用法：node scripts/check_sheet.mjs
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
const PORT = 5215;
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

/* ---------- 2. 打开页面 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());   // 退出练习 / 清空标记的 confirm 一律确认

await page.goto(URL_APP);
await page.waitForTimeout(1000);

// 四种题型各来几道：3 单选 + 2 多选 + 2 判断 + 1 个案例组（3 小题）
// 多选故意做成「不是全选」、判断故意答「错误」，这样两个「去除」开关不论开关都不会把它们滤掉。
const mkOpts = (texts) => texts.map((t, i) => ({ key: String.fromCharCode(65 + i), text: t }));
const mkSingle = (id, stem, texts, ci) => ({ id, type: 'single', stem, options: mkOpts(texts), answerKeys: [String.fromCharCode(65 + ci)], answerText: String.fromCharCode(65 + ci), correctIdx: ci, analysis: null });
const FAKE = [
  mkSingle(1, '答题卡验收 1：1+1=?', ['1', '2', '3'], 1),
  mkSingle(2, '答题卡验收 2：2+2=?', ['3', '4', '5'], 1),
  mkSingle(3, '答题卡验收 3：3+3=?', ['5', '6', '7'], 1),
  { id: 4, type: 'multiple', stem: '答题卡验收 4：下列哪些是偶数？', options: mkOpts(['2', '4', '5', '7']), answerKeys: ['A', 'B'], answerText: 'A. 2；B. 4', correctIdx: [0, 1], analysis: null },
  { id: 5, type: 'multiple', stem: '答题卡验收 5：下列哪些是奇数？', options: mkOpts(['3', '5', '8', '10']), answerKeys: ['A', 'B'], answerText: 'A. 3；B. 5', correctIdx: [0, 1], analysis: null },
  { id: 6, type: 'judge', stem: '答题卡验收 6：1+1=3。', options: mkOpts(['正确', '错误']), answerKeys: ['B'], answerText: '错误', correctIdx: [1], analysis: null },
  { id: 7, type: 'judge', stem: '答题卡验收 7：2+2=5。', options: mkOpts(['正确', '错误']), answerKeys: ['B'], answerText: '错误', correctIdx: [1], analysis: null },
  Object.assign(mkSingle(8, '案例小题 1：该业务应如何处理？', ['甲', '乙', '丙'], 1), { isCase: true, caseId: 1, caseBackground: '某支行受理了一笔贷款业务……' }),
  Object.assign(mkSingle(9, '案例小题 2：应由谁审批？', ['甲', '乙', '丙'], 1), { isCase: true, caseId: 1, caseBackground: '某支行受理了一笔贷款业务……' }),
  Object.assign(mkSingle(10, '案例小题 3：需要哪些材料？', ['甲', '乙', '丙'], 1), { isCase: true, caseId: 1, caseBackground: '某支行受理了一笔贷款业务……' })
];

await page.evaluate(async (fake) => {
  if (!window.__exam || !window.__store) throw new Error('调试钩子未注入（dev 模式吗？）');
  Object.keys(localStorage)
    .filter(k => k.startsWith('ce_') || k.startsWith('credit_exam'))
    .forEach(k => localStorage.removeItem(k));
  await window.__store.loadBankState(null, false);
  window.__store.saveArr(window.__store.LS.wrong, [3, 6]);     // 错题集 2 题
  window.__store.saveArr(window.__store.LS.fav, [4, 5]);        // 收藏 2 题
  window.__exam.setQuestions(fake);
  window.__exam.initEngine();
  // 本脚本测的是答题卡底色（未答 / 已答 / 对 / 错）与标记共存：
  // "已答但还没回显答案"才是蓝底，所以这里显式关掉「选完展示正确答案」。
  // （v2.16 起它**出厂默认是开着的**，开着的话单选答完即回显 → 格子直接变绿/红，C1/D4 的蓝底断言就不成立了；
  //   这个开关本身的默认值由 scripts/check_defaults.mjs 验收）
  const ra = document.getElementById('revealAfter');
  ra.checked = false;
  ra.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('auth').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  document.getElementById('topBankName').textContent = '答题卡验收库';
  for (const s of ['banks', 'home', 'practice', 'result']) {
    document.getElementById(s).classList.toggle('hide', s !== 'home');
  }
  window.__exam.refreshHomeUI();
}, FAKE);

/* ---------- 3. 断言 ---------- */
const fails = [];
let n = 0;
const chk = (cond, name, extra) => { n++; if (!cond) fails.push(`T${n} ${name}${extra ? ' → ' + extra : ''}`); };

/** 答题卡整块状态：分组 / 每格类名 / 统计 / 标记笔 */
const sheet = () => page.evaluate(() => {
  const card = document.getElementById('sheetCard');
  const grps = [...document.querySelectorAll('#sheet .sh-grp')].map(g => ({
    t: g.dataset.t,
    badge: g.querySelector('.sh-grp-h .badge').textContent.trim(),
    n: g.querySelectorAll('.c').length,
    head: g.querySelector('.sh-grp-n').textContent.replace(/\s+/g, ' ').trim()
  }));
  const cells = [...document.querySelectorAll('#sheet .c')].map(c => ({
    go: parseInt(c.dataset.go, 10),
    text: c.textContent.trim(),
    cls: [...c.classList].filter(x => x !== 'c').sort()
  }));
  return {
    shown: !card.classList.contains('hide'),
    toggleShown: !document.getElementById('sheetToggle').classList.contains('hide'),
    grps, cells,
    stat: document.getElementById('sheetStat').textContent.replace(/\s+/g, ' ').trim(),
    count: document.getElementById('sheetCount').textContent.trim(),
    hint: document.getElementById('sheetHint').textContent.trim(),
    clearShown: !document.getElementById('sheetClearMarks').classList.contains('hide'),
    pens: [...document.querySelectorAll('#sheetPens .pen')].map(p => ({ pen: p.dataset.pen, on: p.classList.contains('on') })),
    legend: [...document.querySelectorAll('.sh-legend span')].map(s => s.textContent.trim())
  };
});
const cellOf = (cells, go) => (cells.find(c => c.go === go) || { cls: [] });
const openSheet = async () => {
  const st0 = await sheet();
  if (!st0.shown) { await page.click('#sheetToggle'); await page.waitForTimeout(180); }
  return sheet();
};
const pen = async p => { await page.click('#sheetPens .pen[data-pen="' + p + '"]'); await page.waitForTimeout(120); };
const tapCell = async go => { await page.click('#sheet .c[data-go="' + go + '"]'); await page.waitForTimeout(180); };
const answers = () => page.evaluate(() => ({
  idx: window.__exam.S.idx,
  mode: window.__exam.S.mode,
  pool: window.__exam.S.pool.length,
  pcount: document.getElementById('pcount').textContent.trim()
}));

/* ================= A 答题卡不再是「组卷专属」 ================= */
await page.click('.mode[data-mode="sequential"]');
await page.waitForTimeout(150);
await page.click('#startBtn');
await page.waitForTimeout(300);
let a = await answers();
chk(a.mode === 'sequential' && a.pool === 10, 'A1 顺序练习开练，pool = 10 题（三单选两多选两判断一组案例）', JSON.stringify(a));

let st = await sheet();
chk(st.toggleShown, 'A2 ⭐ 顺序练习（非组卷模式）也能看到「答题卡」入口', String(st.toggleShown));
st = await openSheet();
chk(st.shown, 'A2 点开后答题卡面板显示出来');

chk(st.grps.map(g => g.t).join() === 'single,multiple,judge,case', 'A3 题型分组顺序：单选→多选→判断→案例', st.grps.map(g => g.t).join());
chk(st.grps.map(g => g.badge).join() === '单选题,多选题,判断题,案例题', 'A3 每组组头带题型徽标', st.grps.map(g => g.badge).join());
chk(st.grps.map(g => g.n).join() === '3,2,2,3', 'A3 各组题数 3 / 2 / 2 / 3（案例 3 道小题归一组）', st.grps.map(g => g.n).join());
chk(st.grps.every(g => /题 · 已答 0$/.test(g.head)), 'A3 组头写明该组「N 题 · 已答 M」', JSON.stringify(st.grps.map(g => g.head)));
chk(st.cells.length === 10 && st.cells.map(c => c.text).join('') === '12345678910', 'A3 十格题号按原顺序显示 1..10', st.cells.map(c => c.text).join(','));

const fresh = st.cells.filter(c => c.cls.length === 0).length;
chk(fresh === 9 && cellOf(st.cells, 0).cls.join() === 'cur', 'A4 未答全灰、只有当前题（第 1 题）带描边', fresh + ' 灰 / ' + JSON.stringify(cellOf(st.cells, 0).cls));
chk(st.stat === '已答 0 · 未答 10' && st.count === '(0/10)', 'A4 统计行与按钮计数都是 0/10', st.stat + ' | ' + st.count);
chk(!st.clearShown, 'A4 还没有标记时不显示「清空标记」', String(st.clearShown));
chk(st.legend.join('|') === '未答|已答|答对|答错|当前|标记', 'A4 图例六项齐全（未答/已答/答对/答错/当前/标记）', st.legend.join('|'));
chk(st.pens.filter(p => p.on).length === 1 && st.pens.find(p => p.on).pen === 'jump', 'A4 默认选中的是「跳转」笔', JSON.stringify(st.pens));

/* ================= B 跳转笔：点题号 = 跳题（原行为不变） ================= */
await pen('jump');
await tapCell(5);
a = await answers();
st = await sheet();
chk(a.idx === 5 && a.pcount === '第 6 / 10 题', 'B1 跳转笔下点第 6 格 → 真的跳到第 6 题', JSON.stringify({ idx: a.idx, pcount: a.pcount }));
chk(!st.shown, 'B1 跳完之后答题卡自动收起（和原来一致）', String(st.shown));

/* ================= C 底色：已答 / 对 / 错 ================= */
await openSheet();
await tapCell(1);                                          // 跳到第 2 题（单选）
await page.click('#opts .opt[data-i="1"]');                // 选 B → 答对
await page.waitForTimeout(200);
await openSheet();
await tapCell(2);                                          // 跳到第 3 题（单选）
await page.click('#opts .opt[data-i="0"]');                // 选 A → 答错
await page.waitForTimeout(250);

st = await openSheet();
chk(st.cells.filter(c => c.cls.includes('ans')).length === 2, 'C1 答完两题（还没看答案）→ 两格是「已答」蓝底', JSON.stringify(st.cells.map(c => c.cls.join('+'))));
chk(st.stat === '已答 2 · 未答 8' && st.count === '(2/10)', 'C1 统计行跟着变：已答 2 · 未答 8', st.stat + ' | ' + st.count);
chk(st.grps[0].head === '3 题 · 已答 2', 'C1 组头也按组统计（单选题 3 题 · 已答 2）', st.grps[0].head);

// 打开「看答案」→ 已答的格子应当立刻分化成绿（对）/ 红（错）
await page.evaluate(() => { window.__exam.S.showAns = true; window.__exam.renderSheet(); });
await page.waitForTimeout(180);
st = await sheet();
chk(cellOf(st.cells, 1).cls.join() === 'right', 'C2 第 2 题（答对）→ 绿底', JSON.stringify(cellOf(st.cells, 1).cls));
chk(cellOf(st.cells, 2).cls.join() === 'cur,wrong', 'C2 第 3 题（答错）→ 红底，且保留当前题描边', JSON.stringify(cellOf(st.cells, 2).cls));
chk(!cellOf(st.cells, 1).cls.includes('ans'), 'C2 ⭐ 看过答案后不再停留在「已答」蓝底（对错信息优先）', JSON.stringify(cellOf(st.cells, 1).cls));
await page.evaluate(() => { window.__exam.S.showAns = false; window.__exam.renderSheet(); });
await page.waitForTimeout(180);

/* ================= D 三色标记：点题号上色，不跳题 ================= */
await pen('1');
st = await sheet();
chk(/存疑/.test(st.hint) && /不会跳题/.test(st.hint), 'D1 选「存疑」笔后提示写明：点题号上色、不会跳题', st.hint);
chk(st.pens.find(p => p.on).pen === '1', 'D1 「存疑」笔变成选中态', JSON.stringify(st.pens));

const idxBefore = (await answers()).idx;
await tapCell(0);
a = await answers(); st = await sheet();
chk(cellOf(st.cells, 0).cls.includes('mk') && cellOf(st.cells, 0).cls.includes('m1'), 'D2 点第 1 格 → 打上黄标（mk + m1）', JSON.stringify(cellOf(st.cells, 0).cls));
chk(a.idx === idxBefore, 'D2 ⭐ 上色模式下点题号不会跳题（idx 不变）', idxBefore + ' → ' + a.idx);
chk(st.shown, 'D2 上色后答题卡保持展开，方便连着标好几题', String(st.shown));
chk(st.clearShown && /标记/.test(st.stat), 'D2 有标记后出现「清空标记」并在统计行显示标记数', st.stat);

await tapCell(0);
st = await sheet();
chk(!cellOf(st.cells, 0).cls.includes('mk'), 'D3 同一支笔再点一次 → 取消该标记', JSON.stringify(cellOf(st.cells, 0).cls));

await pen('1'); await tapCell(0);
await pen('2'); await tapCell(1);
await pen('3'); await tapCell(2);
st = await sheet();
const mkCells = st.cells.filter(c => c.cls.includes('mk'));
chk(['m1', 'm2', 'm3'].every(k => st.cells.some(c => c.cls.includes(k))), 'D4 三支笔各标一格 → m1/m2/m3 三种颜色同时存在', JSON.stringify(mkCells.map(c => c.cls.join('+'))));
chk(/标记/.test(st.stat) && /3/.test(st.stat), 'D4 统计行显示「标记 3」', st.stat);
chk(cellOf(st.cells, 1).cls.includes('ans') && cellOf(st.cells, 1).cls.includes('mk'), 'D4 ⭐ 标记与「已答」底色共存（三角 vs 底色，互不覆盖）', JSON.stringify(cellOf(st.cells, 1).cls));

/* ================= E 标记落盘 + 重进题库仍在 ================= */
let ls = await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('credit_exam_progress') || 'null');
  return { v: raw && raw.v, marks: (raw && raw.marks) || null };
});
chk(ls.v === 4 && ls.marks && Object.keys(ls.marks).length === 3, 'E1 标记随进度一起落盘（v4 + marks 3 项）', JSON.stringify(ls));
chk(ls.marks['1'] === 1 && ls.marks['2'] === 2 && ls.marks['3'] === 3, 'E1 落盘用的是「题目id → 颜色」映射（1→黄 2→紫 3→青）', JSON.stringify(ls.marks));

const re = await page.evaluate(async () => {
  await window.__store.loadBankState(null, false);     // 模拟重新进题库
  window.__exam.refreshHomeUI();
  window.__exam.renderSheet();
  return { m1: window.__store.markOf(1), m3: window.__store.markOf(3), cnt: window.__store.markCount() };
});
chk(re.m1 === 1 && re.m3 === 3 && re.cnt === 3, 'E1 ⭐ 重新进题库后标记还在（markOf 1→黄、3→青）', JSON.stringify(re));

/* ================= F 擦除笔 + 练完一遍标记不丢 ================= */
const beforeCnt = await page.evaluate(() => window.__store.markCount());
await pen('0');
await tapCell(1);
st = await sheet();
chk(!cellOf(st.cells, 1).cls.includes('mk') && st.cells.filter(c => c.cls.includes('mk')).length === 2, 'F1 擦除笔点一下 → 只去掉那一格的标记，其余不动', JSON.stringify(st.cells.filter(c => c.cls.includes('mk')).map(c => c.cls.join('+'))));
chk(await page.evaluate(() => window.__store.markCount()) === beforeCnt - 1, 'F1 擦除后标记总数 -1', String(beforeCnt));
chk(/擦除/.test(st.hint), 'F1 擦除笔的提示文案正确', st.hint);

await pen('jump');
await tapCell(9);                                          // 跳到最后一题
await page.click('#nextBtn');                              // 最后一题的主按钮 = 完成
await page.waitForTimeout(700);
const done = await page.evaluate(() => ({
  resultShown: !document.getElementById('result').classList.contains('hide'),
  prog: Object.keys(window.__store.loadProgressMap()),
  marks: window.__store.markCount()
}));
chk(done.resultShown, 'F2 顺序练习走完进入结果页', String(done.resultShown));
chk(done.prog.length === 0, 'F2 练习完成后进度被清掉（原有语义不变）', JSON.stringify(done.prog));
chk(done.marks === 2, 'F2 ⭐ 标记不随进度被清（练完一遍标记还在）', String(done.marks));

/* ================= G 四种模式都能开答题卡 ================= */
await page.click('#quitBtn2');
await page.waitForTimeout(300);
// 提示：走完一遍练习会把"没答对的题"都加进错题集（showResult 里的既有行为），
// 所以这里先把错题集重置成固定的 2 题，否则错题练习的 pool 会被上一步污染。
await page.evaluate(() => window.__store.saveArr(window.__store.LS.wrong, [3, 6]));
for (const [m, expect] of [['wrong', 2], ['fav', 2], ['exam', 10]]) {
  await page.click('.mode[data-mode="' + m + '"]');
  await page.waitForTimeout(220);
  await page.click('#startBtn');
  await page.waitForTimeout(m === 'exam' ? 500 : 300);
  const s2 = await openSheet();
  const a2 = await answers();
  chk(s2.shown && s2.cells.length === expect, 'G1 ' + m + ' 模式也能打开答题卡并渲染 ' + expect + ' 格',
    JSON.stringify({ shown: s2.shown, cells: s2.cells.length, mode: a2.mode, pool: a2.pool, grps: s2.grps.map(g => g.t + ':' + g.n) }));
  await page.click('#quitBtn');
  await page.waitForTimeout(300);
}

/* ================= H 手机端不挤爆 ================= */
await page.click('.mode[data-mode="sequential"]');
await page.waitForTimeout(220);
await page.click('#startBtn');
await page.waitForTimeout(300);
await openSheet();
await page.evaluate(() => window.scrollTo(0, 0));
await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(400);
const mob = await page.evaluate(() => {
  const card = document.getElementById('sheetCard').getBoundingClientRect();
  const inner = [...document.querySelectorAll('#sheetCard .pen, #sheetCard .sh-legend .c, #sheetCard .sh-clear')];
  return {
    clientW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    cardR: Math.round(card.right),
    worstR: inner.length ? Math.round(Math.max(...inner.map(e => e.getBoundingClientRect().right))) : 0,
    cells: document.querySelectorAll('#sheet .c').length
  };
});
chk(mob.scrollW <= mob.clientW, 'H1 375px 打开答题卡后无横向溢出', mob.scrollW + ' > ' + mob.clientW);
chk(mob.worstR <= mob.cardR + 1, 'H1 375px：标记笔/图例/清空按钮都没越出卡片右边界', mob.worstR + ' > ' + mob.cardR);
await page.screenshot({ path: path.join(SHOTS, 'sheet-mobile.png') });

await page.setViewportSize({ width: 320, height: 700 });
await page.waitForTimeout(400);
const mob2 = await page.evaluate(() => ({
  clientW: document.documentElement.clientWidth,
  scrollW: document.documentElement.scrollWidth
}));
chk(mob2.scrollW <= mob2.clientW, 'H2 320px 同样无横向溢出', mob2.scrollW + ' > ' + mob2.clientW);

/* ================= I 桌面截图 + 清空标记 ================= */
await page.setViewportSize({ width: 1100, height: 1000 });
await page.waitForTimeout(350);
await openSheet();
// 造一张"什么状态都有"的图：答对/答错/已答未揭示 + 三种标记同时在场，一眼能看出四个通道互不打架
await page.evaluate(() => {
  const S = window.__exam.S;
  S.userAns[1] = 1; S.revealed[1] = true;      // 第 2 题：答对（绿）
  S.userAns[2] = 0; S.revealed[2] = true;      // 第 3 题：答错（红）
  S.userAns[3] = [0];                          // 第 4 题：已答但没看过答案（蓝）
  window.__exam.setMark(2, 2);                 // 第 2 题：紫标（与"绿底"共存）
  window.__exam.setMark(6, 1);                 // 第 6 题：黄标（未答 + 标记）
  window.__exam.setMark(10, 3);                // 第 10 题：青标
  window.__exam.renderSheet();
});
await page.waitForTimeout(200);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: path.join(SHOTS, 'sheet-desktop.png') });

await page.click('#sheetClearMarks');
await page.waitForTimeout(300);
st = await sheet();
const after = await page.evaluate(() => ({
  cnt: window.__store.markCount(),
  lsMarks: (JSON.parse(localStorage.getItem('credit_exam_progress') || 'null') || {}).marks
}));
chk(st.cells.every(c => !c.cls.includes('mk')) && after.cnt === 0, 'I1 「清空标记」把本题库标记清干净', JSON.stringify({ mkCells: st.cells.filter(c => c.cls.includes('mk')).length, cnt: after.cnt }));
chk(!st.clearShown && !/标记/.test(st.stat), 'I1 清空后按钮收起、统计行不再显示标记数', st.stat);
chk(!after.lsMarks || Object.keys(after.lsMarks).length === 0, 'I1 清空动作也落了盘', JSON.stringify(after.lsMarks));

chk(jsErrors.length === 0, 'J1 全程无 JS 报错', jsErrors.join(' | '));

/* ---------- 收尾 ---------- */
await browser.close();
srv.kill();

console.log(`\n答题卡：${n - fails.length} / ${n} 通过`);
if (fails.length) {
  console.log('未通过：');
  fails.forEach(f => console.log('   · ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过（截图见 shots/sheet-*.png）');
}
