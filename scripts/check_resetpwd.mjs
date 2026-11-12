/**
 * 「用户管理 → 重置密码」验收。
 *
 * 权限口径：只有管理员能重置别人的密码；临时密码明文只回一次，库里只存 bcrypt 哈希。
 *
 * 覆盖点：
 *  A. 管理员界面
 *    A1 每个账号行都有「重置密码」按钮
 *    A2 点击弹出确认框，文案含该账号名
 *    A3 确认框点「取消」→ 一个请求都不发
 *    A4 确认 → POST /api/admin-users，body 为 { action:'resetPassword', userId }
 *    A5 行下方展开结果条，临时密码 8 位、不含易混字符 0/O/1/l/I
 *    A6 点「复制」→ 剪贴板拿到同一个密码
 *    A7 同一行重复重置 → 结果条只有一条（不堆叠）
 *    A8 接口报错 → 不出现结果条，顶部显示错误文案，按钮恢复可点
 *  B. 普通用户
 *    B1 没有「用户管理」入口
 *  C. 源码 / 接口守卫（纵深防御）
 *    C1 api 有 resetPassword 分支 + CSPRNG 临时密码 + bcrypt.hash
 *    C2 重置分支位于 is_admin 校验**之后**（顺序断言：先验管理员再动密码）
 *    C3 接口响应里不出现 password_hash
 *    C4 前端不把密码写进 localStorage / sessionStorage / URL
 *  D. 手机端 375px 无横向溢出
 *  E. 全程无 JS 报错
 *
 * 用法：node scripts/check_resetpwd.mjs
 * 说明：不连库、不连线上。接口用 page.route 打桩，纯前端行为 + 静态源码校验。
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
const PORT = 5217;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MY_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '33333333-3333-3333-3333-333333333333';

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
let ROLE = 'admin';                       // admin | user
let POST_MODE = 'ok';                     // ok | fail
const TMP = 'Ab3dEf7h';                   // 桩接口固定返回的临时密码（8 位、无易混字符）

const USERS = [
  { id: MY_ID, username: '常云凡', isAdmin: true, dept: '人力资源部', role: '管理员岗', createdAt: '2026-09-01T02:00:00Z', bankCount: 3, sharedCount: 2 },
  { id: OTHER_ID, username: '张三', isAdmin: false, dept: '信贷部', role: '客户经理', createdAt: '2026-09-10T02:00:00Z', bankCount: 1, sharedCount: 0 }
];

const seen = { reset: [], all: [] };

/* ---------- 3. 浏览器 + 接口桩 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({
  viewport: { width: 430, height: 1000 },
  deviceScaleFactor: 2,
  permissions: ['clipboard-read', 'clipboard-write']
});
const page = await ctx.newPage();

const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));

// 对话框：可切换 accept / dismiss，并记录文案
let DIALOG = 'accept';
const dialogs = [];
page.on('dialog', async d => {
  dialogs.push(d.message());
  if (DIALOG === 'accept') await d.accept();
  else await d.dismiss();
});

const fakeJwt = () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: MY_ID, username: '常云凡', role: 'authenticated' }) + '.sig';
};

await page.addInitScript(([tok]) => {
  localStorage.setItem('ce_token', tok);
  localStorage.setItem('ce_user', '常云凡');
  localStorage.removeItem('ce_current_bank');
  // 剪贴板打桩：捕获 writeText 的入参，避免 headless 剪贴板环境差异
  window.__copied = null;
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async t => { window.__copied = t; } }
    });
  } catch (e) { }
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
  const req = route.request();
  const m = req.method();
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });

  if (m === 'GET') {
    return fulfil(route, { ok: true, users: ROLE === 'admin' ? USERS : [], me: { id: MY_ID, isAdmin: ROLE === 'admin' } });
  }

  // POST
  let body = {};
  try { body = JSON.parse(req.postData() || '{}'); } catch (e) { }
  seen.all.push(body);

  if (body.action === 'resetPassword') {
    seen.reset.push(body);
    if (POST_MODE === 'fail') return fulfil(route, { error: '重置失败：数据库连接超时' }, 500);
    const target = USERS.find(u => u.id === body.userId);
    return fulfil(route, { ok: true, username: target ? target.username : '未知', tempPassword: TMP, generated: true });
  }

  return fulfil(route, { ok: true, users: USERS, updated: '张三' });
});

await page.route('**/rest/v1/**', async route => {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
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

/** 打开「用户管理」并等列表渲染完 */
async function openAdmin() {
  await page.waitForTimeout(300);
  if (!(await visible('#admin'))) {
    await page.click('#toAdmin');
  }
  await page.waitForFunction(
    () => document.querySelectorAll('#userList .user-row').length > 0,
    null, { timeout: 8000 }
  ).catch(() => { });
  await page.waitForTimeout(200);
}

/* ---------- 5. A. 管理员：界面与交互 ---------- */
console.log('\n【A. 管理员 · 重置密码】');
ROLE = 'admin';
await page.goto(URL_APP);
await page.waitForTimeout(1400);
await openAdmin();

