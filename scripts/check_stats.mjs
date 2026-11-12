/**
 * 「管理员查看每个用户的做题情况」验收。
 *
 * 口径（本脚本守的就是这条线）：
 *   已做量 = 该用户在**任何模式**下答过的不重复题目数（同题多轮取最近一次作答）
 *   正确率 = 答对数 ÷ 已做数（没做的题不进分母）
 *   分母   = 该题库题目总数（用于画进度条）
 *
 * 覆盖点：
 *  A. 弹层与渲染
 *    A1 每个账号行：保存 / 做题情况 / 重置密码
 *    A2 点「做题情况」打开弹层，标题是该账号
 *    A3 顶部四格：累计做题 / 总正确率 / 练过题库 / 最近练习
 *    A4 明细行显示「已做 32 / 100」、正确率 75%、进度条按覆盖比例
 *    A5 明细按最近练习时间倒序；A6 ✕ 与遮罩都能关
 *    A7 无记录账号显示空态
 *    A8 接口报错显示错误文案
 *  B. 普通用户没有「用户管理」入口
 *  C. 统计口径单测（直接跑 api/admin-stats.js 的导出函数）
 *    C1 同一题在多轮里只算一次
 *    C2 后一轮改了作答 → 以最近一次为准
 *    C3 正确率分母是「已做数」，不是题库总数
 *    C4 coverage = 已做 / 题库总数
 *    C5 单选 / 多选（乱序、少选、多选）/ 判断 / 判断 answerText 兜底
 *    C6 **交叉一致性**：同一批题目分别喂给浏览器 window.__exam.isCorrect 和
 *       服务端 isAnswerCorrect，结果必须逐个相同（防止以后只改了一边）
 *  D. 手机端 375px 无横向溢出
 *  E. 全程无 JS 报错
 *
 * 用法：node scripts/check_stats.mjs
 * 说明：不连库、不连线上。接口用 page.route 打桩。
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { summarizeBank, isAnswerCorrect } from '../api/admin-stats.js';

const PW_CORE = process.env.PW_CORE
  || 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;
const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5218;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MY_ID = '11111111-1111-1111-1111-111111111111';
const ZHANG_ID = '44444444-4444-4444-4444-444444444444';
const LI_ID = '55555555-5555-5555-5555-555555555555';

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

/* ---------- 2. 桩数据 ---------- */
let ROLE = 'admin';
let STATS_MODE = 'ok';          // ok | fail

const USERS = [
  { id: MY_ID, username: '常云凡', isAdmin: true, dept: '人力资源部', role: '管理员岗', createdAt: '2026-09-01T02:00:00Z', bankCount: 3, sharedCount: 2 },
  { id: ZHANG_ID, username: '张三', isAdmin: false, dept: '信贷部', role: '客户经理', createdAt: '2026-09-10T02:00:00Z', bankCount: 1, sharedCount: 0 },
  { id: LI_ID, username: '李四', isAdmin: false, dept: '运营部', role: '柜员', createdAt: '2026-09-12T02:00:00Z', bankCount: 0, sharedCount: 0 }
];

const ZHANG_STATS = {
  ok: true,
  user: { id: ZHANG_ID, username: '张三' },
  summary: { bankCount: 2, answered: 45, correct: 33, rate: 73, lastAt: '2026-10-20T01:00:00Z' },
  items: [
    { bankId: 'b1', bankName: '2026反洗钱资格考试', total: 100, answered: 32, correct: 24, rate: 75, coverage: 32, orphan: 0, modes: { sequential: 32 }, lastAt: '2026-10-20T01:00:00Z' },
    { bankId: 'b2', bankName: '信贷业务题库', total: 80, answered: 13, correct: 9, rate: 69, coverage: 16, orphan: 0, modes: { exam: 13 }, lastAt: '2026-10-18T01:00:00Z' }
  ]
};

