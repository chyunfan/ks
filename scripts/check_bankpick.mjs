/**
 * 「练习内容」切换（点顶栏那份内容名换题库）的验收。
 *
 * 需求原话：「当前题库改为『练习内容』，可以点击当前内容名称选择，
 *          如图片中点击『2026反洗钱资格考试』选择不同练习内容」。
 * 追加需求：「将打字练习作为练习内容之一，可在下拉选项中选择『打字练习』，页面跳转至打字练习」。
 *
 * 也就是说：以前换题库必须「管理题库 → 找到那一行 → 点练习」，绕一圈；
 * 现在顶栏那行「练习内容：XXX」本身就是入口，点一下弹出列表直接换，
 * 列表里除了各份题库，还固定摆着「打字练习」这一项（它不是题库，单独一组置顶）。
 *
 * 覆盖点：
 *  A. 顶栏入口：文案改成「练习内容」、名字在一个可点按钮里、没选题库时显示「—」
 *  B. 弹层：点开显示、分组（其他练习 / 我上传的 / 其他人上传的）、题库行给出题量/上传者/可见范围、
 *     当前那份有「当前」角标与高亮、遮罩 / ✕ / Esc 三种关闭方式
 *  C. 切换真的生效：顶栏名字跟着变、localStorage 落盘、进入该内容的练习首页、
 *     点「当前」那份只关不重载
 *  D. 口径一致：题库部分与「管理题库」页用的是同一份数据（同一个 listBanks）
 *  E. 手机端 375px：顶栏不溢出、名字省略号、弹层行不溢出
 *  G. 练习中的守卫：做题/打字时入口变灰、内部函数也拦住
 *  H. 「打字练习」作为「练习内容」之一：置顶单列一组、点它跳字库屏、顶栏名字跟着变、
 *     「当前」角标不与题库打架、能直接从打字练习切回题库
 *  F. 源码守卫 + 全程无 JS 报错
 *
 * 用法：node scripts/check_bankpick.mjs
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
const PORT = 5218;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MY_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';

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

/* ---------- 2. 桩数据 ---------- */
const QS_A = [
  { id: 1, type: 'single', stem: '反洗钱题库的第 1 题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null }
];
const QS_B = [
  { id: 1, type: 'single', stem: '张三题库的第 1 题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null },
  { id: 2, type: 'single', stem: '张三题库的第 2 题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null }
];
const LONG_NAME = '2026年反洗钱与反恐怖融资资格考试（客户经理岗）题库';
const BANKS = [
  { id: 'b-wash', user_id: MY_ID, owner_name: '常云凡', name: '2026反洗钱资格考试', questions: QS_A, case_count: 0, created_at: '2026-09-27T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-long', user_id: MY_ID, owner_name: '常云凡', name: LONG_NAME, questions: QS_A, case_count: 2, created_at: '2026-09-26T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-other', user_id: OTHER_ID, owner_name: '张三', name: '张三的信贷题库', questions: QS_B, case_count: 0, created_at: '2026-09-25T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] }
];

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
  localStorage.removeItem('ce_current_bank');   // 初始「还没选练习内容」
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
      if (idEq) {
        const hit = BANKS.filter(b => b.id === decodeURIComponent(idEq[1]));
        const wantSingle = String(req.headers()['accept'] || '').includes('object');
        return fulfil(route, wantSingle ? (hit[0] || null) : hit);
      }
      return fulfil(route, BANKS);
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

const topbar = () => page.evaluate(() => {
  const sub = document.querySelector('.tb-sub');
  const sw = document.getElementById('bankSwitch');
  const name = document.getElementById('topBankName');
  return {
    subText: sub ? sub.textContent.trim() : '(无)',
    hasSwitch: !!sw,
    switchTag: sw ? sw.tagName : '',
    nameText: name ? name.textContent.trim() : '(无)',
    insideSwitch: !!(sw && name && sw.contains(name)),
    bar: (() => { const b = document.getElementById('topbar2'); return b ? { sw: b.scrollWidth, cw: b.clientWidth } : null; })(),
    screen: ['banks', 'home', 'practice', 'result'].filter(s => { const el = document.getElementById(s); return el && !el.classList.contains('hide'); })
  };
});

const picker = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#bankPickList .pick-row')];
  return {
    shown: !document.getElementById('bankPick').classList.contains('hide'),
    title: document.querySelector('#bankPick .modal-head span').textContent.trim(),
    hint: document.getElementById('bankPickHint').textContent.trim(),
    heads: [...document.querySelectorAll('#bankPickList .list-head')].map(e => e.textContent.trim()),
    rows: rows.map(r => ({
      id: r.dataset.id,
      typing: r.dataset.typing === '1',   // 下拉里的「打字练习」入口不是题库，别混进题库口径的断言
      name: (r.querySelector('.pick-name') || {}).textContent ? r.querySelector('.pick-name').textContent.trim() : '',
      meta: (r.querySelector('.pick-meta') || {}).textContent ? r.querySelector('.pick-meta').textContent.trim() : '',
      cur: r.classList.contains('on'),
      flag: (r.querySelector('.pick-flag') || {}).textContent ? r.querySelector('.pick-flag').textContent.trim() : '',
      tag: (r.querySelector('.vis-tag') || {}).textContent ? r.querySelector('.vis-tag').textContent.trim() : ''
    })),
    boxW: Math.round(document.querySelector('#bankPick .modal-box').getBoundingClientRect().width),
    maxRowW: rows.length ? Math.round(Math.max(...rows.map(r => r.getBoundingClientRect().width))) : 0,
    docW: document.documentElement.clientWidth,
    docSW: document.documentElement.scrollWidth
  };
});

const pick = async nameOrId => {
  const ok = await page.evaluate(v => {
    const rows = [...document.querySelectorAll('#bankPickList .pick-row')];
    const hit = rows.find(r => r.dataset.id === v || (r.querySelector('.pick-name') || {}).textContent?.trim().startsWith(v));
    if (!hit) return false;
    hit.click();
    return true;
  }, nameOrId);
  await page.waitForTimeout(500);
  return ok;
};

const stored = () => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('ce_current_bank') || 'null'); } catch (e) { return null; }
});

