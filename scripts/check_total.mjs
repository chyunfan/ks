/**
 * 「组卷总分默认 100 分可修改 + 题库没有的题型不参与组卷」端到端验收。
 *
 * 覆盖点：
 *  G1  题库里没有案例题时：不出现案例题行、不进「题库不足」提醒、不计入配置满分
 *  G2  新题库首次进入默认就是 100 分（没有案例题的库也能满 100，份额让给其它题型）
 *  G3  「试卷总分」可修改：120 / 60 / 清空回 100 / 超大题量收敛到题库上限
 *  G4  手改某题型题量 → 满分实时回算，目标总分不被强扭
 *  G5  题库题量不够时如实提示「本卷最多 N 分」，不谎报题库不足
 *  G6  目标总分随组卷配置按题库各存一份，切库原样带出
 *  G7  用户勾掉某题型 = 该题型不参与组卷（不进提醒、不算配置满分）
 *  G8  「按总分配题」幂等
 *  G9  全程无 JS 报错
 *
 * 用法：node scripts/check_total.mjs
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
const PORT = 5205;
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

/* ---------- 3. 构造两套假题库 ---------- */
await page.evaluate(() => {
  Object.keys(localStorage).filter(k => k.startsWith('ce_') || k.startsWith('credit_exam')).forEach(k => localStorage.removeItem(k));
  const mk = (id, type, extra) => Object.assign({
    id, type, stem: 'Q' + id,
    options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }, { key: 'C', text: 'C' }],
    answerKeys: ['A'], answerText: 'A', correctIdx: [0], analysis: null
  }, extra || {});
  // 两套库的题型/题量完全一样，唯一区别：__full 多出 5 组案例题
  const build = (withCase) => {
    const arr = [];
    let id = 1000;
    const push = (type, extra) => arr.push(mk(++id, type, extra));
    for (let i = 0; i < 97; i++) push('single');
    for (let i = 0; i < 51; i++) push('multiple', { correctIdx: [0, 1] });
    for (let i = 0; i < 5; i++) push('multiple', { correctIdx: [0, 1, 2], answerKeys: ['A', 'B', 'C'] });   // 全选；本脚本按"去除"口径统计
    for (let i = 0; i < 24; i++) push('judge', { answerText: '错误', correctIdx: [1], answerKeys: ['B'] });
    for (let i = 0; i < 6; i++) push('judge', { answerText: '正确', correctIdx: [0], answerKeys: ['A'] });     // 正确项；本脚本按"去除"口径统计
    if (withCase) for (let c = 1; c <= 5; c++) for (let s = 0; s < 3; s++) {
      push('single', { isCase: true, caseId: 'g' + c, caseStem: '案例' + c });
    }
    return arr;
  };
  window.__nocase = build(false);   // 可用 97 / 51 / 24，无案例题
  window.__full = build(true);      // 可用 97 / 51 / 24 / 5 组
});

async function openBank(bankId, questions) {
  await page.evaluate(({ bankId, questions }) => {
    window.__exam.setQuestions(questions);
    window.__exam.setBankKey(bankId);
    window.__exam.refreshHomeUI();
    document.getElementById('auth').classList.add('hide');
    document.getElementById('app').classList.remove('hide');
    ['banks', 'practice', 'result'].forEach(s => document.getElementById(s).classList.add('hide'));
    document.getElementById('home').classList.remove('hide');
  }, { bankId, questions });
  await page.waitForTimeout(150);
}
const toExamMode = async () => {
  await page.click('.mode[data-mode="exam"]');
  await page.click('#examCfgHead');
  await page.waitForTimeout(180);
};