const LI_STATS = {
  ok: true,
  user: { id: LI_ID, username: '李四' },
  summary: { bankCount: 0, answered: 0, correct: 0, rate: 0, lastAt: null },
  items: []
};

const seen = { statsQuery: [] };

/* ---------- 3. 浏览器 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 430, height: 1000 }, deviceScaleFactor: 2 });

const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));

const fakeJwt = () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: MY_ID, username: '常云凡', role: 'authenticated' }) + '.sig';
};

await page.addInitScript(([tok]) => {
  localStorage.setItem('ce_token', tok);
  localStorage.setItem('ce_user', '常云凡');
  localStorage.removeItem('ce_current_bank');
}, [fakeJwt()]);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*'
};
const fulfil = (route, body, status = 200) => route.fulfill({
  status,
  headers: Object.assign({ 'content-type': 'application/json' }, CORS),
  body: body === undefined ? '' : JSON.stringify(body)
});

await page.route('**/api/me', route => fulfil(route, {
  id: MY_ID, username: '常云凡',
  isAdmin: ROLE === 'admin', dept: '人力资源部', role: '管理员岗'
}));

await page.route('**/api/admin-users', route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
  return fulfil(route, { ok: true, users: ROLE === 'admin' ? USERS : [], me: { id: MY_ID, isAdmin: ROLE === 'admin' } });
});

await page.route('**/api/admin-stats*', route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
  const url = route.request().url();
  seen.statsQuery.push(url);
  if (STATS_MODE === 'fail') return fulfil(route, { error: '读取进度失败：连接超时' }, 500);
  const uid = (url.match(/userId=([^&]+)/) || [])[1] || '';
  if (uid === ZHANG_ID) return fulfil(route, ZHANG_STATS);
  if (uid === LI_ID) return fulfil(route, LI_STATS);
  return fulfil(route, { ok: true, user: { id: MY_ID, username: '常云凡' }, summary: { bankCount: 0, answered: 0, correct: 0, rate: 0, lastAt: null }, items: [] });
});

await page.route('**/rest/v1/**', async route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
  return fulfil(route, []);
});

/* ---------- 4. 断言工具 ---------- */
const fails = [];
let n = 0;
function chk(cond, name, extra) {
  n++;
  if (cond) console.log(`  ✔ ${name}`);
  else { fails.push(name + (extra ? '｜实际：' + extra : '')); console.log(`  ✘ ${name}${extra ? '｜实际：' + extra : ''}`); }
}
const reload = async () => { await page.reload(); await page.waitForTimeout(1300); };
const visible = sel => page.$eval(sel, el => {
  if (el.classList.contains('hide')) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  return el.getClientRects().length > 0;
}).catch(() => false);

async function openAdmin() {
  await page.waitForTimeout(300);
  if (!(await visible('#admin'))) await page.click('#toAdmin');
  await page.waitForFunction(
    () => document.querySelectorAll('#userList .user-row').length > 0,
    null, { timeout: 8000 }
  ).catch(() => { });
  await page.waitForTimeout(200);
}

/* ---------- 5. C. 统计口径单测（先跑，纯 Node，不依赖浏览器） ---------- */
console.log('\n【C. 统计口径与判分】');
const q = (id, type, correctIdx, extra) => Object.assign(
  { id, type, correctIdx, options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] }, extra || {}
);

// C1/C2/C3/C4：同一题多轮去重 + 取最新作答
const bank = {
  id: 'b-test', name: '口径测试库',
  questions: [q(1, 'single', 1), q(2, 'single', 0), q(3, 'multiple', [0, 1]), q(4, 'judge', [0]), q(5, 'single', 1)]
};
const seq = { mode: 'sequential', updatedAt: 1000, ids: [1, 2, 3, 4, 5], userAns: [1, 1, null, null, null] };  // 1 对、2 错
const exam = { mode: 'exam', updatedAt: 2000, ids: [2, 3, 5], userAns: [0, [0, 1], null] };                        // 2 改对、3 对
const r = summarizeBank(bank, [seq, exam]);

