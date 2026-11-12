/**
 * 「组卷模拟：按题库题型自选题量 + 配置按题库保存」端到端验收。
 *
 * 覆盖点：
 *  T1  题库只有部分题型时，题型行只出现实际存在的题型
 *  T2  「题目类型」勾选变化 → 题型行随之增减、可用量重算
 *  T3  「去除多选全选 / 去除正确判断题」开关影响可用量（与真正抽题同口径）
 *  T4  ± 与「全部」按钮、输入框自定义题量、超量自动收敛
 *  T5  配置数 > 可用量时出现黄色提醒，满分按实际可抽量计算
 *  T6  组卷配置按题库保存：切走再切回，题量原样带出
 *  T7  配置写进 localStorage（credit_exam_cfg.examCfgByBank）
 *  T8  满分随配置实时变化；「恢复默认」在题库充足时回到 100 分
 *  T9  真正开考：抽到的题量 = min(配置, 可用)，满分 = 实际分值合计
 *  T10 界面提示"已保存到题库"
 *
 * 用法：node scripts/check_examcfg.mjs
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
const PORT = 5201;
const URL_APP = `http://localhost:${PORT}/ks/`;

/* ---------- 1. 起 dev server ---------- */
const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((res, rej) => {
  const t0 = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - t0 > 40000) { clearInterval(timer); rej(new Error('vite dev server 启动超时')); return; }
    try { const r = await fetch(URL_APP); if (r.ok) { clearInterval(timer); res(); } } catch (e) { }
  }, 400);
  srv.stderr.on('data', d => process.stderr.write(d));
});

/* ---------- 2. 打开页面 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2 });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());
await page.goto(URL_APP);
await page.waitForTimeout(1200);

/* ---------- 3. 构造两套假题库并清干净本地存储 ---------- */
await page.evaluate(() => {
  Object.keys(localStorage).filter(k => k.startsWith('ce_') || k.startsWith('credit_exam')).forEach(k => localStorage.removeItem(k));
  // 小库：5 单选 / 4 多选（含 1 道全选）/ 3 判断 / 2 组案例（每组 2 小题）
  const mk = (id, type, extra) => Object.assign({
    id, type, stem: 'Q' + id,
    options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }, { key: 'C', text: 'C' }],
    answerKeys: ['A'], answerText: 'A', correctIdx: [0], analysis: null
  }, extra || {});
  const small = [];
  for (let i = 1; i <= 5; i++) small.push(mk(i, 'single'));
  for (let i = 6; i <= 8; i++) small.push(mk(i, 'multiple', { correctIdx: [0, 1] }));
  small.push(mk(9, 'multiple', { correctIdx: [0, 1, 2], answerKeys: ['A', 'B', 'C'] }));   // 全选
  for (let i = 10; i <= 12; i++) small.push(mk(i, 'judge', { answerText: '错误', correctIdx: [1], answerKeys: ['B'] }));
  for (let c = 1; c <= 2; c++) for (let s = 1; s <= 2; s++) {
    small.push(mk(100 + c * 10 + s, 'single', { isCase: true, caseId: 'case' + c, caseStem: '案例' + c }));
  }
  // 大库：97 单选 / 56 多选（5 道全选）/ 30 判断（6 道「正确」，去正确后剩 24）/ 5 组案例（每组 3 小题）
  const big = [];
  let id = 1000;
  const push = (type, extra) => big.push(mk(++id, type, extra));
  for (let i = 0; i < 97; i++) push('single');
  for (let i = 0; i < 51; i++) push('multiple', { correctIdx: [0, 1] });
  for (let i = 0; i < 5; i++) push('multiple', { correctIdx: [0, 1, 2], answerKeys: ['A', 'B', 'C'] });
  for (let i = 0; i < 24; i++) push('judge', { answerText: '错误', correctIdx: [1], answerKeys: ['B'] });
  for (let i = 0; i < 6; i++) push('judge', { answerText: '正确', correctIdx: [0], answerKeys: ['A'] });
  for (let c = 1; c <= 5; c++) for (let s = 0; s < 3; s++) push('single', { isCase: true, caseId: 'big' + c, caseStem: '大案例' + c });
  window.__small = small; window.__big = big;
});

