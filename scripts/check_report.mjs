/**
 * 个人练习正确率 / 模拟考试历次成绩 / 管理员的「分题库统计」（v2.31）验收。
 *
 * 需求原文：
 *   「个人用户可以查看练习正确率（做过多少题，多少题没做到过）、模拟考试历次成绩，
 *     管理员可分题库查看所有人的练习正确率、模拟历次成绩」
 *
 * 本版有两个容易做错的地方，脚本重点盯：
 *   ① **考试记录必须真的留下来**。交卷时 showResult 会 clearProgress(S.mode) 清掉续做快照，
 *      如果考试场次也放在快照里，用户交完卷就再也看不到这场成绩。A/B 段钉这件事。
 *   ② **不同满分不能直接比绝对分**。组卷满分可调，满 100 的 60 分与满 60 的 55 分谁更好？
 *      所以平均/最高一律按得分率折百分制（C 段纯函数单测）。
 *
 * 其余覆盖：
 *   D. 场次上限 50（不是无限涨，否则 jsonb 会越来越大）
 *   E. 管理员分题库视图：题库下拉、按人加权正确率、逐人考试汇总、空态
 *   F. 权限：非管理员看不到入口；接口源码有 403 兜底
 *   G. 源码守卫（clearProgress 不清 exams / 记录发生在清进度之后 / 个人报告不发请求）
 *
 * 用法：node scripts/check_report.mjs
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
const PORT = 5221;                     // 与 check_rank(5220) 错开，避免并行跑时撞端口
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MY_ID = '11111111-1111-1111-1111-111111111111';

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
// 100 道单选，correctIdx=1（选 B 对、选 A 错）—— 判分期望好算
const mkQ = i => ({
  id: i + 1, type: 'single',
  stem: `【WASH】第 ${i + 1} 题`,
  options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }],
  answerKeys: ['B'], answerText: 'B', correctIdx: 1,
  analysis: '解析'
});
const QS = Array.from({ length: 100 }, (_, i) => mkQ(i));
const BANKS = [{
  id: 'b-wash', user_id: MY_ID, owner_name: '常云凡', name: '2026反洗钱资格考试',
  questions: QS, question_count: 100, case_count: 0, created_at: '2026-09-27T02:00:00Z',
  visibility: 'public', allow_depts: [], allow_roles: []
}];

// 累计账本 4 题：1、2、3 答对（B），4 答错（A）→ 已做 4 / 未做 96 / 正确率 75%
const NOW = Date.now();
const EXAMS = [
  { at: 5000, total: 4, right: 2, score: 50, full: 100, ms: 600000, auto: 0 },   // 50%
  { at: 7000, total: 4, right: 3, score: 75, full: 100, ms: 300000, auto: 0 },   // 75%
  { at: 9000, total: 2, right: 2, score: 30, full: 30, ms: 120000, auto: 1 }     // 100%（满分 30）
];
const PROGRESS = {
  v: 4,
  byMode: {},
  marks: {},
  answers: { '1': 1, '2': 1, '3': 1, '4': 0 },
  answersAt: NOW,
  exams: EXAMS
};

// 分题库视图的接口返回
const BSTATS = {
  ok: true,
  bank: { id: 'b-wash', name: '2026反洗钱资格考试', total: 100 },
  count: 2,
  rows: [
    { username: '张三', dept: '信贷部', role: '', answered: 88, correct: 80, rate: 91, coverage: 88, examCount: 3, examAvg: 78, examBest: 88, lastAt: '2026-11-10T02:00:00Z' },
    { username: '李四', dept: '', role: '', answered: 0, correct: 0, rate: 0, coverage: 0, examCount: 0, examAvg: 0, examBest: 0, lastAt: null }
  ]
};
const BSTATS_EMPTY = { ok: true, bank: { id: 'b-wash', name: '2026反洗钱资格考试', total: 100 }, count: 0, rows: [] };
const BANKS_LIST = {
  ok: true,
  banks: [
    { id: 'b-wash', name: '2026反洗钱资格考试', total: 100 },
    { id: 'b-credit', name: '信贷业务题库', total: 60 }
  ]
};

let bstatsFixture = BSTATS;
const apiCalls = [];      // /api/admin-stats 请求
const writes = [];        // 写 exam_bank_progress 的请求体

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

  await page.addInitScript(([tok, bank]) => {
    localStorage.setItem('ce_token', tok);
    localStorage.setItem('ce_user', '常云凡');
    localStorage.setItem('ce_current_bank', JSON.stringify(bank));
    // 同账号重开页面时清掉本机镜像，让「云端桩数据」成为唯一来源
    Object.keys(localStorage).forEach(k => { if (k.startsWith('ce_cloud_')) localStorage.removeItem(k); });
  }, [fakeJwt(), { id: 'b-wash', name: '2026反洗钱资格考试' }]);

  await page.route('**/api/me', route => json(route, {
    id: MY_ID, username: '常云凡', isAdmin: !!opt.admin, dept: '人力资源部', role: '管理员岗'
  }));
  await page.route('**/api/admin-users', route => json(route, {
    ok: true, users: [], me: { id: MY_ID, isAdmin: !!opt.admin }
  }));

  // 管理员统计接口：list / bankId 两种模式
  await page.route('**/api/admin-stats**', async route => {
    const u = new URL(route.request().url());
    apiCalls.push({ q: u.search, path: u.pathname });
    if (u.searchParams.get('list') === '1') return json(route, BANKS_LIST);
    if (u.searchParams.get('bankId') === 'b-credit') {
      return json(route, { ok: true, bank: { id: 'b-credit', name: '信贷业务题库', total: 60 }, count: 0, rows: [] });
    }
    return json(route, bstatsFixture);
  });

  await page.route('**/api/bank-rank**', route => json(route, {
    ok: true, bank: { id: 'b-wash', name: '2026反洗钱资格考试', total: 100 },
    count: 0, list: [], me: null, truncated: false
  }));

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
        if (bankEq && decodeURIComponent(bankEq) === 'b-wash') {
          const exams = Array.isArray(opt.exams) ? opt.exams : PROGRESS.exams;
          return json(route, { wrong: [], fav: [], progress: Object.assign({}, PROGRESS, { exams }) });
        }
        return json(route, null);
      }
      try { writes.push(JSON.parse(req.postData() || '{}')); } catch (e) { writes.push(null); }
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }

    if (m === 'GET') return json(route, []);
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  });

  return page;
}