chk(r.answered === 3, 'C1 同一题在两轮里只算一次（答了 1/2/3 共 3 题）', String(r.answered));
chk(r.correct === 3, 'C2 题 2 以最近一轮为准（改成对的 → 3 题全对）', String(r.correct));
chk(r.rate === 100, 'C3 正确率分母是已做数（3/3 = 100%）', String(r.rate));
chk(r.total === 5 && r.coverage === 60, 'C4 覆盖度 = 已做 3 / 题库 5 = 60%', `${r.total}/${r.coverage}`);
chk(r.modes.sequential === 2 && r.modes.exam === 2, 'C1 分模式计数正确（各 2 题）', JSON.stringify(r.modes));

// C5 各题型判分
chk(isAnswerCorrect(q(1, 'single', 1), 1) === true, 'C5 单选：对');
chk(isAnswerCorrect(q(1, 'single', 1), 0) === false, 'C5 单选：错');
chk(isAnswerCorrect(q(3, 'multiple', [0, 1]), [1, 0]) === true, 'C5 多选：乱序勾选判对');
chk(isAnswerCorrect(q(3, 'multiple', [0, 1]), [0]) === false, 'C5 多选：少选判错');
chk(isAnswerCorrect(q(3, 'multiple', [0, 1]), [0, 1, 2]) === false, 'C5 多选：多选判错');
chk(isAnswerCorrect(q(4, 'judge', [0]), 0) === true, 'C5 判断：对');
chk(isAnswerCorrect(q(4, 'judge', [0]), 1) === false, 'C5 判断：错');
chk(isAnswerCorrect({ type: 'judge', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerText: '正确' }, 0) === true,
  'C5 判断：无 correctIdx 时按 answerText 反查');
chk(isAnswerCorrect(q(1, 'single', 1), null) === false, 'C5 未作答不算对');

// 旧格式（v2 单快照）也要能统计
const legacy = { v: 2, mode: 'sequential', updatedAt: 3000, ids: [1, 2], userAns: [1, 0] };
const r2 = summarizeBank(bank, [legacy]);
chk(r2.answered === 2 && r2.correct === 2, 'C 兼容旧版单快照格式（无 byMode）', `${r2.answered}/${r2.correct}`);

/* ---------- 6. A. 弹层与渲染 ---------- */
console.log('\n【A. 管理员 · 做题情况】');
ROLE = 'admin';
await page.goto(URL_APP);
await page.waitForTimeout(1400);
await openAdmin();

const rowActs = await page.$$eval('#userList .user-row', rs => rs.map(r => ({
  id: r.dataset.id,
  acts: Array.from(r.querySelectorAll('.u-fields .btn')).map(b => b.textContent.trim())
})));
chk(rowActs.length === 3, 'A 用户列表渲染 3 个账号', String(rowActs.length));
chk(rowActs.every(r => r.acts.join() === '保存,做题情况,重置密码'),
  'A1 每行按钮为 保存 / 做题情况 / 重置密码', JSON.stringify(rowActs.map(r => r.acts)));

await page.click(`#userList .user-row[data-id="${ZHANG_ID}"] .u-stats`);
await page.waitForTimeout(700);
chk(await visible('#statsModal'), 'A2 点「做题情况」打开弹层');
chk(/张三/.test(await page.textContent('#statsUserName')), 'A2 弹层标题是被查看的账号');

const stat = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('#statsSummary .stat'));
  return {
    values: cells.map(c => (c.querySelector('b') || {}).textContent || ''),
    labels: cells.map(c => (c.querySelector('span') || {}).textContent || ''),
    rows: Array.from(document.querySelectorAll('#statsList .stat-row')).map(r => ({
      name: (r.querySelector('.sr-name') || {}).textContent || '',
      prog: (r.querySelector('.sr-prog') || {}).textContent.replace(/\s+/g, ' ').trim(),
      barW: (r.querySelector('.sr-bar i') || {}).style.width,
      rate: (r.querySelector('.sr-meta b') || {}).textContent || '',
      rateCls: (r.querySelector('.sr-meta b') || {}).className || ''
    }))
  };
});

