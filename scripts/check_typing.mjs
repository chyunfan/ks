/**
 * 「打字练习」端到端验收（字库 + 练习 + 练习记录）。
 *
 * 本次需求（本脚本守的就是这三条线）：
 *   1) 打字练习与做题程序**共用一套账号**，顶栏入口并排放在一起，叫「打字练习」
 *   2) 管理员上传的字库 / 个人上传的字库，**默认都是所有人可见、所有人可重排**
 *      —— 列表用「管理员上传 / 个人上传」徽章区分来源
 *   3) 管理员可以**查看其他用户的练习记录**
 *
 * 权限口径（v2.26 收窄，本脚本 A3/A5/B1/C8/D7 守着这条线）：
 *   打字：所有人     重排：所有人（editable='all'）
 *   改名 / 可见范围 / 删除：**仅管理员或上传者本人**
 *   即：**非自己上传的字库，普通用户只能「打字、重排」**。
 *
 * 覆盖点：
 *  A. 普通用户
 *    A1 顶栏有「打字练习」入口，点进去是字库屏
 *    A2 列表按「管理员上传 / 个人上传」分组，带来源徽章与可见范围、可重排标签
 *    A3 他人上传的字库：**只有 打字/重排**，没有 改名 / 删除 / 可见范围；
 *       且绕开按钮直调内部改名入口也改不动（第二道闸）
 *    A4 自己上传的字库：打字/重排/改名/可见范围/删除 齐全
 *    A5 被设为「仅上传者可改」的他人字库：**只有「打字」**
 *    A6 导入字库：默认选中「所有人可见」，落库 visibility=public、editable=all，名称自动编号
 *    A7 打字：进练习屏、原文行与跟打行逐字对齐、光标在「下一个字前面」
 *    A8 打字：已打正确字数实时增长、退格删除后自动回正、打满一行自动跳下一行
 *    A9 打完全篇：结果弹窗 + 练习记录写入云端（字段口径对得上）
 *    A10 重排：字序被打乱，字数与用字不变，shuffles 递增（他人的库也能重排 = 所有人可重排）
 *    A11 练习记录屏：只有自己的记录，无账号筛框
 *  B. 管理员
 *    B1 他人字库有 改名/删除/可见范围（管理员全权限）
 *    B2 练习记录能看到其他账号（按账号分组 + 平均速度/正确率）
 *    B3 账号筛选框可见且能筛出某个账号
 *    B4 可见范围弹窗可打开并保存（PATCH 带 visibility）
 *  C. 数据层（supabase/typing.sql 静态校验）
 *    C1 字库表默认 visibility=public、editable=all
 *    C2 select 策略：本人 / 管理员 / public / 部门角色命中
 *    C3 update 策略含 editable='all' —— 这就是「所有人可重排」
 *    C4 delete 策略只认本人或管理员
 *    C5 记录表 select 策略含 exam_is_admin() —— 管理员能看全部
 *    C6 可见范围有触发器锁（非管理员且非上传者改不动）
 *    C7 insert 触发器按服务端身份定 source / owner，防前端伪造「管理员上传」
 *    C8 同一个触发器也把 name 锁住 —— 改名同样只有管理员/上传者能动
 *  D. 源码守卫（防止以后被改回去）
 *  E. 手机端 375px：字库行不横向溢出、练习屏可用
 *  F. 全程无 JS 报错
 *
 * 用法：node scripts/check_typing.mjs
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
const PORT = 5211;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MY_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const MY_NAME = '常云凡';

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
let HZK = [
  { id: 'h-adm', user_id: OTHER_ID, owner_name: '管理员小王', name: 'hzk001', source: 'admin', text: '真的猛士敢于直面惨淡的人生', per_line: 8, chars: 13, visibility: 'public', editable: 'all', allow_depts: [], allow_roles: [], shuffles: 0, created_at: '2026-09-25T02:00:00Z' },
  { id: 'h-mine', user_id: MY_ID, owner_name: MY_NAME, name: 'hzk002', source: 'user', text: '敢于正视淋漓的鲜血这是怎样的哀痛者', per_line: 8, chars: 17, visibility: 'public', editable: 'all', allow_depts: [], allow_roles: [], shuffles: 0, created_at: '2026-09-26T02:00:00Z' },
  { id: 'h-other', user_id: OTHER_ID, owner_name: '张三', name: 'hzk003', source: 'user', text: 'ABCDEFGHIJKLMNOP', per_line: 8, chars: 16, visibility: 'public', editable: 'all', allow_depts: [], allow_roles: [], shuffles: 2, created_at: '2026-09-24T02:00:00Z' },
  { id: 'h-lock', user_id: OTHER_ID, owner_name: '李四', name: 'hzk004', source: 'user', text: '12345678ABCDEFGH', per_line: 8, chars: 16, visibility: 'public', editable: 'owner', allow_depts: [], allow_roles: [], shuffles: 0, created_at: '2026-09-23T02:00:00Z' }
];
let RECS = [
  { id: 'r1', user_id: MY_ID, owner_name: MY_NAME, hzk_id: 'h-mine', hzk_name: 'hzk002', per_line: 8, total: 17, ok: 17, wrong: 0, seconds: 42, speed: 24, acc: 100, timed_out: false, created_at: '2026-09-27T06:10:00Z' },
  { id: 'r2', user_id: OTHER_ID, owner_name: '张三', hzk_id: 'h-other', hzk_name: 'hzk003', per_line: 8, total: 16, ok: 14, wrong: 2, seconds: 60, speed: 14, acc: 88, timed_out: false, created_at: '2026-09-27T03:20:00Z' },
  { id: 'r3', user_id: OTHER_ID, owner_name: '李四', hzk_id: 'h-lock', hzk_name: 'hzk004', per_line: 8, total: 16, ok: 9, wrong: 1, seconds: 30, speed: 18, acc: 90, timed_out: true, created_at: '2026-09-26T08:00:00Z' }
];

const seen = { hzkInsert: [], hzkPatch: [], hzkDel: [], recInsert: [], recQuery: 0 };

/* ---------- 3. 浏览器 + 接口桩 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const jsErrors = [];
const dialogs = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

const fakeJwt = () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: MY_ID, username: MY_NAME, role: 'authenticated' }) + '.sig';
};
await page.addInitScript(([tok, nm]) => {
  localStorage.setItem('ce_token', tok);
  localStorage.setItem('ce_user', nm);
  localStorage.removeItem('ce_current_bank');
}, [fakeJwt(), MY_NAME]);

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
  id: MY_ID, username: MY_NAME, isAdmin: ROLE === 'admin', dept: '人力资源部', role: '管理员岗'
}));
await page.route('**/api/admin-users', route => fulfil(route, {
  ok: true,
  users: [
    { id: MY_ID, username: MY_NAME, isAdmin: ROLE === 'admin', dept: '人力资源部', role: '管理员岗', createdAt: '2026-09-01T00:00:00Z', bankCount: 1 },
    { id: OTHER_ID, username: '张三', isAdmin: false, dept: '信贷部', role: '客户经理', createdAt: '2026-09-02T00:00:00Z', bankCount: 2 }
  ],
  me: { id: MY_ID, isAdmin: ROLE === 'admin' }
}));

