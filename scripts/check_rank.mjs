/**
 * 做题排行（v2.30）的验收。
 *
 * 需求原文：「当用户选择某个题库时，若有做题记录，可查看做题数排名」。
 *
 * 这个功能有一个**很容易做错的地方**，脚本主要就盯它：
 *   进度快照在「练完一遍 / 点从头开始」时会被 clearProgress 删掉
 *   （engine.js 的 showResult 里就调了）。如果排行直接读快照，
 *   用户练完整库反而会从「100 / 100」掉到 0 —— 数字自相矛盾。
 *   所以 store.js 里加了一份跨轮次累计的作答账本（progress.answers），
 *   clearProgress 不动它。A2 就是钉这件事（快照只有 3 题时，入口应显示 4 题）。
 *
 * 其余覆盖：
 *   B. 点开才请求（首页不预拉），参数带对当前题库
 *   C. 渲染：名次、并列、我的高亮、正确率配色、进度条、汇总
 *   D. 我不在前 N 名时也要能看到自己第几
 *   E. 空榜 / F. 接口失败
 *   G. 30 秒缓存：反复开合不重复打请求
 *   H. 换题库不串榜（请求带新 bankId、内容跟着换）
 *   I. 服务端口径的纯函数单测（并列名次、隐私字段、可见范围）
 *   J. 源码守卫
 *
 * 用法：node scripts/check_rank.mjs
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
const PORT = 5220;
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
const mkQ = (bank, i) => ({
  id: i + 1, type: 'single',
  stem: `【${bank}】第 ${i + 1} 题`,
  options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }],
  answerKeys: ['B'], answerText: 'B', correctIdx: 1,
  analysis: '解析'
});
const QS_WASH = Array.from({ length: 100 }, (_, i) => mkQ('WASH', i));
const QS_CREDIT = Array.from({ length: 60 }, (_, i) => mkQ('CREDIT', i));

const BANKS = [
  { id: 'b-wash', user_id: MY_ID, owner_name: '常云凡', name: '2026反洗钱资格考试', questions: QS_WASH, question_count: 100, case_count: 0, created_at: '2026-09-27T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] },
  { id: 'b-credit', user_id: OTHER_ID, owner_name: '张三', name: '信贷业务题库', questions: QS_CREDIT, question_count: 60, case_count: 0, created_at: '2026-09-26T02:00:00Z', visibility: 'public', allow_depts: [], allow_roles: [] }
];

// 本机进度：快照里只有 3 题（1、2 答了 1 题、3 没答），但累计账本里有 4 题（第 4 题是上一轮练完清掉快照后留下的）
const NOW = Date.now();
const PROGRESS_WASH = {
  v: 4,
  byMode: { sequential: { v: 2, mode: 'sequential', ids: [1, 2, 3], userAns: [1, 0, null], updatedAt: NOW } },
  marks: {},
  answers: { '1': 1, '2': 0, '3': 1, '4': 0 },
  answersAt: NOW
};

/* 排行接口的四种返回（用 rankFixture 切换，模拟不同题库/异常） */
const NORMAL = {
  ok: true,
  bank: { id: 'b-wash', name: '2026反洗钱资格考试', total: 100 },
  count: 4,
  list: [
    { rank: 1, username: '张三', answered: 88, correct: 80, rate: 91, coverage: 88, lastAt: null, mine: false },
    { rank: 2, username: '李四', answered: 64, correct: 50, rate: 78, coverage: 64, lastAt: null, mine: false },
    { rank: 2, username: '王五', answered: 64, correct: 40, rate: 63, coverage: 64, lastAt: null, mine: false },
    { rank: 4, username: '常云凡', answered: 4, correct: 3, rate: 75, coverage: 4, lastAt: null, mine: true }
  ],
  me: { rank: 4, username: '常云凡', answered: 4, correct: 3, rate: 75, coverage: 4, lastAt: null, mine: true },
  truncated: false
};
const FAR = {
  ok: true,
  bank: { id: 'b-wash', name: '2026反洗钱资格考试', total: 100 },
  count: 12,
  list: [
    { rank: 1, username: '张三', answered: 88, correct: 80, rate: 91, coverage: 88, lastAt: null, mine: false },
    { rank: 2, username: '李四', answered: 70, correct: 60, rate: 86, coverage: 70, lastAt: null, mine: false },
    { rank: 3, username: '王五', answered: 52, correct: 40, rate: 77, coverage: 52, lastAt: null, mine: false }
  ],
  me: { rank: 12, username: '常云凡', answered: 4, correct: 3, rate: 75, coverage: 4, lastAt: null, mine: true },
  truncated: true
};
const EMPTY = {
  ok: true,
  bank: { id: 'b-wash', name: '2026反洗钱资格考试', total: 100 },
  count: 0, list: [], me: null, truncated: false
};
const CREDIT = {
  ok: true,
  bank: { id: 'b-credit', name: '信贷业务题库', total: 60 },
  count: 2,
  list: [
    { rank: 1, username: '赵六', answered: 30, correct: 20, rate: 67, coverage: 50, lastAt: null, mine: false },
    { rank: 2, username: '孙七', answered: 12, correct: 12, rate: 100, coverage: 20, lastAt: null, mine: false }
  ],
  me: null, truncated: false
};