/** 打开题库（相当于 main.js handleOpenBank）：设题 + 设 bankKey + 重渲染 */
async function openBank(bankId, questions) {
  await page.evaluate(({ bankId, questions }) => {
    window.__exam.setQuestions(questions);
    window.__exam.setBankKey(bankId);
    window.__exam.refreshHomeUI();
    // 跳过登录界面，直接进首页（本脚本不测登录）
    document.getElementById('auth').classList.add('hide');
    document.getElementById('app').classList.remove('hide');
    ['banks', 'practice', 'result'].forEach(s => document.getElementById(s).classList.add('hide'));
    document.getElementById('home').classList.remove('hide');
  }, { bankId, questions });
  await page.waitForTimeout(150);
}
const toExamMode = async () => {
  await page.click('.mode[data-mode="exam"]');
  await page.click('#examCfgHead');           // 展开组卷设置
  await page.waitForTimeout(150);
};
/** 读界面上每一行题型 */
const readRows = () => page.evaluate(() => Array.from(document.querySelectorAll('#ecRows .ec-row')).map(r => ({
  t: r.dataset.t,
  label: r.querySelector('.lbl').textContent.trim(),
  hint: r.querySelector('.hint').textContent.trim(),
  avail: parseInt(r.querySelector('input').getAttribute('data-avail'), 10),
  value: parseInt(r.querySelector('input').value, 10)
})));
const readSum = () => page.evaluate(() => ({
  text: document.getElementById('ecSummary').textContent,
  full: parseFloat(document.getElementById('maxScore').textContent),
  warnShown: !document.getElementById('ecWarn').classList.contains('hide'),
  warn: document.getElementById('ecWarn').textContent.trim(),
  saved: document.getElementById('ecSaved').textContent.trim(),
  card: document.getElementById('examCounts').textContent
}));
const setCount = async (t, v) => {
  await page.fill(`#ecRows input[data-t="${t}"]`, String(v));
  await page.evaluate(t => document.querySelector(`#ecRows input[data-t="${t}"]`).dispatchEvent(new Event('change', { bubbles: true })), t);
  await page.waitForTimeout(80);
};
const counts = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__exam.S.examCounts)));
/** 开关类元素（.switch 内的 checkbox 被视觉隐藏，不能用真实点击） */
const toggle = async (id) => {
  await page.evaluate(id => document.getElementById(id).click(), id);
  await page.waitForTimeout(150);
};

const results = [];
const chk = (ok, name, extra) => { results.push({ ok, name, extra }); };

/* ================= v2.16 起出厂默认：两个「去除」开关都是**关**的 =================
   本脚本里所有可用量口径（小库多选 3、大库 97/51/24/5）都是"两个开关都打开"时的值，
   所以先按真实用户点击的方式把这两个开关打开，后面的断言才与口径一致。
   （开关默认值本身是独立的验收点，见 scripts/check_defaults.mjs） */
