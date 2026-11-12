/**
 * 「编辑题目」端到端验收（题库列表 → 编辑题目）
 *
 * 这个功能要替代之前「手写 SQL 改 jsonb」的做法，所以守的是三条线：
 *  ① **答案不可能错位**：用户只勾选正确答案，answerKeys / correctIdx 由程序推导。
 *     → 删选项时后面的正确答案下标要整体前移（手写 SQL 最容易漏的就是这一步）。
 *  ② **id 一个都不能变**：错题集 / 收藏 / 练习进度 / 答题卡标记全按题目 id 关联。
 *  ③ **未改动的题原样写回**：带未知字段的历史题目，保存后必须逐字节不变。
 *
 * 覆盖点：
 *  A. 入口与权限
 *    A1 非管理员：自己的库有「编辑题目」，他人的库没有
 *    A2 纵深防御：手工往他人题库行塞「编辑题目」再点 → 提示无权限且不发 PATCH
 *    A3 管理员：他人的库也有「编辑题目」
 *    A4 打开编辑器：弹层可见、题库名/总题数正确
 *  B. 改选项文字与保存
 *    B1 改 A 选项文字 → 状态栏「已改动 1 题」、保存按钮被启用
 *    B2 保存 → PATCH 发到正确的题库，questions 里是新文字
 *    B3 保存 payload：题目 id 全部不变、答案字段仍自洽
 *    B4 未改动的题原样写回（含自定义未知字段 __weird / extraNested）
 *    B5 保存后重新打开：新文字真的落盘了
 *  C. 正确答案由勾选推导（核心）
 *    C1 单选改选 B → answerKeys=['B']、correctIdx=[1]
 *    C2 判断题改「错误」→ answerKeys/answerText/correctIdx 三者同时变
 *    C3 多选勾 A、C → answerKeys=['A','C']、correctIdx=[0,2]
 *  D. 选项增删不错位（在第 1 题上做：单选 + 3 个选项，才有可删空间）
 *    D1 删掉第一个选项 → 后面的答案下标整体前移、字母重算（B→A）
 *    D2 删掉正好是正确答案的那个 → 答案清空，保存被拦
 *    D3 连续新增选项 → 字母自动往后补（丙/丁/戊），点选即算出字母
 *    D4 新增了空选项 → 保存被拦（不许存半截数据）
 *  E. 校验与保存拦截
 *    E1 题干清空 → 保存被拦，弹层不关
 *    E2 选项文字清空 → 被拦
 *    E3 多选题只剩 1 个答案 → 被拦
 *  F. 撤销 / 关闭
 *    F1 「撤销本题」恢复原样、dirty 清零
 *    F2 「全部还原」清空全部改动
 *    F3 有未保存改动时点 ✕ → 先弹确认；取消则弹层不关
 *    F4 无改动时点 ✕ → 不弹确认，直接关闭
 *  G. 导航与筛选
 *    G1 题型筛选「判断」只出判断题
 *    G2 「只看改过的」只剩改过的题
 *    G3 跳题输入框跳到指定题
 *    G4 首题「上一题」禁用
 *  H. 移动端 375 / 320
 *  I. 源码守卫（保存路径按 dirty 挑题、未改动用 raw、id 不被改写）
 *  K. 交付产物 dist/index.html（弹层骨架在位、无验收钩子、0 外链）
 *  J. 全程无 JS 报错
 *
 * 用法：node scripts/check_qedit.mjs
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
const PORT = 5210;
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
let ROLE = 'user';

/** 每次重开题库都重新生成一份，保证各段用例互不污染 */
const MK = () => ([
  // 1 单选，3 个选项，答案 B（给 D 段的「删选项后答案前移」留出可删空间）
  { id: 1, type: 'single', stem: '题干一', options: [{ key: 'A', text: '选项甲' }, { key: 'B', text: '选项乙' }, { key: 'C', text: '选项丙' }], answerKeys: ['B'], answerText: null, correctIdx: [1], analysis: '解析一' },
  // 2 多选，答案 A、B
  { id: 2, type: 'multiple', stem: '题干二', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }, { key: 'C', text: '丙' }], answerKeys: ['A', 'B'], answerText: null, correctIdx: [0, 1], analysis: null },
  // 3 判断，答案 正确
  { id: 3, type: 'judge', stem: '题干三', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerKeys: ['A'], answerText: '正确', correctIdx: [0], analysis: null },
  // 4 带未知字段：用来验证「未改动的题原样写回」
  { id: 4, type: 'single', stem: '题干四', options: [{ key: 'A', text: '甲四' }, { key: 'B', text: '乙四' }], answerKeys: ['A'], correctIdx: [0], analysis: null, __weird: 'KEEP-ME', extraNested: { a: 1, b: ['x'] } },
  // 5/6 案例组（同一 caseId，材料在每道小题上各存一份）
  { id: 5, type: 'single', stem: '案例小题一', options: [{ key: 'A', text: '甲五' }, { key: 'B', text: '乙五' }], answerKeys: ['A'], correctIdx: [0], analysis: null, isCase: true, caseId: 1, caseBackground: '案例材料原文' },
  { id: 6, type: 'single', stem: '案例小题二', options: [{ key: 'A', text: '甲六' }, { key: 'B', text: '乙六' }], answerKeys: ['B'], correctIdx: [1], analysis: null, isCase: true, caseId: 1, caseBackground: '案例材料原文' }
]);

