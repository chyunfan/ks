import { apiRequest } from './admin.js';
import { answeredCount } from './store.js';

// ============================================================
// 做题排行（用户选定题库后，看本库的「做题数排名」）
// ------------------------------------------------------------
// 数据来自 /api/bank-rank（服务端用 service_role 聚合，客户端拿不到别人的进度行）：
//   · 只能看**自己有权限访问**的题库，服务端会再判一次可见范围；
//   · 榜上只有「做过题的人」，下发的是账号名 + 聚合数字，没有 user_id、没有答案。
//
// 为什么需要它单开一个接口：exam_bank_progress 的 RLS 是「只看自己的」，
// 前端根本读不到别人的进度 —— 排行榜必须由服务端代算。
// ============================================================

const TTL = 30 * 1000;        // 排行缓存 30 秒：连点几次不会重复打请求，刚做完题也能很快看到变化
const LIMIT = 20;             // 榜上最多列多少人

let getBank = () => ({ id: '', name: '' });
let curBank = { id: '', name: '' };
let cache = new Map();        // bankId -> { at, data }
let seq = 0;                  // 请求序号：切库/重开弹层时别让旧响应盖回去

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 正确率配色，与管理员「做题情况」一致：≥80 绿 / ≥60 橙 / 其余红 */
function rateCls(rate, n) {
  if (!n) return 'muted';
  if (rate >= 80) return 'rate-good';
  if (rate >= 60) return 'rate-mid';
  return 'rate-bad';
}

export function initRank(cb) {
  if (cb && typeof cb.getBank === 'function') getBank = cb.getBank;

  $('rankEntry').addEventListener('click', openRank);
  $('rankClose').addEventListener('click', closeRank);
  $('rankMask').addEventListener('click', closeRank);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRank(); });

  refreshRankEntry();
}

/** 切换题库时调用（幂等）：换库要关掉旧弹层，并刷新入口的副标题 */
export function setRankBank(id, name) {
  const next = { id: id || '', name: name || '' };
  if (curBank.id && curBank.id !== next.id) closeRank();
  curBank = next;
  refreshRankEntry();
}

/** 入口副标题：本机看得到自己做了多少题（权威数字以服务端为准） */
export function refreshRankEntry() {
  const hint = $('rankHint');
  if (!hint) return;
  const n = answeredCount();
  hint.textContent = n
    ? '我已做 ' + n + ' 题 · 点开看看排第几'
    : '你还没做过本库，做完一题就会上榜';
}

/** 作废缓存（交卷、换账号时用） */
export function invalidateRank() {
  cache = new Map();
}

function closeRank() {
  const m = $('rankModal');
  if (!m || m.classList.contains('hide')) return;
  m.classList.add('hide');
  seq++;                      // 让在途请求的响应失效，别把内容写进已关闭的弹层
}

async function openRank() {
  const bank = getBank() || {};
  const bankId = bank.id || curBank.id;
  if (!bankId) return;
  if (bank.name) curBank = { id: bankId, name: bank.name };

  const mySeq = ++seq;
  $('rankModal').classList.remove('hide');
  $('rankBankName').textContent = curBank.name || '—';
  $('rankSum').innerHTML = '';
  $('rankList').innerHTML = '<div class="muted rank-msg">正在读取排行…</div>';
  $('rankTip').classList.add('hide');

  try {
    const d = await fetchRank(bankId);
    if (mySeq !== seq) return;
    renderRank(d);
  } catch (e) {
    if (mySeq !== seq) return;
    $('rankList').innerHTML = '<div class="muted rank-msg">读取失败：' + esc(e && e.message || '未知错误') + '</div>';
  }
}

async function fetchRank(bankId) {
  const hit = cache.get(bankId);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const d = await apiRequest('GET', '/api/bank-rank?bankId=' + encodeURIComponent(bankId) + '&limit=' + LIMIT);
  cache.set(bankId, { at: Date.now(), data: d });
  return d;
}

function renderRank(d) {
  const total = (d.bank && d.bank.total) || 0;
  const me = d.me || null;
  const count = d.count || 0;

  $('rankSum').innerHTML =
    '<div class="rs"><b>' + count + '</b><span>参与人数</span></div>' +
    '<div class="rs"><b>' + (me ? '第 ' + me.rank + ' 名' : '未上榜') + '</b><span>我的名次</span></div>' +
    '<div class="rs"><b>' + (me ? me.answered + ' / ' + total : '—') + '</b><span>我已做</span></div>';

  const list = d.list || [];
  if (!list.length) {
    $('rankList').innerHTML = '<div class="muted rank-msg">这个题库还没有人做过题 —— 做完第一题就会出现在榜上。</div>';
    $('rankTip').classList.remove('hide');
    return;
  }

  const medal = r => r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : String(r.rank);

  const row = r => {
    const cov = Math.max(0, Math.min(100, r.coverage || 0));
    return '<div class="rank-row' + (r.mine ? ' me' : '') + '">' +
      '<div class="rank-no r' + Math.min(r.rank, 4) + '">' + medal(r) + '</div>' +
      '<div class="rank-mid">' +
        '<div class="rank-name">' + esc(r.username) +
          (r.mine ? '<span class="rank-tag">我</span>' : '') + '</div>' +
        '<div class="rank-bar"><i style="width:' + cov + '%"></i></div>' +
      '</div>' +
      '<div class="rank-val"><b>' + r.answered + '</b><span class="rank-total"> / ' + total + '</span>' +
        '<span class="rank-rate ' + rateCls(r.rate, r.answered) + '">' + r.rate + '%</span></div>' +
    '</div>';
  };

  let html = list.map(row).join('');
  // 我不在前 N 名时，单独把我的名次接在末尾 —— 否则用户只看到一堆别人，不知道自己第几
  if (me && !list.some(x => x.mine)) {
    html += '<div class="rank-sep">…</div>' + row(me);
  }
  $('rankList').innerHTML = html;
  $('rankTip').classList.remove('hide');
}

// 本地开发调试钩子（生产构建会被剔除），供 scripts/check_rank.mjs 验收
if (import.meta.env.DEV) {
  window.__rank = { open: openRank, close: closeRank, invalidate: invalidateRank, cacheSize: () => cache.size };
}
