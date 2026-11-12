/**
 * 题库加载性能（v2.29）的验收。
 *
 * 起因：用户反馈「题库当前加载速度较慢」。查下来是三处叠加：
 *   ① 题库列表请求把 questions 整列拉下来（只为数一下题数）—— 一个百题题库就几十上百 KB；
 *   ② 首屏启动串行 4 个网络往返（me → 题库题目 → 错题/进度 → 练习设置）；
 *   ③ 每次回列表页都重新请求一遍（改名、删库、从管理页返回都会触发）。
 *
 * 这个脚本不测「快了多少毫秒」（那依赖网络环境，不可复现），
 * 而是钉住**导致慢的机制有没有被去掉**：
 *   A. 列表查询不再包含 questions
 *   B. 列不存在时能自动降级（忘跑 perf.sql 也不白屏），且只试一次
 *   C. 列表缓存：30 秒内回列表页不再发请求，且内容立刻可见
 *   D. 题目缓存：同一题库第二次打开不再重新下载，但改题目后必须失效
 *   E. 启动并行：/api/me 与题库数据请求的时间区间真的重叠
 *   F. 传输体积：列表响应比旧实现小若干倍（用 300 题的桩数据量化）
 *   G. 源码守卫：perf.sql 的触发器、banks.js 的列清单
 *
 * v2.32 又往前推了一步（用户反馈「题库大的时候打开特别慢」）：
 *   · 首屏不再等网络：先画题库列表，题目后台下（E 段）
 *   · 题目落 IndexedDB，重开页面秒进；题库改了才重下（H 段）
 *   · 手点正在后台下那份不会重复下载（I 段）
 *
 * 用法：node scripts/check_speed.mjs
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
const PORT = 5219;
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

/* ---------- 2. 桩数据：故意做厚，模拟真实体量 ---------- */
const mkQ = (bank, i) => ({
  id: i + 1,
  type: 'single',
  stem: `【${bank}】第 ${i + 1} 题：这道题的题干会写满一整行，用来逼近真实题库的字节数，避免桩数据太小导致测量失真`,
  options: [
    { key: 'A', text: '选项甲：这是一个比较长的选项文本，用于撑起真实的 JSON 体积' },
    { key: 'B', text: '选项乙：这是另一个比较长的选项文本，同样用于撑起真实体积' },
    { key: 'C', text: '选项丙：三选一的干扰项也要写长一点才接近真实数据' },
    { key: 'D', text: '选项丁：第四个干扰项' }
  ],
  answerKeys: ['B'], answerText: 'B', correctIdx: 1,
  analysis: '解析：这一段解析同样有几十个字，真实题库里每道题都带解析，累计起来很可观。'
});
const BIG = n => Array.from({ length: n }, (_, i) => mkQ('BIG', i));

const QS_WASH = BIG(300);     // 「大题库」：300 题
const QS_SMALL = BIG(120);

const BANKS = [
  { id: 'b-wash', user_id: MY_ID, owner_name: '常云凡', name: '2026反洗钱资格考试', questions: QS_WASH, question_count: 300, case_count: 6, created_at: '2026-09-27T02:00:00Z', updated_at: '2026-09-27T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-credit', user_id: OTHER_ID, owner_name: '张三', name: '信贷业务题库', questions: QS_SMALL, question_count: 120, case_count: 0, created_at: '2026-09-26T02:00:00Z', updated_at: '2026-09-26T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] }
];
// 旧实现（含 questions）与优化后（不含）的响应体字节数，用于量化传输体积
const LEGACY_BYTES = Buffer.byteLength(JSON.stringify(BANKS));
const SLIM_BYTES = Buffer.byteLength(JSON.stringify(BANKS.map(b => {
  const { questions, ...rest } = b;
  return rest;
})));

/* ---------- 3. 断言工具 ---------- */
const fails = [];
let n = 0;
const chk = (cond, name, extra) => {
  n++;
  if (cond) console.log(`  ✔ ${name}`);
  else { fails.push(name + (extra ? '｜实际：' + extra : '')); console.log(`  ✘ ${name}${extra ? '｜实际：' + extra : ''}`); }
};

const fakeJwt = () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: MY_ID, username: '常云凡', role: 'authenticated' }) + '.sig';
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*'
};
const json = (route, body, status = 200) => route.fulfill({
  status, headers: Object.assign({ 'content-type': 'application/json' }, CORS),
  body: body === undefined ? '' : JSON.stringify(body)
});