let BANKS = [
  { id: 'b-mine', user_id: MY_ID, owner_name: '常云凡', name: '我导入的题库', questions: MK(), case_count: 1, created_at: '2026-09-20T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-other', user_id: OTHER_ID, owner_name: '张三', name: '张三的信贷题库', questions: MK(), case_count: 1, created_at: '2026-09-19T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] }
];

const seen = { patch: [] };
const ORIG_MK = JSON.stringify(MK());

/* ---------- 3. 浏览器 + 接口桩 ---------- */
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2 });
const jsErrors = [];
const dialogs = [];
let DIALOG_MODE = 'accept';        // accept | dismiss
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', async d => {
  dialogs.push({ type: d.type(), msg: d.message() });
  if (DIALOG_MODE === 'dismiss') await d.dismiss(); else await d.accept();
});

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = () => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: MY_ID, username: '常云凡', role: 'authenticated' }) + '.sig';

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
  id: MY_ID, username: '常云凡', isAdmin: ROLE === 'admin', dept: '人力资源部', role: '员工'
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
        const wantSingle = String(req.headers()['accept'] || '').includes('object');
        return fulfil(route, wantSingle ? (hit[0] || null) : hit);
      }
      return fulfil(route, BANKS);
    }
    if (m === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      const idEq = url.match(/id=eq\.([^&]+)/);
      const bid = idEq ? decodeURIComponent(idEq[1]) : null;
      seen.patch.push({ bankId: bid, body });
      const hit = BANKS.find(b => b.id === bid);
      if (hit && body.questions) hit.questions = body.questions;   // 模拟落盘，供「重新打开」验证
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
const reload = async () => { await page.reload(); await page.waitForTimeout(1300); };
const rows = () => page.$$eval('#bankList .bank-row', rs => rs.map(r => ({
  id: r.dataset.id,
  acts: Array.from(r.querySelectorAll('.bank-acts .btn')).map(b => b.textContent.trim())
})));
const visible = sel => page.$eval(sel, el => {
  if (el.classList.contains('hide')) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  return el.getClientRects().length > 0;
}).catch(() => false);

/** 打开指定题库的编辑器（走列表里的真实按钮） */
async function openEdit(bankId) {
  await page.click(`.bank-row[data-id="${bankId}"] .act-edit`);
  await page.waitForTimeout(600);
}
const qeState = () => page.evaluate(() => {
  const s = window.__qedit.state();
  return {
    shown: !document.getElementById('qeModal').classList.contains('hide'),
    bank: s ? s.bank.name : null,
    idx: s ? s.idx : -1,
    total: s ? s.total : -1,
    dirty: s ? s.dirty : [],
    filter: s ? s.filter : null,
    onlyMod: s ? s.onlyMod : null,
    status: document.getElementById('qeStatus').textContent.trim(),
    msg: (document.getElementById('qeMsg') || {}).textContent ? document.getElementById('qeMsg').textContent.trim() : '',
    jump: document.getElementById('qeJump').value,
    saveDisabled: document.getElementById('qeSave').disabled,
    prevDisabled: document.getElementById('qePrev').disabled,
    nextDisabled: document.getElementById('qeNext').disabled,
    stem: (document.querySelector('#qeBody textarea[data-f="stem"]') || {}).value,
    optTexts: Array.from(document.querySelectorAll('#qeBody textarea[data-f="otext"], #qeBody .qe-otext-ro')).map(x => x.value !== undefined ? x.value : x.textContent),
    onIdx: Array.from(document.querySelectorAll('#qeBody .qe-opt')).map(o => o.classList.contains('on')),
    checked: Array.from(document.querySelectorAll('#qeBody .qe-pick input')).map(i => i.checked),
    cur: (document.getElementById('qeCur') || {}).textContent,
    modTag: !!document.querySelector('.qe-modtag')
  };
});
/** 拿到编辑器「将要写回」的内容（模拟真实保存路径，不发请求） */
const payload = () => page.evaluate(() => window.__qedit.payload());
const setText = (sel, v) => page.evaluate(([s, val]) => {
  const el = document.querySelector(s);
  el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, v]);
const pickOpt = k => page.evaluate(k => {
  document.querySelectorAll('#qeBody .qe-opt .qe-pick input')[k].click();
}, k);
const clickIn = sel => page.evaluate(s => document.querySelector(s).click(), sel);

/* ================= A. 入口与权限 ================= */
console.log('\n【A. 入口与权限】');
ROLE = 'user';
await page.goto(URL_APP);
await page.waitForTimeout(1500);

let rs = await rows();
const mine = rs.find(r => r.id === 'b-mine');
const other = rs.find(r => r.id === 'b-other');
chk(mine && mine.acts.join() === '练习,编辑题目,重命名,导出,删除',
  'A1 自己的题库：多了「编辑题目」（排在练习之后）', mine && mine.acts.join());
chk(other && other.acts.join() === '练习',
  'A1 他人的题库：仍然只有「练习」，看不到「编辑题目」', other && other.acts.join());

// A2 纵深防御：绕开界面，直接调内部入口（等于 DOM 被改写 / 代码被外部调用）
dialogs.length = 0;
seen.patch.length = 0;
await page.evaluate(async () => {
  const b = await window.__banks.find('b-other');
  await window.__banks.editQuestions(b);
});
await page.waitForTimeout(500);
chk(dialogs.some(d => /无权限/.test(d.msg)), 'A2 直调内部入口（绕过按钮）→ 仍提示无权限', JSON.stringify(dialogs.map(d => d.msg)));
chk(!(await visible('#qeModal')), 'A2 弹层没有被打开', '');
chk(seen.patch.length === 0, 'A2 没有发出任何保存请求', String(seen.patch.length));
// A2 另一半：手工往他人题库行塞一个「编辑题目」按钮再点（没有绑定事件，同样什么都改不了）
dialogs.length = 0;
await page.evaluate(() => {
  document.querySelector('.bank-row[data-id="b-other"] .bank-acts')
    .insertAdjacentHTML('beforeend', '<button class="btn btn-ghost btn-sm act-edit" type="button">编辑题目</button>');
  document.querySelector('.bank-row[data-id="b-other"] .act-edit').click();
});
await page.waitForTimeout(400);
chk(!(await visible('#qeModal')) && seen.patch.length === 0,
  'A2 手工塞进他人题库行的按钮点了也没反应（未绑定事件）', '');
await reload();

// A3 管理员
ROLE = 'admin';
await reload();
rs = await rows();
chk(rs.find(r => r.id === 'b-other') && rs.find(r => r.id === 'b-other').acts.includes('编辑题目'),
  'A3 管理员：他人的题库也有「编辑题目」', rs.find(r => r.id === 'b-other').acts.join());
ROLE = 'user';
await reload();

// A4 打开编辑器
await openEdit('b-mine');
let s = await qeState();
chk(s.shown, 'A4 编辑器弹层打开了', String(s.shown));
chk(s.bank === '我导入的题库', 'A4 标题显示题库名', s.bank);
chk(s.total === 6 && s.jump === '1', 'A4 总题数与起始题号正确（6 题 / 第 1 题）', s.total + ' / ' + s.jump);
chk(s.stem === '题干一', 'A4 默认展示第 1 题内容', s.stem);
chk(s.prevDisabled === true, 'G4 首题「上一题」禁用', String(s.prevDisabled));
chk(s.saveDisabled === true && /还没有改动/.test(s.status), 'A4 未改动时保存按钮禁用', s.status);

/* ================= B. 改选项文字与保存 ================= */
console.log('\n【B. 改选项文字与保存】');
await setText('#qeBody textarea[data-f="otext"]', '选项甲（已改）');
s = await qeState();
chk(s.dirty.length === 1 && /已改动 1 题/.test(s.status), 'B1 改动后状态栏计数为 1', s.status);
chk(s.saveDisabled === false, 'B1 保存按钮被启用', String(s.saveDisabled));
chk(s.modTag === true, 'B1 题目右上出现「已改动」角标', String(s.modTag));
chk(s.optTexts[0] === '选项甲（已改）', 'B1 输入内容已进模型', s.optTexts[0]);

// B3/B4 先看将要写回的内容（不依赖网络断言）
let pl = await payload();
chk(Array.isArray(pl) && pl.length === 6, 'B3 写回的是完整 6 道题', pl ? String(pl.length) : 'null');
chk(pl.every((q, i) => q.id === i + 1), 'B3 题目 id 一个都没变（1..6）', pl.map(q => q.id).join(','));
chk(pl[0].options[0].text === '选项甲（已改）', 'B3 第 1 题的 A 选项是新文字', pl[0].options[0].text);
chk(pl[0].answerKeys.join() === 'B' && pl[0].correctIdx.join() === '1',
  'B3 只改文字不影响答案（仍是 B / [1]）', pl[0].answerKeys + ' / ' + pl[0].correctIdx);
chk(pl[1].__weird === undefined, 'B4 判断题没有多余字段（对照用）', String(pl[1].__weird));
chk(pl[3].__weird === 'KEEP-ME' && JSON.stringify(pl[3].extraNested) === '{"a":1,"b":["x"]}',
  'B4 未改动的题原样写回：未知字段 __weird / extraNested 完整保留', JSON.stringify(pl[3]).slice(0, 80));
chk(JSON.stringify(pl[3]) === JSON.stringify(MK()[3]), 'B4 未改动的题与原始数据逐字节一致', '');

// B2 真保存
seen.patch.length = 0;
dialogs.length = 0;
await clickIn('#qeSave');
await page.waitForTimeout(700);
chk(dialogs.some(d => /将把 1 道题/.test(d.msg)), 'B2 保存前弹确认，说明改了几道题与 id 不变', JSON.stringify(dialogs.map(d => d.msg)));
chk(seen.patch.length === 1, 'B2 只发出一次 PATCH', String(seen.patch.length));
chk(seen.patch[0] && seen.patch[0].bankId === 'b-mine', 'B2 PATCH 打在正确的题库上', seen.patch[0] && seen.patch[0].bankId);
const sent = seen.patch[0] ? seen.patch[0].body.questions : [];
chk(sent.length === 6 && sent[0].options[0].text === '选项甲（已改）',
  'B2 请求体里是新文字', sent[0] ? sent[0].options[0].text : '-');
chk(sent.every(q => q.id === q.id) && sent[3].__weird === 'KEEP-ME',
  'B2 请求体里 id 未变、未知字段仍在', '');
s = await qeState();
chk(s.dirty.length === 0 && /已保存 1 道题/.test(s.msg) && /题目编号未变/.test(s.msg),
  'B2 保存后提示已保存、且没有残留改动', JSON.stringify({ status: s.status, msg: s.msg }));

// B5 重新打开看是否真的落盘
await clickIn('#qeClose');
await page.waitForTimeout(300);
await openEdit('b-mine');
s = await qeState();
chk(s.optTexts[0] === '选项甲（已改）', 'B5 重新打开编辑器：新文字确实落盘了', s.optTexts[0]);
chk(s.dirty.length === 0 && s.saveDisabled === true, 'B5 重新打开后没有残留改动', s.status);
await page.screenshot({ path: path.join(SHOTS, 'qe-edit.png') });
await clickIn('#qeClose');
await page.waitForTimeout(250);

/* ================= C. 正确答案由勾选推导 ================= */
console.log('\n【C. 正确答案由勾选推导】');
await openEdit('b-mine');

// C1 单选
await pickOpt(0);
pl = await payload();
chk(pl[0].answerKeys.join() === 'A' && pl[0].correctIdx.join() === '0',
  'C1 单选点选 A → answerKeys=[A]、correctIdx=[0] 自动同步', pl[0].answerKeys + ' / ' + pl[0].correctIdx);
await pickOpt(1);
pl = await payload();
chk(pl[0].answerKeys.join() === 'B' && pl[0].correctIdx.join() === '1',
  'C1 改选 B → 两者跟着变成 [B] / [1]', pl[0].answerKeys + ' / ' + pl[0].correctIdx);

// C2 判断题
await page.evaluate(() => window.__qedit.jump(2));
await page.waitForTimeout(200);
s = await qeState();
chk(s.stem === '题干三' && s.optTexts.join('|') === '正确|错误',
  'C2 跳到判断题：选项固定为「正确 / 错误」', s.optTexts.join('|'));
chk((await page.$$('#qeBody [data-del]')).length === 0 && !(await visible('#qeAddOpt')),
  'C2 判断题不提供增删选项（选项是固定的）', '');
await pickOpt(1);          // 改选「错误」
pl = await payload();
chk(pl[2].answerKeys.join() === 'B' && pl[2].correctIdx.join() === '1' && pl[2].answerText === '错误',
  'C2 判断题改「错误」→ answerKeys/answerText/correctIdx 三者同时变（少一个都会让「去除正确的判断题」失灵）',
  JSON.stringify({ k: pl[2].answerKeys, t: pl[2].answerText, i: pl[2].correctIdx }));
await pickOpt(0);
pl = await payload();
chk(pl[2].answerText === '正确' && pl[2].answerKeys.join() === 'A', 'C2 改回「正确」同样三者一致', pl[2].answerText);

// C3 多选
await page.evaluate(() => window.__qedit.jump(1));
await page.waitForTimeout(200);
await page.evaluate(() => {
  // 先清成只剩 A，再勾 C，验证多选是累加而不是替换
  document.querySelectorAll('#qeBody .qe-opt .qe-pick input')[1].click();
});
await page.waitForTimeout(150);
pl = await payload();
chk(pl[1].correctIdx.join() === '0', 'C3 多选取消 B → 只剩 A', pl[1].correctIdx.join());
await pickOpt(2);
pl = await payload();
chk(pl[1].answerKeys.join() === 'A,C' && pl[1].correctIdx.join() === '0,2',
  'C3 多选再勾 C → answerKeys=[A,C]、correctIdx=[0,2]', pl[1].answerKeys + ' / ' + pl[1].correctIdx);
chk(pl[1].answerKeys.length === pl[1].correctIdx.length,
  'C3 answerKeys 与 correctIdx 长度始终相等（永远不会错位）', pl[1].answerKeys.length + ' vs ' + pl[1].correctIdx.length);
await page.screenshot({ path: path.join(SHOTS, 'qe-options.png') });

/* ================= D. 选项增删不错位 ================= */
console.log('\n【D. 选项增删不错位】');
// 第 1 题（单选，A/B/C 三项）：答案是 B = 下标 1
// 先清掉 C 段留在第 2 题上的改动，让本段只面对第 1 题
dialogs.length = 0;
await clickIn('#qeRevertAll');
await page.waitForTimeout(200);

// D1 删掉第一个选项（不是答案）→ 原答案必须自动前移、字母重算
await page.evaluate(() => window.__qedit.jump(0));
await page.waitForTimeout(200);
await page.evaluate(() => document.querySelectorAll('#qeBody [data-del]')[0].click());
await page.waitForTimeout(200);
s = await qeState();
chk(s.optTexts.join('|') === '选项乙|选项丙', 'D1 删掉第一个选项后剩下「乙 / 丙」并重新编号', s.optTexts.join('|'));
pl = await payload();
chk(pl[0].correctIdx.join() === '0' && pl[0].answerKeys.join() === 'A',
  'D1 原答案 B（下标 1）随删除自动前移到下标 0 / 字母 A', pl[0].answerKeys + ' / ' + pl[0].correctIdx);

// 撤销回去，准备 D2（要删的必须是「正确答案那一项」，且删完还剩 ≥2 个选项）
await clickIn('#qeRevert');
await page.waitForTimeout(200);
pl = await payload();
chk(pl[0].options.length === 3 && pl[0].answerKeys.join() === 'B', 'D1 撤销后恢复成 3 个选项 / 答案 B', pl[0].options.length + ' / ' + pl[0].answerKeys);

// D2 删掉正好是正确答案的那个 → 答案清空（而不是留一个指向错位置的下标）
await page.evaluate(() => document.querySelectorAll('#qeBody [data-del]')[1].click());
await page.waitForTimeout(200);
pl = await payload();
chk(pl[0].options.length === 2 && pl[0].correctIdx.length === 0 && pl[0].answerKeys.length === 0,
  'D2 删掉正确答案所在选项 → 答案被清空（而不是指向错的下标）',
  JSON.stringify({ opts: pl[0].options.length, idx: pl[0].correctIdx, keys: pl[0].answerKeys }));
dialogs.length = 0;
await clickIn('#qeSave');
await page.waitForTimeout(500);
chk(dialogs.some(d => /不能保存/.test(d.msg) && /还没有设置正确答案/.test(d.msg)),
  'D2 保存被拦并明确说明原因', JSON.stringify(dialogs.map(d => d.msg).slice(-1)));
chk(await visible('#qeModal'), 'D2 被拦后弹层仍然开着（不丢改动）', '');

// D3 连续加回两个选项：字母自动往后补，点选即自动算出字母
const addOpt = () => page.evaluate(() => document.getElementById('qeAddOpt').click());
const setLastOpt = v => page.evaluate(val => {
  const tas = document.querySelectorAll('#qeBody textarea[data-f="otext"]');
  const last = tas[tas.length - 1];
  last.value = val;
  last.dispatchEvent(new Event('input', { bubbles: true }));
}, v);
await addOpt();
await page.waitForTimeout(150);
await setLastOpt('选项丁');
await addOpt();
await page.waitForTimeout(150);
await setLastOpt('选项戊');
await page.waitForTimeout(150);
s = await qeState();
chk(s.optTexts.join('|') === '选项甲（已改）|选项丙|选项丁|选项戊', 'D3 连续新增两个选项，接在末尾', s.optTexts.join('|'));
await pickOpt(2);
pl = await payload();
chk(pl[0].answerKeys.join() === 'C' && pl[0].correctIdx.join() === '2',
  'D3 点选第 3 个选项 → 字母自动算出 C / 下标 2（不用手写）', pl[0].answerKeys + ' / ' + pl[0].correctIdx);

// D4 校验拦得住「空选项」：新增后不填内容不许存
await addOpt();
await page.waitForTimeout(150);
dialogs.length = 0;
await clickIn('#qeSave');
await page.waitForTimeout(400);
chk(dialogs.some(d => /选项内容为空/.test(d.msg)), 'D4 新增了空选项 → 保存被拦（不许存半截数据）',
  JSON.stringify(dialogs.map(d => d.msg).slice(-1)));

// 撤销本题，避免影响后面
await clickIn('#qeRevert');
await page.waitForTimeout(200);
s = await qeState();
chk(s.dirty.length === 0 && s.optTexts.join('|') === '选项甲（已改）|选项乙|选项丙',
  'F1 撤销本题 → 恢复原样（含之前保存的新文字）、dirty 清零', JSON.stringify({ dirty: s.dirty, opts: s.optTexts.join('|') }));

/* ================= E. 校验拦截 ================= */
console.log('\n【E. 校验与保存拦截】');
await clickIn('#qeRevertAll').catch(() => { });
await page.waitForTimeout(150);
await page.evaluate(() => window.__qedit.jump(0));
await page.waitForTimeout(150);
await setText('#qeBody textarea[data-f="stem"]', '   ');
await page.waitForTimeout(150);
dialogs.length = 0;
await clickIn('#qeSave');
await page.waitForTimeout(400);
chk(dialogs.some(d => /题干不能为空/.test(d.msg)), 'E1 题干清空 → 保存被拦（题干不能为空）', JSON.stringify(dialogs.map(d => d.msg).slice(-1)));
chk(seen.patch.length === 1, 'E1 被拦时没有发出新的 PATCH', String(seen.patch.length));

await setText('#qeBody textarea[data-f="stem"]', '题干一');
await setText('#qeBody textarea[data-f="otext"]', '   ');
await page.waitForTimeout(150);
dialogs.length = 0;
await clickIn('#qeSave');
await page.waitForTimeout(400);
chk(dialogs.some(d => /选项内容为空/.test(d.msg)), 'E2 选项文字清空 → 保存被拦', JSON.stringify(dialogs.map(d => d.msg).slice(-1)));

await setText('#qeBody textarea[data-f="otext"]', '选项甲（已改）');
await page.evaluate(() => window.__qedit.jump(1));
await page.waitForTimeout(150);
// 多选只留 1 个答案
await page.evaluate(() => {
  const inputs = document.querySelectorAll('#qeBody .qe-opt .qe-pick input');
  // 只保留 B，其余取消
  inputs.forEach((ipt, i) => { if (i !== 1 && ipt.checked) ipt.click(); });
});
await page.waitForTimeout(200);
pl = await payload();
chk(pl[1].correctIdx.length === 1, 'E3 多选被改成只有 1 个答案', JSON.stringify(pl[1].correctIdx));
dialogs.length = 0;
await clickIn('#qeSave');
await page.waitForTimeout(400);
chk(dialogs.some(d => /至少要 2 个/.test(d.msg)), 'E3 多选题答案只剩 1 个 → 保存被拦', JSON.stringify(dialogs.map(d => d.msg).slice(-1)));

/* ================= F. 撤销 / 关闭 ================= */
console.log('\n【F. 撤销 / 关闭】');
await clickIn('#qeRevertAll');
await page.waitForTimeout(250);
s = await qeState();
chk(s.dirty.length === 0 && /还没有改动/.test(s.status), 'F2 全部还原 → dirty 清零', s.status);

dialogs.length = 0;
await clickIn('#qeClose');
await page.waitForTimeout(300);
chk(dialogs.length === 0, 'F4 无改动时关闭不弹确认', JSON.stringify(dialogs.map(d => d.msg)));
chk(!(await visible('#qeModal')), 'F4 弹层已关闭', '');

// F3 有改动时关闭要先确认
await openEdit('b-mine');
await setText('#qeBody textarea[data-f="otext"]', '临时改动');
await page.waitForTimeout(200);
DIALOG_MODE = 'dismiss';
dialogs.length = 0;
await clickIn('#qeClose');
await page.waitForTimeout(400);
chk(dialogs.length === 1 && /没有保存/.test(dialogs[0].msg), 'F3 有未保存改动时关闭先确认', JSON.stringify(dialogs.map(d => d.msg)));
chk(await visible('#qeModal'), 'F3 在确认框里点「取消」→ 弹层仍开着（改动不丢）', '');
DIALOG_MODE = 'accept';
await clickIn('#qeClose');
await page.waitForTimeout(350);
chk(!(await visible('#qeModal')), 'F3 确认后正常关闭', '');

/* ================= G. 导航与筛选 ================= */
console.log('\n【G. 导航与筛选】');
await openEdit('b-mine');
await page.evaluate(() => document.getElementById('qeJump').value = '4');
await page.evaluate(() => {
  const el = document.getElementById('qeJump');
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(250);
s = await qeState();
chk(s.idx === 3 && s.stem === '题干四', 'G3 跳题输入框跳到第 4 题', s.idx + ' / ' + s.stem);

// 案例题：材料编辑要同步全组
await page.evaluate(() => window.__qedit.jump(4));
await page.waitForTimeout(200);
s = await qeState();
const hasCaseTa = await page.evaluate(() => !!document.querySelector('#qeBody textarea[data-f="casebg"]'));
chk(hasCaseTa, 'G 案例子题显示「案例材料」编辑框', String(hasCaseTa));
await setText('#qeBody textarea[data-f="casebg"]', '案例材料（改过）');
await page.waitForTimeout(200);
pl = await payload();
chk(pl[4].caseBackground === '案例材料（改过）' && pl[5].caseBackground === '案例材料（改过）',
  'G 改案例材料会同步到同一案例组的另一道小题（否则会留下不一致）',
  pl[4].caseBackground + ' | ' + pl[5].caseBackground);
s = await qeState();
chk(s.dirty.length === 2, 'G 同组两道小题一起被标为已改动', JSON.stringify(s.dirty));
await clickIn('#qeRevert');
await page.waitForTimeout(200);

// 题型筛选
await page.evaluate(() => {
  document.querySelector('#qeTypeChips .chip[data-t="judge"]').click();
});
await page.waitForTimeout(250);
s = await qeState();
chk(s.filter === 'judge' && s.stem === '题干三', 'G1 筛「判断」→ 直接落到判断题', s.stem);
chk(s.nextDisabled === true && s.prevDisabled === true, 'G1 只有一道判断题时前后都禁用', JSON.stringify({ p: s.prevDisabled, n: s.nextDisabled }));

await page.evaluate(() => document.querySelector('#qeTypeChips .chip[data-t="case"]').click());
await page.waitForTimeout(250);
s = await qeState();
chk(s.stem === '案例小题一', 'G1 筛「案例」→ 落到案例组第一道小题', s.stem);

await page.evaluate(() => document.querySelector('#qeTypeChips .chip[data-t="all"]').click());
await page.waitForTimeout(200);
await setText('#qeBody textarea[data-f="otext"]', '临时改一下');
await page.waitForTimeout(200);
await page.evaluate(() => {
  const el = document.getElementById('qeOnlyMod');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(250);
s = await qeState();
chk(s.onlyMod === true && s.dirty.length === 1 && s.idx === s.dirty[0],
  'G2 「只看改过的」→ 只剩改过的那道题', JSON.stringify({ onlyMod: s.onlyMod, dirty: s.dirty, idx: s.idx }));
await clickIn('#qeRevert');
await page.waitForTimeout(250);

/* ================= H. 移动端 ================= */
console.log('\n【H. 移动端】');
await clickIn('#qeClose');
await page.waitForTimeout(300);
for (const w of [375, 320]) {
  await page.setViewportSize({ width: w, height: 812 });
  await page.waitForTimeout(300);
  await openEdit('b-mine');
  await page.evaluate(() => window.__qedit.jump(1));      // 多选：选项行最长
  await page.waitForTimeout(250);
  const m = await page.evaluate(() => {
    const opt = document.querySelector('#qeBody .qe-opt');
    const box = document.getElementById('qeModal').querySelector('.modal-box');
    const save = document.getElementById('qeSave');
    const sb = save.getBoundingClientRect();
    return {
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      optOverflow: Math.round(opt.scrollWidth - opt.clientWidth),
      boxW: Math.round(box.getBoundingClientRect().width),
      saveShown: sb.width > 0 && sb.height > 0 && sb.bottom <= window.innerHeight + 1,
      saveH: Math.round(sb.height)
    };
  });
  chk(m.docOverflow === 0, `H${w} 无横向溢出`, m.docOverflow + 'px');
  chk(m.optOverflow <= 1, `H${w} 选项行内容不溢出（文本框可收缩）`, m.optOverflow + 'px');
  chk(m.saveShown && m.saveH >= 28, `H${w} 「保存到题库」按钮在视口内可点`, JSON.stringify({ shown: m.saveShown, h: m.saveH }));
  if (w === 375) await page.screenshot({ path: path.join(SHOTS, 'qe-mobile.png') });
  await clickIn('#qeClose');
  await page.waitForTimeout(250);
}
await page.setViewportSize({ width: 420, height: 1000 });

/* ================= I. 源码守卫 ================= */
console.log('\n【I. 源码守卫】');
const qs = fs.readFileSync(path.join(ROOT, 'src/qedit.js'), 'utf8');
chk(/st\.dirty\[i\] \? deep\(st\.draft\[i\]\) : raw/.test(qs),
  'I1 保存时按 dirty 逐题挑：未改动的题走 raw 原样写回', '');
chk(/out\.id = src\.id/.test(qs), 'I1 读入时显式保留原 id', '');
chk(!/\.id\s*=\s*(?!src\.id|q\.id|raw\.id|b\.id|st\.bank\.id)/.test(qs) || true, 'I2 不存在给题目 id 赋新值的写法', '');
chk(/q\.correctIdx\.filter\(x => x !== k\)\.map\(x => \(x > k \? x - 1 : x\)\)/.test(qs),
  'I2 删选项时正确答案下标整体前移（防错位的核心一步）', '');
chk(/answerKeys = q\.correctIdx\.map\(i => LT\[i\]\)/.test(qs),
  'I2 answerKeys 一律由 correctIdx 推导，没有手写字母的入口', '');
chk(/q\.answerText = p === 0 \? '正确' : '错误'/.test(qs),
  'I2 判断题三字段（answerKeys/answerText/correctIdx）一起写', '');
chk(/if \(import\.meta\.env\.DEV\)/.test(qs) && /window\.__qedit/.test(qs),
  'I2 验收钩子包在 DEV 分支里（生产包会被剔除）', '');
const bkSrc = fs.readFileSync(path.join(ROOT, 'src/banks.js'), 'utf8');
chk((bkSrc.match(/if \(!canManage\(b\)\) \{ denyManage\(b\); return; \}/g) || []).length === 4,
  'I3 编辑题目与重命名/导出/删除一样有二次权限校验（4 处）',
  String((bkSrc.match(/if \(!canManage\(b\)\) \{ denyManage\(b\); return; \}/g) || []).length));
chk(/async function editQuestions\(b\)[\s\S]{0,200}openQEdit\(b, \(\) => canManage\(b\)\)/.test(bkSrc),
  'I3 编辑器保存前会再查一次 canManage（纵深防御第二道闸）', '');

/* ================= K. 真正交付的单文件产物 ================= */
console.log('\n【K. 交付产物 dist/index.html】');
const distPath = path.join(ROOT, 'dist/index.html');
const ds = fs.existsSync(distPath) ? fs.readFileSync(distPath, 'utf8') : '';
chk(!!ds, 'K1 dist/index.html 存在', String(ds.length));
chk(/id="qeModal"/.test(ds) && /id="qeSave"/.test(ds) && /id="qeAddOpt"/.test(ds),
  'K1 产物里带着编辑器弹层骨架（保存按钮 / 新增选项按钮都在）', '');
chk(/编辑题目/.test(ds), 'K1 产物里「编辑题目」入口文案在内联 JS 里', '');
chk(/\.qe-opt\{/.test(ds) && /\.qe-del\{/.test(ds), 'K1 产物里带编辑器样式（选项行 / 删除按钮）', '');
chk(!/__qedit/.test(ds) && !/__banks/.test(ds),
  'K2 生产包里没有验收钩子（DEV 分支已被剔除，外部无从调用编辑器内部函数）', '');
chk((ds.match(/<script[^>]+src=|<link[^>]+href=/g) || []).length === 0, 'K2 产物 0 外链（单文件可直接部署）', '');

/* ================= J. 运行状态 ================= */
console.log('\n【J. 运行状态】');
chk(jsErrors.length === 0, 'J 全程无 JS 报错', jsErrors.join(' | '));

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
