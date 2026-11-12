/**
 * 结果页「答错」个数的验收。
 *
 * 背景（用户截图反馈）：顺序练习做完 177 题、答对 170，结果页第 3 格「答错」却显示 **0**。
 *
 * 根因：finishSequential() 里把「答错」写成了 S.pool.length − answered，
 *   而 answered 数的是「一个字没写的题」。全做完时未答恒为 0 → 答错永远是 0。
 * 修法：答错 = 总题数 − 答对（含「答了但错」与「跳过去没答」，口径与下方错题清单、错题集一致）。
 *
 * 所以本脚本不只验证「有个非 0 数字」，而是把四种情形都过一遍，并卡住三条硬约束：
 *   · 三格守恒：总题数 = 答对 + 答错
 *   · 答错数 = 结果页「错题清单」条目数（点「查看错题」后数出来的）
 *   · 答错数 = 错题集新增的题目数（关掉「答对自动移出」后按增量比对）
 *
 * 同 check_time：起本地 vite dev server，借 DEV 钩子注入假题，全程真实 UI 点击。
 * 用法：node scripts/check_wrongstat.mjs
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
const PORT = 5236;
const URL_APP = `http://localhost:${PORT}/ks/`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());
await page.goto(URL_APP);
await page.waitForTimeout(1000);

// 6 题：3 单选 + 2 判断 + 1 多选。正确答案依次 = 1 / 1 / [0,2] / 0 / 0 / 2
const FAKE = [
  { id: 901, type: 'single', stem: '统计验收 1：1+1=?', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'C', text: '3' }], answerKeys: ['B'], answerText: 'B', correctIdx: 1, analysis: null },
  { id: 902, type: 'judge', stem: '统计验收 2：2+2=5。', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerKeys: ['B'], answerText: '错误', correctIdx: [1], analysis: null },
  { id: 903, type: 'multiple', stem: '统计验收 3：以下哪些是偶数？', options: [{ key: 'A', text: '2' }, { key: 'B', text: '3' }, { key: 'C', text: '4' }], answerKeys: ['A', 'C'], answerText: 'A、C', correctIdx: [0, 2], analysis: null },
  { id: 904, type: 'single', stem: '统计验收 4：3×3=?', options: [{ key: 'A', text: '9' }, { key: 'B', text: '6' }], answerKeys: ['A'], answerText: 'A', correctIdx: 0, analysis: null },
  { id: 905, type: 'judge', stem: '统计验收 5：地球是圆的。', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answerKeys: ['A'], answerText: '正确', correctIdx: [0], analysis: null },
  { id: 906, type: 'single', stem: '统计验收 6：5+5=?', options: [{ key: 'A', text: '8' }, { key: 'B', text: '9' }, { key: 'C', text: '10' }], answerKeys: ['C'], answerText: 'C', correctIdx: 2, analysis: null }
];
const TOTAL = FAKE.length;

/** 回到首页并洗掉本轮进度；顺带把练习设置固定成本脚本需要的样子 */
async function resetHome(opts = {}) {
  await page.evaluate(async ({ fake, mode }) => {
    const mc = document.querySelector('.mode[data-mode="' + mode + '"]');
    if (mc && !mc.classList.contains('active')) mc.click();
    await window.__store.clearProgress(mode);
    window.__exam.setQuestions(fake);
    window.__exam.initEngine();
    // ⚠ 必须排在 initEngine 之后：initEngine 内部 loadSettings() 会拿本机缓存再 apply 一次，
    //   先设后读的话这几行会被缓存覆盖回去。
    // ⚠ mode 一定要带上：applySettings 第一行就是 S.mode = c.mode || 'sequential'，
    //   漏传会把模式悄悄打回顺序练习（页面高亮在「错题练习」、实际统计的却是顺序练习）。
    // 关掉「选完回显 / 判对题剔除 / 全选题剔除 / 答对自动移出错题集」：
    //   否则题池会被过滤、错题集增量会被自动清理，干扰统计口径的比对。
    window.__exam.applySettings({
      mode,
      showAns: false, rmAll: false, rmCorrectJudge: false,
      revealAfter: false, showAnalysis: false, autoRemoveWrong: false
    });
    document.getElementById('auth').classList.add('hide');
    document.getElementById('app').classList.remove('hide');
    document.getElementById('topBankName').textContent = '统计验收库';
    for (const s of ['banks', 'home', 'practice', 'result']) {
      document.getElementById(s).classList.toggle('hide', s !== 'home');
    }
    window.__exam.refreshHomeUI();
  }, { fake: FAKE, mode: opts.mode || 'sequential' });
  await page.waitForTimeout(180);
}

