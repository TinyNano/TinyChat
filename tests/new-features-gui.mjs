/* v2.0.165 新功能 GUI 自检(真 Chromium + 真服务端):
 *   node tests/new-features-gui.mjs
 *
 * 锁住「接线层」的回归 —— 契约测试只看源码,这里看真页面:
 *   1) 设置 → 账户:两步验区块出现,点「开启」能拿到绑定密钥(真 POST /api/me/totp/setup);
 *   2) 设置 → 对话:自定义指令可保存进 oc_prefs,记忆区块随站点开关显隐;
 *   3) 用户菜单:我的收藏入口存在且能打开面板(真 GET /api/favorites);
 *   4) 消息操作栏:收藏按钮点击走真 POST /api/favorites 且亮星;收藏面板能看到刚收藏的条目;
 *   5) finish_reason=length 的回复显示「继续生成」;
 *   6) 输入框斜杠指令菜单浮出、回车回填模板;「?」呼出快捷键速查。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8381);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'feat-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c, d) => { if (c) ok(m); else bad(m + (d ? ' —— ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用(疑似残留的 php -S),请先结束该进程或用 GUI_PORT 换端口`);
  process.exit(1);
}
await assertPortFree(PORT);

async function loadPlaywright() {
  const candidates = [];
  try { candidates.push(import.meta.resolve('playwright')); } catch (e) { /* 未本地安装 */ }
  const cache = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      const p = join(cache, dir, 'node_modules', 'playwright', 'index.mjs');
      if (existsSync(p)) candidates.push(pathToFileURL(p).href);
    }
  }
  for (const c of candidates) { try { return await import(c); } catch (e) { /* 试下一个 */ } }
  return null;
}
const pw = await loadPlaywright();
if (!pw) { console.log('(skip) 未找到 playwright,跳过新功能 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-newfeat-' + Date.now());
mkdirSync(TMP, { recursive: true });
let app = null;
function cleanup() {
  try { if (app) app.kill(); } catch (e) { /* 忽略 */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
process.on('exit', cleanup);

app = spawn('php', ['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appErr = '';
app.stderr.on('data', (d) => { appErr += String(d); });

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status) return true; } catch (e) { /* 未就绪 */ }
    await sleep(250);
  }
  return false;
}
if (!(await waitFor(BASE + '/api/config'))) {
  console.error('✗ 应用服务未启动\n' + appErr.slice(-1500));
  process.exit(1);
}

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
page.on('response', (r) => {
  const u = r.url();
  if (u.indexOf('/api/') >= 0 && r.status() >= 400) console.log('  [HTTP ' + r.status() + '] ' + r.request().method() + ' ' + u.slice(u.indexOf('/api/')).split('?')[0]);
});

// 一条带 AI 回复的对话:finishReason=length 用于「继续生成」按钮断言
const now = Date.now();
await page.addInitScript(([token, uid]) => {
  localStorage.setItem('oc_token', token);
  const now2 = Date.now();
  localStorage.setItem('oc_chats_' + uid, JSON.stringify([
    {
      id: 'nf1', title: '新功能自检对话', createdAt: now2, updatedAt: now2,
      messages: [
        { role: 'user', content: '介绍一下自己', createdAt: now2 },
        { role: 'assistant', content: '我是测试回复,内容被截断了', model: 'mock-model', createdAt: now2, finishReason: 'length' },
      ],
    },
  ]));
  // 本地从未自选过主题:默认主题逻辑不应在此场景报错
  localStorage.removeItem('oc_prefs');
}, [login.token, login.user.id]);

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.waitForSelector('#input', { timeout: 20000 });
await sleep(800);
if (pageErrors.length) console.log('  [启动期 JS 错误] ' + pageErrors.slice(0, 3).join(' | '));
check('启动后登录弹窗未被打开(无 401 登出)', await page.evaluate(() => {
  const m = document.getElementById('auth-modal');
  return !m || !m.classList.contains('show');
}));

console.log('== 1. 设置 → 账户:两步验证 ==');
await page.evaluate(() => window.openSettings ? window.openSettings('account') : (document.getElementById('user-menu-settings') || {}).click());
await sleep(600);
check('两步验区块出现', await page.isVisible('#totp-row'));
check('状态为未开启', (await page.textContent('#totp-state-label')).includes('未开启'));
await page.click('#acc-totp-btn');
await page.waitForSelector('#totp-setup-box:not(.hidden)', { timeout: 10000 });
const secret = await page.textContent('#totp-secret');
check('绑定密钥已下发(真 POST /api/me/totp/setup)', /^[A-Z2-7]{32}$/.test(secret || ''), 'secret=' + secret);
const uri = await page.textContent('#totp-uri');
check('otpauth URI 已下发', (uri || '').indexOf('otpauth://totp/') === 0);
await page.click('#totp-cancel');
await sleep(300);
// 关闭设置弹窗
await page.evaluate(() => { const m = document.getElementById('settings-modal'); if (m && window.OCUI) window.OCUI.closeModal(m); });
await sleep(400);

console.log('== 2. 设置 → 对话:自定义指令与记忆 ==');
await page.evaluate(() => window.openSettings('chat'));
await sleep(500);
check('自定义指令输入框存在', await page.isVisible('#pref-custom-instructions'));
await page.fill('#pref-custom-instructions', '请始终用中文回答');
await page.evaluate(() => { const el = document.getElementById('pref-custom-instructions'); el.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(400);
const savedIns = await page.evaluate(() => { try { return (JSON.parse(localStorage.getItem('oc_prefs') || '{}').customInstructions) || ''; } catch (e) { return ''; } });
check('自定义指令已写入 oc_prefs(云同步管道)', savedIns === '请始终用中文回答', 'got=' + savedIns);
check('记忆管理入口存在', await page.isVisible('#pref-memory-manage'));
await page.click('#pref-memory-manage');
await page.waitForSelector('.modal-mask #oc-mem-list', { timeout: 8000 });
await sleep(500);
const memEmpty = await page.textContent('#oc-mem-list');
check('记忆面板打开并加载(空态文案)', (memEmpty || '').length > 0);
await page.evaluate(() => { const m = document.getElementById('settings-modal'); if (m && window.OCUI) window.OCUI.closeModal(m); });
await page.evaluate(() => document.querySelectorAll('.modal-mask.show').forEach((m) => { if (window.OCUI) window.OCUI.closeModal(m); }));
await sleep(400);

console.log('== 3. 用户菜单:我的收藏 ==');
check('收藏入口可见(登录态)', await page.evaluate(() => {
  const b = document.getElementById('user-menu-favorites');
  return !!b && !b.classList.contains('hidden') && !b.hidden;
}));

console.log('== 4. 消息操作栏:收藏与继续生成 ==');
await page.waitForSelector('.msg.assistant .msg-actions', { timeout: 15000 });
const favBtnVisible = await page.isVisible('.msg.assistant .msg-actions [data-act="fav"]');
check('收藏按钮对 assistant 消息可见', favBtnVisible);
check('朗读按钮可见(仅可见性,不真读)', await page.isVisible('.msg.assistant .msg-actions [data-act="speak"]'));
const contVisible = await page.isVisible('.msg.assistant .msg-actions [data-act="continue"]');
check('finish_reason=length 的回复显示「继续生成」', contVisible);
await page.click('.msg.assistant .msg-actions [data-act="fav"]');
await sleep(900);
const favActive = await page.evaluate(() => {
  const b = document.querySelector('.msg.assistant .msg-actions [data-act="fav"]');
  const m = (window.OCApp.state.chats || [])[0].messages[1];
  return { active: b.classList.contains('active'), faved: !!m._faved, hasId: !!m._id };
});
check('收藏后按钮点亮且消息带 _id', favActive.active && favActive.faved && favActive.hasId, JSON.stringify(favActive));
// 收藏面板能看到这条
await page.evaluate(() => { const b = document.getElementById('user-menu-favorites'); if (b) b.click(); });
await page.waitForSelector('.oc-fav-item', { timeout: 8000 });
const favItemText = await page.textContent('.oc-fav-item .oc-fav-content');
check('收藏面板列出刚收藏的内容(真 GET /api/favorites)', (favItemText || '').includes('测试回复'));
await page.keyboard.press('Escape');
await sleep(400);

console.log('== 5. 斜杠指令 ==');
await page.click('#input');
await page.fill('#input', '/');
await sleep(300);
check('斜杠菜单浮出', await page.isVisible('.slash-menu'));
const slashCount = await page.evaluate(() => document.querySelectorAll('.slash-item').length);
check('指令菜单带模板项(' + slashCount + ' 项)', slashCount >= 5);
await page.keyboard.press('Enter');
await sleep(300);
const filled = await page.evaluate(() => document.getElementById('input').value);
check('回车回填模板(翻译)', filled.indexOf('翻译') >= 0, 'got=' + filled.slice(0, 30));
// 优化提示词命令走 AI 调用(无供应商),只验证菜单项存在
await page.fill('#input', '/优化');
await sleep(300);
check('斜杠指令可搜索过滤', await page.evaluate(() => {
  const items = document.querySelectorAll('.slash-item');
  return items.length === 1 && items[0].textContent.includes('优化');
}));
await page.keyboard.press('Escape');
await sleep(200);

console.log('== 6. 快捷键速查 ==');
// 焦点必须离开输入框(斜杠测试后还停在 #input),否则 ? 走 inInput 守卫被忽略
await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); document.body.focus(); });
await page.keyboard.press('?');
await sleep(400);
check('? 呼出快捷键速查弹窗', await page.evaluate(() => !!document.querySelector('.oc-shortcut-table')));
await page.keyboard.press('Escape');
await sleep(300);

console.log('== 7. 站点默认主题与 TTS 按钮 ==');
check('默认主题逻辑未破坏外观(画布类仍在)', await page.evaluate(() => document.documentElement.getAttribute('data-theme') !== null));
check('STT 按钮显隐与浏览器语音能力一致', await page.evaluate(() => {
  const b = document.getElementById('stt-btn');
  if (!b) return false;
  const supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  return supported ? !b.classList.contains('hidden') : b.classList.contains('hidden');
}));

check('无页面级 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

console.log('');
if (fail) { console.log('失败 ' + fail + ' 项'); await browser.close(); process.exit(1); }
console.log('全部通过');
await browser.close();
process.exit(0);
