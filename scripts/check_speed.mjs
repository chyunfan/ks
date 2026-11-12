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
  { id: 'b-wash', user_id: MY_ID, owner_name: '常云凡', name: '2026反洗钱资格考试', questions: QS_WASH, question_count: 300, case_count: 6, created_at: '2026-09-27T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-credit', user_id: OTHER_ID, owner_name: '张三', name: '信贷业务题库', questions: QS_SMALL, question_count: 120, case_count: 0, created_at: '2026-09-26T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] }
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
        if (opt.bankDelay) await new Promise(r => setTimeout(r, opt.bankDelay));
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
 * E. 启动并行：/api/me 与题库请求重叠
 * ============================================================ */
console.log('\n【E】首屏并行');
{
  const { page, log, waits } = await makePage(browser, {
    savedBank: 'b-wash', meDelay: 400, bankDelay: 50
  });
  const t0 = Date.now();
  await page.goto(URL_APP);
  await page.waitForFunction(() => {
    const h = document.getElementById('home');
    return h && !h.classList.contains('hide');
  }, null, { timeout: 15000 });
  const elapsed = Date.now() - t0;
  // 身份请求有 400ms 延迟，要等它落地再断言（否则 t1 还是 null，重叠判断不成立）
  await page.waitForTimeout(600);

  const meW = waits[0];
  const bankQ = log.find(x => x.select && x.select.includes('questions'));
  chk(!!meW && !!bankQ, 'E1 两个请求都发生了', JSON.stringify({ me: !!meW, bank: !!bankQ }));
  if (meW && bankQ && meW.t1) {
    const overlap = meW.t0 < bankQ.t1 && bankQ.t0 < meW.t1;
    chk(overlap, 'E2 身份请求与题库请求时间重叠（真并行，不是排队）',
      `me[${meW.t0 - t0},${meW.t1 - t0}] bank[${bankQ.t0 - t0},${bankQ.t1 - t0}]`);
  } else {
    chk(false, 'E2 身份请求与题库请求时间重叠（真并行，不是排队）', '时间戳缺失');
  }
  // 串行的话至少 400+50=450ms 起（还没算渲染），并行应明显低于此
  chk(elapsed < 900, 'E3 首屏总耗时未被串行拉长', elapsed + ' ms');

  const homeName = await page.evaluate(() => document.getElementById('topBankName').textContent.trim());
  chk(homeName === '2026反洗钱资格考试', 'E4 并行后顶栏名字正确（身份晚到不影响题库加载）', homeName);
  // 首页四张模式卡 + 每张卡里的计数框 / 续做横幅，都是 refreshHomeUI() 画的
  const counts = await page.evaluate(() => ({
    modes: document.querySelectorAll('#home .mode').length,
    countBoxes: ['examCounts', 'wrongCounts', 'favCounts'].filter(id => document.getElementById(id)).length,
    resumes: document.querySelectorAll('#home .rs').length
  }));
  chk(counts.modes === 4 && counts.countBoxes === 3 && counts.resumes === 4,
    'E5 首页卡片正常渲染（错题/收藏/进度没因并行而错位）', JSON.stringify(counts));
  await page.close();
}

/* ============================================================
 * G. 加载反馈：慢的时候不能是纯白，快的时候不能闪
 * ============================================================ */
console.log('\n【G】加载遮罩');
{
  const { page } = await makePage(browser, { savedBank: 'b-wash', meDelay: 600, bankDelay: 300 });
  await page.goto(URL_APP);
  await page.waitForTimeout(400);          // 此刻仍在加载（me 600ms / bank 300ms）
  const mid = await page.evaluate(() => {
    const m = document.getElementById('bootMask');
    return {
      exists: !!m,
      off: m ? m.classList.contains('off') : null,
      text: (document.getElementById('bootText') || {}).textContent || '',
      opacity: m ? Number(getComputedStyle(m).opacity) : -1
    };
  });
  chk(mid.exists && mid.off === false, 'G1 加载期间显示遮罩（不再是纯白页面）', JSON.stringify(mid));
  chk(/题库/.test(mid.text), 'G2 文案说清在加载什么', mid.text);
  chk(mid.opacity > 0.5, 'G3 遮罩真的可见（不是只加了类却透明）', 'opacity=' + mid.opacity);

  await page.waitForFunction(() => document.getElementById('bootMask').classList.contains('off'), null, { timeout: 15000 });
  chk(true, 'G4 加载完成后遮罩收起');
  const pe = await page.evaluate(() => getComputedStyle(document.getElementById('bootMask')).pointerEvents);
  chk(pe === 'none', 'G5 收起后不再拦截点击', pe);

  // 收起后要能正常用
  await page.evaluate(() => document.getElementById('toBanks').click());
  await page.waitForTimeout(500);
  const rows = await listRows(page);
  chk(rows.length > 0, 'G6 遮罩收起后页面可正常操作', rows.length + ' 行');

  // 延迟淡入：加载快时不应该出现（否则会闪一下，比白屏更难受）
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
  chk(/const BANK_COLS = 'id,name,case_count,question_count,created_at,user_id,owner_name,visibility,allow_depts,allow_roles'/.test(banksSrc),
    'F1 新列清单固定（不含 questions）');
  chk(/BANK_COLS_LEGACY[\s\S]{0,200}questions/.test(banksSrc), 'F2 保留含 questions 的旧清单用于降级');
  chk(/isMissingColumn/.test(banksSrc) && /42703/.test(banksSrc), 'F3 有列缺失的识别逻辑');
  chk(/invalidateBankList/.test(banksSrc), 'F4 改名/删库后有缓存失效入口');
  chk(/create trigger exam_banks_sync_count_trg/.test(perfSql), 'F5 perf.sql 含触发器（任何写入路径都同步题数）');
  chk(/add column if not exists question_count/.test(perfSql), 'F6 perf.sql 幂等加列');
  chk(/update public\.exam_banks[\s\S]{0,200}question_count/.test(perfSql), 'F7 perf.sql 含历史数据回填');

  const qeditSrc = fs.readFileSync(path.join(ROOT, 'src/qedit.js'), 'utf8');
  chk(/dropQuestions\(st\.bank\.id\)/.test(qeditSrc), 'F8 编辑题目保存后清缓存');
}

await browser.close();
srv.kill();

console.log(`\n${fails.length ? '✘' : '✔'} 通过 ${n - fails.length}/${n}`);
if (fails.length) {
  console.log('\n失败项：');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