/** 按 select 参数裁剪一行（模拟 PostgREST 的列选择行为） */
function project(row, select) {
  if (!select || select === '*') return row;
  const cols = select.split(',').map(s => s.trim()).filter(Boolean);
  const out = {};
  cols.forEach(c => { if (c in row) out[c] = row[c]; });
  return out;
}

/**
 * 造一个页面并装好桩。
 * @param {{savedBank?:string, legacyFail?:boolean, meDelay?:number, bankDelay?:number}} opt
 * @returns {{page, log:Array, waits:Array}}
 */
async function makePage(browser, opt = {}) {
  const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 1 });
  const log = [];      // 每次 exam_banks 请求：{t0,t1,select,bytes,rows}
  const waits = [];    // 每个 /api/me 请求的时间区间
  page.on('pageerror', e => fails.push('JS 报错：' + e.message));
  page.on('dialog', d => d.accept());

  await page.addInitScript(([tok, saved]) => {
    localStorage.setItem('ce_token', tok);
    localStorage.setItem('ce_user', '常云凡');
    if (saved) localStorage.setItem('ce_current_bank', JSON.stringify(saved));
    else localStorage.removeItem('ce_current_bank');
  }, [fakeJwt(), opt.savedBank ? { id: opt.savedBank, name: '占位名' } : null]);

  await page.route('**/api/me', async route => {
    // 记录要在**请求到达时**就落地：这个桩故意有延迟，若等 fulfill 之后再记，
    // 断言会在请求还没完成时读到空数组，误判成「请求没发生」。
    const rec = { t0: Date.now(), t1: null, path: '/api/me' };
    waits.push(rec);
    if (opt.meDelay) await new Promise(r => setTimeout(r, opt.meDelay));
    await json(route, { id: MY_ID, username: '常云凡', isAdmin: false, dept: '人力资源部', role: '管理员岗' });
    rec.t1 = Date.now();
  });
  await page.route('**/api/admin-users', route => json(route, { ok: true, users: [], me: { id: MY_ID, isAdmin: false } }));
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    const m = req.method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    const url = req.url();
    const table = (url.match(/rest\/v1\/([a-z_]+)/) || [])[1];
    if (table === 'exam_banks') {
      if (m === 'GET') {
        const t0 = Date.now();
        const sp = new URL(url).searchParams;
        const select = sp.get('select') || '*';
        const idEq = (url.match(/id=eq\.([^&]+)/) || [])[1];
        let payload;
        if (idEq) {
          const hit = BANKS.filter(b => b.id === decodeURIComponent(idEq));
          const one = hit.length ? project(hit[0], select) : null;
          payload = String(req.headers()['accept'] || '').includes('object') ? one : (one ? [one] : []);
        } else {
          payload = BANKS.map(b => project(b, select));
        }
        // 模拟「列还没建」：任何带了 question_count 的 select 直接 400
        if (opt.legacyFail && select.includes('question_count')) {
          log.push({ t0, t1: Date.now(), select, bytes: 0, rows: -1, failed: true });
          return json(route, {
            code: '42703',
            message: 'column exam_banks.question_count does not exist',
            details: null, hint: null
          }, 400);
        }
        const d = (opt.bankDelay || 0) + (select.includes('questions') ? (opt.qDelay || 0) : 0);
        if (d) await new Promise(r => setTimeout(r, d));
        const body = JSON.stringify(payload);
        log.push({ t0, t1: Date.now(), select, bytes: Buffer.byteLength(body), rows: Array.isArray(payload) ? payload.length : 1 });
        return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'application/json' }, CORS), body });
      }
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    if (m === 'GET') return json(route, []);
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  });

  return { page, log, waits };
}