/* ============ A. 顶栏入口 ============ */
console.log('\n【A. 顶栏「练习内容」入口】');
await page.goto(URL_APP);
await page.waitForTimeout(1500);

let tb = await topbar();
chk(/练习内容/.test(tb.subText), 'A1 顶栏文案是「练习内容：」（不再是「当前题库：」）', tb.subText);
chk(!/当前题库/.test(tb.subText), 'A1 旧文案「当前题库」已经不在顶栏里', tb.subText);
chk(tb.hasSwitch && tb.switchTag === 'BUTTON', 'A1 名字外面是一个真正的按钮（可点、键盘可达）', tb.switchTag);
chk(tb.insideSwitch, 'A1 #topBankName 就在这个按钮里（点名字即点按钮）', JSON.stringify(tb));
chk(tb.nameText === '—', 'A2 还没选过练习内容时显示「—」', tb.nameText);
chk(tb.screen.includes('banks'), 'A2 首次进入停在「管理题库」页（尚未自动进入某个内容）', JSON.stringify(tb.screen));

/* ============ B. 弹层 ============ */
console.log('\n【B. 选择练习内容弹层】');
await page.click('#bankSwitch');
await page.waitForTimeout(500);
let p = await picker();
const bankRows = () => p.rows.filter(r => !r.typing);   // 题库行
const typingRow = () => p.rows.find(r => r.typing);     // 「打字练习」那行
chk(p.shown, 'B1 点顶栏「练习内容」弹出选择弹层', JSON.stringify({ shown: p.shown }));
chk(p.title === '选择练习内容', 'B1 弹层标题是「选择练习内容」', p.title);
chk(bankRows().length === BANKS.length, 'B1 列出全部题库（3 份）', 'n=' + bankRows().length);
chk(p.heads.length === 3 && p.heads[0] === '其他练习'
  && /我上传的（2）/.test(p.heads[1]) && /其他人上传的（1）/.test(p.heads[2]),
  'B1 三组：其他练习 / 我上传的 / 其他人上传的（打字练习单独一组，不跟题库混排）', JSON.stringify(p.heads));
