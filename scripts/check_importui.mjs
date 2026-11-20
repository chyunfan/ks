/**
 * 「导入题库」入口合并的验收（v2.38）
 *
 * 需求原话：「把下载模版功能做进导入题库按钮」。
 *
 * 以前工具栏并排两个按钮（导入题库 / 下载空模板），挤，而且没模板的人要
 * 「先点右边下载 → 回头再点左边导入」。现在只有一个「导入题库」：
 * 点开弹窗第一屏 = 选择文件 + 下载空模板，选完文件原地切到第二屏看解析结果。
 *
 * 覆盖点：
 *   A. 工具栏只剩一个入口（没有第二个「下载空模板」按钮）
 *   B. 点导入 → 弹窗第一屏（选文件 / 下模板），且这一屏**不**加载 427 KB 的 Excel 组件
 *   C. 「下载空模板」真的下载到能打开的 xlsx
 *   D. 选完文件自动切第二屏：解析结果、题库名自动填、保存可用
 *   E. 解析失败留在第二屏、保存禁用，「重新选择」能再开文件选择框
 *   F. 关掉再打开回到干净的第一屏（不残留上一次的预览 / 题库名）
 *   G. 源码守卫 + 全程无 JS 报错
 *
 * 用法：node scripts/check_importui.mjs      （需要 npm run build 后的 dist 存在？不需要，走 dev server）
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import * as XLSX from 'xlsx';

const PW_CORE = process.env.PW_CORE
  || 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;
const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5240;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const MY_ID = '11111111-1111-1111-1111-111111111111';

/* ---------- 1. dev server ---------- */
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

/* ---------- 2. 造两个 xlsx：一个合法、一个表头不对 ---------- */
function makeBook(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '题库');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const GOOD = makeBook([
  ['题型', '案例材料', '题干', 'A', 'B', 'C', 'D', 'E', 'F', '答案', '解析'],
  ['单选', '', '柜面业务中「现金收付」的第一道关口是？', '核对凭证', '清点现金', '登记台账', '复核签字', '', '', 'B', '先清点'],
  ['判断', '', '大额取现需要登记备案。', '', '', '', '', '', '', '对', '']
]);
const BAD_HEADER = makeBook([
  ['题目', '答案'],
  ['随便一题', 'A']
]);

/* ---------- 3. 浏览器 + 接口桩 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 420, height: 980 }, deviceScaleFactor: 2, acceptDownloads: true });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());

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
  status, headers: Object.assign({ 'content-type': 'application/json' }, CORS),
  body: body === undefined ? '' : JSON.stringify(body)
});
await page.route('**/api/me', route => fulfil(route, {
  id: MY_ID, username: '常云凡', isAdmin: false, dept: '人力资源部', role: '管理员岗'
}));
await page.route('**/api/admin-users', route => fulfil(route, { ok: true, users: [], me: { id: MY_ID, isAdmin: false } }));
await page.route('**/rest/v1/**', async route => {
  const req = route.request();
  const m = req.method();
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
  const url = req.url();
  const table = (url.match(/rest\/v1\/([a-z_]+)/) || [])[1];
  if (table === 'exam_banks') {
    if (m === 'GET') {
      const idEq = url.match(/id=eq\.([^&]+)/);
      if (idEq) return fulfil(route, null);
      return fulfil(route, []);
    }
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  }
  if (m === 'GET') return fulfil(route, []);
  return route.fulfill({ status: 204, headers: CORS, body: '' });
});