const listRows = page => page.evaluate(() => [...document.querySelectorAll('#bankList .bank-row')].map(r => ({
  id: r.dataset.id,
  name: (r.querySelector('.bank-name') || {}).textContent?.trim() || '',
  meta: (r.querySelector('.muted') || {}).textContent?.trim() || ''
})));

const browser = await chromium.launch({ executablePath: EXE });

/* ============================================================
 * A. 列表请求不再包含 questions
 * ============================================================ */
console.log('\n【A】列表查询瘦身');
{
  const { page, log } = await makePage(browser, {});
  await page.goto(URL_APP);
  await page.waitForSelector('#bankList .bank-row', { timeout: 15000 });
  const listQ = log.filter(x => x.rows !== 1);   // 列表请求（返回多行）
  chk(listQ.length >= 1, 'A1 进入列表页发起了题库列表请求', '发起 ' + listQ.length + ' 次');
  const first = listQ[0] || { select: '' };
  chk(!/questions/.test(first.select), 'A2 列表 select 不含 questions', first.select);
  chk(/question_count/.test(first.select), 'A3 列表 select 含 question_count', first.select);
  chk(/id/.test(first.select) && /name/.test(first.select) && /case_count/.test(first.select)
    && /owner_name/.test(first.select) && /visibility/.test(first.select)
    && /allow_depts/.test(first.select) && /allow_roles/.test(first.select),
    'A4 列表该有的字段一个不少（少一个界面就少一块信息）', first.select);

  const rows = await listRows(page);
  chk(rows.length === 2, 'A5 列表渲染出 2 个题库', '实际 ' + rows.length);
  chk(/300 题/.test(rows.find(r => r.id === 'b-wash')?.meta || ''), 'A6 题数取自 question_count（300 题）', rows.find(r => r.id === 'b-wash')?.meta);
  chk(/120 题/.test(rows.find(r => r.id === 'b-credit')?.meta || ''), 'A7 另一个库题数正确（120 题）', rows.find(r => r.id === 'b-credit')?.meta);

  // 体积量化
  const ratio = LEGACY_BYTES / SLIM_BYTES;
  console.log(`     旧实现响应 ${(LEGACY_BYTES / 1024).toFixed(1)} KB → 现在 ${(SLIM_BYTES / 1024).toFixed(1)} KB（${ratio.toFixed(1)} 倍）`);
  chk(ratio > 20, 'A8 列表响应至少小 20 倍', ratio.toFixed(1) + ' 倍');
  chk(first.bytes < 2048, 'A9 实际下发的列表响应 < 2 KB', first.bytes + ' 字节');
  await page.close();
}

/* ============================================================
 * B. 列不存在时自动降级（忘跑 perf.sql 也不能白屏）
 * ============================================================ */
console.log('\n【B】未跑 perf.sql 的降级');
{
  const { page, log } = await makePage(browser, { legacyFail: true });
  await page.goto(URL_APP);
  await page.waitForSelector('#bankList .bank-row', { timeout: 15000 });
  const rows = await listRows(page);
  chk(rows.length === 2, 'B1 降级后列表照常渲染', '实际 ' + rows.length + ' 行');
  chk(/300 题/.test(rows.find(r => r.id === 'b-wash')?.meta || ''), 'B2 降级路径也能算出题数（数数组长度）', rows.find(r => r.id === 'b-wash')?.meta);
  const listQ = log.filter(x => x.rows !== 1);
  chk(listQ.some(x => x.failed), 'B3 确实先试了带 question_count 的查询并失败', '失败 ' + listQ.filter(x => x.failed).length + ' 次');
  chk(listQ.some(x => !x.failed && /questions/.test(x.select)), 'B4 失败后回退到含 questions 的旧查询', JSON.stringify(listQ.map(x => x.select)));

  // 关键：回列表页不能再白试一次
  const before = log.length;
  await page.evaluate(() => document.getElementById('toTyping').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('toBanks').click());
  await page.waitForTimeout(600);
  const retryFail = log.slice(before).filter(x => x.failed);
  chk(retryFail.length === 0, 'B5 记住探测结果，不再重复发注定失败的请求', '又试了 ' + retryFail.length + ' 次');
  await page.close();
}

