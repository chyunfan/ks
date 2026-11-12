import { initAuth, getSession, getUsername, logout } from './auth.js';
import { initBanks, renderBanks, openBankById, invalidateBankList } from './banks.js';
import { initEngine, refreshHomeUI, syncPrefsFromCloud, resetPrefsToDefault, setBankKey, setQuestions } from './engine.js';
import { loadBankState } from './store.js';
import { initAdmin, loadMe, applyAdminEntry } from './admin.js';
import { initHzk, renderHzk, renderRecords } from './hzk.js';
import { initTyping, startTyping, resetTypingPrefs } from './typing.js';
import { clearQuestionCache } from './bankcache.js';
import { showBoot, hideBoot } from './bootmask.js';
import { initRank, setRankBank, refreshRankEntry, invalidateRank } from './rank.js';
import { initReport, setReportBank, refreshReportEntry } from './report.js';

const APP_SCREENS = ['banks', 'admin', 'home', 'practice', 'result', 'hzk', 'tprec', 'typing'];
// 这几屏算「正在练习」：顶栏「练习内容」要变灰（做题的练习页/结果页 + 打字练习屏）
const BUSY_SCREENS = ['practice', 'result', 'typing'];
// 这几屏属于「打字练习」这个练习内容：顶栏那行名字要显示「打字练习」
const TYPING_SCREENS = ['hzk', 'tprec', 'typing'];

/** 当前这份题库的名字。顶栏要显示它；进了打字练习就临时让位给「打字练习」 */
let curBankName = '';
/** 当前题库 id。做题排行要按库查，切换题库时必须跟着变 */
let curBankId = '';

const screenShown = id => {
  const el = document.getElementById(id);
  return !!el && !el.classList.contains('hide');
};

/**
 * 顶栏「练习内容」的可用状态与显示名字。
 * 练习屏里不同题库的题号会重复（都是 1、2、3…），这时候换库，回来点「继续练习」
 * 会拿新库的题去对旧库的快照 —— 题就对不上了。所以只在这些屏里变灰，别的时候正常可点。
 */
function syncBankSwitchState() {
  // 名字：在打字练习那几屏显示「打字练习」，别让顶栏还挂着上次那份题库名
  const nameEl = document.getElementById('topBankName');
  if (nameEl) nameEl.textContent = TYPING_SCREENS.some(screenShown) ? '打字练习' : (curBankName || '—');

  const sw = document.getElementById('bankSwitch');
  if (!sw) return;
  const busy = BUSY_SCREENS.some(screenShown);
  sw.classList.toggle('busy', busy);
  sw.setAttribute('aria-disabled', busy ? 'true' : 'false');
  sw.title = busy ? '练习中不能切换，请先退出练习' : '点击切换练习内容';
}

/**
 * 练习屏是 engine 自己切 DOM 的（不走 showScreen），所以在这里盯住它们的 class 变化再同步。
 * 不这么接一下的话，进了练习页顶栏还是「可点」的样子 —— 与内部守卫（banks.js 的 busyPracticing）不一致。
 */