/** 结果页读数（全部在 page.evaluate 里取，Node 侧不碰 document） */
const stats = () => page.evaluate(() => {
  const num = id => Number((document.getElementById(id).textContent || '').trim());
  return {
    shown: !document.getElementById('result').classList.contains('hide'),
    total: num('stTotal'), right: num('stRight'), wrong: num('stWrong'),
    sub: document.getElementById('resSub').textContent.trim(),
    score: document.getElementById('resScore').textContent.trim(),
    title: document.getElementById('resTitle').textContent.trim(),
    listItems: document.querySelectorAll('#wrongList .wl-item').length,
    listHidden: document.getElementById('wrongWrap').classList.contains('hide'),
    wrongCnt: Number((document.getElementById('wrongCnt').textContent || '0').trim()),
    scrollW: document.documentElement.scrollWidth,
    viewW: document.documentElement.clientWidth
  };
});

const curType = () => page.evaluate(() => {
  const S = window.__exam.S, q = S.pool[S.idx];
  return q ? (q.isCase ? 'case' : q.type) : null;
});

/**
 * 按计划一路答到最后一题并完成。
 * plan[k] = 该题要点的选项下标数组；null = 一个字不点、直接跳过去（多选题不能用 null，会弹「请先选择」）。
 */
async function playAll(plan) {
  for (let k = 0; k < plan.length; k++) {
    const type = await curType();
    const picks = plan[k];
    if (picks) {
      for (const i of picks) {
        await page.click('#opts .opt[data-i="' + i + '"]');
        await page.waitForTimeout(45);
      }
    }
    if (type === 'multiple') {
      // 多选题：第一下是「确定」（核对），第二下才是「下一题 / 完成」
      await page.click('#nextBtn');
      await page.waitForTimeout(90);
    }
    await page.click('#nextBtn');            // 最后一题 → 「完成」→ finishSequential
    await page.waitForTimeout(120);
  }
}

/** 一路点到最后一题并交卷（后面的题一个字不答），用于「未答也算不对」的场景 */
async function finishRemaining() {
  for (let g = 0; g < 30; g++) {
    const fin = await page.evaluate(() => window.__exam.S.finished);
    if (fin) return true;
    await page.click('#nextBtn');
    await page.waitForTimeout(100);
  }
  return await page.evaluate(() => window.__exam.S.finished);
}

const fails = [];
let n = 0;
const chk = (cond, name, extra) => { n++; if (!cond) fails.push(`T${n} ${name}${extra ? ' → ' + extra : ''}`); };

/* ============ A. 全部答对 → 答错必须是 0 ============ */
await resetHome();
await page.click('#startBtn');
await page.waitForTimeout(250);
await playAll([[1], [1], [0, 2], [0], [0], [2]]);
let r = await stats();
chk(r.shown, 'A1 答题结束进入结果页', JSON.stringify({ shown: r.shown }));
chk(r.total === TOTAL && r.right === TOTAL, 'A1 全对：总题数/答对都是 6', JSON.stringify({ total: r.total, right: r.right }));
chk(r.wrong === 0, 'A1 全对：答错 = 0', 'wrong=' + r.wrong);
chk(r.wrong === r.total - r.right, 'A1 三格守恒：总题数 = 答对 + 答错', `${r.total} vs ${r.right}+${r.wrong}`);
await page.screenshot({ path: path.join(SHOTS, 'wrongstat-all-correct.png'), clip: { x: 0, y: 0, width: 420, height: 560 } });

/* ============ B. 错 2 题（答了但错 / 多选漏选）→ 答错必须是 2 ============ */
await resetHome();
const beforeB = await page.evaluate(() => {
  window.__exam.refreshHomeUI();          // 先把首页计数刷成当前真值，再做增量比对
  return Number(document.getElementById('wrongCnt').textContent.trim());
});
await page.click('#startBtn');
await page.waitForTimeout(250);
// 题1 选 A（错）；题3 多选只选一个（漏选=错）；其余全对 → 对 4 错 2
await playAll([[0], [1], [0], [0], [0], [2]]);
r = await stats();
chk(r.right === 4 && r.wrong === 2, 'B1 错 2 题：答对 4 / 答错 2（旧版这里恒为 0）', JSON.stringify({ right: r.right, wrong: r.wrong }));
chk(r.wrong === r.total - r.right, 'B1 三格守恒', `${r.total} vs ${r.right}+${r.wrong}`);
chk(r.sub.indexOf('4 / 6') >= 0, 'B1 副标题与答对数一致（4 / 6 正确）', r.sub);
chk(r.score === '4', 'B1 大数字仍显示答对数', r.score);
chk(r.listHidden, 'B2 错题清单默认收起（还没点「查看错题」）', 'hidden=' + r.listHidden);
await page.click('#reviewWrong');
await page.waitForTimeout(150);
const expanded = await stats();
chk(!expanded.listHidden, 'B2 点「查看错题」后清单展开', 'hidden=' + expanded.listHidden);
chk(expanded.listItems === r.wrong, 'B2 清单条目数 = 答错数（3 处口径同源）', `${expanded.listItems} vs ${r.wrong}`);
const bList = await page.evaluate(() => [...document.querySelectorAll('#wrongList .wl-item .q')].map(e => e.textContent.trim()));
chk(bList.length === 2 && /验收 1/.test(bList[0]) && /验收 3/.test(bList[1]),
  'B2 清单里正是那两道做错的题（第 1 题答错 + 第 3 题多选漏选）', JSON.stringify(bList));