let rankFixture = NORMAL;
let rankFail = false;
const calls = [];       // 每次 /api/bank-rank 请求：{ url, bankId, limit, at }
const writes = [];      // 写进 exam_bank_progress 的请求体（验「累计账本」真的落库）

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

function project(row, select) {
  if (!select || select === '*') return row;
  const out = {};
  select.split(',').map(s => s.trim()).filter(Boolean).forEach(c => { if (c in row) out[c] = row[c]; });
  return out;
}

async function makePage(browser, opt = {}) {
  const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => fails.push('JS 报错：' + e.message));
  page.on('dialog', d => d.accept());

  await page.addInitScript(([tok, saved]) => {
    localStorage.setItem('ce_token', tok);
    localStorage.setItem('ce_user', '常云凡');
    localStorage.setItem('ce_current_bank', JSON.stringify(saved));
  }, [fakeJwt(), { id: opt.bank || 'b-wash', name: '占位' }]);

  await page.route('**/api/me', route => json(route, {
    id: MY_ID, username: '常云凡', isAdmin: false, dept: '人力资源部', role: '管理员岗'
  }));
  await page.route('**/api/admin-users', route => json(route, { ok: true, users: [], me: { id: MY_ID, isAdmin: false } }));

  // 排行接口：记录参数 + 按当前 fixture 返回
  await page.route('**/api/bank-rank**', async route => {
    const u = new URL(route.request().url());
    calls.push({ url: u.pathname + u.search, bankId: u.searchParams.get('bankId'), limit: u.searchParams.get('limit'), at: Date.now() });
    if (rankFail) return json(route, { error: '需要管理员权限' }, 500);
    if (u.searchParams.get('bankId') === 'b-credit') return json(route, CREDIT);
    return json(route, rankFixture);
  });

  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    const m = req.method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    const url = req.url();
    const table = (url.match(/rest\/v1\/([a-z_]+)/) || [])[1];

    if (table === 'exam_banks') {
      if (m === 'GET') {
        const sp = new URL(url).searchParams;
        const select = sp.get('select') || '*';
        const idEq = (url.match(/id=eq\.([^&]+)/) || [])[1];
        if (idEq) {
          const hit = BANKS.find(b => b.id === decodeURIComponent(idEq));
          const one = hit ? project(hit, select) : null;
          const single = String(req.headers()['accept'] || '').includes('object');
          return json(route, single ? one : (one ? [one] : []));
        }
        return json(route, BANKS.map(b => project(b, select)));
      }
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }

    if (table === 'exam_bank_progress') {
      if (m === 'GET') {
        const bankEq = (url.match(/bank_id=eq\.([^&]+)/) || [])[1];
        const bankId = bankEq ? decodeURIComponent(bankEq) : '';
        // 只有 b-wash 有进度；b-credit 是「没做过」的库
        if (bankId === 'b-wash') return json(route, { wrong: [], fav: [], progress: PROGRESS_WASH });
        return json(route, null);
      }
      // 写入（upsert）：把请求体记下来，K 段要验累计账本有没有一起写进去
      try { writes.push(JSON.parse(req.postData() || '{}')); } catch (e) { writes.push(null); }
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }

    if (m === 'GET') return json(route, []);
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  });

  return { page };
}