chk(stat.values[0] === '45', 'A3 累计做题 = 45', stat.values[0]);
chk(stat.values[1] === '73%', 'A3 总正确率 = 73%', stat.values[1]);
chk(stat.values[2] === '2', 'A3 练过题库 = 2', stat.values[2]);
chk(/2026-10-20/.test(stat.values[3]), 'A3 最近练习日期', stat.values[3]);
chk(stat.labels.join() === '累计做题,总正确率,练过题库,最近练习', 'A3 四格标题正确', stat.labels.join());

chk(stat.rows.length === 2, 'A4 明细列出 2 个题库', String(stat.rows.length));
chk(stat.rows[0].name === '2026反洗钱资格考试', 'A5 明细按最近练习倒序（第一条是 10-20 那个）', stat.rows[0].name);
chk(/已做 32 \/ 100/.test(stat.rows[0].prog), 'A4 显示「已做 32 / 100」', stat.rows[0].prog);
chk(stat.rows[0].rate === '75%', 'A4 正确率 75%', stat.rows[0].rate);
chk(stat.rows[0].rateCls === 'rate-mid', 'A4 75% 用中档配色（60–79）', stat.rows[0].rateCls);
chk(stat.rows[0].barW === '32%', 'A4 进度条按覆盖比例 32%', stat.rows[0].barW);
chk(/已做 13 \/ 80/.test(stat.rows[1].prog) && stat.rows[1].barW === '16%',
  'A4 第二行 13 / 80、进度条 16%', `${stat.rows[1].prog} / ${stat.rows[1].barW}`);

await page.screenshot({ path: path.join(SHOTS, 'stats-modal.png'), fullPage: false });

// A6 关闭
await page.click('#statsClose');
await page.waitForTimeout(300);
chk(!(await visible('#statsModal')), 'A6 点 ✕ 关闭弹层');
await page.click(`#userList .user-row[data-id="${ZHANG_ID}"] .u-stats`);
await page.waitForTimeout(600);
await page.click('#statsMask', { position: { x: 6, y: 6 } });
await page.waitForTimeout(300);
chk(!(await visible('#statsModal')), 'A6 点遮罩也能关闭');

// A7 空态
await page.click(`#userList .user-row[data-id="${LI_ID}"] .u-stats`);
await page.waitForTimeout(700);
const empty = await page.evaluate(() => ({
  rows: document.querySelectorAll('#statsList .stat-row').length,
  text: (document.getElementById('statsList') || {}).textContent || '',
  rate: (document.querySelector('#statsSummary .stat b') || {}).textContent || ''
}));
chk(empty.rows === 0 && /还没有做题记录/.test(empty.text), 'A7 无记录账号显示空态', empty.text.trim().slice(0, 30));
chk(empty.rate === '0', 'A7 无记录账号累计做题为 0', empty.rate);
await page.click('#statsClose');
await page.waitForTimeout(250);

// A8 接口失败
STATS_MODE = 'fail';
await page.click(`#userList .user-row[data-id="${ZHANG_ID}"] .u-stats`);
await page.waitForTimeout(700);
const failTxt = await page.evaluate(() => (document.getElementById('statsList') || {}).textContent || '');
chk(/加载失败/.test(failTxt) && /连接超时/.test(failTxt), 'A8 接口报错时显示错误文案', failTxt.trim().slice(0, 40));
STATS_MODE = 'ok';
await page.click('#statsClose');
await page.waitForTimeout(250);