await page.route('**/rest/v1/**', async route => {
  const req = route.request();
  const m = req.method();
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
  const url = req.url();
  const table = (url.match(/rest\/v1\/([a-z_]+)/) || [])[1];
  const idEq = () => {
    const hit = url.match(/id=eq\.([^&]+)/);
    return hit ? decodeURIComponent(hit[1]) : null;
  };
  const wantSingle = String(req.headers()['accept'] || '').includes('object');
  const one = rows => (wantSingle ? (rows[0] || null) : rows);

  if (table === 'exam_hzk') {
    if (m === 'GET') {
      const id = idEq();
      return fulfil(route, id ? one(HZK.filter(h => h.id === id)) : HZK);
    }
    if (m === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      seen.hzkInsert.push(body);
      // 服务端会回填 source / owner_name（触发器干的事），这里模拟一下
      const row = Object.assign({ id: 'h-new', created_at: new Date().toISOString(), source: ROLE === 'admin' ? 'admin' : 'user', owner_name: MY_NAME, shuffles: 0, allow_depts: [], allow_roles: [] }, body);
      HZK = [row].concat(HZK);
      return route.fulfill({ status: 201, headers: CORS, body: '' });
    }
    if (m === 'PATCH') {
      const id = idEq();
      const body = JSON.parse(req.postData() || '{}');
      seen.hzkPatch.push({ id, body });
      HZK = HZK.map(h => (h.id === id ? Object.assign({}, h, body) : h));
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    if (m === 'DELETE') {
      const id = idEq();
      seen.hzkDel.push(id);
      HZK = HZK.filter(h => h.id !== id);
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  }

  if (table === 'exam_typing_records') {
    if (m === 'GET') {
      seen.recQuery++;
      // RLS 口径：普通用户只拿得到自己的；管理员拿得到全部
      const rows = ROLE === 'admin' ? RECS : RECS.filter(r => r.user_id === MY_ID);
      return fulfil(route, rows);
    }
    if (m === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      seen.recInsert.push(body);
      RECS = [Object.assign({ id: 'r-new', created_at: new Date().toISOString() }, body)].concat(RECS);
      return route.fulfill({ status: 201, headers: CORS, body: '' });
    }
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  }

  // 做题程序那几张表：给最小可用桩，别让 boot 挂掉
  if (table === 'exam_banks') {
    if (m === 'GET') {
      const id = idEq();
      const BANKS = [{ id: 'b1', user_id: MY_ID, owner_name: MY_NAME, name: '默认题库', questions: [], case_count: 0, created_at: '2026-09-01T00:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] }];
      return fulfil(route, id ? one(BANKS.filter(b => b.id === id)) : BANKS);
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
const visible = sel => page.$eval(sel, el => {
  if (el.classList.contains('hide')) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  return el.getClientRects().length > 0;
}).catch(() => false);
const hzkRows = () => page.$$eval('#hzkList .bank-row', rs => rs.map(r => ({
  id: r.dataset.id,
  name: r.querySelector('.bank-name').textContent.trim(),
  tags: Array.from(r.querySelectorAll('.bank-name .src-tag, .bank-name .vis-tag')).map(t => t.textContent.trim()),
  acts: Array.from(r.querySelectorAll('.bank-acts .btn')).map(b => b.textContent.trim())
})));
const hzkHeads = () => page.$$eval('#hzkList .list-head', els => els.map(e => e.textContent.trim()));
const gotoHzk = async () => { await page.click('#toTyping'); await page.waitForTimeout(500); };
const type = async (text, wait = 160) => {
  await page.evaluate(t => {
    const g = document.getElementById('tpGhost');
    g.value = t;
    g.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await page.waitForTimeout(wait);
};
const tpState = () => page.evaluate(() => ({
  ok: document.getElementById('tpStOk').textContent,
  acc: document.getElementById('tpStAcc').textContent,
  prog: document.getElementById('tpStProg').textContent,
  speed: document.getElementById('tpStSpeed').textContent,
  time: document.getElementById('tpStTime').textContent,
  srcLine: [...document.querySelectorAll('.tp-block.active .tp-row.src .tp-cell')].map(c => c.textContent).join(''),
  inpOk: document.querySelectorAll('.tp-row.inp .tp-cell.ok').length,
  inpErr: document.querySelectorAll('.tp-row.inp .tp-cell.err').length,
  activeLine: (() => { const b = document.querySelector('.tp-block.active'); return b ? b.dataset.li : '-'; })(),
  caretAt: (() => {
    const c = document.querySelector('.tp-cell.caret');
    if (!c) return null;
    const bar = c.querySelector('.tp-caret-bar');
    if (!bar) return 'no-bar';
    return Math.round(bar.getBoundingClientRect().left - c.getBoundingClientRect().left);
  })()
}));

/* ---------- 5. A. 普通用户 ---------- */
console.log('\n【A. 普通用户】');
ROLE = 'user';
await page.goto(URL_APP);
await page.waitForTimeout(1200);

chk(await visible('#toTyping'), 'A1 顶栏有「打字练习」入口');
await gotoHzk();
chk(await visible('#hzk'), 'A1 点开后进入字库屏');

let rows = await hzkRows();
let heads = await hzkHeads();
chk(rows.length === 4, 'A2 列出 4 个字库', String(rows.length));
chk(heads.some(h => /管理员上传/.test(h)), 'A2 有「管理员上传」分组', heads.join(' | '));
chk(heads.some(h => /个人上传/.test(h)), 'A2 有「个人上传」分组', heads.join(' | '));

const adm = rows.find(r => r.id === 'h-adm');
const mine = rows.find(r => r.id === 'h-mine');
const lock = rows.find(r => r.id === 'h-lock');
chk(adm && adm.tags.join().includes('管理员上传'), 'A2 管理员上传的带来源徽章', adm && adm.tags.join());
chk(mine && mine.tags.join().includes('个人上传'), 'A2 个人上传的带来源徽章', mine && mine.tags.join());
chk(adm && adm.tags.join().includes('所有人可见'), 'A2 默认所有人可见有标签', adm && adm.tags.join());
chk(adm && adm.tags.join().includes('所有人可重排'), 'A2 默认「所有人可重排」有标签', adm && adm.tags.join());

chk(adm && adm.acts.join() === '打字,重排', 'A3 他人的库：只有 打字 / 重排 两个按钮', adm && adm.acts.join());
chk(!(adm && adm.acts.some(a => /改名|删除|可见范围/.test(a))), 'A3 他人的库没有「改名」「删除」「可见范围」');
chk(mine && mine.acts.join() === '打字,重排,改名,可见范围,删除', 'A4 自己的库：五个按钮齐全', mine && mine.acts.join());
chk(lock && lock.acts.join() === '打字', 'A5 仅上传者可改的库：只有「打字」', lock && lock.acts.join());
await page.screenshot({ path: path.join(SHOTS, 'typing-hzk-user.png') });

/* A3 第二道闸：绕开按钮，直调内部入口 —— 改名必须被拦下，且一发 PATCH 都不该发出去 */
const gate = await page.evaluate(async () => {
  const other = await window.__hzk.find('h-adm');     // 他人上传（editable='all'）
  const own = await window.__hzk.find('h-mine');      // 自己上传
  const lockH = await window.__hzk.find('h-lock');    // 他人上传且 editable='owner'
  return {
    renameOther: window.__hzk.canRenameHz(other),
    renameOwn: window.__hzk.canRenameHz(own),
    editOther: window.__hzk.canEditHz(other),
    editLock: window.__hzk.canEditHz(lockH)
  };
});
chk(gate.renameOther === false, 'A3 内部判定：他人字库 canRenameHz = false', JSON.stringify(gate));
chk(gate.renameOwn === true, 'A4 内部判定：自己的字库 canRenameHz = true', JSON.stringify(gate));
chk(gate.editOther === true, 'A3 内部判定：他人字库仍可重排（canEditHz = true）', JSON.stringify(gate));
chk(gate.editLock === false, 'A5 内部判定：「仅上传者可改」的库连重排也不行', JSON.stringify(gate));

const beforeRename = seen.hzkPatch.length;
await page.evaluate(async () => {
  const h = await window.__hzk.find('h-adm');
  await window.__hzk.rename(h);                       // 直调内部改名入口（不是点按钮）
});
await page.waitForTimeout(250);
chk(seen.hzkPatch.length === beforeRename, 'A3 直调内部改名入口：一发 PATCH 都没发出去', String(seen.hzkPatch.length - beforeRename));
chk(dialogs.some(m => /无权限[\s\S]*改名/.test(m)), 'A3 并且弹出了「无权限：改名只有管理员或上传者本人可以操作」', dialogs.slice(-2).join(' | '));

/* A6 导入字库 */
console.log('\n【A6. 导入字库】');
await page.click('#hzkImportBtn');
await page.waitForTimeout(200);
chk(await visible('#hzkImportModal'), 'A6 导入弹窗打开');
chk(await page.isChecked('#hzkVisOpts input[value="public"]'), 'A6 默认选中「所有人可见」');
chk(await page.inputValue('#hzkImportName') === 'hzk005', 'A6 名称自动编号 hzk005', await page.inputValue('#hzkImportName'));
chk(await page.inputValue('#hzkImportPerLine') === '35', 'A6 每行字数默认 35', await page.inputValue('#hzkImportPerLine'));
await page.fill('#hzkImportText', '这是新导入的字库内容用于验证');
await page.selectOption('#hzkImportPerLine', '16');
await page.click('#hzkImportSave');
await page.waitForTimeout(500);
chk(seen.hzkInsert.length === 1, 'A6 发出 1 次字库落库请求', String(seen.hzkInsert.length));
const ins = seen.hzkInsert[0] || {};
chk(ins.name === 'hzk005', 'A6 落库名 = hzk005', ins.name);
chk(ins.visibility === 'public', 'A6 落库可见范围 = public（所有人可见）', ins.visibility);
chk(ins.editable === 'all', 'A6 落库可修改范围 = all（所有人可修改）', ins.editable);
chk(ins.per_line === 16 && ins.chars === 14, 'A6 每行字数与字数正确', ins.per_line + '/' + ins.chars);
chk(!('source' in ins), 'A6 前端不上传 source（由服务端按身份判定）', JSON.stringify(Object.keys(ins)));

/* A7 ~ A9 打字 */
console.log('\n【A7-A9. 打字流程】');
await page.waitForTimeout(300);
// 期望值一律从桩数据算出来，避免手写文本数错字
const TEXT = HZK.find(h => h.id === 'h-mine').text;
const PER = HZK.find(h => h.id === 'h-mine').per_line;
const charsOf = s => Array.from(s);
const lineOf = i => charsOf(TEXT).slice(i * PER, (i + 1) * PER).join('');
const nLines = Math.ceil(charsOf(TEXT).length / PER);
const row2 = (await hzkRows()).find(r => r.id === 'h-mine');
chk(!!row2, 'A7 hzk002 仍在列上');
await page.click('#hzkList .bank-row[data-id="h-mine"] .act-type');
await page.waitForTimeout(600);
chk(await visible('#typing'), 'A7 进入练习屏');
chk((await page.textContent('#tpHzkName')).startsWith('hzk002'), 'A7 顶部显示当前字库名', await page.textContent('#tpHzkName'));

let st = await tpState();
const blockCount = await page.$$eval('.tp-block', bs => bs.length);
chk(st.srcLine === lineOf(0), 'A7 首行原文 = 按每行 ' + PER + ' 字切出的第一行', st.srcLine + ' ≠ ' + lineOf(0));
chk(blockCount === nLines, TEXT.length + ' 字按每行 ' + PER + ' 字切出 ' + nLines + ' 段', String(blockCount));
chk(await page.inputValue('#tpPerLine') === String(PER), 'A7 每行字数下拉跟随字库设定', await page.inputValue('#tpPerLine'));
chk(st.caretAt === 0, 'A7 光标贴在「下一个待打字」的格子左边界（字前）', String(st.caretAt));
const hint = await page.textContent('#tpHintCode');
chk(/^[a-z]{1,4}$/.test(hint), 'A7 五笔编码提示有值', hint);
chk(await page.isChecked('#tpHintOn'), 'A7 编码提示默认勾选');
chk(await page.isChecked('#tpLimitOn') && await page.inputValue('#tpLimitMin') === '5', 'A7 限时默认勾选 5 分钟');
await page.uncheck('#tpHintOn');
await page.waitForTimeout(120);
chk(await page.evaluate(() => document.getElementById('tpHintCode').offsetParent === null), 'A7 取消勾选后编码提示隐藏');
await page.check('#tpHintOn');
await page.waitForTimeout(120);

// 逐字对齐：比较上下两行同列格子的 x
const align = await page.evaluate(() => {
  const b = document.querySelector('.tp-block.active');
  const s = [...b.querySelectorAll('.tp-row.src .tp-cell')].map(c => c.getBoundingClientRect().left);
  const i = [...b.querySelectorAll('.tp-row.inp .tp-cell')].map(c => c.getBoundingClientRect().left);
  return s.map((x, k) => Math.round(Math.abs(x - i[k])));
});
chk(align.length === PER && align.every(d => d === 0), 'A7 上下两行逐列 x 偏差全 0', align.join(','));

const half = Math.floor(PER / 2);
await type(lineOf(0).slice(0, half));                 // 前一半打对
await type('错'.repeat(PER - half));                  // 后一半全错 → 打满首行自动跳第二行
st = await tpState();
chk(st.inpOk === half && st.inpErr === PER - half, 'A8 打满首行：' + half + ' 对 ' + (PER - half) + ' 错，原文行同步标红', st.inpOk + '/' + st.inpErr);
chk(st.ok === String(half), 'A8 已打正确字数 = ' + half, st.ok);
chk(st.acc === Math.round(half / PER * 100) + '%', 'A8 正确率按打过的字算', st.acc);
chk(st.activeLine === '1', 'A8 打满一行自动跳下一行', st.activeLine);

for (let i = 0; i < PER - half; i++) { await page.keyboard.press('Backspace'); await page.waitForTimeout(50); }
chk(await page.evaluate(() => window.__typing.state().charIdx) === half, 'A8 退格把光标退回首行中间');
st = await tpState();
chk(st.inpOk === half && st.inpErr === 0, 'A8 退格删掉错字后错误清零', st.inpOk + '/' + st.inpErr);

// 按算出来的文本把全篇打完
for (let i = 0; i < nLines; i++) {
  const seg = lineOf(i);
  const from = (i === 0) ? half : 0;
  await type(seg.slice(from), 220);
}
await page.waitForTimeout(500);
st = await tpState();
const total = charsOf(TEXT).length;
chk(await visible('#tpResModal'), 'A9 打完全篇弹出结果');
chk(st.ok === String(total) && st.acc === '100%', 'A9 状态栏 ' + total + ' 字全对、正确率 100%', st.ok + '/' + st.acc);
const resTxt = await page.textContent('#tpResChars');
chk(new RegExp(total + ' / ' + total).test(resTxt), 'A9 结果页「已打 / 总字数」= ' + total + ' / ' + total, resTxt);
await page.screenshot({ path: path.join(SHOTS, 'typing-result.png') });

const rec = seen.recInsert[0] || {};
chk(seen.recInsert.length === 1, 'A9 练习记录写入云端 1 条', String(seen.recInsert.length));
chk(rec.user_id === MY_ID && rec.owner_name === MY_NAME, 'A9 记录归属当前账号', rec.user_id + '/' + rec.owner_name);
chk(rec.hzk_name === 'hzk002' && rec.total === total, 'A9 记录带字库名与总字数', rec.hzk_name + '/' + rec.total);
chk(rec.ok === total && rec.wrong === 0 && rec.acc === 100, 'A9 记录口径：ok/wrong/acc 对得上', rec.ok + '/' + rec.wrong + '/' + rec.acc);
chk(rec.seconds >= 1 && rec.speed > 0, 'A9 记录带用时与速度', rec.seconds + 's/' + rec.speed);
await page.click('#tpResClose');
await page.waitForTimeout(200);

/* A10 重排（他人的库也能重排 = 所有人可修改） */
console.log('\n【A10. 重排】');
await gotoHzk();
const before = HZK.find(h => h.id === 'h-adm');
await page.click('#hzkList .bank-row[data-id="h-adm"] .act-shuffle');
await page.waitForTimeout(500);
const patch = seen.hzkPatch.find(p => p.id === 'h-adm');
chk(!!patch, 'A10 对他人上传的库发出了重排 PATCH');
const after = HZK.find(h => h.id === 'h-adm');
const sorted = s => [...s].sort().join('');
chk(after.text !== before.text, 'A10 字序已打乱');
chk(sorted(after.text) === sorted(before.text), 'A10 字数与用字不变', after.text);
chk(after.chars === before.chars && after.shuffles === before.shuffles + 1, 'A10 字数不变、shuffles 递增', after.chars + '/' + after.shuffles);
chk((await hzkHeads()).some(h => /已重排/.test(h)) || /已重排/.test(await page.textContent('#hzkList')), 'A10 列表有重排结果提示');

/* A11 练习记录（普通用户） */
console.log('\n【A11. 练习记录（普通用户）】');
await page.click('#toRecords');
await page.waitForTimeout(600);
chk(await visible('#tprec'), 'A11 进入练习记录屏');
const scopeTxt = await page.textContent('#tprecScope');
chk(/我的练习记录/.test(scopeTxt), 'A11 普通用户视角 = 我的练习记录', scopeTxt);
chk(!(await visible('#tprecSearch')), 'A11 普通用户没有账号筛选框');
const recTxt = await page.textContent('#tprecList');
chk(!/张三|李四/.test(recTxt), 'A11 看不到别人的记录');
chk(/hzk002/.test(recTxt), 'A11 能看到自己的记录');
await page.click('#tprecBack');
await page.waitForTimeout(400);
chk(await visible('#hzk'), 'A11 返回字库屏');

/* ---------- 6. B. 管理员 ---------- */
console.log('\n【B. 管理员】');
ROLE = 'admin';
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);
await gotoHzk();
rows = await hzkRows();
const adm2 = rows.find(r => r.id === 'h-adm');
const lock2 = rows.find(r => r.id === 'h-lock');
chk(adm2 && adm2.acts.join() === '打字,重排,改名,可见范围,删除', 'B1 管理员对他人字库有改名/删除/可见范围（全权限）', adm2 && adm2.acts.join());
chk(lock2 && lock2.acts.includes('重排') && lock2.acts.includes('删除'), 'B1 管理员可越过「仅上传者可改」', lock2 && lock2.acts.join());
const admGate = await page.evaluate(async () => window.__hzk.canRenameHz(await window.__hzk.find('h-adm')));
chk(admGate === true, 'B1 内部判定：管理员可以改他人字库的名字', String(admGate));

await page.click('#hzkList .bank-row[data-id="h-other"] .act-scope');
await page.waitForTimeout(300);
chk(await visible('#hzkScopeModal'), 'B4 可见范围弹窗打开');
await page.check('#hzkScopeOpts input[value="scope"]');
await page.waitForTimeout(150);
chk(await visible('#hzkScopeDetail'), 'B4 选「按部门/角色」后展开明细');
await page.click('#hzkDeptChips .tag, #hzkDeptChips .tag-sep', { force: true }).catch(() => { });
await page.evaluate(() => {
  const box = document.getElementById('hzkDeptChips');
  const t = box.querySelector('.tag');
  if (t) t.click();
});
await page.waitForTimeout(120);
await page.click('#hzkScopeSave');
await page.waitForTimeout(500);
const sp = seen.hzkPatch.find(p => p.id === 'h-other');
chk(sp && sp.body.visibility === 'scope', 'B4 保存后 PATCH 带 visibility=scope', sp && JSON.stringify(sp.body));

await page.click('#toRecords');
await page.waitForTimeout(600);
chk(await visible('#tprecSearch'), 'B2 管理员有账号筛选框');
const adminRecTxt = await page.textContent('#tprecList');
chk(/管理员视图/.test(await page.textContent('#tprecScope')), 'B2 管理员视角文案正确');
chk(/张三/.test(adminRecTxt) && /李四/.test(adminRecTxt), 'B2 能看到其他用户的练习记录');
chk(/3 个账号|2 个账号/.test(adminRecTxt) || /平均/.test(adminRecTxt), 'B2 有汇总（平均速度/正确率）', adminRecTxt.slice(0, 80));
await page.fill('#tprecSearch', '张三');
await page.waitForTimeout(250);
chk(/张三/.test(await page.textContent('#tprecList')) && !/李四/.test(await page.textContent('#tprecList')), 'B3 筛选「张三」只剩他的记录');
await page.fill('#tprecSearch', '');
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(SHOTS, 'typing-records-admin.png') });

/* ---------- 7. C. 数据层静态校验 ---------- */
console.log('\n【C. 数据层（supabase/typing.sql）】');
const sql = fs.readFileSync(path.join(ROOT, 'supabase/typing.sql'), 'utf8');
const flat = sql.replace(/\s+/g, ' ');
chk(fs.existsSync(path.join(ROOT, 'supabase/typing.sql')), 'C0 supabase/typing.sql 存在');
chk(/visibility text not null default 'public'/.test(flat) && /editable text not null default 'all'/.test(flat),
  'C1 字库表默认 public + all（所有人可见 + 可重排）');
chk(/create policy exam_hzk_select[\s\S]{0,400}?visibility = 'public'/.test(sql), 'C2 字库 select 策略含全员可见');
chk(/create policy exam_hzk_update[\s\S]{0,400}?editable = 'all'/.test(sql), 'C3 字库 update 策略含 editable=all（所有人可重排）');
chk(/create policy exam_hzk_delete[\s\S]{0,200}?auth\.uid\(\) = user_id or public\.exam_is_admin\(\)/.test(sql), 'C4 字库 delete 只认本人或管理员');
chk(/create policy exam_trec_select[\s\S]{0,200}?public\.exam_is_admin\(\)/.test(sql), 'C5 记录 select 含管理员（可看全部）');
chk(/trg_exam_hzk_lock_scope/.test(sql) && /exam_hzk_lock_scope/.test(sql), 'C6 有可见范围锁定触发器');
chk(/new\.name\s*:=\s*old\.name/.test(flat),
  'C8 同一个触发器也把 name 锁住（改名只有管理员/上传者能动，服务端兜底）');
chk(/trg_exam_hzk_owner/.test(sql) && /new\.source := case when public\.exam_is_admin\(\)/.test(flat),
  'C7 有 insert 触发器按服务端身份定 source');

/* ---------- 8. D. 源码守卫 ---------- */
console.log('\n【D. 源码守卫】');
const srcTyping = fs.readFileSync(path.join(ROOT, 'src/typing.js'), 'utf8');
const srcHzk = fs.readFileSync(path.join(ROOT, 'src/hzk.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
chk(/id="toTyping"/.test(html) && /打字练习/.test(html), 'D1 顶栏入口叫「打字练习」');
chk(/editable: 'all'/.test(srcHzk), 'D2 导入时默认 editable=all');
chk(/const visibility = visEl \? visEl\.value : 'public'/.test(srcHzk), 'D3 导入可见范围默认落到 public');
chk(/\.tp-caret-bar\{[^}]*left:0/.test(css.replace(/\s+/g, '')), 'D4 光标条锚在格子左边界（字前）');
chk(/Math\.max\(15, Math\.min\(30/.test(srcTyping) && /--cw/.test(srcTyping), 'D5 单字宽度自适应且上下行共用');
chk(/editable = 'all' or auth\.uid\(\) = user_id or public\.exam_is_admin\(\)/.test(flat), 'D6 数据库 update 策略与前端口径一致');
chk(/export function canRenameHz\(h\) \{ return !!h && \(isAdmin\(\) \|\| mineOf\(h\)\); \}/.test(srcHzk),
  'D7 前端有独立的 canRenameHz（改名仅管理员/上传者，不再复用 canEditHz）');
chk(/async function renameHz\(h\) \{\s*if \(!canRenameHz\(h\)\)/.test(srcHzk),
  'D7 renameHz 用的是 canRenameHz 这道闸');
chk(!/async function renameHz\(h\) \{\s*if \(!canEditHz\(h\)\)/.test(srcHzk),
  'D7 renameHz 不再复用 canEditHz（否则别人上传的库又变得可改名了）');
chk(/if \(canRenameHz\(h\)\) acts\.push\('<button class="btn btn-ghost btn-sm act-rename"/.test(srcHzk),
  'D7 列表里「改名」按钮也按 canRenameHz 出');

/* ---------- 9. E. 窄屏 ---------- */
console.log('\n【E. 手机端 375px】');
await page.setViewportSize({ width: 375, height: 812 });
await page.click('#toTyping');
await page.waitForTimeout(600);
const overflow = await page.evaluate(() => ({
  docW: document.documentElement.scrollWidth,
  winW: window.innerWidth,
  bodyW: document.body.scrollWidth
}));
chk(overflow.docW <= overflow.winW + 1, 'E1 字库屏无横向溢出', JSON.stringify(overflow));
chk(await visible('#toTyping'), 'E1 窄屏顶栏入口仍在（显示两字短称）');
await page.click('#hzkList .bank-row[data-id="h-mine"] .act-type');
await page.waitForTimeout(600);
await type('敢于正视');
const ov2 = await page.evaluate(() => ({ docW: document.documentElement.scrollWidth, winW: window.innerWidth }));
chk(ov2.docW <= ov2.winW + 1, 'E2 练习屏窄屏无横向溢出', JSON.stringify(ov2));
const align2 = await page.evaluate(() => {
  const b = document.querySelector('.tp-block.active');
  const s = [...b.querySelectorAll('.tp-row.src .tp-cell')].map(c => c.getBoundingClientRect().left);
  const i = [...b.querySelectorAll('.tp-row.inp .tp-cell')].map(c => c.getBoundingClientRect().left);
  return s.map((x, k) => Math.round(Math.abs(x - i[k])));
});
chk(align2.every(d => d === 0), 'E2 窄屏上下行仍逐列对齐', align2.join(','));
await page.screenshot({ path: path.join(SHOTS, 'typing-mobile.png') });

/* ---------- 10. F. 无 JS 报错 ---------- */
console.log('\n【F. 运行期】');
chk(jsErrors.length === 0, 'F1 全程无 JS 报错', jsErrors.slice(0, 3).join(' | '));

/* ---------- 收尾 ---------- */
await browser.close();
srv.kill();
const nAll = n, nBad = fails.length;
console.log(`\n===== 打字练习验收：${nAll - nBad} / ${nAll} 通过 =====`);
if (nBad) {
  console.log('未通过：');
  fails.forEach(f => console.log('  · ' + f));
  process.exitCode = 1;
}