await page.screenshot({ path: path.join(SHOTS, 'wrongstat-2-wrong.png'), clip: { x: 0, y: 0, width: 420, height: 900 } });
// 结果页不会去刷新首页的错题集计数，回首页再看（真实路径：点「再来一次」）
await page.evaluate(() => document.getElementById('againBtn').click());
await page.waitForTimeout(250);
const homeWrong = await page.evaluate(() => {
  window.__exam.refreshHomeUI();
  return Number(document.getElementById('wrongCnt').textContent.trim());
});
chk(homeWrong - beforeB === 2, 'B3 答错数 = 错题集新增条目数（关掉自动移出后应为 2 条）', `before=${beforeB} after=${homeWrong}`);

/* ============ C. 跳过没答的题也算「不对」→ 答错 = 1 ============ */
await resetHome();
await page.click('#startBtn');
await page.waitForTimeout(250);
// 第 4 题（单选）一个字不点直接跳过；其余全对 → 对 5 错 1
await playAll([[1], [1], [0, 2], null, [0], [2]]);
r = await stats();
chk(r.right === 5 && r.wrong === 1, 'C1 跳过 1 题：答对 5 / 答错 1（跳过的按没做对计）', JSON.stringify({ right: r.right, wrong: r.wrong }));
chk(r.wrong === r.total - r.right, 'C1 三格守恒', `${r.total} vs ${r.right}+${r.wrong}`);
await page.click('#reviewWrong');
await page.waitForTimeout(150);
const cList = await page.evaluate(() => [...document.querySelectorAll('#wrongList .wl-item .q')].map(e => e.textContent.trim()));
chk(cList.length === 1 && /统计验收 4/.test(cList[0] || ''), 'C2 错题清单里就是那道被跳过的第 4 题（口径与答错数同源）', JSON.stringify(cList));

/* ============ D. 一题没对 → 答错 = 总题数（不能出现「0 / 全错」的矛盾） ============ */
await resetHome();
await page.click('#startBtn');
await page.waitForTimeout(250);
// 六题全部答错（多选题只勾一个 = 漏选，同样是错）
await playAll([[0], [0], [0], [1], [1], [0]]);
r = await stats();
chk(r.right === 0 && r.wrong === TOTAL, 'D1 全错：答对 0 / 答错 = 总题数 6', JSON.stringify({ right: r.right, wrong: r.wrong }));
chk(r.sub.indexOf('0 / 6') >= 0, 'D1 副标题 0 / 6 正确', r.sub);
chk(r.wrong !== 0, 'D1 答错不是 0（旧 bug 的正面反例）', 'wrong=' + r.wrong);

/* ============ E. 判对题被剔除时，答错按「实际池子」算 ============ */
await resetHome();
await page.evaluate(() => {
  // 打开「去除正确的判断题」：判断题 902（答案=错误）保留，905（答案=正确）应被剔除 → 池子剩 5 题
  // 同样必须排在 initEngine 之后，否则被本机缓存覆盖
  window.__exam.applySettings({ rmCorrectJudge: true, revealAfter: false, showAns: false, autoRemoveWrong: false });
});
await page.waitForTimeout(150);
await page.click('#startBtn');
await page.waitForTimeout(250);
const liveTotal = await page.evaluate(() => window.__exam.S.pool.length);
await playAll([[0], [1], [0]]);        // 前 3 题：错 / 对 / 多选漏选错 → 对 1 错 2
await finishRemaining();                // 剩下 2 题一个字不答 → 也算不对
r = await stats();
chk(liveTotal === 5, 'E1 判对题被剔除后，实际池子剩 5 题', 'live=' + liveTotal);
chk(r.total === liveTotal, 'E1 结果页「总题数」跟实际池子一致', `shown=${r.total} live=${liveTotal}`);
chk(r.right === 1 && r.wrong === 4, 'E1 对 1 错 4（2 题答错 + 2 题未答）', JSON.stringify({ right: r.right, wrong: r.wrong }));
chk(r.wrong === r.total - r.right, 'E1 池子被过滤后三格仍守恒', `${r.total} vs ${r.right}+${r.wrong}`);