/* ============================================================
 * C. 列表缓存：回列表页不重新请求，且立刻可见
 * ============================================================ */
console.log('\n【C】列表缓存（先出内容，再后台刷新）');
{
  const { page, log } = await makePage(browser, {});
  await page.goto(URL_APP);
  await page.waitForSelector('#bankList .bank-row', { timeout: 15000 });
  const before = log.length;

  await page.evaluate(() => document.getElementById('toTyping').click());
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('toBanks').click());
  // 不等 waitForSelector：要验证的是「立刻就有内容」，不是「等一会儿才有」
  const instant = await listRows(page);
  await page.waitForTimeout(500);
  chk(instant.length === 2, 'C1 切回列表页时内容立刻在（无需等待请求）', '立刻看到 ' + instant.length + ' 行');
  chk(log.length === before, 'C2 30 秒内回列表页不再发请求', '多发了 ' + (log.length - before) + ' 次');
  await page.close();
}

/* ============================================================
 * D. 题目缓存：同一题库第二次打开不再下载
 * ============================================================ */
console.log('\n【D】题目缓存');
{
  const { page, log } = await makePage(browser, {});
  await page.goto(URL_APP);
  await page.waitForSelector('#bankList .bank-row', { timeout: 15000 });

  const openRow = async id => {
    await page.evaluate(v => {
      const row = document.querySelector(`#bankList .bank-row[data-id="${v}"]`);
      row.querySelector('.act-open').click();
    }, id);
    await page.waitForTimeout(700);
  };

  await openRow('b-wash');
  const q1 = log.filter(x => x.select.includes('questions'));
  chk(q1.length === 1, 'D1 首次打开题库下载了题目', '请求 ' + q1.length + ' 次');
  chk(q1[0] && q1[0].bytes > 50000, 'D2 这次下载确实是大响应（>50 KB，说明缓存有省头）', q1[0] ? (q1[0].bytes / 1024).toFixed(1) + ' KB' : '无');

  const homeName = await page.evaluate(() => document.getElementById('topBankName').textContent.trim());
  chk(homeName === '2026反洗钱资格考试', 'D3 打开后进的是该题库的练习首页', homeName);

  // 回列表再打开同一份
  await page.evaluate(() => document.getElementById('toBanks').click());
  await page.waitForTimeout(500);
  await openRow('b-wash');
  const q2 = log.filter(x => x.select.includes('questions'));
  chk(q2.length === 1, 'D4 再次打开同一题库不重复下载（命中缓存）', '累计 ' + q2.length + ' 次');

  // 换一个题库必须真的下载
  await page.evaluate(() => document.getElementById('toBanks').click());
  await page.waitForTimeout(500);
  await openRow('b-credit');
  const q3 = log.filter(x => x.select.includes('questions'));
  chk(q3.length === 2, 'D5 换一个题库仍要下载（缓存按题库隔离）', '累计 ' + q3.length + ' 次');

  // 缓存模块直接在页面里验证 TTL / LRU 边界（不用等 5 分钟）
  const cacheOK = await page.evaluate(() => {
    const c = window.__bankcache;
    if (!c) return { ok: false, why: '调试钩子缺失' };
    c.clearQuestionCache();
    c.putQuestions('x1', [{ id: 1 }]);
    const hit = !!c.getQuestions('x1');
    c.dropQuestions('x1');
    const afterDrop = c.getQuestions('x1') === null;
    c.clearQuestionCache();
    for (let i = 0; i < 6; i++) c.putQuestions('y' + i, [{ id: i }]);
    const kept = c.cacheStats().length;          // 上限 4 个
    c.clearQuestionCache();
    return { ok: true, hit, afterDrop, kept };
  });
  chk(cacheOK.ok && cacheOK.hit, 'D6 缓存读写正常', JSON.stringify(cacheOK));
  chk(cacheOK.afterDrop, 'D7 失效后取不到（改题目不会读到旧题）', JSON.stringify(cacheOK));
  chk(cacheOK.kept === 4, 'D8 缓存有上限，不会把内存撑爆', '保留 ' + cacheOK.kept + ' 个');
  await page.close();
}