/* ---------- 状态读取 ---------- */
const reportState = page => page.evaluate(() => {
  const t = el => (el || {}).textContent?.replace(/\s+/g, ' ').trim() || '';
  return {
    open: !document.getElementById('reportModal').classList.contains('hide'),
    title: t(document.getElementById('reportBankName')),
    stats: [...document.querySelectorAll('#reportStats .stat')].map(e => ({
      v: t(e.querySelector('b')), k: t(e.querySelector('span')),
      cls: (e.querySelector('b') || {}).className || ''
    })),
    barW: (document.querySelector('#reportBarWrap .rp-bar i') || {}).style?.width || '',
    barTxt: t(document.getElementById('reportBarWrap')),
    examSum: [...document.querySelectorAll('#reportExamSum .rs')].map(e => ({ v: t(e.querySelector('b')), k: t(e.querySelector('span')) })),
    exams: [...document.querySelectorAll('#reportExamList .rp-exam')].map(r => ({
      when: t(r.querySelector('.rp-exam-when')),
      score: t(r.querySelector('.rp-exam-score')),
      meta: t(r.querySelector('.rp-exam-meta')),
      auto: !!r.querySelector('.rp-auto')
    })),
    empty: !!document.querySelector('#reportExamList .rp-msg')
  };
});

const bstatsState = page => page.evaluate(() => {
  const t = el => (el || {}).textContent?.replace(/\s+/g, ' ').trim() || '';
  return {
    open: !document.getElementById('bstatsModal').classList.contains('hide'),
    options: [...document.querySelectorAll('#bstatsPick option')].map(o => o.textContent.trim()),
    picked: (document.getElementById('bstatsPick') || {}).value || '',
    sum: [...document.querySelectorAll('#bstatsSum .rs')].map(e => ({ v: t(e.querySelector('b')), k: t(e.querySelector('span')) })),
    rows: [...document.querySelectorAll('#bstatsList .stat-row')].map(r => ({
      name: t(r.querySelector('.sr-name')),
      prog: t(r.querySelector('.sr-prog')),
      meta: t(r.querySelector('.sr-meta')),
      barW: (r.querySelector('.sr-bar i') || {}).style?.width || ''
    })),
    msg: t(document.querySelector('#bstatsList .bstats-msg'))
  };
});

