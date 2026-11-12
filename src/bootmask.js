/**
 * 启动/加载遮罩（v2.29）
 *
 * 为什么需要：已登录时 boot() 要先把题库拉回来才知道该进哪一屏，
 * 这段原本是**纯白**——题库大一点就是一两秒白屏，看起来像卡死了。
 * 打开某个大题库同理（拉题目可能几百 KB）。
 *
 * 遮罩本体在 index.html（#bootMask），CSS 里延迟 150ms 才淡入：
 * 加载够快就完全不出现，不会闪一下反而更慌。
 *
 * 单独一个模块是为了让 main.js（启动流程）和 banks.js（打开题库）都能用，
 * 又不互相 import —— 这两个模块已经有一条 import 链，再加一条容易成环。
 */

/** 显示遮罩并设置文案；重复调用只更新文案，不重放动画 */
export function showBoot(text) {
  const el = document.getElementById('bootMask');
  if (!el) return;
  const t = document.getElementById('bootText');
  if (t && text) t.textContent = text;
  el.classList.remove('off');
}

/** 收起遮罩（CSS 里有 180ms 淡出过渡） */
export function hideBoot() {
  const el = document.getElementById('bootMask');
  if (el) el.classList.add('off');
}