await page.evaluate(() => {
  ['rmAll', 'rmCorrectJudge'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
});
await page.waitForTimeout(200);

/* ================= T1 题型行只出现在题库实际有的题型 ================= */
await openBank('bank-small', await page.evaluate(() => window.__small));
await toExamMode();
let rows = await readRows();
chk(rows.map(r => r.t).join() === 'single,multiple,judge,case', 'T1 四种题型齐全时按 单选/多选/判断/案例 顺序生成 4 行', rows.map(r => r.t + '=' + r.avail).join(' '));
chk(rows[0].avail === 5 && rows[1].avail === 3 && rows[2].avail === 3 && rows[3].avail === 2,
  'T1 各行可用量与题库一致（单选5 / 多选3[全选已去除] / 判断3 / 案例2组）', rows.map(r => r.avail).join('/'));
chk(/可用/.test(rows[0].hint), 'T1 每行显示「题库可用 N 题」', rows[0].hint);
// 新题库（该题库还没存过配置）→ 给标准配置，但按可用量收敛，免得一进来就满屏"题库不足"
chk(JSON.stringify(await counts()) === JSON.stringify({ single: 5, multiple: 3, judge: 3, case: 2 }),
  'T1 新题库默认配置按可用量收敛（5/3/3/2，而非 60/40/20/5）', JSON.stringify(await counts()));
chk(!(await readSum()).warnShown, 'T1 新题库首次进入不出现「题库不足」提醒');

/* ================= T3 去除开关影响可用量（与真正抽题同口径） ================= */
await toggle('rmAll');                       // 关掉「去除多选全选」
rows = await readRows();
chk(rows[1].avail === 4, 'T3 关掉「去除多选全选」→ 多选题可用量 3 → 4', String(rows[1].avail));
await toggle('rmAll');
rows = await readRows();
chk(rows[1].avail === 3, 'T3 重新打开 → 回到 3（全选题被剔除）', String(rows[1].avail));
await toggle('rmAll');                       // 再关掉：后续用例按「多选可用 4」断言

/* ================= T2 题型勾选变化 → 行随之增减 ================= */
await page.click('#typeChips .chip[data-t="judge"]');   // 取消勾选判断题
await page.waitForTimeout(150);
rows = await readRows();
chk(!rows.some(r => r.t === 'judge'), 'T2 取消勾选「判断题」→ 判断题行消失', rows.map(r => r.t).join());
await page.click('#typeChips .chip[data-t="judge"]');
await page.waitForTimeout(150);
rows = await readRows();
chk(rows.some(r => r.t === 'judge'), 'T2 重新勾选 → 判断题行回来', rows.map(r => r.t).join());

/* ================= T4 自定义题量 / ± / 全部 / 超量收敛 ================= */
await setCount('single', 4);
chk((await counts()).single === 4, 'T4 输入框自定义题量：单选设为 4', String((await counts()).single));
await page.click('#ecRows .ec-step[data-t="single"][data-step="1"]');
await page.waitForTimeout(120);
chk((await counts()).single === 5, 'T4 「+」按钮 +1 → 5', String((await counts()).single));
await page.click('#ecRows .ec-step[data-t="single"][data-step="-1"]');
await page.waitForTimeout(120);
chk((await counts()).single === 4, 'T4 「−」按钮 −1 → 4', String((await counts()).single));
await page.click('#ecRows .ec-max[data-t="single"]');
await page.waitForTimeout(120);
chk((await counts()).single === 5, 'T4 「全部」→ 取该题型可用量 5', String((await counts()).single));
// 超量输入
await page.fill('#ecRows input[data-t="single"]', '999');
await page.evaluate(() => document.querySelector('#ecRows input[data-t="single"]').dispatchEvent(new Event('change', { bubbles: true })));
await page.waitForTimeout(150);
chk((await counts()).single === 5, 'T4 输入 999 → 自动收敛到可用量 5', String((await counts()).single));
chk((await page.$eval('#ecRows input[data-t="single"]', el => el.value)) === '5', 'T4 输入框显示值同步收敛为 5');

/* ================= T8 满分实时计算 ================= */
await setCount('multiple', 4);
await setCount('judge', 3);
await setCount('case', 2);
let sum = await readSum();
// 5×0.5 + 4×1 + 3×0.5 + 2×4 = 2.5 + 4 + 1.5 + 8 = 16
chk(sum.full === 16, 'T8 满分实时 = 单选5×0.5 + 多选4×1 + 判断3×0.5 + 案例2×4 = 16', String(sum.full));
chk(/满分/.test(sum.card) && /16/.test(sum.card), 'T8 首页「组卷模拟考试」卡片同步显示满分与时长', sum.card);
chk(/已选\s*14\s*项/.test(sum.text), 'T8 汇总行显示已选题量 14 项', sum.text);

/* ================= T5 超量提醒 + 满分按实际可抽量 ================= */
await toggle('rmAll');                       // 打开去全选：多选可用 4 → 3
sum = await readSum();
chk(sum.warnShown && /多选题 配置 4 题，题库仅 3 题/.test(sum.warn), 'T5 可用量下降后出现「题库不足」提醒', sum.warn);
chk(sum.full === 15, 'T5 满分按实际可抽量算：2.5 + 3 + 1.5 + 8 = 15', String(sum.full));
chk(/应为 16 分/.test(sum.text), 'T5 汇总行同时标注「按配置应为 16 分」', sum.text);
await toggle('rmAll');
sum = await readSum();
chk(!sum.warnShown, 'T5 恢复后提醒自动消失', String(sum.warnShown));
await toggle('rmAll');                       // 再打开「去除多选全选」：后续按默认口径断言

/* ================= T10 保存提示 ================= */
sum = await readSum();
chk(/已保存到/.test(sum.saved) && /题库/.test(sum.saved), 'T10 界面提示「已保存到题库…」', sum.saved);

/* ================= T6/T7 按题库保存 ================= */
await openBank('bank-big', await page.evaluate(() => window.__big));
await toExamMode();
sum = await readSum();
rows = await readRows();
chk(rows.map(r => r.avail).join('/') === '97/51/24/5', 'T6 换到大库后可用量按大库重算（97/51/24/5）', rows.map(r => r.avail).join('/'));
chk(JSON.stringify(await counts()) === JSON.stringify({ single: 60, multiple: 40, judge: 20, case: 5 }),
  'T6 大库（题库充足）首次进入 → 标准配置 60/40/20/5', JSON.stringify(await counts()));
chk(sum.full === 100, 'T6 大库默认配置 60/40/20/5 → 满分 100 分', String(sum.full));
// 大库自定义配置
await setCount('single', 30);
await setCount('multiple', 20);
await page.click('#ecZeroAll');
await page.waitForTimeout(150);
chk((await counts()).case === 0 && (await counts()).judge === 0, 'T6 「全部清零」→ 判断题/案例题归零', JSON.stringify(await counts()));
// 用「恢复默认」回到 100 分
await page.click('#ecDefault');
await page.waitForTimeout(150);
sum = await readSum();
chk(sum.full === 100, 'T8 「恢复默认（100 分）」在题库充足时回到满分 100', String(sum.full));
chk(JSON.stringify(await counts()) === JSON.stringify({ single: 60, multiple: 40, judge: 20, case: 5 }),
  'T8 恢复默认题量 = 60/40/20/5', JSON.stringify(await counts()));
// 大库设一个特别配置，然后切回小库
await setCount('single', 37);
await page.click('#ecMaxAll');
await page.waitForTimeout(150);
const bigCounts = await counts();
await openBank('bank-small', await page.evaluate(() => window.__small));
await toExamMode();
const smallCounts = await counts();
chk(smallCounts.single === 5 && smallCounts.multiple === 4 && smallCounts.judge === 3 && smallCounts.case === 2,
  'T6 切回小库：小库自己的配置被带出（5/4/3/2，不是大库的）', JSON.stringify(smallCounts));
await openBank('bank-big', await page.evaluate(() => window.__big));
await toExamMode();
chk(JSON.stringify(await counts()) === JSON.stringify(bigCounts),
  'T6 再切回大库：大库的配置原样带出', JSON.stringify(await counts()));

/* ================= T7 localStorage 落盘 ================= */
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem(window.__exam.prefsKey()) || 'null'));
chk(stored && stored.examCfgByBank && stored.examCfgByBank['bank-big'] &&
  JSON.stringify(stored.examCfgByBank['bank-big'].counts) === JSON.stringify(bigCounts),
  'T7 配置已写入 localStorage.credit_exam_cfg.examCfgByBank', JSON.stringify(stored && stored.examCfgByBank));