/* ============================================================
 * E. 启动不再被网络挡住（v2.32）
 * ------------------------------------------------------------
 * 老流程：白屏 → 等 /api/me → 等整库题目 → 才出第一个像素。
 * 新流程：先把题库列表拿出来（标题、题数都在列表元数据里），题目在后台下。
 * 所以这里的判据是「**首屏内容出现的时间远早于题库下载完成**」。
 * ============================================================ */
console.log('\n【E】首屏不再等网络');
{
  const { page, log, waits } = await makePage(browser, {
    savedBank: 'b-wash', meDelay: 400, bankDelay: 50, qDelay: 900
  });
  const t0 = Date.now();
  await page.goto(URL_APP);
  // ① 首屏先有内容：列表屏可见且已有文字（标题或"正在加载"），完全不必等整库题目
  await page.waitForFunction(() => {
    const app = document.getElementById('app');
    const banks = document.getElementById('banks');
    const box = document.getElementById('bankList');
    return app && !app.classList.contains('hide') && banks && !banks.classList.contains('hide')
      && box && box.textContent.trim().length > 0;
  }, null, { timeout: 15000 });
  const firstPaint = Date.now() - t0;
  // ② 本机没有缓存：留在列表页，题目下完自动进首页
  await page.waitForFunction(() => {
    const h = document.getElementById('home');
    return h && !h.classList.contains('hide');
  }, null, { timeout: 15000 });
  const elapsed = Date.now() - t0;
  await page.waitForTimeout(600);

  const meW = waits[0];
  const bankQ = log.find(x => x.select && x.select.includes('questions'));
  chk(!!meW && !!bankQ, 'E1 身份与题库两个请求都发生了', JSON.stringify({ me: !!meW, bank: !!bankQ }));
  if (meW && bankQ && meW.t1) {
    const overlap = meW.t0 < bankQ.t1 && bankQ.t0 < meW.t1;
    chk(overlap, 'E2 身份请求与题库请求时间重叠（真并行，不是排队）',
      `me[${meW.t0 - t0},${meW.t1 - t0}] bank[${bankQ.t0 - t0},${bankQ.t1 - t0}]`);
  } else {
    chk(false, 'E2 身份请求与题库请求时间重叠（真并行，不是排队）', '时间戳缺失');
  }
  // 题库人为延迟 900ms：首屏若还能在 400ms 内出内容，说明根本没等它
  chk(firstPaint < 500, 'E3 首屏内容早于整库题目到达（不再白屏等网络）', firstPaint + ' ms');
  chk(bankQ && firstPaint < (bankQ.t1 - t0),
    'E3 首屏出现在题目响应结束之前', `首屏 ${firstPaint}ms / 题目完成 ${bankQ ? bankQ.t1 - t0 : '?'}ms`);
  chk(elapsed >= 900, 'E4 题目下完之后才自动进首页（进首页仍需要题目）', elapsed + ' ms');

  const homeName = await page.evaluate(() => document.getElementById('topBankName').textContent.trim());
  chk(homeName === '2026反洗钱资格考试', 'E5 自动进首页后顶栏名字正确', homeName);
  // 首页四张模式卡 + 每张卡里的计数框 / 续做横幅，都是 refreshHomeUI() 画的
  const counts = await page.evaluate(() => ({
    modes: document.querySelectorAll('#home .mode').length,
    countBoxes: ['examCounts', 'wrongCounts', 'favCounts'].filter(id => document.getElementById(id)).length,
    resumes: document.querySelectorAll('#home .rs').length
  }));
  chk(counts.modes === 4 && counts.countBoxes === 3 && counts.resumes === 4,
    'E6 首页卡片正常渲染（错题/收藏/进度没因并行而错位）', JSON.stringify(counts));
  await page.close();
}

