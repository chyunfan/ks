/**
 * 「管理员控制题库可见范围 + 用户管理」端到端验收。
 *
 * 覆盖点：
 *  A. 普通用户视角
 *    A1 顶部栏没有「用户管理」入口
 *    A2 题库列表按「我上传的 / 其他人上传的」分组，并标注上传者
 *    A3 他人上传的题库：只有「练习 / 导出」，没有重命名 / 删除 / 可见范围
 *    A4 自己上传的题库：有重命名 / 删除，但没有可见范围（可见范围归管理员）
 *    A5 可见范围徽标：全员可见 / 按部门·角色（带明细）/ 仅自己
 *  B. 管理员视角
 *    B1 顶部栏出现「用户管理」
 *    B2 用户管理页：列出账号 + 部门 / 角色 / 管理员标记 / 题库数量
 *    B3 改部门 / 角色 / 管理员开关 → 保存 → 发往 /api/admin-users 的请求体正确
 *    B4 他人上传的题库：多出「可见范围」按钮
 *    B5 可见范围弹窗：三种模式切换、按部门·角色时显示明细
 *    B6 未选任何部门/角色就保存 → 拦下并提示，不发请求
 *    B7 选「按部门 / 角色」并勾选部门 → PATCH 的请求体正确，列表徽标随之更新
 *    B8 切「仅自己可见」→ PATCH 体里范围被清空，徽标变为「仅自己可见」
 *  C. 交付文件与 SQL 完整性
 *    C1 api/me.js、api/admin-users.js 存在
 *    C2 supabase/admin.sql 含全部关键语句（管理员判定 / 范围判定 / 四条策略 / 账号表 RLS）
 *  D. 全程无 JS 报错
 *
 * 说明：RLS 的"谁到底能查到哪些行"由数据库决定，本地无法连库验证，
 *      所以本脚本用桩数据把「所有库都返回」的场景喂给前端，专测界面权限；
 *      数据库侧的可见性由 supabase/admin.sql 的策略保证（第 C2 组做静态校验）。
 *
 * 用法：node scripts/check_admin.mjs
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
const PORT = 5203;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MY_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';

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
let ROLE = 'user';                       // user | admin
let USERS = [
  { id: MY_ID, username: '常云凡', isAdmin: true, dept: '人力资源部', role: '管理员岗', createdAt: '2026-09-01T01:00:00Z', bankCount: 1, sharedCount: 1 },
  { id: OTHER_ID, username: '张三', isAdmin: false, dept: '信贷部', role: '客户经理', createdAt: '2026-09-05T01:00:00Z', bankCount: 2, sharedCount: 2 },
  { id: '33333333-3333-3333-3333-333333333333', username: '李四', isAdmin: false, dept: '运营部', role: '柜员', createdAt: '2026-09-08T01:00:00Z', bankCount: 0, sharedCount: 0 }
];
let BANKS = [
  { id: 'b-mine', user_id: MY_ID, owner_name: '常云凡', name: '信贷考试题库 A', questions: [], case_count: 0, created_at: '2026-09-20T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-other', user_id: OTHER_ID, owner_name: '张三', name: '反假币题库', questions: [], case_count: 0, created_at: '2026-09-19T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-scope', user_id: OTHER_ID, owner_name: '张三', name: '客户经理专属题库', questions: [], case_count: 0, created_at: '2026-09-18T02:00:00Z', visibility: 'scope', allow_depts: ['信贷部'], allow_roles: ['客户经理'] }
];

const seen = { adminGet: 0, adminPost: null, patch: [] };

/* ---------- 3. 浏览器 + 接口桩 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2 });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());

// 假 JWT：前端只解析 payload 取 sub，服务端签名由真实接口保证
const fakeJwt = () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: MY_ID, username: '常云凡', role: 'authenticated' }) + '.sig';
};

await page.addInitScript(([tok, uid]) => {
  localStorage.setItem('ce_token', tok);
  localStorage.setItem('ce_user', '常云凡');
  localStorage.removeItem('ce_current_bank');
}, [fakeJwt(), MY_ID]);

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

// —— /api/me 与 /api/admin-users
await page.route('**/api/me', route => {
  if (ROLE === 'admin') return fulfil(route, { id: MY_ID, username: '常云凡', isAdmin: true, dept: '人力资源部', role: '管理员岗' });
  return fulfil(route, { id: MY_ID, username: '常云凡', isAdmin: false, dept: '人力资源部', role: '管理员岗' });
});

