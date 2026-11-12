/**
 * 验收「练习选项退出后保持上次设置」。
 *
 * 用法：node scripts/check_prefs.mjs      （前置：先构建出 dist/index.html）
 *
 * 做法：file:// 打开单文件产物 → 模拟用户切换 4 个开关 → 刷新页面（等价于
 *       "退出后再次打开/登录"）→ 检查开关是否回到用户改过的状态，而不是 HTML 里的默认值。
 *
 * v2.33 起「练习选项」标题本身就是一颗折叠按钮、选项默认收起，这里一并钉住：
 *   · 标题是 <button>，默认收起（内容区不可见）；
 *   · 点一下铺开、再点收起；开关状态与折叠与否互不影响。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PW_CORE = process.env.PW_CORE
  || 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;
const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';
const FILE = pathToFileURL(path.resolve(import.meta.dirname, '..', 'dist', 'index.html')).href;

const SWITCHES = ['showAns', 'rmAll', 'rmCorrectJudge', 'revealAfter', 'showAnalysis', 'autoRemoveWrong'];
// 出厂默认（v2.18 起）：只有「选完展示正确答案」「展示解析」「答对自动移出错题集」是开着的
const HTML_DEFAULT = { showAns: false, rmAll: false, rmCorrectJudge: false, revealAfter: true, showAnalysis: true, autoRemoveWrong: true };
const readSwitches = ids => Object.fromEntries(ids.map(id => [id, document.getElementById(id).checked]));

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 375, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.goto(FILE);
await page.waitForTimeout(1200);

// ---- v2.33：练习选项 = 折叠按钮，默认收起 ----
const foldState = () => page.evaluate(() => {
  const h = document.getElementById('prefsHead');
  const b = document.getElementById('prefsBody');
  const r = b.getBoundingClientRect();
  return {
    tag: h ? h.tagName : '(缺失)',
    aria: h ? h.getAttribute('aria-expanded') : null,
    hidden: b.classList.contains('hide'),
    visible: r.height > 0 && getComputedStyle(b).display !== 'none',
    arr: (document.getElementById('prefsArr') || {}).textContent,
    on: h.classList.contains('on')
  };
});
// 此刻还在登录页（#app 是隐藏的），所以这一步只判类名/箭头/aria；
// 「真的铺开了」等首页显示出来再量（见下面 reload 之后）。
const fBrief = await foldState();
let fOpen = null, fClosed = null;

// 1) 用户手动改 4 个开关（模拟真实点击：改 checked 再派发 change）
await page.evaluate(() => {
  const toggle = id => {
    const el = document.getElementById(id);
    el.checked = !el.checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  ['showAns', 'rmAll', 'rmCorrectJudge', 'revealAfter', 'showAnalysis'].forEach(toggle);
});
await page.waitForTimeout(300);

const changed = await page.evaluate(readSwitches, SWITCHES);
// 本脚本跑的是 dist 单文件产物（DEV 钩子已被剔除，拿不到 __exam.prefsKey()），
// 所以键名直接写死：v2.16 起本机缓存按账号隔离，未登录 = credit_exam_cfg:guest
const stored = await page.evaluate(() => {
  const key = 'credit_exam_cfg:guest';
  return { key, snap: JSON.parse(localStorage.getItem(key) || 'null') };
});

// 2) 刷新页面 = 退出后再次打开/登录
await page.reload();
await page.waitForTimeout(1200);
const afterReload = await page.evaluate(readSwitches, SWITCHES);

// 3) 顺手拍一张「练习选项」区域，看提示文案与开关状态
await page.evaluate(() => {
  document.getElementById('auth').classList.add('hide');
  const app = document.getElementById('app');
  app.classList.remove('hide', 'in-practice');
  ['banks', 'practice', 'result'].forEach(s => document.getElementById(s).classList.add('hide'));
  document.getElementById('home').classList.remove('hide');
});
// 首页显出来了：现在才量「点一下铺开 / 再点收起」的真实可见性
await page.waitForTimeout(200);
const fBeforeClick = await foldState();          // reload 之后应当又是默认收起
await page.evaluate(() => document.getElementById('prefsHead').click());
await page.waitForTimeout(250);
fOpen = await foldState();
await page.evaluate(() => document.getElementById('prefsHead').click());
await page.waitForTimeout(250);
fClosed = await foldState();
await page.evaluate(() => document.getElementById('prefsHead').click());   // 截图用：保持展开
await page.waitForTimeout(200);
await page.evaluate(() => {
  const b = document.getElementById('prefsBody');
  if (b && b.classList.contains('hide')) document.getElementById('prefsHead').click();
});
await page.waitForTimeout(200);
const clip = await page.evaluate(() => {
  const sec = [...document.querySelectorAll('#home .section')].find(s => s.textContent.includes('练习选项'));
  sec.scrollIntoView({ block: 'center' });
  const r = sec.getBoundingClientRect();
  return { x: 0, y: Math.max(0, Math.round(r.top - 12)), width: 375, height: Math.round(Math.min(r.height + 24, 880)) };
});
await page.screenshot({ path: path.resolve(import.meta.dirname, '..', 'shots', 'prefs-section.png'), clip });

await browser.close();

// 3) 判定
const rows = SWITCHES.map(k => ({
  开关: k,
  页面默认值: HTML_DEFAULT[k],
  用户改后: changed[k],
  刷新后: afterReload[k],
  是否记住: changed[k] === afterReload[k] ? '✅' : '❌ 丢失'
}));
const foldRows = [
  ['标题是按钮', fBrief.tag === 'BUTTON', fBrief.tag],
  ['默认收起（内容区不可见）', fBrief.hidden && !fBrief.visible, JSON.stringify(fBrief)],
  ['默认箭头朝右 ▸ 且不高亮', fBrief.arr === '▸' && !fBrief.on, fBrief.arr + ' on=' + fBrief.on],
  ['刷新后又回到收起', fBeforeClick.hidden && !fBeforeClick.visible, JSON.stringify(fBeforeClick)],
  ['点一下铺开', !fOpen.hidden && fOpen.visible && fOpen.arr === '▾' && fOpen.on, JSON.stringify(fOpen)],
  ['再点一下收起', fClosed.hidden && !fClosed.visible && fClosed.arr === '▸' && !fClosed.on, JSON.stringify(fClosed)],
  ['aria-expanded 跟着变', fBrief.aria === 'false' && fOpen.aria === 'true' && fClosed.aria === 'false',
    fBrief.aria + ' → ' + fOpen.aria + ' → ' + fClosed.aria]
].map(([name, good, extra]) => ({ 项: name, 结果: good ? '✅' : '❌ ' + extra }));
const foldOk = foldRows.every(r => r['结果'] === '✅');

const ok = rows.every(r => r['是否记住'] === '✅') && foldOk;
const reallyRestored = SWITCHES.some(k => HTML_DEFAULT[k] !== afterReload[k]); // 确实不是"回到默认"

console.log(JSON.stringify({
  本机缓存键: stored.key,
  本地存储: stored.snap
    ? { 有updatedAt: typeof stored.snap.updatedAt === 'number', rmAll: stored.snap.rmAll, revealAfter: stored.snap.revealAfter }
    : '（无）',
  逐项: rows,
  折叠按钮: foldRows,
  结论: ok ? '✅ 退出后保持上次设置 + 折叠按钮行为正确' : '❌ 有设置未保持或折叠行为不对',
  佐证非默认值: reallyRestored ? '✅ 恢复的是用户设定，不是 HTML 默认' : '⚠️ 恰好与默认相同，判据不足',
  JS错误: errors.length ? errors : '无'
}, null, 2));