const rankState = page => page.evaluate(() => ({
  open: !document.getElementById('rankModal').classList.contains('hide'),
  title: (document.getElementById('rankBankName') || {}).textContent?.trim() || '',
  hint: (document.getElementById('rankHint') || {}).textContent?.trim() || '',
  sum: [...document.querySelectorAll('#rankSum .rs')].map(e => ({
    v: (e.querySelector('b') || {}).textContent?.trim() || '',
    k: (e.querySelector('span') || {}).textContent?.trim() || ''
  })),
  rows: [...document.querySelectorAll('#rankList .rank-row')].map(r => ({
    no: (r.querySelector('.rank-no') || {}).textContent?.trim() || '',
    name: (r.querySelector('.rank-name') || {}).textContent?.trim() || '',
    val: (r.querySelector('.rank-val') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
    rateCls: (r.querySelector('.rank-rate') || {}).className || '',
    barW: (r.querySelector('.rank-bar i') || {}).style?.width || '',
    mine: r.classList.contains('me')
  })),
  sep: document.querySelectorAll('#rankList .rank-sep').length,
  msg: (document.querySelector('#rankList .rank-msg') || {}).textContent?.trim() || '',
  tipShown: !document.getElementById('rankTip').classList.contains('hide')
}));

const openRank = async page => {
  await page.click('#rankEntry');
  await page.waitForFunction(() => {
    const box = document.getElementById('rankList');
    return box && !box.querySelector('.rank-msg') || /失败/.test(box.textContent);
  }, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(120);
};

const closeRank = async page => {
  await page.evaluate(() => window.__rank && window.__rank.close());
  await page.waitForTimeout(80);
};

const browser = await chromium.launch({ executablePath: EXE });

/* ============================================================
 * A. 入口：只在有做题记录时才说得上「可查看」，且首页不预拉数据
 * ============================================================ */
console.log('\n【A】首页入口（累计口径）');
{
  const { page } = await makePage(browser, {});
  await page.goto(URL_APP);
  await page.waitForSelector('#rankEntry', { timeout: 15000 });
  await page.waitForTimeout(400);

  const s = await rankState(page);
  chk(!!(await page.$('#rankEntry')), 'A1 首页有「做题排行」入口');
  // 快照里只有 3 题答过（userAns 有 1 个 null），账本里 4 题 → 必须显示 4
  chk(s.hint === '我已做 4 题 · 点开看看排第几', 'A2 副标题用累计账本口径（4 题，不是快照的 2 题）', s.hint);
  chk(calls.length === 0, 'A3 首页不预拉排行（点开才请求）', '已发起 ' + calls.length + ' 次');
  chk(s.rows.length === 0 && !s.open, 'A4 弹层默认关闭、没有残留行');
  await page.close();
}

/* ============================================================
 * B/C. 点开 → 请求参数 + 渲染
 * ============================================================ */
console.log('\n【B】请求参数');
let page;
{
  const made = await makePage(browser, {});
  page = made.page;
  await page.goto(URL_APP);
  await page.waitForSelector('#rankEntry', { timeout: 15000 });
  await page.waitForTimeout(300);

  await openRank(page);
  chk(calls.length === 1, 'B1 点开只发一次请求', '发了 ' + calls.length + ' 次');
  chk(calls[0]?.bankId === 'b-wash', 'B2 带上当前题库 id', calls[0]?.bankId);
  chk(Number(calls[0]?.limit) === 20, 'B3 带上 limit=20', calls[0]?.limit);
  chk(/\/api\/bank-rank$/.test((calls[0]?.url || '').split('?')[0]), 'B4 打到 /api/bank-rank', calls[0]?.url);

  console.log('\n【C】渲染');
  const s = await rankState(page);
  chk(s.open === true, 'C1 弹层已打开');
  chk(s.title === '2026反洗钱资格考试', 'C2 标题是本库名', s.title);
  chk(s.sum.length === 3, 'C3 顶部三格汇总', s.sum.length + ' 格');
  chk(s.sum[0]?.v === '4' && s.sum[0]?.k === '参与人数', 'C4 参与人数 4', JSON.stringify(s.sum[0]));
  chk(s.sum[1]?.v === '第 4 名', 'C5 我的名次 第 4 名', s.sum[1]?.v);
  chk(s.sum[2]?.v === '4 / 100', 'C6 我已做 4 / 100', s.sum[2]?.v);

  chk(s.rows.length === 4, 'C7 榜上 4 行', s.rows.length + ' 行');
  chk(s.rows[0]?.no === '🥇', 'C8 第一名显示奖牌', s.rows[0]?.no);
  chk(s.rows[1]?.no === '🥈' && s.rows[2]?.no === '🥈',
    'C9 并列第二名两人都是银牌（名次不跳成 3）', [s.rows[1]?.no, s.rows[2]?.no].join('/'));
  chk(s.rows[3]?.no === '4', 'C10 并列之后下一位是第 4 名', s.rows[3]?.no);
  chk(s.rows[3]?.mine === true, 'C11 我那一行高亮', String(s.rows[3]?.mine));
  chk(/我$/.test(s.rows[3]?.name || ''), 'C12 我的行带「我」标签', s.rows[3]?.name);
  chk(/^4 \/ 100/.test(s.rows[3]?.val || ''), 'C13 我的行显示 4 / 100', s.rows[3]?.val);
  chk(/75%/.test(s.rows[3]?.val || '') && /rate-mid/.test(s.rows[3]?.rateCls || ''), 'C14 正确率 75% 且是橙色档', s.rows[3]?.rateCls);
  chk(/rate-good/.test(s.rows[0]?.rateCls || ''), 'C15 91% 是绿色档', s.rows[0]?.rateCls);
  chk(s.rows[0]?.barW === '88%', 'C16 进度条按覆盖率画（88%）', s.rows[0]?.barW);
  chk(s.sep === 0, 'C17 我在榜内时不额外插「我的名次」段', s.sep + ' 段');
  chk(s.tipShown, 'C18 口径说明可见');

  // 375px 不溢出
  await page.setViewportSize({ width: 375, height: 780 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    box: Math.round(document.querySelector('#rankModal .modal-box').getBoundingClientRect().width)
  }));
  chk(overflow.doc <= 376, 'C19 375px 下页面不横向溢出', overflow.doc + 'px');
  chk(overflow.box <= 355, 'C20 弹层宽度收进屏幕', overflow.box + 'px');
  await page.screenshot({ path: path.join(SHOTS, 'rank-mobile.png') });
  await page.setViewportSize({ width: 420, height: 1000 });

  await page.screenshot({ path: path.join(SHOTS, 'rank-modal.png') });
}

/* ============================================================
 * G. 缓存：关掉再开不重复请求
 * ============================================================ */
console.log('\n【G】30 秒缓存');
{
  const before = calls.length;
  await closeRank(page);
  await openRank(page);
  chk(calls.length === before, 'G1 30 秒内重开不重复请求', '又发了 ' + (calls.length - before) + ' 次');
  const cs = await page.evaluate(() => window.__rank.cacheSize());
  chk(cs === 1, 'G2 缓存里只有本库一条', cs + ' 条');

  // 练完回首页要能立刻看到新数字 → 首页出现时作废缓存
  await page.evaluate(() => document.getElementById('home').classList.add('hide'));
  await page.waitForTimeout(60);
  await page.evaluate(() => document.getElementById('home').classList.remove('hide'));
  await page.waitForTimeout(120);
  const cs2 = await page.evaluate(() => window.__rank.cacheSize());
  chk(cs2 === 0, 'G3 回首页作废排行缓存（刚做完的题不会被 30 秒缓存挡住）', cs2 + ' 条');
}

/* ============================================================
 * D. 我不在前 N 名
 * ============================================================ */
console.log('\n【D】我的名次在榜外');
{
  rankFixture = FAR;
  await page.evaluate(() => window.__rank.invalidate());
  await closeRank(page);
  await openRank(page);
  const s = await rankState(page);
  chk(s.rows.length === 4, 'D1 榜单 3 行 + 我自己 1 行', s.rows.length + ' 行');
  chk(s.sep === 1, 'D2 中间有省略分隔', s.sep + ' 段');
  chk(s.rows[3]?.no === '12' && s.rows[3]?.mine === true, 'D3 末行是我的第 12 名', s.rows[3]?.no);
  chk(s.sum[1]?.v === '第 12 名', 'D4 汇总里名次正确', s.sum[1]?.v);
  chk(s.sum[0]?.v === '12', 'D5 参与人数 12', s.sum[0]?.v);
}

/* ============================================================
 * E. 空榜
 * ============================================================ */
console.log('\n【E】没有人做过');
{
  rankFixture = EMPTY;
  await page.evaluate(() => window.__rank.invalidate());
  await closeRank(page);
  await openRank(page);
  const s = await rankState(page);
  chk(/还没有人做过题/.test(s.msg), 'E1 空榜有明确说明', s.msg);
  chk(s.rows.length === 0, 'E2 不渲染任何行', s.rows.length + ' 行');
  chk(s.sum[1]?.v === '未上榜', 'E3 汇总显示「未上榜」', s.sum[1]?.v);
  chk(s.sum[2]?.v === '—', 'E4 我已做显示占位', s.sum[2]?.v);
}

/* ============================================================
 * F. 接口失败
 * ============================================================ */
console.log('\n【F】接口失败');
{
  rankFail = true;
  await page.evaluate(() => window.__rank.invalidate());
  await closeRank(page);
  await openRank(page);
  const s = await rankState(page);
  chk(/读取失败/.test(s.msg), 'F1 失败有提示（不是空白）', s.msg);
  chk(/需要管理员权限/.test(s.msg), 'F2 把后端给的原因透出来', s.msg);
  chk(s.open === true, 'F3 弹层仍在，可关闭重试');

  rankFail = false;
  rankFixture = NORMAL;                     // E 段把 fixture 换成了空榜，这里要还原
  await page.evaluate(() => window.__rank.invalidate());
  await closeRank(page);
  await openRank(page);
  const s2 = await rankState(page);
  chk(s2.rows.length === 4, 'F4 失败不写缓存：重开能正常拿到数据', s2.rows.length + ' 行');
  await closeRank(page);
}

/* ============================================================
 * H. 换题库不串榜
 * ============================================================ */
console.log('\n【H】切换题库');
{
  rankFixture = NORMAL;
  const before = calls.length;
  await page.click('#bankSwitch');
  await page.waitForSelector('#bankPickList .pick-row', { timeout: 10000 });
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('#bankPickList .pick-row')].find(x => x.dataset.id === 'b-credit');
    r.click();
  });
  await page.waitForTimeout(900);

  const hint = await page.evaluate(() => document.getElementById('rankHint').textContent.trim());
  chk(hint === '你还没做过本库，做完一题就会上榜', 'H1 换到没做过的库，副标题跟着变', hint);

  await openRank(page);
  const last = calls[calls.length - 1];
  chk(calls.length === before + 1, 'H2 换库后重新请求（没吃到上一个库的缓存）', '发了 ' + (calls.length - before) + ' 次');
  chk(last.bankId === 'b-credit', 'H3 请求带新库 id', last.bankId);
  const s = await rankState(page);
  chk(s.title === '信贷业务题库', 'H4 标题是新库名', s.title);
  chk(s.rows.length === 2, 'H5 内容是 2 行（新库的榜）', s.rows.length + ' 行');
  chk(/12 \/ 60/.test(s.rows[1]?.val || ''), 'H6 分母用新库题数（60）', s.rows[1]?.val);
  chk(s.sum[1]?.v === '未上榜', 'H7 我在新库没做过 → 未上榜', s.sum[1]?.v);
  await page.screenshot({ path: path.join(SHOTS, 'rank-switch.png') });
  await closeRank(page);
}

