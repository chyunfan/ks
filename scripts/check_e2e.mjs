// 端到端验证：注册→登录→带自定义 JWT 读写 Supabase（验证 RLS 的 auth.uid() 是否真的生效）
//
// ⚠️ 本脚本会往【线上正式库】注册一个账号（USER 常量）并且**不会**删掉它。
//    上一轮跑留下的 diag_check_2026 因为注册得比正式账号早，被 admin.sql 的
//    「首个管理员」引导逻辑自动升成了管理员，而它的密码就明文写在下面 —— 等于管理员
//    权限外泄（管理员可改任意题库的可见范围 / 重命名 / 删库）。
//    因此：
//      1) 必须显式加参数才会执行，避免顺手一跑又留一个账号
//      2) 跑完立刻执行 supabase/cleanup-test-accounts.sql 清掉
//      3) 以后联调把 USER 改成一眼看出是临时的名字，别用固定名反复跑
const base = 'https://www.chyunfan.cn/ks';
const USER = 'diag_check_2026';
const PASS = 'diag123456';

if (!process.argv.includes('--i-know-it-hits-production')) {
  console.log('默认不执行：本脚本会在线上正式库注册账号「' + USER + '」且不会自动删除。');
  console.log('确认要跑，请加参数： --i-know-it-hits-production');
  console.log('跑完记得执行 supabase/cleanup-test-accounts.sql 清理。');
  process.exit(0);
}

const j = (r) => r.json().catch(() => ({}));

(async () => {
  // 取出前端配置的 supabase url/key
  // 权威来源 = Vercel 直连域名（根路径下相对资源解析正常）；本地 dist 无 .env，取不到配置
  const ORIGIN = 'https://credit-exam-cloud.vercel.app/';
  let js = '';
  const html = await (await fetch(ORIGIN)).text();
  const m = html.match(/src="([^"]+\.js)"/);
  js = m ? await (await fetch(new URL(m[1], ORIGIN).href)).text() : html;
  const url = (js.match(/https:\/\/[A-Za-z0-9-]+\.supabase\.co/) || [])[0];
  const anon = (js.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/) || [])[0];
  console.log('supabase =', url);

  // 1) 注册（若已存在则下一步登录会成功）
  let r = await fetch(base + '/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  console.log('1) register ->', r.status, JSON.stringify(await j(r)));

  // 2) 登录拿 token
  r = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  const login = await j(r);
  console.log('2) login    ->', r.status, 'token?', !!login.token);
  if (!login.token) { console.log('   无法继续'); return; }

  const payload = JSON.parse(Buffer.from(login.token.split('.')[1], 'base64url').toString('utf8'));
  console.log('   JWT payload =', JSON.stringify(payload));

  const authHeaders = {
    apikey: anon,
    Authorization: 'Bearer ' + login.token,
    'content-type': 'application/json'
  };

  // 3) 带 token 写入一条题库（RLS with check 必须通过；user_id 用 payload.sub）
  r = await fetch(`${url}/rest/v1/exam_banks`, {
    method: 'POST',
    headers: { ...authHeaders, Prefer: 'return=representation' },
    body: JSON.stringify([{ user_id: payload.sub, name: '__diag__', questions: [], case_count: 0 }])
  });
  const created = await j(r);
  console.log('3) insert bank ->', r.status, JSON.stringify(created).slice(0, 200));

  // 4) 带 token 读回（RLS using 必须通过）
  r = await fetch(`${url}/rest/v1/exam_banks?select=id,name&name=eq.__diag__`, { headers: authHeaders });
  const rows = await j(r);
  console.log('4) select bank ->', r.status, JSON.stringify(rows).slice(0, 200));

  // 5) 清理临时题库
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const d = await fetch(`${url}/rest/v1/exam_banks?id=eq.${row.id}`, { method: 'DELETE', headers: authHeaders });
      console.log('5) delete ' + row.id + ' ->', d.status);
    }
  }

  // 6) 再读一次确认已清空
  r = await fetch(`${url}/rest/v1/exam_banks?select=id&name=eq.__diag__`, { headers: authHeaders });
  console.log('6) after cleanup ->', r.status, JSON.stringify(await j(r)));

  console.log('\n⚠️ 账号「' + USER + '」仍留在线上库里（本脚本不负责删账号）。');
  console.log('   联调结束请到 Supabase → SQL Editor 执行 supabase/cleanup-test-accounts.sql');
  console.log('   的段 2 → 段 3，把它删掉；否则它有可能被管理员的引导逻辑或人工误升为管理员。');
})();
