/**
 * 验收「每个人的第一次进入，练习选项默认如图」（v2.16）。
 *
 * 出厂默认（改这三处必须同步：src/engine.js 的 DEFAULT_PREFS、index.html 的 checked 属性、本脚本的 DEFAULT）：
 *   默认显示答案        关
 *   去除多选全选题目     关
 *   去除正确的判断题     关
 *   选完展示正确答案     开
 *   答对自动移出错题集   开
 *
 * 覆盖点：
 *   A 全新设备 · 未登录首次打开 → 五个开关都是出厂默认，且 HTML 初始属性与之一致（首帧不闪）
 *   B 全新设备 · 已登录首次进题库（云端无记录）→ 仍是默认
 *   C 换账号不继承：甲改过的设置不会出现在乙的"第一次进入"里；切回甲设置完好
 *   D 云端已有设置的老账号 → 以云端为准，不被出厂默认覆盖
 *   E 老版本的全局键 credit_exam_cfg → 登录后一次性搬进本账号的键，老用户设置不丢
 *   F 「继续练习」不再把练习选项改成进度快照里的旧值
 *   G applySettings() 遇到缺字段的旧快照 → 用出厂默认兜底（不是一律 false）
 *   H 375 / 320 手机端首页无横向溢出
 *
 * 用法：node scripts/check_defaults.mjs   （自带 vite dev server，借 DEV 调试钩子读内部状态）
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
const PORT = 5241;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ⚠️ key 顺序必须与 engine.js 的 DEFAULT_PREFS 完全一致（G3 是 JSON.stringify 全量比对）
const DEFAULT = { showAns: false, rmAll: false, rmCorrectJudge: false, revealAfter: true, showAnalysis: true, autoRemoveWrong: true };
const IDS = Object.keys(DEFAULT);

/* ---------- 1. 起 dev server ---------- */
const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((res, rej) => {
  const t0 = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - t0 > 40000) { clearInterval(timer); rej(new Error('vite dev server 启动超时')); return; }
    try { const r = await fetch(URL_APP); if (r.ok) { clearInterval(timer); res(); } } catch (e) { /* 还没起来 */ }
  }, 400);
  srv.stderr.on('data', d => process.stderr.write(d));
});

const browser = await chromium.launch({ executablePath: EXE });
const jsErrors = [];

const fails = [];
let n = 0;
const chk = (cond, name, extra) => {
  n++;
  if (!cond) fails.push(`第${n}项 ${name}${extra !== undefined && extra !== '' ? ' → ' + extra : ''}`);
};

/* ---------- 2. 小工具 ---------- */
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtOf = (uid, name) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: uid, username: name, role: 'authenticated' }) + '.sig';

const UID_A = 'aaaa1111-0000-4000-8000-000000000001';
const UID_B = 'bbbb2222-0000-4000-8000-000000000002';
const UID_C = 'cccc3333-0000-4000-8000-000000000003';
const UID_D = 'dddd4444-0000-4000-8000-000000000004';
const K = uid => 'credit_exam_cfg:' + uid;

/** 开一个干净的浏览器上下文：清空存储 + 预置 token（首次打开时 page 会把 __next_token 落到 ce_token） */
async function newCtx({ token = '', legacy = null, viewport = { width: 420, height: 950 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(({ token, legacy }) => {
    if (localStorage.getItem('__next_token') === null) localStorage.setItem('__next_token', token);
    localStorage.setItem('ce_token', localStorage.getItem('__next_token') || '');
    if (legacy) localStorage.setItem('credit_exam_cfg', legacy);
  }, { token, legacy });
  const page = await ctx.newPage();
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('dialog', d => d.accept());
  return { ctx, page };
}

/* supabase REST 桩：CLOUD=null → 无记录（返回空数组）；CLOUD={...} → 一条记录 */
let CLOUD = null;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*'
};
async function stubCloud(page) {
  await page.route('**/rest/v1/exam_user_prefs**', route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    return route.fulfill({
      status: 200,
      headers: Object.assign({ 'content-type': 'application/json' }, CORS),
      body: JSON.stringify(CLOUD ? [{ prefs: CLOUD }] : [])
    });
  });
}