/* ============================================================
 * K. 端到端：真的做一道题，账本要落库、入口要跟着涨
 *    （这是整个功能的地基：没有累计账本，练完清进度就会归零）
 * ============================================================ */
console.log('\n【K】做一题 → 账本落库 → 入口更新');
{
  // 现在停在 b-credit（桩里没有进度）
  const beforeHint = await page.evaluate(() => document.getElementById('rankHint').textContent.trim());
  chk(beforeHint === '你还没做过本库，做完一题就会上榜', 'K1 起始状态：该库无做题记录', beforeHint);

  await page.click('#startBtn');
  await page.waitForSelector('#practice .opt', { timeout: 10000 });
  await page.evaluate(() => document.querySelector('#practice .opt[data-i="0"]').click());
  await page.waitForTimeout(900);          // 等 400ms 防抖的落库

  const last = writes[writes.length - 1] || {};
  const prog = last.progress || {};
  chk(!!prog.answers && Object.keys(prog.answers).length === 1, 'K2 落库的 progress 里带累计账本（1 题）',
    JSON.stringify(prog.answers || null));
  chk(String(prog.answers && prog.answers['1']) === '0', 'K3 账本记的是刚刚选的作答', JSON.stringify(prog.answers['1']));
  chk(!!prog.byMode && !!prog.byMode.sequential, 'K4 快照照旧在（两种数据并存）');

  await page.click('#quitBtn');             // 确认框被自动接受
  await page.waitForTimeout(500);
  const afterHint = await page.evaluate(() => document.getElementById('rankHint').textContent.trim());
  chk(afterHint === '我已做 1 题 · 点开看看排第几', 'K5 回首页入口立刻显示「我已做 1 题」', afterHint);

  // 再点开排行：缓存已被首页作废，必须重新请求
  const beforeCalls = calls.length;
  await openRank(page);
  chk(calls.length === beforeCalls + 1, 'K6 做完题再点开，重新请求（没吃旧缓存）', '发了 ' + (calls.length - beforeCalls) + ' 次');
  await closeRank(page);
}

