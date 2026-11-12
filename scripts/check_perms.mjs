/**
 * 「非管理员只能练习，不可删除 / 修改他人题库」端到端验收。
 *
 * 权限口径（本脚本守的就是这条线）：
 *   上传者本人 或 管理员 → 可改名 / 导出 / 删除（可见范围仅管理员）
 *   其他登录用户        → **只能练习**
 *
 * 覆盖点：
 *  A. 非管理员（普通用户）视角
 *    A1 他人上传的题库：操作区**只有「练习」**，没有编辑题目 / 重命名 / 导出 / 删除 / 可见范围
 *    A2 列表头提示「其他人上传的（N）· 只能练习」
 *    A3 自己上传的题库：练习 / 重命名 / 导出 / 删除，但**没有**「可见范围」
 *    A4 没有「用户管理」入口
 *    A5 他人题库点「练习」真的能进入答题（练习能力没被误伤）
 *    A6 纵深防御：往他人题库行里手工塞一个「删除」按钮再点，不会发出删除请求
 *    A7 window.__banks.canManage()：他人库 false、自己的库 true
 *  B. 管理员视角
 *    B1 他人上传的题库：练习 / 编辑题目 / 重命名 / 导出 / 可见范围 / 删除 全都有
 *    B2 自己的题库：同样全部拥有（含可见范围）
 *    B3 有「用户管理」入口，且能打开他人题库的可见范围弹窗
 *    B4 canManage()：他人库 true
 *  C. 数据层加固（supabase/lock-banks.sql 静态校验）
 *    C1 存在，且含 exam_bank_vis_locked 判定函数（security definer，绕开 RLS 自身）
 *    C2 insert 策略：普通用户只能建 visibility='public' 的库（堵「直接插私有库」）
 *    C3 update 策略：非管理员改自己的库时三个可见范围字段必须原样不变
 *    C4 delete 策略：只认本人或管理员（删他人库会级联删错题/进度，必须锁死）
 *    C5 越权自检段包在事务里并有 rollback（跑自检不会改动真实数据）
 *  D. 源码守卫（纵深防御，防止以后有人把守卫删掉）
 *  E. 手机端：375px 下他人题库只有一个按钮，行不折行、无横向溢出
 *  F. 全程无 JS 报错
 *
 * 用法：node scripts/check_perms.mjs
 *
 * 说明：RLS 究竟放不放行由数据库决定，本地不连库，所以数据库侧靠
 *      supabase/lock-banks.sql 的静态校验 + 其自检段（在 Supabase 里跑一次）。
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
const QS = [
  { id: 1, type: 'single', stem: '权限测试题一', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null },
  { id: 2, type: 'single', stem: '权限测试题二', options: [{ key: 'A', text: '3' }, { key: 'B', text: '4' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null }
];
let BANKS = [
  { id: 'b-mine', user_id: MY_ID, owner_name: '常云凡', name: '我导入的题库', questions: QS, case_count: 0, created_at: '2026-09-20T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-other', user_id: OTHER_ID, owner_name: '张三', name: '张三的信贷题库', questions: QS, case_count: 0, created_at: '2026-09-19T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-shared', user_id: OTHER_ID, owner_name: '李四', name: '客户经理专属题库', questions: QS, case_count: 0, created_at: '2026-09-18T02:00:00Z', visibility: 'scope', allow_depts: ['信贷部'], allow_roles: ['客户经理'] }
];

const seen = { del: [], patch: [], insert: [] };

/* ---------- 3. 浏览器 + 接口桩 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2 });
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
  status,
  headers: Object.assign({ 'content-type': 'application/json' }, CORS),
  body: body === undefined ? '' : JSON.stringify(body)
});

await page.route('**/api/me', route => fulfil(route, {
  id: MY_ID, username: '常云凡',
  isAdmin: ROLE === 'admin', dept: '人力资源部', role: '管理员岗'
}));
await page.route('**/api/admin-users', route => fulfil(route, { ok: true, users: [], me: { id: MY_ID, isAdmin: ROLE === 'admin' } }));