const rowsInfo = () => page.$$eval('#userList .user-row', rs => rs.map(r => ({
  id: r.dataset.id,
  name: r.querySelector('.u-name').textContent.trim(),
  acts: Array.from(r.querySelectorAll('.u-fields .btn')).map(b => b.textContent.trim())
})));
let rs = await rowsInfo();
chk(rs.length === 2, 'A 用户列表渲染 2 个账号', String(rs.length));
chk(rs.every(r => r.acts.includes('重置密码')),
  'A1 每个账号行都有「重置密码」按钮', JSON.stringify(rs.map(r => r.acts)));
chk(rs.find(r => r.id === OTHER_ID).acts.join() === '保存,做题情况,重置密码',
  'A1 普通账号行：保存 + 做题情况 + 重置密码（不多不少）', rs.find(r => r.id === OTHER_ID).acts.join());

await page.screenshot({ path: path.join(SHOTS, 'resetpwd-list.png'), fullPage: false });

// A3 取消 → 不发请求
DIALOG = 'dismiss';
dialogs.length = 0;
await page.click(`#userList .user-row[data-id="${OTHER_ID}"] .u-reset`);
await page.waitForTimeout(500);
chk(dialogs.length === 1 && /张三/.test(dialogs[0]),
  'A2 点击弹出确认框，且文案含该账号名', JSON.stringify(dialogs));
chk(/旧密码立即失效/.test(dialogs[0] || ''), 'A2 确认框说明了「旧密码立即失效」', dialogs[0]);
chk(seen.reset.length === 0, 'A3 取消后没有发出任何重置请求', JSON.stringify(seen.reset));
chk((await page.$$('#userList .u-reset-out')).length === 0, 'A3 取消后不出现结果条');

// A4/A5 确认 → 发请求 + 展开结果条
DIALOG = 'accept';
await page.click(`#userList .user-row[data-id="${OTHER_ID}"] .u-reset`);
await page.waitForTimeout(700);
chk(seen.reset.length === 1, 'A4 确认后发出 1 次重置请求', String(seen.reset.length));
chk(seen.reset[0] && seen.reset[0].action === 'resetPassword',
  'A4 请求体 action = resetPassword', JSON.stringify(seen.reset[0]));
chk(seen.reset[0] && seen.reset[0].userId === OTHER_ID,
  'A4 请求体带正确的 userId', seen.reset[0] && seen.reset[0].userId);
chk(!('password' in (seen.reset[0] || {})), 'A4 前端不传自定密码（用服务端生成）');

const out = await page.evaluate(() => {
  const el = document.querySelector('#userList .u-reset-out');
  if (!el) return null;
  const pwd = (el.querySelector('.u-pwd') || {}).textContent || '';
  const row = el.previousElementSibling;
  return {
    pwd,
    label: (el.querySelector('.u-reset-label') || {}).textContent || '',
    tip: (el.querySelector('.u-reset-tip') || {}).textContent || '',
    onRow: row ? row.dataset.id : null,
    hasCopy: !!el.querySelector('.u-copy')
  };
});
chk(!!out, 'A5 确认后行下方展开结果条');
chk(out && out.onRow === OTHER_ID, 'A5 结果条挂在被重置的那个账号下面', out && out.onRow);
chk(out && out.pwd === TMP, 'A5 结果条显示的密码 = 接口返回值', out && out.pwd);
chk(out && out.pwd.length === 8, 'A5 临时密码 8 位', out && String(out.pwd.length));
chk(out && !/[0O1lI]/.test(out.pwd), 'A5 临时密码不含易混字符 0/O/1/l/I', out && out.pwd);
chk(out && /张三/.test(out.label), 'A5 结果条标明了是谁的密码', out && out.label);
chk(out && /只显示这一次/.test(out.tip), 'A5 结果条提示「只显示这一次」', out && out.tip);
chk(out && out.hasCopy, 'A5 结果条带「复制」按钮');

// A6 复制
await page.click('#userList .u-reset-out .u-copy');
await page.waitForTimeout(400);
const copied = await page.evaluate(() => window.__copied);
chk(copied === TMP, 'A6 点「复制」把同一个密码写进剪贴板', String(copied));
const copyLabel = await page.textContent('#userList .u-reset-out .u-copy');
chk(copyLabel === '已复制', 'A6 复制后按钮反馈「已复制」', copyLabel);

await page.screenshot({ path: path.join(SHOTS, 'resetpwd-result.png'), fullPage: false });

// A7 重复重置不堆叠
await page.click(`#userList .user-row[data-id="${OTHER_ID}"] .u-reset`);
await page.waitForTimeout(700);
const outCount = (await page.$$('#userList .u-reset-out')).length;
chk(outCount === 1, 'A7 同一行重复重置，结果条仍只有 1 条', String(outCount));
chk(seen.reset.length === 2, 'A7 第二次重置确实又发了请求', String(seen.reset.length));