/** 页面上五个开关的实际状态 + HTML 初始属性（defaultChecked 不会被 JS 改写，用来验"首帧不闪"） */
const readSw = page => page.evaluate(ids => Object.fromEntries(ids.map(id => {
  const el = document.getElementById(id);
  return [id, { on: el.checked, htmlOn: el.defaultChecked }];
})), IDS);
const readOn = async page => {
  const s = await readSw(page);
  return Object.fromEntries(IDS.map(k => [k, s[k].on]));
};
const readState = page => page.evaluate(ids => ({
  S: Object.fromEntries(ids.map(k => [k, window.__exam.S[k]])),
  key: window.__exam.prefsKey(),
  hint: (document.getElementById('prefsHint') || {}).textContent || '',
  localKeys: Object.keys(localStorage).filter(k => k.startsWith('credit_exam_cfg')).sort()
}), IDS);

const diffFrom = (obj, want) => IDS.filter(k => obj[k] !== want[k]).map(k => `${k}=${JSON.stringify(obj[k])}(应为${JSON.stringify(want[k])})`).join(' ');
const showHome = page => page.evaluate(() => {
  document.getElementById('auth').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  ['banks', 'admin', 'practice', 'result'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hide'); });
  document.getElementById('home').classList.remove('hide');
});

const FAKE = [
  { id: 1, type: 'single', stem: '默认值验收 1', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null },
  { id: 2, type: 'judge', stem: '默认值验收 2', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerKeys: ['B'], answerText: '错误', correctIdx: [1], analysis: null },
  { id: 3, type: 'multiple', stem: '默认值验收 3', options: [{ key: 'A', text: '2' }, { key: 'B', text: '4' }, { key: 'C', text: '5' }], answerKeys: ['A', 'B'], answerText: 'A、B', correctIdx: [0, 1], analysis: null }
];

/* ================= A0 真实交付产物（dist 单文件，无调试钩子） ================= */
{
  const FILE = pathToFileURL(path.join(ROOT, 'dist', 'index.html')).href;
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => jsErrors.push('[dist] ' + e.message));
  await page.goto(FILE);
  await page.waitForTimeout(1600);
  const sw = await readSw(page);
  const on = Object.fromEntries(IDS.map(k => [k, sw[k].on]));
  const dFile = diffFrom(on, DEFAULT);
  chk(!dFile, 'A0 dist 单文件产物（生产构建、无调试钩子）首次打开 → 五个开关都是出厂默认', dFile);
  const dFileHtml = IDS.filter(k => sw[k].htmlOn !== DEFAULT[k]).map(k => `${k} html=${sw[k].htmlOn}`).join(' ');
  chk(!dFileHtml, 'A0 产物里的 HTML 初始属性同样与默认一致', dFileHtml);
  await ctx.close();
}

/* ================= A5 产物层面的账号隔离（dist 无钩子，只能看 localStorage 键名与开关状态） ================= */
{
  const FILE = pathToFileURL(path.join(ROOT, 'dist', 'index.html')).href;
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
  await ctx.addInitScript(tok => {
    if (localStorage.getItem('__next_token') === null) localStorage.setItem('__next_token', tok);
    localStorage.setItem('ce_token', localStorage.getItem('__next_token') || '');
  }, jwtOf(UID_A, '甲'));
  const page = await ctx.newPage();
  page.on('pageerror', e => jsErrors.push('[dist-iso] ' + e.message));
  await page.goto(FILE);
  await page.waitForTimeout(1600);
  await page.evaluate(() => {
    const el = document.getElementById('showAns');
    el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('credit_exam_cfg')).sort());
  chk(keys.includes(K(UID_A)), 'A5 产物里设置写进本账号的键 credit_exam_cfg:<uid>（按账号隔离）', keys.join(' '));
  chk(!keys.includes('credit_exam_cfg'), 'A5 产物里不再使用老的全机共用键', keys.join(' '));
  await page.evaluate(tok => localStorage.setItem('__next_token', tok), jwtOf(UID_B, '乙'));
  await page.reload();
  await page.waitForTimeout(1600);
  const dIso = diffFrom(await readOn(page), DEFAULT);
  chk(!dIso, 'A5 产物层面换账号（同一台设备）→ 新账号第一次进入仍是出厂默认', dIso);
  await ctx.close();
}