/* ---------- 4. 断言工具 ---------- */
const fails = [];
let n = 0;
const chk = (cond, name, extra) => {
  n++;
  if (cond) console.log(`  ✔ ${name}`);
  else { fails.push(name + (extra ? '｜实际：' + extra : '')); console.log(`  ✘ ${name}${extra ? '｜实际：' + extra : ''}`); }
};
const visible = sel => page.$eval(sel, el => {
  if (el.classList.contains('hide')) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  return el.getClientRects().length > 0;
}).catch(() => false);
const libReqs = () => reqs.filter(u => /\/lib\//.test(u));

const reqs = [];
page.on('request', r => reqs.push(r.url()));

await page.goto(URL_APP);
await page.waitForFunction(() => !document.getElementById('banks').classList.contains('hide'), null, { timeout: 20000 });
await page.waitForTimeout(400);

/* ---------- A. 工具栏只剩一个入口 ---------- */
console.log('\n【A. 工具栏】');
chk(await visible('#importBtn'), 'A1 工具栏有「导入题库」按钮', '');
const toolbarBtns = await page.$eval('#banks .section', el => {
  const row = el.querySelector('div[style*="display:flex"]');
  return row ? [...row.querySelectorAll('button')].map(b => b.id || b.textContent.trim()) : [];
});
chk(toolbarBtns.length === 1 && toolbarBtns[0] === 'importBtn',
  'A2 工具栏只有「导入题库」一个按钮（下载模板已并入）', JSON.stringify(toolbarBtns));
const tplInModal = await page.$eval('#importModal', el => !!el.querySelector('#tplBtn'));
chk(tplInModal, 'A3 「下载空模板」在导入弹窗里（不是工具栏）', '');

/* ---------- B. 点导入 → 第一屏，且不加载 Excel 组件 ---------- */
console.log('\n【B. 第一屏】');
const before = libReqs().length;
await page.click('#importBtn');
await page.waitForTimeout(300);
chk(await visible('#importModal'), 'B1 点「导入题库」弹出弹窗', '');
chk(await visible('#importPick'), 'B2 第一屏显示「选择文件 / 下载空模板」', '');
chk(!(await visible('#importResult')), 'B2 第一屏看不到题库名 / 保存按钮（还没选文件）', '');
chk(await visible('#importPickFile') && await visible('#tplBtn'), 'B3 两个入口都在：下载空模板 + 选择文件', '');
// v2.39：模板按钮要摆在主按钮**上方**，而且要像个按钮（不是一行小字链接）
const order = await page.evaluate(() => {
  const t = document.getElementById('tplBtn').getBoundingClientRect();
  const f = document.getElementById('importPickFile').getBoundingClientRect();
  return {
    isBtn: document.getElementById('tplBtn').classList.contains('btn'),
    above: t.top < f.top,
    sameWidth: Math.abs(t.width - f.width) < 2,
    h: Math.round(t.height)
  };
});
chk(order.isBtn && order.above, 'B5 下载模板在「选择文件」上方（顺序如上）', JSON.stringify(order));
chk(order.sameWidth && order.h >= 34, 'B5 下载模板是按钮尺寸（与主按钮同宽、可点区域够大）', JSON.stringify(order));
chk(libReqs().length === before, 'B4 只是打开弹窗，不下载 427 KB 的 Excel 组件（点了才下）', libReqs().length - before + ' 个请求');
await page.screenshot({ path: path.join(SHOTS, 'importui-1-pick.png'), fullPage: false });

/* ---------- C. 下载空模板 ---------- */
console.log('\n【C. 下载空模板】');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#tplBtn')]);
const name = dl.suggestedFilename();
const dlPath = await dl.path();
const head = dlPath ? fs.readFileSync(dlPath).subarray(0, 2).toString('latin1') : '';
chk(/题库模板\.xlsx$/.test(name), 'C1 下载到的文件名是「题库模板.xlsx」', name);
chk(head === 'PK', 'C2 文件是真的 xlsx（zip 头 PK，不是空文件/HTML）', 'head=' + JSON.stringify(head));
chk(libReqs().length > before, 'C3 点下载才去取 Excel 组件（按需加载生效）', libReqs().length + ' 个');

/* ---------- D. 选文件 → 第二屏 ---------- */
console.log('\n【D. 选完文件切第二屏】');
await page.setInputFiles('#fileInput', {
  name: '柜面业务题库.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  buffer: GOOD
});
await page.waitForTimeout(800);
chk(await visible('#importResult'), 'D1 选完文件后弹窗切到第二屏（预览 + 题库名 + 保存）', '');
chk(!(await visible('#importPick')), 'D1 第一屏收起（不叠着）', '');
const prev = await page.$eval('#importPreview', el => el.textContent.replace(/\s+/g, ' '));
chk(/解析成功/.test(prev) && /共 2 题/.test(prev), 'D2 预览显示「解析成功：共 2 题」', prev.slice(0, 60));
chk((await page.inputValue('#bankName')) === '柜面业务题库', 'D3 题库名自动填成文件名（去掉扩展名）', await page.inputValue('#bankName'));
chk(!(await page.$eval('#saveBankBtn', el => el.disabled)), 'D4 保存按钮可用', '');
await page.screenshot({ path: path.join(SHOTS, 'importui-2-result.png'), fullPage: false });

/* ---------- E. 解析失败 / 重新选择 ---------- */
console.log('\n【E. 解析失败与重选】');
await page.setInputFiles('#fileInput', {
  name: '表头不对.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  buffer: BAD_HEADER
});
await page.waitForTimeout(800);
const prev2 = await page.$eval('#importPreview', el => el.textContent.replace(/\s+/g, ' '));
chk(/解析失败/.test(prev2) && /题型/.test(prev2), 'E1 表头不对时给出「解析失败 + 缺哪些列」', prev2.slice(0, 60));
chk(await page.$eval('#saveBankBtn', el => el.disabled), 'E1 解析失败时保存按钮禁用', '');
chk(await visible('#importRepick'), 'E2 第二屏有「重新选择」按钮（不用关弹窗重来）', '');
const chooser = await Promise.all([
  page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
  page.click('#importRepick')
]).then(r => r[0]);
chk(!!chooser, 'E2 点「重新选择」会打开文件选择框', chooser ? 'ok' : '没反应');

/* ---------- F. 关闭后回到干净的第一屏 ---------- */
console.log('\n【F. 关闭复位】');
await page.click('#importClose');
await page.waitForTimeout(300);
chk(!(await visible('#importModal')), 'F1 关闭后弹窗收起', '');
await page.click('#importBtn');
await page.waitForTimeout(300);
const clean = await page.evaluate(() => ({
  pick: !document.getElementById('importPick').classList.contains('hide'),
  result: !document.getElementById('importResult').classList.contains('hide'),
  prev: document.getElementById('importPreview').textContent.trim(),
  name: document.getElementById('bankName').value,
  disabled: document.getElementById('saveBankBtn').disabled
}));
chk(clean.pick && !clean.result, 'F2 再打开是第一屏', JSON.stringify(clean));
chk(clean.prev === '' && clean.name === '' && clean.disabled, 'F3 上一次的预览 / 题库名 / 保存状态都清掉了', JSON.stringify(clean));
await page.click('#importClose');

/* ---------- G. 375px 不溢出 ---------- */
console.log('\n【G. 窄屏】');
await page.setViewportSize({ width: 375, height: 760 });
await page.click('#importBtn');
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => {
  const box = document.querySelector('#importModal .modal-box');
  const inner = document.querySelector('#importPick');
  return { boxW: box.clientWidth, innerW: inner.scrollWidth, docW: document.documentElement.scrollWidth, winW: window.innerWidth };
});
chk(overflow.innerW <= overflow.boxW + 1 && overflow.docW <= overflow.winW + 1,
  'G1 375px 下第一屏不横向溢出', JSON.stringify(overflow));