/* ============ F. 375px 窄屏：4 格 2×2、无溢出、答错数字看得见 ============ */
await page.setViewportSize({ width: 375, height: 812 });
await resetHome();
await page.click('#startBtn');
await page.waitForTimeout(250);
await playAll([[0], [1], [0, 2], [0], [0], [2]]);   // 错 1 题 → 答错 1
r = await stats();
const geom = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('#result .stat')];
  const ys = cells.map(c => Math.round(c.getBoundingClientRect().top));
  const w = document.getElementById('stWrong');
  return {
    rows: new Set(ys).size, perRow: ys.filter(y => y === ys[0]).length,
    wText: w.textContent.trim(), visible: w.getBoundingClientRect().width > 0 && w.getBoundingClientRect().height > 0
  };
});
chk(r.wrong === 1, 'F1 375px 宽：答错 = 1（窄屏不影响统计）', 'wrong=' + r.wrong);
chk(r.scrollW <= r.viewW, 'F1 375px 宽：结果页无横向溢出', `${r.scrollW} > ${r.viewW}`);
chk(geom.rows === 2 && geom.perRow === 2, 'F1 375px 宽：4 格仍是 2×2', JSON.stringify(geom));
chk(geom.visible && geom.wText === '1', 'F1 375px 宽：「答错」那格数字正常显示', JSON.stringify(geom));
await page.screenshot({ path: path.join(SHOTS, 'wrongstat-mobile.png'), clip: { x: 0, y: 0, width: 375, height: 620 } });
await page.setViewportSize({ width: 420, height: 900 });

/* ============ G. 错题练习模式：标题要说对，统计口径不变 ============ */
// 错题练习/收藏练习走的是同一个 finishSequential：标题过去写死成「顺序练习完成」，驴唇不对马嘴
await resetHome({ mode: 'wrong' });
const wrongPoolLen = await page.evaluate(() => window.__exam.S.pool.length);
chk(wrongPoolLen > 0, 'G1 错题集已有题目（前面几轮写进去的错题）', 'len=' + wrongPoolLen);
if (wrongPoolLen > 0) {
  await page.evaluate(() => document.getElementById('startBtn').click());
  await page.waitForTimeout(250);
  const liveLen = await page.evaluate(() => window.__exam.S.pool.length);
  await playAll(Array.from({ length: liveLen }, () => [0]));   // 每题都选第一个选项（保证每题都作答，不会弹「请先选择」）
  r = await stats();
  chk(r.title === '错题练习完成', 'G1 错题练习的结果页标题是「错题练习完成」（不再是顺序练习）', r.title);
  chk(r.wrong === r.total - r.right, 'G1 错题练习也满足三格守恒', `${r.total} vs ${r.right}+${r.wrong}`);
  chk(r.total === liveLen, 'G1 总题数 = 错题练习的实际题量', `${r.total} vs ${liveLen}`);
}

/* ============ H. 静态核对 ============ */
const eng = fs.readFileSync(path.join(ROOT, 'src/engine.js'), 'utf8');
const seq = /function finishSequential\(\)[\s\S]*?\n\}/.exec(eng);
chk(!!seq, 'H1 找得到 finishSequential()', '');
if (seq) {
  chk(/const wrong = S\.pool\.length - right;/.test(seq[0]),
    'H1 finishSequential 里答错 = 总题数 − 答对', seq[0].split('\n').filter(l => /wrong/.test(l))[0] || '');
  chk(!/pool\.length - answered/.test(seq[0]),
    'H1 旧写法（pool.length − answered，只数「没作答」）已删除', '');
  chk(!/answered\+\+/.test(seq[0]), 'H1 用来数「没作答」的 answered 累加已彻底移除（注释里的说明不算）', '');
  chk(/MODE_NAME\[S\.mode\][\s\S]{0,40}完成/.test(seq[0]),
    'H1 结果页标题按当前模式取（错题/收藏练习不再冒充「顺序练习完成」）', '');
}
const exam = /function finishExam\([\s\S]*?\n\}/.exec(eng);
chk(!!exam && /const total = S\.pool\.length, wrong = total - right;/.test(exam[0]),
  'H2 考试模式本来就是「总 − 对」，两种模式口径已一致', exam ? exam[0].split('\n').filter(l => /wrong =/.test(l))[0] : '');
chk(jsErrors.length === 0, 'H3 全程无 JS 报错', jsErrors.join(' | '));

await browser.close();
srv.kill();

console.log(`\n答错统计：${n - fails.length} / ${n} 通过`);
if (fails.length) {
  console.log('未通过：');
  fails.forEach(f => console.log('   · ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过（截图见 shots/wrongstat-*.png）');
}