/* ================= A 全新设备 · 未登录首次打开 ================= */
{
  const { ctx, page } = await newCtx({ token: '', viewport: { width: 375, height: 950 } });
  await page.goto(URL_APP);
  await page.waitForTimeout(1300);
  const sw = await readSw(page);
  const on = Object.fromEntries(IDS.map(k => [k, sw[k].on]));
  const dA = diffFrom(on, DEFAULT);
  chk(!dA, 'A1 未登录首次打开 → 五个开关都是出厂默认', dA);
  const dH = IDS.filter(k => sw[k].htmlOn !== DEFAULT[k]).map(k => `${k} html=${sw[k].htmlOn}`).join(' ');
  chk(!dH, 'A2 index.html 的 checked 属性与出厂默认一致（首帧不会先画旧状态再跳）', dH);
  const st = await readState(page);
  const dS = diffFrom(st.S, DEFAULT);
  chk(!dS, 'A3 内存状态 S 也是出厂默认', dS);
  chk(st.key === 'credit_exam_cfg:guest', 'A4 未登录时本机缓存键 = credit_exam_cfg:guest', st.key);
  // 截图：手机端「练习选项」区域（375）
  await showHome(page);
  await page.waitForTimeout(250);
  const clip = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('#home .section')].find(s => s.textContent.includes('练习选项'));
    sec.scrollIntoView({ block: 'start' });
    const r = sec.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    return { x: 0, y: Math.max(0, Math.round(r.top - 10)), width: vw, height: Math.round(Math.min(r.height + 20, 880)) };
  });
  await page.screenshot({ path: path.join(SHOTS, 'defaults-prefs.png'), clip });
  await ctx.close();
}

/* ================= B 已登录首次进题库（云端无记录） ================= */
{
  CLOUD = null;
  const { ctx, page } = await newCtx({ token: jwtOf(UID_B, '乙') });
  await stubCloud(page);
  await page.goto(URL_APP);
  await page.waitForTimeout(1300);
  const st = await readState(page);
  const dB = diffFrom(st.S, DEFAULT);
  chk(!dB, 'B1 已登录首次打开（本账号无任何记录）→ 出厂默认', dB);
  chk(st.key === K(UID_B), 'B2 本机缓存键按账号隔离 = credit_exam_cfg:<uid>', st.key);
  await page.evaluate(async () => { await window.__exam.syncPrefsFromCloud(); });
  await page.waitForTimeout(300);
  const afterSync = await readOn(page);
  const dBs = diffFrom(afterSync, DEFAULT);
  chk(!dBs, 'B3 云端无记录、同步完成后仍是出厂默认', dBs);
  chk(/跟随账号/.test((await readState(page)).hint), 'B4 提示文案为「改完自动记住（跟随账号）」', (await readState(page)).hint);
  await ctx.close();
}

/* ================= C 换账号不继承（同一台设备） ================= */
{
  CLOUD = null;
  const { ctx, page } = await newCtx({ token: jwtOf(UID_A, '甲') });
  await stubCloud(page);
  await page.goto(URL_APP);
  await page.waitForTimeout(1300);
  await page.evaluate(async () => { await window.__exam.syncPrefsFromCloud(); });
  await page.waitForTimeout(200);
  // 甲改两个开关：打开「默认显示答案」、关掉「选完展示正确答案」
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('showAns', true); set('revealAfter', false);
  });
  await page.waitForTimeout(300);
  const savedA = await page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), K(UID_A));
  chk(savedA && savedA.showAns === true && savedA.revealAfter === false,
    'C1 甲改过的设置写进甲自己的缓存键', JSON.stringify(savedA && { showAns: savedA.showAns, revealAfter: savedA.revealAfter }));

  // 真实登出（走 main.js 的 doLogout：logout + resetPrefsToDefault）
  await page.evaluate(() => document.getElementById('logoutBtn').click());
  await page.waitForTimeout(250);
  const afterLogout = await readState(page);
  const dL = diffFrom(afterLogout.S, DEFAULT);
  chk(!dL, 'C2 登出后内存设置立刻收回出厂默认（不等新账号登录）', dL);

  // 换成乙登录
  await page.evaluate(tok => localStorage.setItem('__next_token', tok), jwtOf(UID_B, '乙'));
  await page.reload();
  await page.waitForTimeout(1300);
  const stB = await readState(page);
  const dB = diffFrom(stB.S, DEFAULT);
  chk(!dB, 'C3 乙第一次进入 → 出厂默认（没有继承甲的设置）', dB);
  const dBui = diffFrom(await readOn(page), DEFAULT);
  chk(!dBui, 'C4 乙看到的五个开关也都是默认', dBui);
  chk(!stB.localKeys.includes(K(UID_B)), 'C5 乙此刻还没有自己的本机缓存（确实是「第一次进入」）', stB.localKeys.join(' '));
  chk(stB.localKeys.includes(K(UID_A)), 'C6 甲的本机缓存仍在（隔离≠清空所有人）', stB.localKeys.join(' '));
  await page.evaluate(async () => { await window.__exam.syncPrefsFromCloud(); });
  await page.waitForTimeout(300);
  const dBs = diffFrom(await readOn(page), DEFAULT);
  chk(!dBs, 'C7 乙同步云端（无记录）后仍是默认', dBs);

  // 切回甲 → 甲自己的设置完好
  await page.evaluate(tok => localStorage.setItem('__next_token', tok), jwtOf(UID_A, '甲'));
  await page.reload();
  await page.waitForTimeout(1300);
  const backA = await readState(page);
  chk(backA.S.showAns === true && backA.S.revealAfter === false,
    'C8 切回甲 → 甲原来的设置完好', JSON.stringify({ showAns: backA.S.showAns, revealAfter: backA.S.revealAfter }));
  await ctx.close();
}