await page.screenshot({ path: path.join(SHOTS, 'importui-3-mobile.png'), fullPage: false });
await page.click('#importClose');

/* ---------- H. 源码守卫 + JS 报错 ---------- */
console.log('\n【H. 源码守卫】');
const banksSrc = fs.readFileSync(path.join(ROOT, 'src/banks.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
chk(/function openImport\(/.test(banksSrc) && /function setImportStage\(/.test(banksSrc),
  'H1 弹窗有 openImport / setImportStage（两屏切换）', '');
chk(/id="tplBtn"[^>]*>下载空模板/.test(htmlSrc), 'H2 下载入口在弹窗第一屏（「下载空模板」）', '');
chk(!/id="tplBtn"[^>]*class="btn btn-ghost/.test(htmlSrc), 'H2 工具栏里不再有第二个 ghost 按钮', '');
chk(/closeImport[\s\S]{0,200}setImportStage\('pick'\)/.test(banksSrc), 'H3 关闭时复位到第一屏', '');
chk(jsErrors.length === 0, 'H4 全程无 JS 报错', jsErrors.join(' | '));

await browser.close();
srv.kill('SIGTERM');

console.log('\n' + '='.repeat(56));
console.log(`  通过 ${n - fails.length} / ${n}`);
if (fails.length) {
  console.log('  未通过：');
  fails.forEach(f => console.log('   · ' + f));
}
console.log('='.repeat(56));
process.exit(fails.length ? 1 : 0);