await page.route('**/api/admin-users', async route => {
  const req = route.request();
  if (req.method() === 'GET') {
    seen.adminGet++;
    return fulfil(route, { ok: true, users: USERS, me: { id: MY_ID, isAdmin: true } });
  }
  const body = JSON.parse(req.postData() || '{}');
  seen.adminPost = body;
  USERS = USERS.map(u => u.id === body.userId
    ? Object.assign({}, u, {
      dept: body.dept !== undefined ? body.dept : u.dept,
      role: body.role !== undefined ? body.role : u.role,
      isAdmin: body.isAdmin !== undefined ? !!body.isAdmin : u.isAdmin
    })
    : u);
  const hit = USERS.find(u => u.id === body.userId);
  return fulfil(route, { ok: true, users: USERS, updated: hit ? hit.username : '' });
});

// —— Supabase REST 桩（题库 / 进度 / 设置）
await page.route('**/rest/v1/**', async route => {
  const req = route.request();
  const m = req.method();
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });

  const url = req.url();
  const table = (url.match(/rest\/v1\/([a-z_]+)/) || [])[1];

  if (table === 'exam_banks') {
    if (m === 'GET') {
      const idEq = url.match(/id=eq\.([^&]+)/);
      if (idEq) return fulfil(route, BANKS.filter(b => b.id === idEq[1]));
      return fulfil(route, BANKS);
    }
    if (m === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      seen.patch.push({ url, body });
      const idEq = url.match(/id=eq\.([^&]+)/);
      if (idEq) BANKS = BANKS.map(b => (b.id === idEq[1] ? Object.assign({}, b, body) : b));
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  }

  if (table === 'exam_bank_progress' || table === 'exam_user_prefs') {
    if (m === 'GET') return fulfil(route, []);
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  }

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

const reload = async () => { await page.reload(); await page.waitForTimeout(1100); };
const bankRows = () => page.$$eval('#bankList .bank-row', rows => rows.map(r => ({
  id: r.dataset.id,
  name: r.querySelector('.bank-name').textContent.trim(),
  acts: Array.from(r.querySelectorAll('.bank-acts .btn')).map(b => b.textContent.trim()),
  meta: r.querySelector('.muted').textContent.trim()
})));
const heads = () => page.$$eval('#bankList .list-head', els => els.map(e => e.textContent.trim()));
// 注意：不能用 offsetParent 判定 —— 弹窗是 position:fixed，offsetParent 恒为 null
const visible = sel => page.$eval(sel, el => {
  if (el.classList.contains('hide')) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  return el.getClientRects().length > 0;
}).catch(() => false);

/* ---------- 5. A. 普通用户 ---------- */
console.log('\n【A. 普通用户视角】');
ROLE = 'user';
await page.goto(URL_APP);
await page.waitForTimeout(1200);

chk(!(await visible('#toAdmin')), 'A1 普通用户看不到「用户管理」入口');

let rows = await bankRows();
let hs = await heads();
chk(rows.length === 3, 'A2 题库列表列出全部 3 个可见题库', String(rows.length));
chk(hs.join('|').includes('我上传的（1）') && hs.join('|').includes('其他人上传的（2）'), 'A2 按「我上传的 / 其他人上传的」分组', hs.join(' / '));

const rowMine = rows.find(r => r.id === 'b-mine');
const rowOther = rows.find(r => r.id === 'b-other');
const rowScope = rows.find(r => r.id === 'b-scope');

chk(rowMine && /上传者：常云凡（我）/.test(rowMine.meta), 'A2 自己的库标注「上传者：常云凡（我）」', rowMine && rowMine.meta);
chk(rowOther && /上传者：张三/.test(rowOther.meta), 'A2 他人库标注「上传者：张三」', rowOther && rowOther.meta);
chk(rowMine.acts.join() === '练习,编辑题目,重命名,导出,删除', 'A4 自己的库：练习/编辑题目/重命名/导出/删除，无「可见范围」', rowMine.acts.join());
chk(rowOther.acts.join() === '练习', 'A3 他人的库：只有「练习」（不可改名/导出/删除）', rowOther.acts.join());
chk(/全员可见/.test(rowOther.name), 'A5 「全员可见」徽标', rowOther.name);
chk(/限定：部门 信贷部 · 角色 客户经理/.test(rowScope.name), 'A5 「按部门·角色」徽标带明细', rowScope.name);

await page.screenshot({ path: path.join(SHOTS, 'admin-banks-user.png'), fullPage: false });

/* ---------- 6. B. 管理员 ---------- */
console.log('\n【B. 管理员视角】');
ROLE = 'admin';
await reload();

chk(await visible('#toAdmin'), 'B1 管理员看到「用户管理」入口');

rows = await bankRows();
chk(rows.find(r => r.id === 'b-other').acts.includes('可见范围'), 'B4 他人的库多出「可见范围」按钮', rows.find(r => r.id === 'b-other').acts.join());
chk(rows.find(r => r.id === 'b-mine').acts.includes('可见范围'), 'B4 管理员对自己的库也能调可见范围', rows.find(r => r.id === 'b-mine').acts.join());
await page.screenshot({ path: path.join(SHOTS, 'admin-banks-admin.png'), fullPage: false });

// 进用户管理
await page.click('#toAdmin');
await page.waitForTimeout(500);
chk(await visible('#admin'), 'B2 进入用户管理页');
chk((await page.$$('#userList .user-row')).length === 3, 'B2 列出全部 3 个账号');
const uRows = await page.$$eval('#userList .user-row', rs => rs.map(r => ({
  id: r.dataset.id,
  name: r.querySelector('.u-name').textContent.trim(),
  dept: r.querySelector('.u-dept').value,
  role: r.querySelector('.u-role').value,
  adm: r.querySelector('.u-isadmin').checked,
  meta: r.querySelector('.u-main .muted').textContent.trim()
})));
const u3 = uRows.find(u => u.name.includes('张三'));
chk(u3 && u3.dept === '信贷部' && u3.role === '客户经理', 'B2 显示账号的部门与角色', u3 && (u3.dept + '/' + u3.role));
chk(/题库 2 个（共享 2）/.test(u3.meta), 'B2 显示该账号的题库数量', u3.meta);

// 手机端排版：字段标签与弹窗按钮都不该被压成两行
const labelH = await page.$eval('#userList .user-row .u-f>span', el => Math.round(el.getBoundingClientRect().height));
chk(labelH < 26, 'B2 手机端「部门/角色」标签不折行', labelH + 'px');
await page.screenshot({ path: path.join(SHOTS, 'admin-users.png'), fullPage: false });

// 搜索
await page.fill('#userSearch', '运营');
await page.waitForTimeout(200);
chk((await page.$$('#userList .user-row')).length === 1, 'B2 搜索框按部门筛选');
await page.fill('#userSearch', '');
await page.waitForTimeout(200);

// 保存某人的部门/角色/管理员
const liId = '33333333-3333-3333-3333-333333333333';
await page.fill(`#userList .user-row[data-id="${liId}"] .u-dept`, '运营管理部');
await page.fill(`#userList .user-row[data-id="${liId}"] .u-role`, '大堂经理');
await page.click(`#userList .user-row[data-id="${liId}"] .u-save`);
await page.waitForTimeout(500);
chk(seen.adminPost && seen.adminPost.action === 'updateUser' && seen.adminPost.userId === liId, 'B3 保存请求体带 action/userId', JSON.stringify(seen.adminPost));
chk(seen.adminPost && seen.adminPost.dept === '运营管理部' && seen.adminPost.role === '大堂经理' && seen.adminPost.isAdmin === false,
  'B3 请求体带新的部门 / 角色 / 管理员标记', JSON.stringify(seen.adminPost));
chk(/已保存/.test(await page.textContent('#adminMsg')), 'B3 界面回显「已保存：李四」', await page.textContent('#adminMsg'));

// 可见范围：回题库列表
await page.click('#toBanks');
await page.waitForTimeout(600);
await page.click('#bankList .bank-row[data-id="b-other"] .act-scope');
await page.waitForTimeout(400);
chk(await visible('#scopeModal'), 'B5 可见范围弹窗打开');
chk((await page.textContent('#scopeBankName')).includes('反假币题库'), 'B5 弹窗标题显示题库名');
chk(await page.$eval('input[name="scopeVis"][value="public"]', el => el.checked), 'B5 默认选中「全员可见」');
chk(!(await visible('#scopeDetail')), 'B5 全员可见时不显示部门/角色明细');

// 切到「按部门 / 角色」
await page.click('#scopeOpts .scope-opt:nth-child(2)');
await page.waitForTimeout(300);
chk(await visible('#scopeDetail'), 'B5 切到「按部门 / 角色」后显示明细');
const footBtn = await page.$$eval('.scope-foot .btn', els => els.map(e => ({ t: e.textContent.trim(), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })));
chk(footBtn.every(b => b.h < 56 && b.w < 200), 'B5 弹窗底部「取消/保存」各自一行不折行', JSON.stringify(footBtn));
chk((await page.textContent('#scopeHint')).includes('只有部门或角色命中的人能看到'), 'B5 提示文案随模式变化', await page.textContent('#scopeHint'));

// 不选任何值就保存 → 拦下
await page.click('#scopeSave');
await page.waitForTimeout(300);
chk(seen.patch.length === 0 && (await page.textContent('#scopeMsg')).includes('至少选择'), 'B6 未选部门/角色 → 拦下并提示', await page.textContent('#scopeMsg'));

// 勾选候选部门（来自用户管理里维护的部门）
const cand = await page.$('#deptChips .tag[data-v="信贷部"]');
chk(!!cand, 'B5 部门候选来自用户管理里的部门', cand ? '有「+ 信贷部」' : '未出现');
if (cand) await cand.click();
await page.waitForTimeout(200);
chk((await page.$$('#deptChips .tag.on')).length === 1, 'B5 点击候选变为已选标签');

await page.screenshot({ path: path.join(SHOTS, 'admin-scope.png'), fullPage: false });
await page.click('#scopeSave');
await page.waitForTimeout(600);
const p1 = seen.patch[seen.patch.length - 1];
chk(p1 && p1.body.visibility === 'scope' && p1.body.allow_depts.join() === '信贷部' && p1.body.allow_roles.length === 0,
  'B7 PATCH 体：visibility=scope + allow_depts=[信贷部]', JSON.stringify(p1 && p1.body));
chk(/id=eq\.b-other/.test(p1.url), 'B7 只改这一个题库（带 id 过滤）', p1.url);
chk(!(await visible('#scopeModal')), 'B7 保存后弹窗关闭');
rows = await bankRows();
chk(/限定：部门 信贷部/.test(rows.find(r => r.id === 'b-other').name), 'B7 列表徽标立即变为「限定：部门 信贷部」', rows.find(r => r.id === 'b-other').name);

// 切「仅自己可见」
await page.click('#bankList .bank-row[data-id="b-other"] .act-scope');
await page.waitForTimeout(300);
await page.click('#scopeOpts .scope-opt:nth-child(3)');
await page.waitForTimeout(200);
await page.click('#scopeSave');
await page.waitForTimeout(600);
const p2 = seen.patch[seen.patch.length - 1];
chk(p2.body.visibility === 'private' && p2.body.allow_depts.length === 0 && p2.body.allow_roles.length === 0,
  'B8 切「仅自己可见」→ 范围被清空', JSON.stringify(p2.body));
rows = await bankRows();
chk(/仅自己可见/.test(rows.find(r => r.id === 'b-other').name), 'B8 徽标变为「仅自己可见」', rows.find(r => r.id === 'b-other').name);

/* ---------- 7. C. 交付文件与 SQL ---------- */
console.log('\n【C. 交付文件与 SQL】');
const meApi = path.join(ROOT, 'api/me.js');
const admApi = path.join(ROOT, 'api/admin-users.js');
const sql = path.join(ROOT, 'supabase/admin.sql');
chk(fs.existsSync(meApi), 'C1 api/me.js 存在');
chk(fs.existsSync(admApi), 'C1 api/admin-users.js 存在');
const s = fs.existsSync(sql) ? fs.readFileSync(sql, 'utf8') : '';
chk(/create or replace function public\.exam_is_admin/.test(s), 'C2 SQL：管理员判定函数 exam_is_admin');
chk(/create or replace function public\.exam_in_scope/.test(s), 'C2 SQL：范围判定函数 exam_in_scope（security definer 绕开账号表 RLS）');
chk(/security definer/g.test(s) && (s.match(/security definer/g) || []).length >= 2, 'C2 SQL：两个判定函数都是 security definer', String((s.match(/security definer/g) || []).length));
chk(/create policy exam_banks_select/.test(s) && /create policy exam_banks_insert/.test(s)
  && /create policy exam_banks_update/.test(s) && /create policy exam_banks_delete/.test(s), 'C2 SQL：题库表四条策略齐备');
chk(/visibility = 'public'/.test(s) && /visibility = 'scope' and public\.exam_in_scope/.test(s), 'C2 SQL：select 策略含「全员可见 / 范围可见」');
chk(/alter table public\.exam_accounts enable row level security/.test(s), 'C2 SQL：账号表开启 RLS（挡住密码哈希直连读取）');
chk(/drop policy if exists exam_banks_all/.test(s), 'C2 SQL：删除旧的「仅本人」单条策略');
chk(/add column if not exists visibility text not null default 'public'/.test(s), 'C2 SQL：visibility 默认 public（人人导入后可见）');

/* ---------- 8. E. 手机端顶栏多一个按钮后不溢出 ---------- */
console.log('\n【E. 手机端顶栏】');
await page.setViewportSize({ width: 375, height: 812 });
await reload();
const bar = await page.evaluate(() => {
  const b = document.getElementById('topbar2');
  const btns = Array.from(document.querySelectorAll('#topbar2 .tb-right .btn'));
  return {
    h: Math.round(b.getBoundingClientRect().height),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    btns: btns.map(x => ({ t: x.textContent.trim(), clipped: x.scrollWidth > x.clientWidth + 1 })),
    adminShown: !document.getElementById('toAdmin').classList.contains('hide')
  };
});
chk(bar.adminShown, 'E1 375px 下「用户」入口可见');
chk(bar.h <= 50, 'E1 顶栏仍是单行矮条（≤50px）', bar.h + 'px');
chk(bar.overflow === 0, 'E1 顶栏无横向溢出', bar.overflow + 'px');
chk(bar.btns.every(x => !x.clipped), 'E1 三个按钮文案都不被截断', JSON.stringify(bar.btns));
await page.screenshot({ path: path.join(SHOTS, 'admin-topbar-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 90 } });

/* ---------- 9. D. 无 JS 报错 ---------- */
console.log('\n【D. 运行状态】');
chk(jsErrors.length === 0, 'D 全程无 JS 报错', jsErrors.join(' | '));

await browser.close();
srv.kill('SIGTERM');

/* ---------- 9. 汇总 ---------- */
console.log('\n' + '='.repeat(56));
console.log(`  通过 ${n - fails.length} / ${n}`);
if (fails.length) {
  console.log('  未通过：');
  fails.forEach(f => console.log('   · ' + f));
}
console.log('='.repeat(56));
process.exit(fails.length ? 1 : 0);