chk(bankRows().some(r => r.name.indexOf('2026反洗钱资格考试') === 0), 'B1 列表里有截图那份「2026反洗钱资格考试」', JSON.stringify(bankRows().map(r => r.name)));
chk(bankRows().every(r => /\d+ 题/.test(r.meta) && /上传者：/.test(r.meta)), 'B2 每题库行给出题量与上传者', JSON.stringify(bankRows().map(r => r.meta)));
chk(bankRows().every(r => /全员可见|仅自己可见|限定/.test(r.tag)), 'B2 每题库行带可见范围徽标（与管理页口径一致）', JSON.stringify(bankRows().map(r => r.tag)));
chk(p.rows.every(r => !r.cur) && p.rows.every(r => r.flag === ''), 'B2 还没选过，所有行都不带「当前」角标', JSON.stringify(p.rows.map(r => [r.cur, r.flag])));
chk(/共 3 份题库/.test(p.hint) && /打字练习/.test(p.hint), 'B2 顶部提示说明了题库总数、也点了打字练习', p.hint);
await page.screenshot({ path: path.join(SHOTS, 'bankpick-open.png'), clip: { x: 0, y: 0, width: 420, height: 700 } });

// 三种关闭方式
// 遮罩中心被弹层盒子盖住，点左上角那点空白处（真实用户点遮罩也是点边上）
 await page.click('#bankPickMask', { position: { x: 6, y: 6 } });
await page.waitForTimeout(250);
chk(!(await picker()).shown, 'B3 点遮罩可关闭');
await page.click('#bankSwitch');
await page.waitForTimeout(400);
await page.click('#bankPickClose');
await page.waitForTimeout(250);
chk(!(await picker()).shown, 'B3 点 ✕ 可关闭');
await page.click('#bankSwitch');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
chk(!(await picker()).shown, 'B3 按 Esc 可关闭');

/* ============ C. 切换真的生效 ============ */
console.log('\n【C. 切换练习内容】');
await page.click('#bankSwitch');
await page.waitForTimeout(450);
chk(await pick('b-other'), 'C1 点得到「张三的信贷题库」这一行');
tb = await topbar();
chk(!(await picker()).shown, 'C1 选完自动收起弹层');
chk(tb.nameText === '张三的信贷题库', 'C1 顶栏名字跟着换成新内容', tb.nameText);
chk(tb.screen.includes('home'), 'C1 直接进入该内容的练习首页（不用再点一次「练习」）', JSON.stringify(tb.screen));
let st = await stored();
chk(st && st.id === 'b-other' && st.name === '张三的信贷题库', 'C2 选中项落盘到 localStorage（刷新后仍停在这份）', JSON.stringify(st));
const loaded = await page.evaluate(() => {
  const qs = window.__exam.questions() || [];
  return { n: qs.length, stem: qs[0] ? qs[0].stem : '' };
});
chk(loaded.n === QS_B.length && /张三题库/.test(loaded.stem),
  'C2 装的确实是新内容的题（题目数/题干都换了）', JSON.stringify(loaded));

// 再打开：当前那份要高亮 + 角标
await page.click('#bankSwitch');
await page.waitForTimeout(450);
p = await picker();
const curRow = p.rows.find(r => r.cur);
chk(!!curRow && curRow.id === 'b-other', 'C3 当前练的那份带高亮 .on', JSON.stringify(p.rows.map(r => [r.id, r.cur])));
chk(curRow && curRow.flag === '当前', 'C3 并显示「当前」角标', curRow ? curRow.flag : '(无)');
chk(p.rows.filter(r => r.cur).length === 1, 'C3 「当前」只有一个（不会同时高亮两份）', 'n=' + p.rows.filter(r => r.cur).length);
await page.screenshot({ path: path.join(SHOTS, 'bankpick-current.png'), clip: { x: 0, y: 0, width: 420, height: 700 } });

// 点「当前」那份 → 只关不重载
const before = await stored();
chk(await pick('b-other'), 'C4 点「当前」那一份');
await page.waitForTimeout(400);
chk(!(await picker()).shown, 'C4 弹层收起');
tb = await topbar();
chk(tb.nameText === '张三的信贷题库' && (await stored()).id === before.id, 'C4 点当前那份不会重载、名字保持不变', tb.nameText);

// 切到自己的另一份
await page.click('#bankSwitch');
await page.waitForTimeout(450);
chk(await pick('b-wash'), 'C5 切换到「2026反洗钱资格考试」');
tb = await topbar();
chk(tb.nameText === '2026反洗钱资格考试', 'C5 顶栏显示新内容名（就是截图里那一行）', tb.nameText);
chk((await stored()).id === 'b-wash', 'C5 落盘也更新了', JSON.stringify(await stored()));
await page.screenshot({ path: path.join(SHOTS, 'bankpick-switched.png'), clip: { x: 0, y: 0, width: 420, height: 420 } });