await page.route('**/rest/v1/**', async route => {
  const req = route.request();
  const m = req.method();
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
  const url = req.url();
  const table = (url.match(/rest\/v1\/([a-z_]+)/) || [])[1];

  if (table === 'exam_banks') {
    if (m === 'GET') {
      const idEq = url.match(/id=eq\.([^&]+)/);
      if (idEq) {
        const hit = BANKS.filter(b => b.id === decodeURIComponent(idEq[1]));
        // 前端 .single() 会带 Accept: application/vnd.pgrst.object+json，此时必须回对象而不是数组，
        // 否则 SDK 直接报错 → questions 拿不到 → 练习起不来（这个坑踩过一次）
        const wantSingle = String(req.headers()['accept'] || '').includes('object');
        return fulfil(route, wantSingle ? (hit[0] || null) : hit);
      }
      return fulfil(route, BANKS);
    }
    if (m === 'POST') {
      seen.insert.push(JSON.parse(req.postData() || '{}'));
      return route.fulfill({ status: 201, headers: CORS, body: '' });
    }
    if (m === 'PATCH') {
      seen.patch.push({ url, body: JSON.parse(req.postData() || '{}') });
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    if (m === 'DELETE') {
      const idEq = url.match(/id=eq\.([^&]+)/);
      seen.del.push(idEq ? decodeURIComponent(idEq[1]) : '(no-id)');
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
const reload = async () => { await page.reload(); await page.waitForTimeout(1200); };
const rows = () => page.$$eval('#bankList .bank-row', rs => rs.map(r => ({
  id: r.dataset.id,
  name: r.querySelector('.bank-name').textContent.trim(),
  acts: Array.from(r.querySelectorAll('.bank-acts .btn')).map(b => b.textContent.trim())
})));
const heads = () => page.$$eval('#bankList .list-head', els => els.map(e => e.textContent.trim()));
const visible = sel => page.$eval(sel, el => {
  if (el.classList.contains('hide')) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  return el.getClientRects().length > 0;      // 不能用 offsetParent：fixed 元素恒为 null
}).catch(() => false);

/* ---------- 5. A. 非管理员 ---------- */
console.log('\n【A. 非管理员（普通用户）】');
ROLE = 'user';
await page.goto(URL_APP);
await page.waitForTimeout(1400);

chk(!(await visible('#toAdmin')), 'A4 看不到「用户管理」入口');

let rs = await rows();
const mine = rs.find(r => r.id === 'b-mine');
const other = rs.find(r => r.id === 'b-other');
const shared = rs.find(r => r.id === 'b-shared');
chk(rs.length === 3, 'A 列表列出 3 个可见题库', String(rs.length));

chk(other && other.acts.join() === '练习', 'A1 他人上传的题库：操作区只有「练习」', other && other.acts.join());
chk(shared && shared.acts.join() === '练习', 'A1 范围共享的题库：同样只有「练习」', shared && shared.acts.join());
chk(other && !other.acts.some(a => /重命名|删除|导出|可见范围|编辑题目/.test(a)),
  'A1 他人题库没有编辑题目 / 重命名 / 删除 / 导出 / 可见范围', other && other.acts.join());
chk(mine && mine.acts.join() === '练习,编辑题目,重命名,导出,删除',
  'A3 自己的题库：练习/编辑题目/重命名/导出/删除，且无「可见范围」', mine && mine.acts.join());

const hs = await heads();
chk(hs.join('|').includes('他人') && hs.join('|').includes('只能练习'),
  'A2 列表头明确标注「其他人上传的 · 只能练习」', hs.join(' / '));

const g = await page.evaluate(() => ({
  other: window.__banks.canManage({ mine: false, name: 'x' }),
  mine: window.__banks.canManage({ mine: true, name: 'x' })
}));
chk(g.other === false, 'A7 canManage(他人库) = false', String(g.other));
chk(g.mine === true, 'A7 canManage(自己的库) = true', String(g.mine));

await page.screenshot({ path: path.join(SHOTS, 'perm-user-banks.png'), fullPage: false });

// A6 纵深防御：手工往他人题库行里塞一个「删除」按钮，点了也不该发出删除请求
await page.evaluate(() => {
  const row = document.querySelector('#bankList .bank-row[data-id="b-other"]');
  row.querySelector('.bank-acts').insertAdjacentHTML('beforeend',
    '<button class="btn btn-ghost btn-sm act-del" type="button">删除</button>');
});
await page.click('#bankList .bank-row[data-id="b-other"] .act-del').catch(() => { });
await page.waitForTimeout(400);
chk(seen.del.length === 0, 'A6 伪造「删除」按钮点下去也不会发删除请求', 'DELETE → ' + JSON.stringify(seen.del));

// A5 练习能用（点「练习」= 进入该题库首页，再点「开始练习」才答题）
await page.click('#bankList .bank-row[data-id="b-other"] .act-open');
await page.waitForTimeout(900);
const opened = await page.evaluate(() => ({
  home: !document.getElementById('home').classList.contains('hide'),
  total: (window.__exam && window.__exam.examPlan) ? window.__exam.examPlan().poolTotal : -1,
  bank: document.getElementById('topBankName').textContent.trim()
}));
chk(opened.home && opened.total === 2, 'A5 他人题库点「练习」正常打开并载入 2 题', JSON.stringify(opened));
chk(/张三的信贷题库/.test(opened.bank), 'A5 顶栏显示正在练习的题库名', opened.bank);

await page.click('#startBtn');
await page.waitForTimeout(600);
const quiz = await page.evaluate(() => ({
  shown: !document.getElementById('practice').classList.contains('hide'),
  pcount: (document.getElementById('pcount') || {}).textContent || ''
}));
chk(quiz.shown && /第 1 \/ 2 题/.test(quiz.pcount), 'A5 普通用户能真正开始答题', JSON.stringify(quiz));

// 回题库列表（reload 时 addInitScript 会清掉 ce_current_bank，不会自动进题库）
await reload();

/* ---------- 6. B. 管理员 ---------- */
console.log('\n【B. 管理员】');
ROLE = 'admin';
await reload();

chk(await visible('#toAdmin'), 'B3 出现「用户管理」入口');
rs = await rows();
chk(rs.find(r => r.id === 'b-other').acts.join() === '练习,编辑题目,重命名,导出,可见范围,删除',
  'B1 他人题库：练习/编辑题目/重命名/导出/可见范围/删除 全都有', rs.find(r => r.id === 'b-other').acts.join());
chk(rs.find(r => r.id === 'b-mine').acts.join() === '练习,编辑题目,重命名,导出,可见范围,删除',
  'B2 自己的题库：同样全部拥有', rs.find(r => r.id === 'b-mine').acts.join());
chk((await page.evaluate(() => window.__banks.canManage({ mine: false, name: 'x' }))) === true,
  'B4 canManage(他人库) = true（管理员可管）');

await page.screenshot({ path: path.join(SHOTS, 'perm-admin-banks.png'), fullPage: false });

await page.click('#bankList .bank-row[data-id="b-other"] .act-scope');
await page.waitForTimeout(400);
chk(await visible('#scopeModal'), 'B3 管理员能打开他人题库的「可见范围」弹窗');
chk((await page.textContent('#scopeBankName')).includes('张三的信贷题库'), 'B3 弹窗针对的是该题库');
await page.click('#scopeClose');
await page.waitForTimeout(250);

/* ---------- 7. C. 数据层加固 ---------- */
console.log('\n【C. 数据层加固 supabase/lock-banks.sql】');
const lockPath = path.join(ROOT, 'supabase/lock-banks.sql');
chk(fs.existsSync(lockPath), 'C1 supabase/lock-banks.sql 存在');
const L = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '';
chk(/create or replace function public\.exam_bank_vis_locked/.test(L), 'C1 含可见范围锁定判定函数 exam_bank_vis_locked');
chk(/exam_bank_vis_locked[\s\S]{0,400}security definer/.test(L) || /security definer[\s\S]{0,600}exam_bank_vis_locked/.test(L),
  'C1 该函数是 security definer（否则策略里查不到旧值，本人也改不了）');
chk(/create policy exam_banks_insert[\s\S]*?visibility = 'public'/.test(L),
  'C2 insert 策略：普通用户只能建「全员可见」的库');
chk(/create policy exam_banks_update[\s\S]*?exam_bank_vis_locked\(id, visibility, allow_depts, allow_roles\)/.test(L),
  'C3 update 策略：非管理员不能改可见范围三个字段');
chk(/create policy exam_banks_delete[\s\S]*?for delete using \([\s\S]*?auth\.uid\(\) = user_id or public\.exam_is_admin\(\)/.test(L),
  'C4 delete 策略：只认本人或管理员');
chk(/^begin;/m.test(L) && /^rollback;/m.test(L), 'C5 越权自检包在事务里并 rollback（不会改动真实数据）');
chk(/set local role authenticated/.test(L) && /request\.jwt\.claims/.test(L),
  'C5 自检用 set local role + jwt.claims 模拟普通用户身份');

/* ---------- 8. D. 源码守卫 ---------- */
console.log('\n【D. 源码守卫】');
const bk = fs.readFileSync(path.join(ROOT, 'src/banks.js'), 'utf8');
chk(/function canManage\(b\)/.test(bk), 'D 存在统一权限口径 canManage()');
chk((bk.match(/if \(!canManage\(b\)\) \{ denyManage\(b\); return; \}/g) || []).length === 4,
  'D 编辑题目 / 重命名 / 导出 / 删除 四个操作都有二次校验',
  String((bk.match(/if \(!canManage\(b\)\) \{ denyManage\(b\); return; \}/g) || []).length));
chk((bk.match(/if \(own\) acts\.push/g) || []).length === 4
  && /if \(adm\) acts\.push\('<button class="btn btn-ghost btn-sm act-scope"/.test(bk),
  'D 按钮渲染：他人题库对非管理员只出「练习」');
chk(/if \(!isAdmin\(\)\) \{ alert\('无权限：「可见范围」只有管理员可以调整。'\); return; \}/.test(bk)
  && /if \(!isAdmin\(\)\) \{ closeScope\(\); alert/.test(bk),
  'D 「可见范围」打开与保存两处都有管理员校验');

/* ---------- 9. E. 手机端 ---------- */
console.log('\n【E. 手机端 375px】');
ROLE = 'user';
await page.setViewportSize({ width: 375, height: 812 });
await reload();
const mob = await page.evaluate(() => {
  const row = document.querySelector('#bankList .bank-row[data-id="b-other"]');
  const btns = Array.from(row.querySelectorAll('.bank-acts .btn'));
  return {
    acts: btns.map(b => b.textContent.trim()),
    btnH: btns.map(b => Math.round(b.getBoundingClientRect().height)),
    rowShown: row.getClientRects().length > 0,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
  };
});
chk(mob.rowShown && mob.acts.join() === '练习', 'E 他人题库在手机端只有「练习」', mob.acts.join());
chk(mob.overflow === 0, 'E 手机端无横向溢出', mob.overflow + 'px');
chk(mob.btnH.every(h => h <= 44), 'E 按钮高度正常（≤44px，未折行）', JSON.stringify(mob.btnH));
await page.screenshot({ path: path.join(SHOTS, 'perm-mobile.png'), fullPage: false });

/* ---------- 10. F. 运行状态 ---------- */
console.log('\n【F. 运行状态】');
chk(jsErrors.length === 0, 'F 全程无 JS 报错', jsErrors.join(' | '));

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