/* ============================================================
 * I. 服务端纯函数单测（不走浏览器）
 * ============================================================ */
console.log('\n【I】服务端口径');
{
  const { summarizeBank } = await import(pathToFileURL(path.join(ROOT, 'api/admin-stats.js')).href);
  const { buildRank, canSeeBank } = await import(pathToFileURL(path.join(ROOT, 'api/bank-rank.js')).href);

  const q = (id, ci) => ({ id, type: 'single', correctIdx: ci, options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] });
  const bank = { id: 'b1', name: '测试库', questions: [q(1, 1), q(2, 0), q(3, 1), q(4, 0)] };

  const onlyBook = summarizeBank(bank, [], { 1: 1, 2: 1, 3: 1 }, 1000);
  chk(onlyBook.answered === 3 && onlyBook.correct === 2, 'I1 只有累计账本也能算（练完清进度不掉数）',
    `answered=${onlyBook.answered} correct=${onlyBook.correct}`);

  const override = summarizeBank(bank, [{ mode: 'wrong', updatedAt: 2000, ids: [2], userAns: [0] }], { 1: 1, 2: 1, 3: 1 }, 1000);
  chk(override.correct === 3 && override.answered === 3, 'I2 快照覆盖账本里的旧作答（后来答对要算对）',
    `correct=${override.correct}`);

  const orphan = summarizeBank(bank, [], { 99: 1 }, 0);
  chk(orphan.answered === 0 && orphan.orphan === 1, 'I3 题库改过、题已不存在的不算已做（记 orphan）',
    `answered=${orphan.answered} orphan=${orphan.orphan}`);

  const rows = [
    { userId: 'a', answered: 32, correct: 24, rate: 75, coverage: 32, lastAt: null },
    { userId: 'b', answered: 32, correct: 20, rate: 63, coverage: 32, lastAt: null },
    { userId: 'c', answered: 10, correct: 9, rate: 90, coverage: 10, lastAt: null },
    { userId: 'me', answered: 5, correct: 5, rate: 100, coverage: 5, lastAt: null }
  ];
  const nameOf = new Map([['a', '张三'], ['b', '李四'], ['c', '王五'], ['me', '我']]);
  const r = buildRank({ rows, nameOf, meId: 'me', limit: 2 });
  chk(r.list[0].rank === 1 && r.list[1].rank === 1, 'I4 做题数相同即并列同名次',
    r.list.map(x => x.rank).join(','));
  chk(r.count === 4 && r.truncated === true, 'I5 截断时 count 仍是总人数', `count=${r.count}`);
  chk(r.me && r.me.rank === 4 && r.me.mine === true, 'I6 我不在前 N 也能取到自己的名次', r.me && r.me.rank);
  chk(!('userId' in r.list[0]), 'I7 下发字段不含 userId（隐私）', Object.keys(r.list[0]).join(','));
  chk(r.list[0].username === '张三', 'I8 默认按答题数降序，同分看正确率', r.list[0].username);

  chk(canSeeBank({ user_id: 'u1', visibility: 'private' }, { id: 'u1' }) === true, 'I9 可见范围：本人可见');
  chk(canSeeBank({ user_id: 'u2', visibility: 'private' }, { id: 'u1', dept: '', role: '' }) === false, 'I10 他人私有库不可见');
  chk(canSeeBank({ user_id: 'u2', visibility: 'private' }, { id: 'u1', is_admin: true }) === true, 'I11 管理员可见');
  chk(canSeeBank({ user_id: 'u2', visibility: 'scope', allow_depts: ['信贷部'], allow_roles: [] }, { id: 'u1', dept: '信贷部' }) === true, 'I12 部门命中可见');
  chk(canSeeBank({ user_id: 'u2', visibility: 'scope', allow_depts: ['信贷部'], allow_roles: [] }, { id: 'u1', dept: '人力资源部' }) === false, 'I13 部门不命中不可见');
}