/* ============================================================
 * G. 加载反馈：慢的时候不白屏，快的时候不闪
 * ============================================================ */
console.log('\n【G】加载反馈');
{
  const { page } = await makePage(browser, { savedBank: 'b-wash', meDelay: 600, bankDelay: 300, qDelay: 1200 });
  await page.goto(URL_APP);
  await page.waitForFunction(() => {
    const app = document.getElementById('app');
    const box = document.getElementById('bankList');
    return app && !app.classList.contains('hide') && box && box.textContent.trim().length > 0;
  }, null, { timeout: 15000 });
  const mid = await page.evaluate(() => {
    const m = document.getElementById('bootMask');
    return {
      appVisible: !document.getElementById('app').classList.contains('hide'),
      listText: document.getElementById('bankList').textContent.trim().slice(0, 40),
      maskOff: m ? m.classList.contains('off') : null,
      maskOpacity: m ? Number(getComputedStyle(m).opacity) : -1
    };
  });
  chk(mid.appVisible && mid.listText.length > 0,
    'G1 题目还在下载时首屏已有内容（不再是纯白页面）', JSON.stringify(mid));
  chk(/题库/.test(mid.listText), 'G2 首屏那句话说明在做什么', mid.listText);
  chk(mid.maskOff === true || mid.maskOpacity < 0.5,
    'G3 界面已出来，遮罩不再挡着（挡住等于白屏）', JSON.stringify(mid));

  await page.waitForFunction(() => !document.getElementById('home').classList.contains('hide'), null, { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('bootMask').classList.contains('off'), null, { timeout: 15000 });
  chk(true, 'G4 进首页后遮罩收起');
  const pe = await page.evaluate(() => getComputedStyle(document.getElementById('bootMask')).pointerEvents);
  chk(pe === 'none', 'G5 收起后不再拦截点击', pe);

  // 收起后要能正常用
  await page.evaluate(() => document.getElementById('toBanks').click());
  await page.waitForTimeout(500);
  const rows = await listRows(page);
  chk(rows.length > 0, 'G6 收起后页面可正常操作', rows.length + ' 行');

  // 慢加载时（下题目那段）仍要有遮罩兜底，且延迟 150ms 淡入（快就不闪）
  const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
  chk(/\.boot-mask\{[^}]*animation:bootIn[^}]*\.15s/.test(css), 'G7 遮罩延迟 150ms 才淡入（快加载不出现、不闪）');
  await page.close();
}

/* ============================================================
 * F. 源码守卫
 * ============================================================ */