chk(stored && typeof stored.updatedAt === 'number', 'T7 快照带 updatedAt（供云端"谁新用谁"比较）', String(stored && stored.updatedAt));

/* ================= T9 真正开考 ================= */
const started = await page.evaluate(() => {
  document.getElementById('startBtn').click();
  return new Promise(r => setTimeout(() => r({
    mode: window.__exam.S.mode,
    pool: window.__exam.S.pool.length,
    full: window.__exam.S.fullScore,
    cfg: JSON.parse(JSON.stringify(window.__exam.S.examCounts)),
    tag: document.getElementById('modeTag').textContent
  }), 300));
});
// 大库：single 97(全部) + multiple 51 + judge 24 + case 5×3=15 → 187
const wantPool = Math.min(bigCounts.single, 97) + Math.min(bigCounts.multiple, 51) + Math.min(bigCounts.judge, 24) + 15;
chk(started.pool === wantPool, 'T9 实际抽到题量 = min(配置, 可用)（' + wantPool + ' 题）', started.pool + ' / ' + started.tag);
chk(started.full > 0 && Math.abs(started.full - (Math.min(bigCounts.single, 97) * 0.5 + Math.min(bigCounts.multiple, 51) * 1 + Math.min(bigCounts.judge, 24) * 0.5 + 5 * 4)) < 0.05,
  'T9 本次满分 = 各题型实际分值合计', String(started.full));

