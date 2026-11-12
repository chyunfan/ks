/**
 * 题库数据的内存缓存（v2.29）
 *
 * 为什么单独一个模块：banks.js 已经 import qedit.js，qedit.js 保存后也要让缓存失效。
 * 两边互相 import 会成环，所以把缓存本身抽出来，谁需要谁 import 它。
 *
 * 两个缓存分开管，因为它们的失效时机不一样：
 *   · 列表元数据（banks.js 内部持有）：改名 / 删库 / 改可见范围 → 失效
 *   · 题目内容（这里）：编辑题目保存 → 失效
 *
 * TTL 不是"数据会过期"，而是"太久没碰就重新取一次"，兜住那些没接失效回调的写入路径。
 * 数据量不小（一个题库的题目可能几百 KB），所以必须设个上限，别让它无限长大。
 */

import { delCachedQuestions } from './idbcache.js';

const QUESTION_TTL = 5 * 60 * 1000;     // 5 分钟
const MAX_BANKS = 4;                    // 最多缓存几个题库的题目（一个题库动辄几百 KB）

/** @type {Map<string, {questions:Array, at:number, hits:number}>} */
const qCache = new Map();

/** 取题目；未命中或已过期返回 null。命中的会移到队尾（近似 LRU）。 */
export function getQuestions(id) {
  if (!id) return null;
  const hit = qCache.get(String(id));
  if (!hit) return null;
  if (Date.now() - hit.at > QUESTION_TTL) {
    qCache.delete(String(id));
    return null;
  }
  hit.hits++;
  qCache.delete(String(id));
  qCache.set(String(id), hit);          // 重新插到队尾
  return hit.questions;
}

/** 存题目（同时按 MAX_BANKS 淘汰最久未用的） */
export function putQuestions(id, questions) {
  if (!id || !Array.isArray(questions)) return;
  const k = String(id);
  qCache.delete(k);
  qCache.set(k, { questions, at: Date.now(), hits: 0 });
  while (qCache.size > MAX_BANKS) {
    const oldest = qCache.keys().next().value;
    qCache.delete(oldest);
  }
}

/** 让某个题库的题目缓存失效（题目被编辑 / 题库被删除 / 重新导入） */
export function dropQuestions(id) {
  if (!id) return;
  qCache.delete(String(id));
  // 本机持久缓存（v2.32）同样要清：题目已经变了，留着只会让人打开旧题
  delCachedQuestions(id).catch(() => {});
}

/** 全清（换账号、退出登录时用 —— 别把上一个人的题目留在内存里） */
export function clearQuestionCache() {
  qCache.clear();
}

/** 调试/验收用：看缓存里有什么 */
export function cacheStats() {
  const out = [];
  qCache.forEach((v, k) => out.push({ id: k, count: v.questions.length, age: Date.now() - v.at, hits: v.hits }));
  return out;
}

// 本地开发调试钩子（生产构建会被剔除），供 scripts/check_speed.mjs 断言缓存行为
if (import.meta.env.DEV) {
  window.__bankcache = { getQuestions, putQuestions, dropQuestions, clearQuestionCache, cacheStats };
}