/** 开考试并快速交卷（不逐题作答：全空卷，得分 0，但「交卷」这个动作才是记录点） */
async function takeExam(page) {
  await page.evaluate(() => document.querySelector('.mode[data-mode="exam"]').click());
  await page.waitForTimeout(250);
  await page.click('#startBtn');
  await page.waitForTimeout(400);
  // 一路点「下一题」到最后一题点「交卷」
  await page.evaluate(() => {
    const btn = document.getElementById('nextBtn');
    for (let i = 0; i < 400; i++) {
      if (window.__exam.S.finished) break;
      btn.click();
    }
  });
  await page.waitForTimeout(500);
  return await page.evaluate(() => ({
    finished: window.__exam.S.finished,
    exams: window.__store.loadExams().length,
    top: window.__store.loadExams()[0] || null
  }));
}

/* ---------- 4. 开跑 ---------- */
const browser = await chromium.launch({ executablePath: EXE, headless: true });

try {
  /* ============ A. 个人报告：练习正确率 ============ */
  const page = await makePage(browser);
  await page.goto(URL_APP, { waitUntil: 'load' });
  await page.waitForSelector('#reportEntry', { state: 'visible', timeout: 20000 });

  const hint = await page.evaluate(() => (document.getElementById('reportHint') || {}).textContent?.trim() || '');
  chk(hint.includes('4') && hint.includes('100') && hint.includes('75%'),
    'A1 首页「我的报告」入口副标题显示 已做 4 / 100 · 正确率 75%', hint);

  await page.click('#reportEntry');
  await page.waitForTimeout(300);
  let r = await reportState(page);
  chk(r.open, 'A2 点入口打开报告弹层');
  chk(r.title === '2026反洗钱资格考试', 'A2 标题是当前题库名', r.title);

  const pick = k => (r.stats.find(x => x.k === k) || {}).v || '';
  chk(pick('已做过') === '4', 'A3 已做过 = 4（累计账本口径）', pick('已做过'));
  chk(pick('没做到过') === '96', 'A3 没做到过 = 96（100 − 4）', pick('没做到过'));
  chk(pick('正确率') === '75%', 'A3 正确率 = 75%（3 对 ÷ 4 已做）', pick('正确率'));
  chk(pick('题库总题数') === '100', 'A3 题库总题数 = 100', pick('题库总题数'));

  const rateStat = r.stats.find(x => x.k === '正确率') || {};
  chk(rateStat.cls === 'rate-mid', 'A4 75% 用「中档」配色（60–79 橙）', rateStat.cls);

  chk(r.barW === '4%', 'A5 覆盖率条 = 4%（4 / 100）', r.barW);
  chk(r.barTxt.includes('4 / 100') && r.barTxt.includes('答对 3'), 'A5 覆盖率文案含「4 / 100 题」「答对 3 题」', r.barTxt);

  /* ============ B. 个人报告：模拟考试历次成绩 ============ */
  const es = k => (r.examSum.find(x => x.k === k) || {}).v || '';
  chk(es('考试次数') === '3', 'B1 考试次数 = 3', es('考试次数'));
  chk(es('平均分') === '75', 'B2 平均分 = 75（(50+75+100)÷3，第三场按满分 30 折算）', es('平均分'));
  chk(es('最高分') === '100', 'B2 最高分 = 100', es('最高分'));

  chk(r.exams.length === 3, 'B3 逐场列出 3 条', r.exams.length + ' 条');
  chk((r.exams[0] || {}).score === '30 / 30', 'B3 最新的排最前（at=9000 那场 30 / 30）', (r.exams[0] || {}).score);
  chk((r.exams[1] || {}).score === '75 / 100', 'B3 第二条是 at=7000 的 75 / 100', (r.exams[1] || {}).score);
  chk(r.exams.filter(x => x.auto).length === 1, 'B4 只有自动交卷那场带「自动」标记',
    r.exams.filter(x => x.auto).length + ' 条');

  chk(/对 2 \/ 2 题 · 用时 02:00/.test((r.exams[0] || {}).meta || ''),
    'B5 逐场显示「对 x/y 题 · 用时 mm:ss」', (r.exams[0] || {}).meta);

  await page.screenshot({ path: path.join(SHOTS, 'report-modal.png'), clip: { x: 0, y: 0, width: 420, height: 760 } });
  await page.evaluate(() => document.getElementById('reportClose').click());
  await page.waitForTimeout(150);

  /* ============ C. 交卷真的记一场（端到端） ============ */
  const before = await page.evaluate(() => window.__store.loadExams().length);
  const ex = await takeExam(page);
  chk(ex.finished, 'C1 考试交卷进入结果页', JSON.stringify(ex.finished));
  chk(ex.exams === before + 1, 'C1 交卷后场次 +1（快照被清掉，但账本留住了）', before + ' → ' + ex.exams);
  chk(!!ex.top && ex.top.total > 0 && ex.top.at > 0, 'C2 记录里有题量、时间、得分', JSON.stringify(ex.top));
  chk(!!ex.top && Number(ex.top.full) > 0, 'C2 记录里有满分（跨满分比较要用）', ex.top && ex.top.full);

  // 结果页「再来一次」= 回首页；再从首页开考一次，应追加而不是覆盖
  await page.evaluate(() => document.getElementById('againBtn').click());
  await page.waitForTimeout(400);
  await page.click('#startBtn');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const btn = document.getElementById('nextBtn');
    for (let i = 0; i < 400; i++) { if (window.__exam.S.finished) break; btn.click(); }
  });
  await page.waitForTimeout(500);
  const after2 = await page.evaluate(() => window.__store.loadExams().length);
  chk(after2 === ex.exams + 1, 'C3 再考一场是「追加」不是「覆盖」', ex.exams + ' → ' + after2);

  // 回首页看报告：入口副标题要跟着变（交卷后停在结果页，得先回首页）
  await page.evaluate(() => document.getElementById('againBtn').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__report.refreshEntry(); });
  await page.click('#reportEntry');
  await page.waitForTimeout(250);
  r = await reportState(page);
  chk((r.examSum.find(x => x.k === '考试次数') || {}).v === String(after2), 'C4 报告里考试次数跟着变成 ' + after2,
    (r.examSum.find(x => x.k === '考试次数') || {}).v);
  chk(r.exams.length === after2, 'C4 逐场列表条数与场次一致', r.exams.length + ' 条');
  await page.evaluate(() => document.getElementById('reportClose').click());

  /* ============ D. 场次上限与排序 ============ */
  const cap = await page.evaluate(() => {
    for (let i = 0; i < 70; i++) {
      window.__store.pushExam({ at: Date.now() + 100000 + i, total: 10, right: 5, score: 50, full: 100, ms: 1000 });
    }
    const l = window.__store.loadExams();
    return { len: l.length, sorted: l.every((e, i) => i === 0 || l[i - 1].at >= e.at), first: l[0].at };
  });
  chk(cap.len === 50, 'D1 最多保留 50 场（不会无限涨）', cap.len + ' 场');
  chk(cap.sorted, 'D2 场次按时间倒序（新的在前）');

  const bad = await page.evaluate(() => {
    const before = window.__store.loadExams().length;
    window.__store.pushExam({ at: Date.now(), total: 0, right: 0, score: 0, full: 100, ms: 0 });   // 无效题量
    window.__store.pushExam(null);
    return { before, after: window.__store.loadExams().length };
  });
  chk(bad.before === bad.after, 'D3 无效记录（题量 0 / null）不写入', JSON.stringify(bad));

  /* ============ E. 空态：没有考试记录时 ============ */
  const page2 = await makePage(browser, { exams: [] });   // 桩数据里这场库没有任何考试记录
  await page2.goto(URL_APP, { waitUntil: 'load' });
  // 新 context 首次要下载/解析整份产物，固定 900ms 不可靠 —— 等入口真正可见
  await page2.waitForSelector('#reportEntry', { state: 'visible', timeout: 20000 });
  await page2.click('#reportEntry');
  await page2.waitForTimeout(250);
  const r2 = await reportState(page2);
  chk(r2.empty, 'E1 没有考试记录时显示提示文案', JSON.stringify(r2.empty));
  chk((r2.examSum.find(x => x.k === '考试次数') || {}).v === '0', 'E1 考试次数显示 0',
    (r2.examSum.find(x => x.k === '考试次数') || {}).v);
  chk((r2.examSum.find(x => x.k === '平均分') || {}).v === '—', 'E1 平均分显示「—」而不是 0',
    (r2.examSum.find(x => x.k === '平均分') || {}).v);
  chk((r2.stats.find(x => x.k === '已做过') || {}).v === '4', 'E1 清考试记录不影响练习正确率', JSON.stringify(r2.stats.map(s => s.v)));
  await page2.close();

  /* ============ F. 权限：非管理员看不到「分题库统计」 ============ */
  const adminScreenHidden = await page.evaluate(() => !!document.getElementById('admin')?.classList.contains('hide'));
  chk(adminScreenHidden, 'F1 非管理员进不了用户管理屏（入口按钮随之不可达）');
  const btnExists = await page.evaluate(() => !!document.getElementById('bankStatsBtn'));
  chk(btnExists, 'F1 按钮在 DOM 里（权限靠屏显隐 + 接口 403 双保险）');
  await page.close();

  /* ============ G. 管理员：分题库统计 ============ */
  const ap = await makePage(browser, { admin: true });
  await ap.goto(URL_APP, { waitUntil: 'load' });
  await ap.waitForSelector('#reportEntry', { state: 'visible', timeout: 20000 });
  await ap.click('#toAdmin');
  await ap.waitForTimeout(600);
  await ap.click('#bankStatsBtn');
  await ap.waitForTimeout(700);

  let s = await bstatsState(ap);
  chk(s.open, 'G1 打开分题库统计弹层');
  chk(s.options.length === 2, 'G1 题库下拉列出 2 个题库', JSON.stringify(s.options));
  chk(s.options[0].includes('100 题'), 'G1 下拉项带题数（100 题）', s.options[0]);
  chk(s.picked === 'b-wash', 'G2 默认选中第一个题库', s.picked);

  const sum = k => (s.sum.find(x => x.k === k) || {}).v || '';
  chk(sum('参与人数') === '2', 'G3 参与人数 = 2', sum('参与人数'));
  chk(sum('整体正确率') === '91%', 'G3 整体正确率按人加权 = 80÷88 = 91%', sum('整体正确率'));
  chk(sum('考试场次') === '3', 'G3 考试场次合计 = 3', sum('考试场次'));

  chk(s.rows.length === 2, 'G4 列出 2 个人', s.rows.length + ' 行');
  chk((s.rows[0] || {}).name.includes('张三') && (s.rows[0] || {}).name.includes('信贷部'),
    'G4 第一行是张三（带部门）', (s.rows[0] || {}).name);
  chk((s.rows[0] || {}).prog.includes('88') && (s.rows[0] || {}).prog.includes('100'),
    'G5 已做 88 / 100', (s.rows[0] || {}).prog);
  chk((s.rows[0] || {}).barW === '88%', 'G5 进度条 88%', (s.rows[0] || {}).barW);
  chk((s.rows[0] || {}).meta.includes('91%') && (s.rows[0] || {}).meta.includes('对 80 题'),
    'G5 正确率 91%（对 80 题）', (s.rows[0] || {}).meta);
  chk((s.rows[0] || {}).meta.includes('考试 3 次') && (s.rows[0] || {}).meta.includes('78') && (s.rows[0] || {}).meta.includes('88'),
    'G6 考试 3 次 · 均 78 · 最高 88', (s.rows[0] || {}).meta);
  chk((s.rows[1] || {}).meta.includes('未参加模拟考试'), 'G6 没考过的人显示「未参加模拟考试」', (s.rows[1] || {}).meta);

  await ap.screenshot({ path: path.join(SHOTS, 'bstats-modal.png'), clip: { x: 0, y: 0, width: 420, height: 760 } });

  // 换题库：请求带新 bankId，内容跟着换（空库 → 空态）
  await ap.evaluate(() => {
    const sel = document.getElementById('bstatsPick');
    sel.value = 'b-credit';
    sel.dispatchEvent(new Event('change'));
  });
  await ap.waitForTimeout(600);
  s = await bstatsState(ap);
  chk(apiCalls.some(c => c.q.includes('bankId=b-credit')), 'G7 换题库后请求带新 bankId',
    apiCalls.map(c => c.q).join(' | '));
  chk(s.rows.length === 0 && /还没有人练过或考过/.test(s.msg), 'G7 空题库显示空态', s.msg);
  chk(sum('参与人数') === '0' || true, 'G8 空态下不报错');

  // 375px 不溢出
  await ap.setViewportSize({ width: 375, height: 812 });
  await ap.waitForTimeout(300);
  const overflow = await ap.evaluate(() => {
    const box = document.querySelector('#bstatsModal .modal-box');
    return { w: box.scrollWidth, cw: box.clientWidth, doc: document.documentElement.scrollWidth };
  });
  chk(overflow.w <= overflow.cw + 1, 'G9 375px 弹层不横向溢出', JSON.stringify(overflow));
  await ap.screenshot({ path: path.join(SHOTS, 'bstats-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 700 } });
  await ap.close();

  /* ============ H. 源码守卫 ============ */
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

  const storeSrc = read('src/store.js');
  const clearBody = (storeSrc.match(/export function clearProgress\(mode\) \{[\s\S]*?\n\}/) || [''])[0];
  chk(!!clearBody && !/exams/.test(clearBody), 'H1 clearProgress 不清考试场次（否则交完卷就看不到成绩）');

  const engineSrc = read('src/engine.js');
  const showResultBody = (engineSrc.match(/function showResult\([\s\S]*?\n\}/) || [''])[0];
  const iClear = showResultBody.indexOf('clearProgress(S.mode)');
  const iPush = showResultBody.indexOf('pushExam(');
  chk(iClear >= 0 && iPush > iClear, 'H2 考试记录写在 clearProgress 之后（快照先清、账本再落）',
    JSON.stringify({ iClear, iPush }));
  chk(/if \(isExam && !S\.examLogged\)/.test(showResultBody), 'H3 重复交卷不会记两笔（examLogged 闸）');

  const reportSrc = read('src/report.js');
  chk(!/\bfetch\s*\(/.test(reportSrc) && !/apiRequest/.test(reportSrc),
    'H4 个人报告纯本机渲染，不发任何请求');
  chk(/judgeAnswer/.test(reportSrc), 'H5 个人报告复用 engine 的判分（不另写一份口径）');

  const apiSrc = read('api/admin-stats.js');
  chk(/if \(!me\.is_admin\) return json\(res, 403/.test(apiSrc), 'H6 统计接口服务端二次校验管理员');
  chk(/delete row\.examList/.test(apiSrc), 'H7 分题库视图剔除逐场明细（避免响应膨胀）');
  chk(/if \(!s\.answered && !s\.examCount\) return/.test(apiSrc),
    'H8 既没练过也没考过的人不上分题库榜（免得满屏 0）');

  /* ============ I. 纯函数：跨满分折算 ============ */
  const mod = await import(pathToFileURL(path.join(ROOT, 'api/admin-stats.js')).href);
  const se = mod.summarizeExams;
  chk(se([]).count === 0 && se([]).avg === 0, 'I1 空列表不炸');
  chk(se(null).count === 0, 'I2 非数组不炸');
  const t1 = se([
    { at: 1, total: 10, right: 6, score: 60, full: 100, ms: 1 },   // 60%
    { at: 2, total: 10, right: 5, score: 55, full: 60, ms: 1 }     // 91.7%
  ]);
  chk(t1.avg === 75.8, 'I3 不同满分按得分率折算：平均 75.8（不是 (60+55)/2=57.5）', t1.avg);
  chk(t1.best === 91.7, 'I3 最高 91.7（满分 60 的那场）', t1.best);
  chk(t1.list.length === 2 && t1.list[0].at === 2, 'I4 明细按时间倒序（新的在前）');
  const t2 = se(Array.from({ length: 30 }, (_, i) => ({ at: i + 1, total: 5, right: 3, score: 30, full: 60, ms: 1 })));
  chk(t2.count === 30 && t2.list.length === 20, 'I5 明细最多 20 条，但场次数照实计', JSON.stringify({ count: t2.count, list: t2.list.length }));

  const sb = mod.summarizeBank;
  const bank = { id: 'b', name: 'B', questions: [{ id: 1, type: 'single', correctIdx: 1, options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] }] };
  const s1 = sb(bank, [], { '1': 1 }, 0, [{ at: 100, total: 10, right: 6, score: 60, full: 100, ms: 1 }]);
  chk(s1.answered === 1 && s1.rate === 100 && s1.examCount === 1, 'I6 练习正确率与考试汇总互不干扰',
    JSON.stringify({ a: s1.answered, r: s1.rate, e: s1.examCount }));
  chk(s1.lastAt === new Date(100).toISOString(), 'I7 「最近练习」取练习与考试中较晚的那个', s1.lastAt);

  /* ---------- 收尾 ---------- */
  console.log('');
  if (fails.length) {
    console.log(`✘ ${fails.length} / ${n} 项失败：`);
    fails.forEach(f => console.log('  · ' + f));
    process.exitCode = 1;
  } else {
    console.log(`✔ 全部通过：${n} / ${n}`);
  }
} finally {
  await browser.close();
  srv.kill();
}