/* ---------- 7. C6. 判分交叉一致性（浏览器 vs 服务端） ---------- */
console.log('\n【C6. 前后端判分一致性】');
const CASES = [
  { q: q(1, 'single', 1), ans: 1 },
  { q: q(1, 'single', 1), ans: 0 },
  { q: q(2, 'single', 0), ans: 0 },
  { q: q(3, 'multiple', [0, 1]), ans: [0, 1] },
  { q: q(3, 'multiple', [0, 1]), ans: [1, 0] },
  { q: q(3, 'multiple', [0, 1]), ans: [0] },
  { q: q(3, 'multiple', [0, 1]), ans: [0, 1, 2] },
  { q: q(3, 'multiple', [0, 1]), ans: [] },
  { q: q(4, 'judge', [0]), ans: 0 },
  { q: q(4, 'judge', [0]), ans: 1 },
  { q: { type: 'judge', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerText: '正确' }, ans: 0 },
  { q: { type: 'judge', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerText: '错误' }, ans: 1 },
  { q: q(5, 'single', 1), ans: null },
  { q: q(6, 'multiple', [1, 2, 3], { options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }] }), ans: [3, 2, 1] }
];

const nodeResults = CASES.map(c => isAnswerCorrect(c.q, c.ans));
const browserResults = await page.evaluate((cases) => {
  const E = window.__exam;
  if (!E || typeof E.isCorrect !== 'function') return null;
  const backup = E.S.userAns;
  E.S.userAns = cases.map(c => c.ans);
  const out = cases.map((c, i) => {
    try { return E.isCorrect(c.q, i); } catch (e) { return 'ERR:' + e.message; }
  });
  E.S.userAns = backup;
  return out;
}, CASES);

chk(Array.isArray(browserResults), 'C6 浏览器端 isCorrect 可用（DEV 钩子已暴露）', String(browserResults));
if (Array.isArray(browserResults)) {
  const diffs = CASES.map((c, i) => ({ i, node: nodeResults[i], browser: browserResults[i] }))
    .filter(x => x.node !== x.browser);
  chk(diffs.length === 0, `C6 ${CASES.length} 组样例前后端判分完全一致`,
    diffs.map(d => `#${d.i}: node=${d.node} browser=${d.browser}`).join(', '));
}

/* ---------- 8. B. 普通用户 ---------- */
console.log('\n【B. 普通用户】');
ROLE = 'user';
await reload();
chk(!(await visible('#toAdmin')), 'B1 普通用户没有「用户管理」入口');

/* ---------- 9. D. 手机端 ---------- */
console.log('\n【D. 手机端 375px】');
ROLE = 'admin';
await page.setViewportSize({ width: 375, height: 780 });
await reload();
await openAdmin();
await page.click(`#userList .user-row[data-id="${ZHANG_ID}"] .u-stats`);
await page.waitForTimeout(700);
const mob = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  cols: getComputedStyle(document.getElementById('statsSummary')).gridTemplateColumns.split(' ').length,
  boxW: Math.round(document.querySelector('#statsModal .modal-box').getBoundingClientRect().width),
  pageW: document.documentElement.clientWidth
}));
chk(mob.overflow <= 1, 'D1 375px 下无横向溢出', `溢出 ${mob.overflow}px`);
chk(mob.cols === 2, 'D1 四格在窄屏变成 2×2', String(mob.cols));
chk(mob.boxW <= mob.pageW, 'D1 弹层不超出屏幕', `${mob.boxW} / ${mob.pageW}`);
await page.screenshot({ path: path.join(SHOTS, 'stats-mobile.png'), fullPage: false });

/* ---------- 10. E. JS 报错 ---------- */
console.log('\n【E. 无 JS 报错】');
chk(jsErrors.length === 0, 'E1 全程无 JS 报错', jsErrors.join(' | '));

/* ---------- 11. 收尾 ---------- */
await browser.close();
srv.kill();

console.log('\n' + '='.repeat(56));
if (fails.length) {
  console.log(`✘ 未通过 ${fails.length} / ${n}`);
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log(`✔ 全部通过：${n} / ${n}`);