/* ============================================================
 * J. 源码守卫
 * ============================================================ */
console.log('\n【J】源码守卫');
{
  const rankSrc = fs.readFileSync(path.join(ROOT, 'src/rank.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'api/bank-rank.js'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src/store.js'), 'utf8');
  const vc = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

  chk(/apiRequest\('GET', '\/api\/bank-rank/.test(rankSrc), 'J1 前端只走自己那个接口，不直连别人的进度行');
  // 注释里提到 user_id 不算问题（那段注释正是在说明「不下发 user_id」），先把注释剥掉再看代码
  const rankCode = rankSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  chk(!/user_id|userId/.test(rankCode), 'J2 前端代码里没有 user_id / userId（拿不到别人的进度标识）');
  chk(/canSeeBank/.test(apiSrc) && /visibility/.test(apiSrc), 'J3 服务端按可见范围再判一次（不能只靠前端）');
  chk(/service_role|SUPABASE_SERVICE_ROLE_KEY/.test(apiSrc), 'J4 排行榜由服务端 service_role 聚合');
  chk(/export function buildRank/.test(apiSrc), 'J5 排名逻辑抽成纯函数，可单测');
  chk(!!vc.functions['api/bank-rank.js'], 'J6 vercel.json 注册了 api/bank-rank.js');
  // clearProgress 里不能顺手把 answers 一起清掉 —— 那正是这个功能最容易掉的坑
  const clearBlock = storeSrc.slice(storeSrc.indexOf('export function clearProgress'), storeSrc.indexOf('export function saveProgress'));
  chk(!/state\.answers\s*=/.test(clearBlock), 'J7 clearProgress 不清累计作答账本', clearBlock.slice(0, 60).replace(/\n/g, ' '));
  chk(/progressPayload[\s\S]{0,400}answers/.test(storeSrc), 'J8 账本随进度 jsonb 一起同步（无新增表）');
}

/* ---------- 收尾 ---------- */
await browser.close();
srv.kill();

console.log('\n' + '─'.repeat(56));
if (fails.length) {
  console.log(`✘ ${fails.length} / ${n} 项未通过：`);
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
} else {
  console.log(`✔ 全部通过：${n} / ${n}`);
}