const readRows = () => page.evaluate(() => Array.from(document.querySelectorAll('#ecRows .ec-row')).map(r => ({
  t: r.dataset.t,
  avail: parseInt(r.querySelector('input').getAttribute('data-avail'), 10),
  value: parseInt(r.querySelector('input').value, 10)
})));
const readSum = () => page.evaluate(() => ({
  text: document.getElementById('ecSummary').textContent,
  full: parseFloat(document.getElementById('maxScore').textContent),
  warnShown: !document.getElementById('ecWarn').classList.contains('hide'),
  warn: document.getElementById('ecWarn').textContent.trim(),
  card: document.getElementById('examCounts').textContent,
  totalInput: document.getElementById('ecTotal').value
}));
const counts = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__exam.S.examCounts)));
const stateTotal = () => page.evaluate(() => window.__exam.S.examTotal);
const setTotal = async (v) => {
  await page.fill('#ecTotal', String(v));
  await page.evaluate(() => document.getElementById('ecTotal').dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForTimeout(150);
};
const setCount = async (t, v) => {
  await page.fill(`#ecRows input[data-t="${t}"]`, String(v));
  await page.evaluate(t => document.querySelector(`#ecRows input[data-t="${t}"]`).dispatchEvent(new Event('change', { bubbles: true })), t);
  await page.waitForTimeout(100);
};
const toggle = async (id) => {
  await page.evaluate(id => document.getElementById(id).click(), id);
  await page.waitForTimeout(180);
};

const results = [];
const chk = (ok, name, extra) => { results.push({ ok, name, extra }); };

/* ================= v2.16 起出厂默认：两个「去除」开关都是**关**的 =================
   本脚本的题库口径（97 / 51 / 24）是"两个开关都打开"时的可用量，
   所以先按真实用户点击的方式把这两个开关打开，后面的断言才与题库口径一致。
   （开关默认值是独立的验收点，见 scripts/check_defaults.mjs） */
await page.evaluate(() => {
  ['rmAll', 'rmCorrectJudge'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
});
await page.waitForTimeout(200);

/* ================= G1/G2 没有案例题的题库：默认就该是 100 分 ================= */
await openBank('bank-nocase', await page.evaluate(() => window.__nocase));
await toExamMode();
let rows = await readRows();
let sum = await readSum();
let c = await counts();

chk(rows.map(r => r.t).join() === 'single,multiple,judge',
  'G1 题库没有案例题 → 案例题行不出现，只渲染 3 行', rows.map(r => r.t).join());
chk(rows.map(r => r.avail).join('/') === '97/51/24',
  'G1 各行可用量与题库一致（97/51/24，全选题与正确判断题已去除）', rows.map(r => r.avail).join('/'));
chk(c.case === 0, 'G1 案例题配置量归零（不参与组卷）', String(c.case));
chk(!sum.warnShown, 'G1 不再出现「案例题 配置 5 组，题库仅 0 组」这类无意义提醒', sum.warn || '(无提醒)');
chk(!/案例/.test(sum.text), 'G1 汇总行不提案例', sum.text);
chk(!/按配置应为/.test(sum.text),
  'G1 不出现「按配置应为 100 分，题库不足」这种误导文案（配置满分已排除缺失题型）', sum.text);

chk(sum.full === 100, 'G2 无案例题的题库，首次进入满分就是 100 分', String(sum.full));
chk(await stateTotal() === 100, 'G2 目标总分默认 100', String(await stateTotal()));
chk(sum.totalInput === '100', 'G2 输入框显示 100', sum.totalInput);
chk(JSON.stringify(c) === JSON.stringify({ single: 76, multiple: 50, judge: 24, case: 0 }),
  'G2 案例题那 20 分的份额按 30:40:10 的分值占比让给其它题型（76/50/24 = 100 分）', JSON.stringify(c));
chk(/✓ 正好/.test(sum.text), 'G2 汇总行标注「✓ 正好」', sum.text);
chk(/满分\s*100\s*分/.test(sum.card), 'G2 首页卡片同步显示满分 100 分', sum.card);
await page.screenshot({ path: path.join(SHOTS, 'total-nocase.png'), fullPage: false });

/* ================= G6 目标总分按题库各存一份 ================= */
await setTotal(60);
sum = await readSum();
chk(sum.full === 60, 'G6 把小库目标总分改成 60 → 满分 60', String(sum.full));
chk(await stateTotal() === 60, 'G6 S.examTotal 跟随为 60', String(await stateTotal()));
const stored60 = await page.evaluate(() => JSON.parse(localStorage.getItem(window.__exam.prefsKey()) || 'null'));
chk(stored60 && stored60.examTotal === 60, 'G6 目标总分写进 localStorage 快照', String(stored60 && stored60.examTotal));
chk(stored60 && stored60.examCfgByBank && stored60.examCfgByBank['bank-nocase'] &&
  stored60.examCfgByBank['bank-nocase'].total === 60,
  'G6 目标总分按题库存入 examCfgByBank[...].total', JSON.stringify(stored60 && stored60.examCfgByBank));

/* ================= G3 有案例题的库：默认 100 分 ================= */
await openBank('bank-full', await page.evaluate(() => window.__full));
await toExamMode();
rows = await readRows();
sum = await readSum();
c = await counts();
chk(rows.map(r => r.t).join() === 'single,multiple,judge,case',
  'G3 题库有案例题 → 四行齐全', rows.map(r => r.t).join());
chk(JSON.stringify(c) === JSON.stringify({ single: 60, multiple: 40, judge: 20, case: 5 }) && sum.full === 100,
  'G3 四题型齐全的库默认仍是标准 100 分（60/40/20/5）', JSON.stringify(c) + ' → ' + sum.full + ' 分');
chk(await stateTotal() === 100, 'G3 切到大库后目标总分回到该库自己的 100（不是小库的 60）', String(await stateTotal()));

/* ================= G3 总分可修改 ================= */
// 配题后各题型的分值占比应仍贴近标准比例（单选 30% / 多选 40% / 判断 10% / 案例 20%）
const PTS = { single: 0.5, multiple: 1, judge: 0.5, case: 4 };
const share = (c, t, total) => (c[t] || 0) * PTS[t] / total;
const shareOk = (c, total) =>
  Math.abs(share(c, 'single', total) - 0.30) < 0.06 &&
  Math.abs(share(c, 'multiple', total) - 0.40) < 0.06 &&
  Math.abs(share(c, 'judge', total) - 0.10) < 0.06 &&
  Math.abs(share(c, 'case', total) - 0.20) < 0.06;
const shareStr = (c, total) => ['single', 'multiple', 'judge', 'case']
  .map(t => Math.round(share(c, t, total) * 100) + '%').join('/');

await page.click('#ecDefault');              // 先回到标准 100 分配置（60/40/20/5），让下面的断言有确定起点
await page.waitForTimeout(180);
let base = await counts();
chk(JSON.stringify(base) === JSON.stringify({ single: 60, multiple: 40, judge: 20, case: 5 }),
  'G3 「恢复默认（100 分）」→ 标准配置 60/40/20/5', JSON.stringify(base));

await setTotal(120);
sum = await readSum(); c = await counts();
chk(sum.full === 120, 'G3 总分改 120 → 满分自动配到 120', String(sum.full));
chk(shareOk(c, sum.full), 'G3 120 分后各题型分值占比仍贴近标准比例', JSON.stringify(c) + ' → ' + shareStr(c, sum.full));
await setTotal(60);
sum = await readSum(); c = await counts();
chk(sum.full === 60, 'G3 总分改 60 → 满分 60', String(sum.full));
chk(shareOk(c, sum.full) && c.case === 3,
  'G3 60 分后各题型分值占比仍贴近标准比例，案例题保住 20%（3 组）',
  JSON.stringify(c) + ' → ' + shareStr(c, sum.full));
await setTotal(0);
sum = await readSum();
chk(sum.full === 100 && await stateTotal() === 100 && sum.totalInput === '100',
  'G3 总分填 0 → 回到默认 100 分（输入框也回填 100）', sum.full + ' / 目标 ' + await stateTotal() + ' / 输入框 ' + sum.totalInput);
await setTotal(999);
sum = await readSum();
chk(sum.full === 131.5 && await stateTotal() === 999,
  'G3 总分可填到 999（接受），但配题收敛到题库上限 131.5 分', sum.full + ' 分 / 目标 ' + await stateTotal());
await setTotal(500);
sum = await readSum();
chk(sum.full === 131.5, 'G5 总分填 500（题库给不了）→ 同样收敛到题库上限 131.5 分', String(sum.full));
chk(/题库题量已全部用上，本卷最多 131\.5 分/.test(sum.text),
  'G5 如实说明「题库题量已全部用上，本卷最多 131.5 分」，而不是谎报题库不足', sum.text);
chk(!/按配置应为/.test(sum.text), 'G5 配置量 = 可用量时不再多一句「按配置应为」，避免自相矛盾', sum.text);
await setTotal(100);

/* ================= G4 手改题量 → 满分实时回算，目标分不被强扭 ================= */
await page.click('#ecDefault');               // 回到 60/40/20/5，让下面的算术有确定起点
await page.waitForTimeout(180);
await setCount('single', 10);
sum = await readSum();
chk(sum.full === 75, 'G4 手改单选 10 题 → 满分实时回算 5 + 40 + 10 + 20 = 75', String(sum.full));
chk(/还差 25 分/.test(sum.text), 'G4 汇总行提示与目标的差额（还差 25 分）', sum.text);
chk(await stateTotal() === 100, 'G4 手改题量不会把目标总分扭成 75（目标仍是 100）', String(await stateTotal()));
await setCount('single', 200);
sum = await readSum();
chk(sum.full === 118.5 && (await counts()).single === 97,
  'G4 输入 200 题 → 收敛到题库上限 97，满分 48.5 + 40 + 10 + 20 = 118.5',
  (await counts()).single + ' 题 → ' + sum.full + ' 分');

/* ================= G8 「按总分配题」 ================= */
await page.click('#ecFit');                   // 把上面改乱的 118.5 分卷子重新配到目标 100
await page.waitForTimeout(200);
sum = await readSum(); c = await counts();
chk(sum.full === 100, 'G8 「按总分配题」把改乱的卷子重新配到目标 100 分', String(sum.full));
chk(c.single > 0 && c.multiple > 0 && c.judge > 0 && c.case > 0,
  'G8 配完四种题型都还在（不会把某题型配没）', JSON.stringify(c));
const before = JSON.stringify(c);
await page.click('#ecFit');
await page.waitForTimeout(200);
chk(JSON.stringify(await counts()) === before, 'G8 幂等：重复点结果不变（不会越点越偏）',
  before + ' / ' + JSON.stringify(await counts()));
await setTotal(150);
await page.click('#ecFit');
await page.waitForTimeout(200);
chk((await readSum()).full === 131.5, 'G8 目标 150（超题库上限 131.5）→ 收敛到上限', String((await readSum()).full));

/* ================= G7 关掉某题型 = 该题型不参与组卷 ================= */
await page.click('#ecDefault');
await page.waitForTimeout(180);
await page.click('#typeChips .chip[data-t="case"]');
await page.waitForTimeout(220);
rows = await readRows(); sum = await readSum(); c = await counts();
chk(!rows.some(r => r.t === 'case'), 'G7 取消勾选「案例题」→ 案例题行消失', rows.map(r => r.t).join());
chk(!sum.warnShown, 'G7 案例题被排除后不出现「题库不足」提醒', sum.warn || '(无提醒)');
chk(!/按配置应为/.test(sum.text), 'G7 被排除的题型不计入配置满分（无「按配置应为」）', sum.text);
chk(sum.full === 80, 'G7 满分按剩下的三种题型算：30 + 40 + 10 = 80', String(sum.full));
await page.click('#typeChips .chip[data-t="case"]');
await page.waitForTimeout(220);
chk((await readRows()).some(r => r.t === 'case'), 'G7 重新勾选 → 案例题行回来');

/* ================= G6 切库带出各自的目标总分 ================= */
await setTotal(140);                          // 大库存一个自己的、有辨识度的目标分
await openBank('bank-nocase', await page.evaluate(() => window.__nocase));
await toExamMode();
sum = await readSum();
chk(await stateTotal() === 60 && sum.full === 60,
  'G6 切回小库：带出它自己的目标总分 60（不是大库的 140）', String(await stateTotal()) + ' → ' + sum.full + ' 分');
await openBank('bank-full', await page.evaluate(() => window.__full));
await toExamMode();
sum = await readSum();
chk(await stateTotal() === 140 && sum.full === 131.5,
  'G6 再切回大库：带出大库自己的 140（题库上限 131.5）', String(await stateTotal()) + ' → ' + sum.full + ' 分');

/* ---------- 截图：两种题库的组卷设置 ---------- */
const shotPanel = async (file, note) => {
  await page.evaluate(() => {
    if (document.getElementById('examCfgBody').classList.contains('hide')) document.getElementById('examCfgHead').click();
  });
  await page.waitForTimeout(200);
  const el = await page.$('#examCfg');
  await el.screenshot({ path: path.join(SHOTS, file) });
  console.log('  📷 ' + file + ' —— ' + note);
};
await openBank('bank-nocase', await page.evaluate(() => window.__nocase));
await toExamMode();
await page.click('#ecDefault');
await page.waitForTimeout(200);
await shotPanel('total-default-100.png', '没有案例题的题库：默认也是 100 分，只有 3 行题型');
await openBank('bank-full', await page.evaluate(() => window.__full));
await toExamMode();
await page.click('#ecDefault');
await page.waitForTimeout(200);
await shotPanel('total-four-types.png', '有案例题的题库：四行题型，标准 100 分');

chk(jsErrors.length === 0, 'G9 全过程无 JS 报错', jsErrors.join(' | '));

/* ---------- 清理 ---------- */
await browser.close();
srv.kill();

/* ---------- 汇总 ---------- */
console.log('\n===== 组卷总分 / 题型参与 端到端验收 =====');
let bad = 0;
results.forEach(r => {
  if (!r.ok) bad++;
  console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + (r.extra !== undefined && !r.ok ? '   → ' + r.extra : ''));
});
console.log('\n通过 ' + (results.length - bad) + ' / ' + results.length + ' 项，失败 ' + bad + ' 项');
process.exit(bad ? 1 : 0);