await page.screenshot({ path: path.join(ROOT, 'shots', 'examcfg-mobile.png'), fullPage: false });

/* ---------- 截图：手机端「组卷设置」展开态 ---------- */
await page.evaluate(() => { window.__exam.S.pool = []; document.getElementById('practice').classList.add('hide'); document.getElementById('home').classList.remove('hide'); window.__exam.refreshHomeUI(); });
await page.waitForTimeout(200);
const shotPanel = async (file, note) => {
  await page.evaluate(() => {
    if (document.getElementById('examCfgBody').classList.contains('hide')) document.getElementById('examCfgHead').click();
  });
  await page.waitForTimeout(200);
  const el = await page.$('#examCfg');
  await el.screenshot({ path: path.join(ROOT, 'shots', file) });
  console.log('  📷 ' + file + ' —— ' + note);
};
// 标准 100 分配置（先展开面板，否则按钮不可见）
await page.evaluate(() => {
  document.getElementById('examCfgBody').classList.remove('hide');
  document.getElementById('examCfgArr').textContent = '▾';
});
await page.waitForTimeout(150);
await page.click('#ecDefault');
await page.waitForTimeout(200);
await shotPanel('examcfg-panel.png', '题库充足：60/40/20/5 → 满分 100 分');
// 超量提醒态：先在「不去全选」下把多选取满（56），再打开「去除多选全选」使可用量回落到 51
await toggle('rmAll');                                  // 关闭去全选：多选可用 56
await page.click('#ecRows .ec-max[data-t="multiple"]');
await page.waitForTimeout(150);
await toggle('rmAll');                                  // 打开去全选：可用 51 < 配置 56
sum = await readSum();
chk(sum.warnShown && /多选题 配置 56 题，题库仅 51 题/.test(sum.warn), 'T12 配置超过可用量 → 黄色提醒给出实际可用量', sum.warn);
chk(sum.full === 111, 'T12 满分按实际可抽量重算：30 + 51 + 10 + 20 = 111', String(sum.full));
await shotPanel('examcfg-warn.png', '配置超过可用量：黄色提醒 + 满分按实际可抽量');
await toggle('rmAll');                                  // 复原

chk(jsErrors.length === 0, 'T11 全过程无 JS 报错', jsErrors.join(' | '));

/* ---------- 清理 ---------- */
await browser.close();
srv.kill();

/* ---------- 汇总 ---------- */
console.log('\n===== 组卷设置端到端验收 =====');
let bad = 0;
results.forEach(r => {
  if (!r.ok) bad++;
  console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + (r.extra !== undefined && !r.ok ? '   → ' + r.extra : ''));
});
console.log('\n通过 ' + (results.length - bad) + ' / ' + results.length + ' 项，失败 ' + bad + ' 项');
process.exit(bad ? 1 : 0);
