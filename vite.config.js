import { defineConfig } from 'vite';

// ============================================================
// base 说明
// ------------------------------------------------------------
// 本应用在 chyunfan.cn 上不是直接部署，而是被「网关项目的 rewrites」代理到
// 子路径（先 /credit-exam-cloud，后 /ks）。rewrites 是服务端代理，浏览器地址栏
// 的 URL 不会变，所以「构建期写死的前缀」和「用户实际访问的路径」很容易对不上。
// 历史上因此出过两次事故：
//   ① base './'      → 产出 ./assets/x.js，在无尾斜杠的 /xxx 下被解析成站点根
//                      /assets/x.js → 网关 404 → 样式全丢
//   ② base 写死 '/credit-exam-cloud/'，但应用换到 /ks 访问 → 浏览器去
//                      /credit-exam-cloud/assets/x.js 取资源 → 命中另一个部署 → 503 → 裸页面
//
// v2.24 起不再依赖 base 解决这个问题，两道保险：
//   1) 构建走 `npm run build`（vite build + scripts/inline.mjs），产物是**零外链**的
//      单文件 index.html —— 资源路径与部署路径彻底无关，放哪个子路径都能跑；
//      inline.mjs 里加了断言，万一下次只跑了 vite build，构建会直接失败而不是发裸页面。
//   2) src/auth.js 的接口前缀改成**运行时**从 location.pathname 推导（见 runtimePrefix），
//      base 只作为最后一个兜底候选。
// 所以下面这个常量现在只影响兜底行为，不再决定成败；保留原值以兼容老路径。
// ============================================================
const APP_BASE = '/credit-exam-cloud/';

export default defineConfig({
  root: '.',
  base: APP_BASE,
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
});