/* ============ D. 与管理页口径一致 ============ */
console.log('\n【D. 与「管理题库」口径一致】');
await page.click('#toBanks');
await page.waitForTimeout(700);
const listIds = await page.$$eval('#bankList .bank-row', rs => rs.map(r => r.dataset.id).sort());
await page.click('#bankSwitch');
await page.waitForTimeout(450);
p = await picker();
const pickIds = bankRows().map(r => r.id).sort();
chk(listIds.join() === pickIds.join(), 'D1 切换列表里的题库 = 管理页里的题库（同一个 listBanks，可见范围口径一致）',
  JSON.stringify({ list: listIds, pick: pickIds }));
const apiIds = await page.evaluate(async () => (await window.__banks.listBanks()).map(b => b.id).sort());
chk(apiIds.join() === listIds.join(), 'D1 与数据源 listBanks() 也一致', JSON.stringify(apiIds));
// 遮罩中心被弹层盒子盖住，点左上角那点空白处（真实用户点遮罩也是点边上）
 await page.click('#bankPickMask', { position: { x: 6, y: 6 } });
await page.waitForTimeout(250);

/* ============ E. 手机端 375px ============ */
console.log('\n【E. 手机端 375px】');
await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(300);
tb = await topbar();
chk(tb.bar && tb.bar.sw <= tb.bar.cw, 'E1 顶栏内部不横向溢出（长名字走省略号）', JSON.stringify(tb.bar));
await page.click('#bankSwitch');
await page.waitForTimeout(450);
p = await picker();
chk(p.docSW <= p.docW, 'E1 弹层打开后页面无横向溢出', `${p.docSW} > ${p.docW}`);
chk(p.maxRowW <= p.boxW + 1, 'E1 每行不超出弹层宽度', `${p.maxRowW} vs ${p.boxW}`);
chk(bankRows().length === 3, 'E1 窄屏下题库列表仍然完整', 'n=' + bankRows().length);
chk(!!typingRow(), 'E1 窄屏下「打字练习」入口也在（不因空间紧张被砍掉）', JSON.stringify(typingRow()));
await page.screenshot({ path: path.join(SHOTS, 'bankpick-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 700 } });
await page.setViewportSize({ width: 420, height: 1000 });
// 遮罩中心被弹层盒子盖住，点左上角那点空白处（真实用户点遮罩也是点边上）
 await page.click('#bankPickMask', { position: { x: 6, y: 6 } });
await page.waitForTimeout(200);

/* ============ G. 练习中不许换（会串题） ============ */
console.log('\n【G. 练习中的守卫】');
await page.click('#toBanks');
await page.waitForTimeout(700);
await page.click('#bankSwitch');
await page.waitForTimeout(450);
chk(await pick('b-long'), 'G1 先切到另一份练习内容');
await page.waitForTimeout(500);
const atHome = await page.evaluate(() => !document.getElementById('home').classList.contains('hide'));
chk(atHome, 'G1 切换后停在该内容的练习首页', 'home=' + atHome);
await page.evaluate(() => document.getElementById('startBtn').click());
await page.waitForTimeout(700);
const guard = await page.evaluate(() => {
  const sw = document.getElementById('bankSwitch');
  return {
    busy: sw.classList.contains('busy'),
    aria: sw.getAttribute('aria-disabled'),
    title: sw.title,
    practiceShown: !document.getElementById('practice').classList.contains('hide')
  };
});
chk(guard.practiceShown, 'G2 已经进入练习页（正在做题）', JSON.stringify(guard));
chk(guard.busy && guard.aria === 'true', 'G2 练习中顶栏入口变灰、标记为不可用', JSON.stringify(guard));
chk(/不能切换/.test(guard.title), 'G2 悬停提示写明「练习中不能切换」', guard.title);
// 第二道闸：绕过按钮直接调内部入口
await page.evaluate(() => window.__banks.openBankPicker());
await page.waitForTimeout(450);
chk(!(await picker()).shown, 'G2 绕过按钮直调内部入口也打不开（不同题库题号会重复，中途换库会串题）');
await page.evaluate(() => document.getElementById('quitBtn').click());
await page.waitForTimeout(600);
const after = await page.evaluate(() => ({
  busy: document.getElementById('bankSwitch').classList.contains('busy'),
  home: !document.getElementById('home').classList.contains('hide')
}));
chk(after.home && !after.busy, 'G3 退出练习后入口恢复可点（进度已保存，可继续练习）', JSON.stringify(after));
await page.click('#bankSwitch');
await page.waitForTimeout(450);
chk((await picker()).shown, 'G3 退出后能正常打开切换列表');
await page.click('#bankPickClose');
await page.waitForTimeout(250);

/* ============ H. 打字练习作为「练习内容」之一 ============ */
console.log('\n【H. 下拉里的「打字练习」】');
const beforeH = await stored();
await page.click('#bankSwitch');
await page.waitForTimeout(450);
p = await picker();
let t = typingRow();
chk(!!t && t.name === '打字练习', 'H1 下拉里有「打字练习」一行', JSON.stringify(t));
chk(p.heads[0] === '其他练习' && p.heads.length === 3, 'H1 它归在首组「其他练习」下（不跟题库混排）', JSON.stringify(p.heads));
chk(await page.evaluate(() => {
  const first = document.querySelector('#bankPickList .pick-row');
  return !!first && first.dataset.typing === '1';
}), 'H1 它排在所有题库行前面', '');
chk(!!t && /字库/.test(t.meta) && !/上传者：/.test(t.meta),
  'H1 副标题说明它是什么（与题库行的元信息口径不同）', t ? t.meta : '');

await page.evaluate(() => document.querySelector('#bankPickList .pick-row[data-typing="1"]').click());
await page.waitForTimeout(800);
const inHzk = await page.evaluate(() => ({
  picker: !document.getElementById('bankPick').classList.contains('hide'),
  hzk: !document.getElementById('hzk').classList.contains('hide'),
  name: document.getElementById('topBankName').textContent.trim(),
  busy: document.getElementById('bankSwitch').classList.contains('busy'),
  stored: (() => { try { return JSON.parse(localStorage.getItem('ce_current_bank') || 'null'); } catch (e) { return null; } })()
}));
chk(!inHzk.picker, 'H2 选完自动收起弹层', JSON.stringify(inHzk));
chk(inHzk.hzk, 'H2 页面跳到打字练习（字库列表屏）', JSON.stringify(inHzk));
chk(inHzk.name === '打字练习', 'H2 顶栏那行名字变成「打字练习」', inHzk.name);
chk(!inHzk.busy, 'H2 字库列表屏不算「练习中」，入口仍可点（还能换回去）', JSON.stringify(inHzk));
chk(inHzk.stored && beforeH && inHzk.stored.id === beforeH.id,
  'H2 不动「上次题库」的记录（刷新后仍回到原来那份题库）', JSON.stringify({ before: beforeH, after: inHzk.stored }));
await page.screenshot({ path: path.join(SHOTS, 'bankpick-typing.png'), clip: { x: 0, y: 0, width: 420, height: 700 } });

// 在打字练习里再打开下拉：当前内容换成打字练习，题库行就不该再标「当前」
await page.click('#bankSwitch');
await page.waitForTimeout(450);
p = await picker();
t = typingRow();
chk(!!t && t.cur && t.flag === '当前', 'H3 这时「打字练习」带「当前」角标', JSON.stringify(t));
chk(bankRows().every(r => !r.cur), 'H3 题库行都不带「当前」（当前内容是打字练习，两边都标会打架）', JSON.stringify(bankRows().map(r => [r.id, r.cur])));
chk(p.rows.filter(r => r.cur).length === 1, 'H3 「当前」始终只有一个', 'n=' + p.rows.filter(r => r.cur).length);
await page.screenshot({ path: path.join(SHOTS, 'bankpick-typing-cur.png'), clip: { x: 0, y: 0, width: 420, height: 700 } });

// 点「当前」的打字练习 → 只关不重进
await page.evaluate(() => document.querySelector('#bankPickList .pick-row[data-typing="1"]').click());
await page.waitForTimeout(400);
chk(!(await picker()).shown, 'H4 点「当前」的打字练习只关掉弹层', '');
chk(await visible('#hzk'), 'H4 仍停在字库屏（不重新进入）', '');

// 从打字练习切回题库
await page.click('#bankSwitch');
await page.waitForTimeout(450);
chk(await pick('b-wash'), 'H5 从打字练习里能直接切回题库');
await page.waitForTimeout(600);
const backHome = await page.evaluate(() => ({
  home: !document.getElementById('home').classList.contains('hide'),
  hzk: !document.getElementById('hzk').classList.contains('hide'),
  name: document.getElementById('topBankName').textContent.trim()
}));
chk(backHome.home && !backHome.hzk, 'H5 进到该题库的练习首页（字库屏已收起）', JSON.stringify(backHome));
chk(backHome.name === '2026反洗钱资格考试', 'H5 顶栏名字从「打字练习」换回题库名', backHome.name);

// 打字练习进行中（打字屏）：跟做题一样拦住不给换
const typingBusy = await page.evaluate(() => {
  document.getElementById('home').classList.add('hide');
  document.getElementById('hzk').classList.add('hide');
  document.getElementById('typing').classList.remove('hide');
  return { busy: window.__banks.busyPracticing(), onTyping: window.__banks.isOnTypingScreen() };
});
chk(typingBusy.busy && typingBusy.onTyping, 'H6 打字屏里内部闸也为真（与顶栏变灰口径一致）', JSON.stringify(typingBusy));
await page.evaluate(() => window.__banks.openBankPicker());
await page.waitForTimeout(400);
chk(!(await picker()).shown, 'H6 打字屏里绕过按钮直调内部入口也打不开（打了一半换内容这一轮就断了）', '');
await page.evaluate(() => {
  document.getElementById('typing').classList.add('hide');
  document.getElementById('home').classList.remove('hide');
});
await page.waitForTimeout(300);

/* ============ F. 源码守卫 ============ */
console.log('\n【F. 源码守卫】');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const bjs = fs.readFileSync(path.join(ROOT, 'src/banks.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
chk(/id="bankSwitch"/.test(html) && /练习内容：/.test(html), 'F1 index.html 顶栏是「练习内容：+ 可点按钮 #bankSwitch」', '');
chk(!/当前题库：/.test(html), 'F1 index.html 里没有残留的「当前题库：」', '');
chk(/id="bankPick"/.test(html) && /选择练习内容/.test(html), 'F1 index.html 有 #bankPick 弹层骨架', '');
chk(/export async function openBankPicker/.test(bjs), 'F2 banks.js 导出 openBankPicker', '');
chk(/await listBanks\(\)/.test(bjs.split('export async function openBankPicker')[1] || ''), 'F2 切换列表复用 listBanks（不另起一套查询，口径才不会漂）', '');
chk(/closeBankPicker\(\);[\s\S]{0,220}?await openBank\(b\)/.test(bjs), 'F2 选完先收弹层再取题（弹层不压在新页面上）', '');
chk(/data-cur=/.test(bjs) && /dataset\.cur === '1'/.test(bjs), 'F2 点当前那份时短路（不重复重载）', '');
chk(/\.tb-switch\{/.test(css) && /\.pick-row\{/.test(css), 'F3 styles.css 有 .tb-switch / .pick-row 样式', '');
chk(/\.pick-typing\{/.test(css) && /\.pick-ic\{/.test(css), 'F3 styles.css 有 .pick-typing / .pick-ic（打字练习行跟题库行一眼区分）', '');
const mjs = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
chk(/function pickTypingRow/.test(bjs) && /data-typing/.test(bjs), 'F3 banks.js 有「打字练习」入口行（带 data-typing 标记）', '');
chk(/onOpenTyping/.test(bjs) && /onOpenTyping: showHzk/.test(mjs), 'F3 main.js 把「打字练习」的去处（showHzk）注进下拉', '');
chk(/TYPING_SCREENS/.test(mjs) && /'打字练习'/.test(mjs), 'F3 main.js 在打字那几屏把顶栏名字切成「打字练习」', '');
chk(jsErrors.length === 0, 'F4 全程无 JS 报错', jsErrors.join(' | '));

await browser.close();
srv.kill();

console.log(`\n切换练习内容：${n - fails.length} / ${n} 通过`);
if (fails.length) {
  console.log('未通过：');
  fails.forEach(f => console.log('   · ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过（截图见 shots/bankpick-*.png）');
}
