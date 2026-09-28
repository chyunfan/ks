import { initAuth, getSession, getUsername, logout } from './auth.js';
import { initBanks, renderBanks, openBankById } from './banks.js';
import { initEngine, refreshHomeUI, syncPrefsFromCloud, resetPrefsToDefault, setBankKey, setQuestions } from './engine.js';
import { loadBankState } from './store.js';
import { initAdmin, loadMe, applyAdminEntry } from './admin.js';
import { initHzk, renderHzk, renderRecords } from './hzk.js';
import { initTyping, startTyping, resetTypingPrefs } from './typing.js';

const APP_SCREENS = ['banks', 'admin', 'home', 'practice', 'result', 'hzk', 'tprec', 'typing'];
// 这几屏算「正在练习」：顶栏「练习内容」要变灰（做题的练习页/结果页 + 打字练习屏）
const BUSY_SCREENS = ['practice', 'result', 'typing'];
// 这几屏属于「打字练习」这个练习内容：顶栏那行名字要显示「打字练习」
const TYPING_SCREENS = ['hzk', 'tprec', 'typing'];

/** 当前这份题库的名字。顶栏要显示它；进了打字练习就临时让位给「打字练习」 */
let curBankName = '';

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
  // 先等该题库的错题/收藏/进度加载完成，再渲染首页，避免计数与续做横幅用到旧题库的数据
  await loadBankState(id, true);
  setQuestions(questions);
  setBankKey(id);        // 切换题库 → 带出该题库自己的组卷配置（没存过则给标准配置）
  curBankName = name;    // 顶栏那行名字由 syncBankSwitchState 统一写，这里只记下是哪一份
  document.getElementById('topUser').textContent = getUsername() || '已登录';
  showScreen('home');
  // 登录后按账号恢复上次的练习设置（练习选项/模式/组卷参数）；拉取失败不影响使用
  await syncPrefsFromCloud();
  refreshHomeUI();
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
  resetPrefsToDefault();   // 练习设置收回出厂默认：换账号登录时不该继承上一个人的选项
  resetTypingPrefs();      // 打字练习的本机参数同理
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
    onMeChange: () => { renderBanks(); }
  });
  initHzk({ onStartTyping: openHzkForTyping });
  initTyping({ onExit: showHzk });

  document.getElementById('toBanks').addEventListener('click', showBanks);
  document.getElementById('toTyping').addEventListener('click', showHzk);
  document.getElementById('toRecords').addEventListener('click', showRecords);
  document.getElementById('tprecBack').addEventListener('click', showHzk);
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  watchPracticeScreens();   // 练习屏由 engine 自己切，顶栏状态靠盯 class 变化来同步

  if (getSession()) {
    await refreshIdentity();   // 管理员入口的显隐取决于这一步
    const saved = (() => { try { return JSON.parse(localStorage.getItem('ce_current_bank') || 'null'); } catch { return null; } })();
    if (saved && saved.id) {
      // openBankById 内部会 await handleOpenBank：加载该题库状态并渲染首页
      const ok = await openBankById(saved.id);
      if (ok) return;
    }
    showBanks();
  } else {
    showScreen('auth');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