console.log('\n【F】源码与 SQL 守卫');
{
  const banksSrc = fs.readFileSync(path.join(ROOT, 'src/banks.js'), 'utf8');
  const perfSql = fs.readFileSync(path.join(ROOT, 'supabase/perf.sql'), 'utf8');
  chk(/const BANK_COLS = 'id,name,case_count,question_count,created_at,updated_at,user_id,owner_name,visibility,allow_depts,allow_roles'/.test(banksSrc),
    'F1 新列清单固定（不含 questions，含 updated_at 版本号）');
  chk(/BANK_COLS_LEGACY[\s\S]{0,200}questions/.test(banksSrc), 'F2 保留含 questions 的旧清单用于降级');
  chk(/isMissingColumn/.test(banksSrc) && /42703/.test(banksSrc), 'F3 有列缺失的识别逻辑');
  chk(/invalidateBankList/.test(banksSrc), 'F4 改名/删库后有缓存失效入口');
  chk(/create trigger exam_banks_sync_count_trg/.test(perfSql), 'F5 perf.sql 含触发器（任何写入路径都同步题数）');
  chk(/add column if not exists question_count/.test(perfSql), 'F6 perf.sql 幂等加列');
  chk(/update public\.exam_banks[\s\S]{0,200}question_count/.test(perfSql), 'F7 perf.sql 含历史数据回填');

  const qeditSrc = fs.readFileSync(path.join(ROOT, 'src/qedit.js'), 'utf8');
  chk(/dropQuestions\(st\.bank\.id\)/.test(qeditSrc), 'F8 编辑题目保存后清缓存');

  // ---- v2.32：大件按需加载 ----
  const importSrc = fs.readFileSync(path.join(ROOT, 'src/import.js'), 'utf8');
  const typingSrc = fs.readFileSync(path.join(ROOT, 'src/typing.js'), 'utf8');
  const assetsSrc = fs.readFileSync(path.join(ROOT, 'src/assets.js'), 'utf8');
  chk(!/from 'xlsx'/.test(banksSrc) && !/from 'xlsx'/.test(importSrc),
    'F9 主包不再静态引入 Excel 组件（改成用到才加载）');
  chk(!/from '\.\/wubi\.js'/.test(typingSrc), 'F10 主包不再静态引入五笔码表');
  chk(/ensureXLSX/.test(banksSrc) && /ensureWubi/.test(typingSrc),
    'F11 两处都改成按需加载（ensureXLSX / ensureWubi）');
  chk(fs.existsSync(path.join(ROOT, 'public/lib/xlsx.min.js')) && fs.existsSync(path.join(ROOT, 'public/lib/wubi.js')),
    'F12 两个按需加载件已生成到 public/lib');
  chk(/libUrls/.test(assetsSrc) && /runtimePrefix/.test(assetsSrc),
    'F13 按需件走运行时前缀候选（部署在 /ks 子路径也不会 404）');
  chk(/getCachedQuestions/.test(banksSrc) && /putCachedQuestions/.test(banksSrc) && /revalidateQuestions/.test(banksSrc),
    'F14 题目有本机缓存 + 版本校验');
  chk(/prefetchBanks/.test(banksSrc) && /abortPrefetch/.test(banksSrc),
    'F15 有后台预取，且用户点题库时能让位（abort）');
}

/* ============================================================
 * H. 本机缓存（IndexedDB）· v2.32
 * ------------------------------------------------------------
 * 用户的原话：「先展示出题库标题，后台默认从前往后加载，+本地缓存，
 * 若用户点击了某个题库的练习，则优先加载该题库，题库有更新需更新缓存」。
 * 这一段钉住的就是这几条：缓存真的落了、重开不再下、题库改了才换。
 * ============================================================ */