function watchPracticeScreens() {
  const ob = new MutationObserver(syncBankSwitchState);
  BUSY_SCREENS.forEach(id => {
    const el = document.getElementById(id);
    if (el) ob.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  syncBankSwitchState();
}

/**
 * 回到首页时刷一次排行入口的副标题：练完题回来「我已做 N 题」得跟着变，
 * 否则会一直停在上次进首页时的数字。首页显隐也是直接切 class，所以同样盯属性。
 */
function watchHome() {
  const el = document.getElementById('home');
  if (!el) return;
  new MutationObserver(() => {
    if (el.classList.contains('hide')) return;
    // 练完一轮回到首页：刚做的题要能立刻反映在榜上，所以顺手作废排行缓存
    invalidateRank();
    refreshRankEntry();
    refreshReportEntry();    // 个人报告的「已做 / 正确率」也刚变过
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
}

function showScreen(name) {
  if (name === 'auth') {
    document.getElementById('auth').classList.remove('hide');
    document.getElementById('app').classList.add('hide');
    return;
  }
  document.getElementById('auth').classList.add('hide');
  const app = document.getElementById('app');
  app.classList.remove('hide');
  // 练习中（做题的练习/结果页、打字屏）给 app 打标记：手机端会收起顶部应用栏，把屏幕留给题目
  app.classList.toggle('in-practice', BUSY_SCREENS.indexOf(name) >= 0);
  APP_SCREENS.forEach(s => {
    document.getElementById(s).classList.toggle('hide', s !== name);
  });
  syncBankSwitchState();
}

function showBanks() {
  document.getElementById('topUser').textContent = getUsername() || '已登录';
  renderBanks();
  showScreen('banks');
}

async function handleOpenBank({ id, name, questions }) {
  try { localStorage.setItem('ce_current_bank', JSON.stringify({ id, name })); } catch (e) {}
  // 错题/收藏/进度 与 练习设置 分属两张表、互不依赖 —— 并行拉，省掉一个往返。
  // 但两者都必须在 refreshHomeUI() 之前到位：计数要用前者，applySettings() 会重置模式（后者）。
  const stateP = loadBankState(id, true);
  const prefsP = syncPrefsFromCloud().catch(() => {});
  await stateP;          // 先等该题库的错题/收藏/进度，避免首页计数与续做横幅用到旧题库的数据
  setQuestions(questions);
  setBankKey(id);        // 切换题库 → 带出该题库自己的组卷配置（没存过则给标准配置）
  curBankName = name;    // 顶栏那行名字由 syncBankSwitchState 统一写，这里只记下是哪一份
  curBankId = id;        // 排行按库查：换库必须换 id，否则会看到上一份库的榜单
  // 排行入口的副标题要用本机已做量：必须在 loadBankState 之后调（那时累计账本才到位）
  setRankBank(id, name);
  setReportBank(id, name);   // 个人报告同样按库：换库要关掉旧弹层、重算副标题
  document.getElementById('topUser').textContent = getUsername() || '已登录';
  showScreen('home');
  await prefsP;          // 登录后按账号恢复上次的练习设置（练习选项/模式/组卷参数）
  refreshHomeUI();
  refreshRankEntry();    // 练习设置回来后可能改了模式，但「已做量」和答案无关，这里只是兜一次
}

function enterApp() {
  // 先拿到「我是谁、是不是管理员」，再渲染题库列表（列表里的按钮按权限显示）
  return refreshIdentity().then(showBanks);
}

/** 拉取身份资料 → 刷新顶部栏入口与用户名 */
async function refreshIdentity() {
  await loadMe();
  applyAdminEntry();
  const el = document.getElementById('topUser');
  if (el) el.textContent = getUsername() || '已登录';
}

function doLogout() {
  logout();
  try { localStorage.removeItem('ce_current_bank'); } catch (e) {}
  curBankName = '';        // 换账号后顶栏不该还留着上一个人的练习内容名
  curBankId = '';
  setRankBank('', '');     // 排行的「我已做」是按账号算的，换人必须清
  setReportBank('', '');   // 个人报告同理：不能把上一个人的正确率留给下一个人看
  invalidateRank();
  resetPrefsToDefault();   // 练习设置收回出厂默认：换账号登录时不该继承上一个人的选项
  resetTypingPrefs();      // 打字练习的本机参数同理
  invalidateBankList();    // 列表缓存里有按账号算出来的「我上传的」，换人必须作废
  clearQuestionCache();    // 别把上一个账号看过的题库留在内存里
  showScreen('auth');
}

/* ---------- 打字练习（字库 → 练习 → 记录） ---------- */
// 既是顶栏「打字练习」按钮的去处，也是下拉「练习内容 → 打字练习」的去处
async function showHzk() {
  document.getElementById('topUser').textContent = getUsername() || '已登录';
  showScreen('hzk');
  await renderHzk();
}

async function showRecords() {
  showScreen('tprec');
  await renderRecords();
}

async function openHzkForTyping(hzk) {
  // 先进屏再装载：引擎要按容器真实宽度算单字宽度（逐字对齐靠它）
  showScreen('typing');
  startTyping(hzk);
}

async function boot() {
  initAuth({ onLogin: enterApp });
  // onOpenTyping：「练习内容」下拉里选中「打字练习」时跳哪去
  initBanks({ onOpenBank: handleOpenBank, onOpenTyping: showHzk });
  initEngine();
  initAdmin({
    onBack: showBanks,
    onShow: () => showScreen('admin'),
    onMeChange: () => { renderBanks({ force: true }); }   // 身份(管理员)变了，行内按钮要按新权限重画
  });
  initHzk({ onStartTyping: openHzkForTyping });
  initTyping({ onExit: showHzk });
  // 做题排行：入口在首页，按「当前题库」查
  initRank({ getBank: () => ({ id: curBankId, name: curBankName }) });
  // 我的报告：纯本机数据（累计作答 + 考试场次），不发请求
  initReport({ getBank: () => ({ id: curBankId, name: curBankName }) });

  document.getElementById('toBanks').addEventListener('click', showBanks);
  document.getElementById('toTyping').addEventListener('click', showHzk);
  document.getElementById('toRecords').addEventListener('click', showRecords);
  document.getElementById('tprecBack').addEventListener('click', showHzk);
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  watchPracticeScreens();   // 练习屏由 engine 自己切，顶栏状态靠盯 class 变化来同步
  watchHome();              // 回首页时刷新排行与报告的入口副标题

  if (getSession()) {
    // 这一屏原本是纯白的：要把题库拉回来才知道进哪一屏。遮罩延迟 150ms 淡入，快就不闪。
    showBoot('正在加载题库…');
    try {
      const identP = refreshIdentity();      // /api/me：我是谁、是不是管理员
      const saved = (() => { try { return JSON.parse(localStorage.getItem('ce_current_bank') || 'null'); } catch { return null; } })();
      if (saved && saved.id) {
        // 身份资料与题库数据互不依赖（RLS 用的是 localStorage 里已有的令牌），
        // 串起来就是白等一个往返 → 并行。openBankById 内部会 await handleOpenBank 完成首页渲染。
        const [ok] = await Promise.all([openBankById(saved.id), identP]);
        if (ok) {
          // 身份晚到时首页可能已经画过一遍按钮，这里补刷一次（纯 DOM，不发请求）
          refreshHomeUI();
          return;
        }
      } else {
        await identP;
      }
      showBanks();
    } finally {
      hideBoot();
    }
  } else {
    showScreen('auth');
    hideBoot();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