// A8 接口失败
POST_MODE = 'fail';
await page.click(`#userList .user-row[data-id="${OTHER_ID}"] .u-reset`);
await page.waitForTimeout(700);
const failState = await page.evaluate((oid) => {
  const btn = document.querySelector(`#userList .user-row[data-id="${oid}"] .u-reset`);
  return {
    outs: document.querySelectorAll('#userList .u-reset-out').length,
    msg: (document.getElementById('adminMsg') || {}).textContent || '',
    btnDisabled: btn ? !!btn.disabled : null,
    btnText: btn ? btn.textContent : ''
  };
}, OTHER_ID);
chk(failState.outs === 0, 'A8 接口失败时不出现结果条（旧结果已清）', String(failState.outs));
chk(/重置失败/.test(failState.msg), 'A8 顶部显示接口返回的错误文案', failState.msg);
chk(failState.btnDisabled === false && failState.btnText === '重置密码',
  'A8 失败后按钮恢复可点、文字复原', JSON.stringify([failState.btnDisabled, failState.btnText]));
POST_MODE = 'ok';

/* ---------- 6. B. 普通用户 ---------- */
console.log('\n【B. 普通用户】');
ROLE = 'user';
await reload();
chk(!(await visible('#toAdmin')), 'B1 普通用户看不到「用户管理」入口');
const noAdminUI = await page.evaluate(() => !document.querySelector('#toAdmin') ||
  document.getElementById('toAdmin').classList.contains('hide'));
chk(noAdminUI === true, 'B1 入口对普通用户是隐藏状态');

/* ---------- 7. C. 源码 / 接口守卫 ---------- */
console.log('\n【C. 源码与接口守卫】');
const apiSrc = fs.readFileSync(path.join(ROOT, 'api/admin-users.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'src/admin.js'), 'utf8');

chk(/action === 'resetPassword'/.test(apiSrc), 'C1 接口有 resetPassword 分支');
chk(/genTempPassword/.test(apiSrc) && /randomInt\(/.test(apiSrc),
  'C1 临时密码用 CSPRNG（crypto.randomInt）生成，不是 Math.random');
chk(/bcrypt\.hash\(tempPassword, 10\)/.test(apiSrc),
  'C1 用 bcrypt.hash(cost=10) 与注册口径一致');
chk(/BCDEFGHJKLMNPQRSTUVWXYZ/.test(apiSrc) && !/0123456789/.test(apiSrc.slice(apiSrc.indexOf('PW_CHARS'), apiSrc.indexOf('PW_CHARS') + 120)),
  'C1 字符集剔除了 0/O/1/l/I 易混字符');

const iAdminChk = apiSrc.indexOf('if (!me.is_admin)');
const iReset = apiSrc.indexOf("action === 'resetPassword'");
chk(iAdminChk > 0 && iReset > iAdminChk,
  'C2 重置分支在「is_admin 校验」之后（先验管理员再动密码）', `is_admin@${iAdminChk} reset@${iReset}`);

chk(!/tempPassword:\s*password_hash/.test(apiSrc), 'C3 响应里没有把 password_hash 当成临时密码返回');
chk(/\.select\('id,username,is_admin'\)/.test(apiSrc),
  'C3 读目标账号只取必要列，不 select(*) 把密码哈希拉下来');

chk(!/localStorage\.setItem\([^)]*tempPassword/.test(adminSrc)
  && !/localStorage\.setItem\([^)]*pwd/.test(adminSrc),
  'C4 前端不把临时密码写进 localStorage');
chk(!/sessionStorage\.setItem/.test(adminSrc), 'C4 前端不把临时密码写进 sessionStorage');
chk(!/location\.(href|search)\s*=\s*[^;]*pwd/i.test(adminSrc), 'C4 前端不把密码塞进 URL');

/* ---------- 8. D. 手机端 ---------- */
console.log('\n【D. 手机端 375px】');
ROLE = 'admin';
await page.setViewportSize({ width: 375, height: 780 });
await reload();
await openAdmin();
await page.click(`#userList .user-row[data-id="${OTHER_ID}"] .u-reset`);
await page.waitForTimeout(700);
const mob = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  outWidth: (() => {
    const el = document.querySelector('#userList .u-reset-out');
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  })(),
  pageWidth: document.documentElement.clientWidth
}));
chk(mob.overflow <= 1, 'D1 375px 下无横向溢出', `溢出 ${mob.overflow}px`);
chk(mob.outWidth > 0 && mob.outWidth <= mob.pageWidth, 'D1 结果条不超出屏幕宽度',
  `${mob.outWidth} / ${mob.pageWidth}`);
await page.screenshot({ path: path.join(SHOTS, 'resetpwd-mobile.png'), fullPage: false });

/* ---------- 9. E. JS 报错 ---------- */
console.log('\n【E. 无 JS 报错】');
chk(jsErrors.length === 0, 'E1 全程无 JS 报错', jsErrors.join(' | '));

/* ---------- 10. 收尾 ---------- */
await browser.close();
srv.kill();

console.log('\n' + '='.repeat(56));
if (fails.length) {
  console.log(`✘ 未通过 ${fails.length} / ${n}`);
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log(`✔ 全部通过：${n} / ${n}`);