/* ================= D 云端已有设置的老账号 ================= */
{
  CLOUD = {
    mode: 'sequential', types: { single: true, multiple: true, judge: true, case: true },
    showAns: true, rmAll: true, rmCorrectJudge: true, revealAfter: false, showAnalysis: false, autoRemoveWrong: false,
    updatedAt: Date.now() + 60000
  };
  const { ctx, page } = await newCtx({ token: jwtOf(UID_C, '丙') });
  await stubCloud(page);
  await page.goto(URL_APP);
  await page.waitForTimeout(1300);
  await page.evaluate(async () => { await window.__exam.syncPrefsFromCloud(); });
  await page.waitForTimeout(300);
  const st = await readState(page);
  chk(st.S.showAns === true && st.S.rmAll === true && st.S.rmCorrectJudge === true && st.S.revealAfter === false && st.S.showAnalysis === false && st.S.autoRemoveWrong === false,
    'D1 云端已有设置的老账号 → 以云端为准，不被出厂默认覆盖', diffFrom(st.S, CLOUD));
  await ctx.close();
  CLOUD = null;
}

/* ================= E 老版本全局键一次性搬迁 ================= */
{
  const legacy = JSON.stringify({
    mode: 'sequential', types: { single: true, multiple: true, judge: true, case: true },
    showAns: true, rmAll: true, rmCorrectJudge: true, revealAfter: false, autoRemoveWrong: false,
    examCounts: { single: 60, multiple: 40, judge: 20, case: 5 }, examTotal: 100, updatedAt: Date.now() - 1000
  });
  const { ctx, page } = await newCtx({ token: jwtOf(UID_D, '丁'), legacy });
  await page.goto(URL_APP);
  await page.waitForTimeout(1300);
  const st = await readState(page);
  chk(st.localKeys.includes(K(UID_D)), 'E1 老版本全局键里的设置已搬进本账号的键（老用户不丢设置）', st.localKeys.join(' '));
  chk(!st.localKeys.includes('credit_exam_cfg'), 'E2 老全局键搬完即删（免得下一个账号又读到）', st.localKeys.join(' '));
  chk(st.S.showAns === true && st.S.revealAfter === false, 'E3 搬过来的值确实生效', JSON.stringify({ showAns: st.S.showAns, revealAfter: st.S.revealAfter }));
  await ctx.close();
}