console.log('\n【H】本机缓存与版本更新');
{
  const { page, log } = await makePage(browser, { savedBank: 'b-wash' });
  const homeReady = () => page.waitForFunction(() => {
    const h = document.getElementById('home');
    return h && !h.classList.contains('hide');
  }, null, { timeout: 20000 });
  const qReqs = () => log.filter(x => x.select && x.select.includes('questions')).length;

  await page.goto(URL_APP);
  await homeReady();

  // H1 题目落进本机缓存，并带着版本号（据此判断题库有没有更新）
  const inIdb = await page.evaluate(() => new Promise(resolve => {
    const r = indexedDB.open('ce_cache', 1);
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      const db = r.result;
      try {
        const req = db.transaction('kv', 'readonly').objectStore('kv').get('q:b-wash');
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const v = req.result;
          resolve(v ? { n: (v.qs || []).length, ver: v.updatedAt || '' } : null);
        };
      } catch (e) { resolve(null); }
    };
  }));
  chk(!!inIdb && inIdb.n === 300 && !!inIdb.ver, 'H1 题目落进本机缓存（300 题 + 版本号）', JSON.stringify(inIdb));

  // H2 重新打开页面：直接读本机，不再重下整库题目
  const before = qReqs();
  await page.reload();
  await homeReady();
  await page.waitForTimeout(400);
  chk(qReqs() === before, 'H2 重开页面不再下载整库题目（从本机读到）', before + ' → ' + qReqs());

  // H3 题库没变时不做无谓重下（版本一致）
  await page.reload();
  await homeReady();
  await page.waitForTimeout(600);
  chk(qReqs() === before, 'H3 版本没变就不重下（校验只发一个几百字节的请求）', before + ' → ' + qReqs());

  // H4 题库更新（updated_at 变了）→ 后台自动换缓存
  const qsBackup = BANKS[0].questions;
  const verBackup = BANKS[0].updated_at;
  BANKS[0].updated_at = '2026-11-12T03:00:00Z';
  BANKS[0].questions = QS_SMALL;            // 内容也换掉，验证真的换了题
  await page.reload();
  await homeReady();
  const replaced = await page.waitForFunction(
    () => window.__exam && window.__exam.questions().length === 120,
    null, { timeout: 20000 }
  ).then(() => true).catch(() => false);
  chk(replaced, 'H4 题库有更新时自动换缓存（版本变了才重下）',
    '内存里 ' + (await page.evaluate(() => (window.__exam ? window.__exam.questions().length : -1))) + ' 题');
  chk(qReqs() > before, 'H5 换缓存真的重新下载了一次', before + ' → ' + qReqs());

  // 还原桩数据，别把后面的用例带歪（历史上踩过这个坑）
  BANKS[0].questions = qsBackup;
  BANKS[0].updated_at = verBackup;

  // H6 退出登录清空本机缓存
  await page.evaluate(() => document.getElementById('logoutBtn').click());
  await page.waitForTimeout(600);
  const afterLogout = await page.evaluate(() => new Promise(resolve => {
    const r = indexedDB.open('ce_cache', 1);
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      const db = r.result;
      try {
        const req = db.transaction('kv', 'readonly').objectStore('kv').count();
        req.onerror = () => resolve(null);
        req.onsuccess = () => resolve(req.result);
      } catch (e) { resolve(null); }
    };
  }));
  chk(afterLogout === 0, 'H6 退出登录清空本机缓存（不把上一个人的题留给下一个人）', String(afterLogout));
  await page.close();
}

/* ============================================================
 * I. 手点「正在后台下载」的那份题库，不能重复下载（v2.32）
 * ============================================================ */
console.log('\n【I】后台加载与用户点击不打架');
{
  const { page, log } = await makePage(browser, { savedBank: 'b-wash', qDelay: 900 });
  await page.goto(URL_APP);
  await page.waitForSelector('#bankList .bank-row .act-open', { timeout: 15000 });
  // 用户等不及后台那份，直接点它
  await page.click('#bankList .bank-row .act-open');
  await page.waitForFunction(() => !document.getElementById('home').classList.contains('hide'), null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const qs = log.filter(x => x.select && x.select.includes('questions')).length;
  chk(qs === 1, 'I1 同一题库的在途请求合并成一次（不重复下整库）', qs + ' 次');
  const name = await page.evaluate(() => document.getElementById('topBankName').textContent.trim());
  chk(name === '2026反洗钱资格考试', 'I2 点完之后进的是这份题库（不会被后台自动跳转抢走）', name);
  const onHome = await page.evaluate(() => !document.getElementById('home').classList.contains('hide'));
  chk(onHome, 'I3 停在首页（自动跳转没有把用户又拽回去）', String(onHome));
  await page.close();
}

await browser.close();
srv.kill();

console.log(`\n${fails.length ? '✘' : '✔'} 通过 ${n - fails.length}/${n}`);
if (fails.length) {
  console.log('\n失败项：');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