/* ================= F 「继续练习」不改练习选项 ================= */
{
  const { ctx, page } = await newCtx({ token: jwtOf(UID_A, '甲') });
  await page.goto(URL_APP);
  await page.waitForTimeout(1300);
  // 用户当前设置：开着「选完展示正确答案」
  await page.evaluate(() => {
    const el = document.getElementById('revealAfter');
    el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(fake => { window.__exam.setQuestions(fake); }, FAKE);
  const oldSnap = {
    mode: 'sequential', types: { single: true, multiple: true, judge: true, case: true },
    ids: [1, 2, 3], userAns: [0, null, null], revealed: [false, false, false],
    showAns: false, rmAll: true, rmCorrectJudge: true, revealAfter: false, showAnalysis: false, autoRemoveWrong: false,
    remainingMs: 0, elapsedMs: 0
  };
  const r = await page.evaluate(snap => {
    window.__exam.start(snap, 0);
    return {
      revealAfter: window.__exam.S.revealAfter,
      showAns: window.__exam.S.showAns,
      rmAll: window.__exam.S.rmAll,
      rmCorrectJudge: window.__exam.S.rmCorrectJudge,
      showAnalysis: window.__exam.S.showAnalysis,
      uiReveal: document.getElementById('revealAfter').checked,
      uiAnalysis: document.getElementById('showAnalysis').checked,
      pool: window.__exam.S.pool.length,
      stored: JSON.parse(localStorage.getItem(window.__exam.prefsKey()) || 'null')
    };
  }, oldSnap);
  chk(r.pool === 3, 'F0 继续练习仍按快照的题号原样重建题池（3 题）', String(r.pool));
  chk(r.revealAfter === true, 'F1 「继续练习」不会把「选完展示正确答案」改成快照里的旧值', String(r.revealAfter));
  chk(r.showAns === false && r.rmAll === false && r.rmCorrectJudge === false && r.showAnalysis === true,
    'F2 其它练习选项也保持用户当前设置（不被快照污染）',
    JSON.stringify({ showAns: r.showAns, rmAll: r.rmAll, rmCorrectJudge: r.rmCorrectJudge, showAnalysis: r.showAnalysis }));
  chk(r.uiReveal === true && r.uiAnalysis === true, 'F3 界面开关同步显示用户当前的设置', JSON.stringify({ revealAfter: r.uiReveal, showAnalysis: r.uiAnalysis }));
  chk(r.stored && r.stored.revealAfter === true && r.stored.rmAll === false,
    'F4 快照里的旧值不会被写回本机缓存（否则设置会被"继续练习"拖回去）',
    JSON.stringify(r.stored && { revealAfter: r.stored.revealAfter, rmAll: r.stored.rmAll }));
  await ctx.close();
}

/* ================= G applySettings 缺字段兜底 ================= */
{
  const { ctx, page } = await newCtx({ token: '' });
  await page.goto(URL_APP);
  await page.waitForTimeout(1200);
  const r = await page.evaluate(ids => {
    window.__exam.applySettings({ mode: 'sequential' });          // 旧快照：五个开关字段全缺
    const all = Object.fromEntries(ids.map(k => [k, window.__exam.S[k]]));
    window.__exam.applySettings({ revealAfter: false });           // 只显式给一个字段
    const mixed = Object.fromEntries(ids.map(k => [k, window.__exam.S[k]]));
    return { all, mixed, def: Object.assign({}, window.__exam.defaultPrefs) };
  }, IDS);
  const dG = diffFrom(r.all, DEFAULT);
  chk(!dG, 'G1 旧快照缺字段 → 用出厂默认兜底（不是一律 false）', dG);
  chk(r.mixed.revealAfter === false && r.mixed.showAns === DEFAULT.showAns && r.mixed.rmAll === DEFAULT.rmAll && r.mixed.autoRemoveWrong === DEFAULT.autoRemoveWrong,
    'G2 显式给出的字段照用，其余仍走出厂默认',
    JSON.stringify(r.mixed));
  chk(JSON.stringify(r.def) === JSON.stringify(DEFAULT), 'G3 调试钩子暴露的 defaultPrefs 与验收期望一致', JSON.stringify(r.def));
  await ctx.close();
}

/* ================= H 手机端不溢出 ================= */
for (const w of [375, 320]) {
  const { ctx, page } = await newCtx({ token: '', viewport: { width: w, height: 900 } });
  await page.goto(URL_APP);
  await page.waitForTimeout(1300);
  await showHome(page);
  await page.waitForTimeout(250);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  chk(ov.sw <= ov.cw + 1, `H ${w}px 首页无横向溢出`, JSON.stringify(ov));
  if (w === 320) {
    const clip = await page.evaluate(() => {
      const sec = [...document.querySelectorAll('#home .section')].find(s => s.textContent.includes('练习选项'));
      sec.scrollIntoView({ block: 'start' });
      const r = sec.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      return { x: 0, y: Math.max(0, Math.round(r.top - 8)), width: vw, height: Math.round(Math.min(r.height + 16, 880)) };
    });
    await page.screenshot({ path: path.join(SHOTS, 'defaults-320.png'), clip });
  }
  await ctx.close();
}

chk(jsErrors.length === 0, 'I 全过程无 JS 报错', jsErrors.join(' | '));

/* ---------- 收尾 ---------- */
await browser.close();
srv.kill();

const total = n;
const bad = fails.length;
console.log('\n===== 练习选项默认值端到端验收 =====');
console.log('  期望默认：' + IDS.map(k => `${k}=${DEFAULT[k] ? '开' : '关'}`).join('，'));
if (bad) {
  console.log('\n  ❌ 未通过 ' + bad + ' / ' + total + ' 项：');
  fails.forEach(f => console.log('     ' + f));
} else {
  console.log('  ✅ 全部 ' + total + ' 项通过');
}
console.log('\n通过 ' + (total - bad) + ' / ' + total + ' 项，失败 ' + bad + ' 项');
process.exit(bad ? 1 : 0);
