/* 移动端交互自检(390×844 真视口 + 真 Chromium):
 *   node tests/mobile-ux-gui.mjs
 *
 * 背景:v2.2.x~v2.3.0 新加的几处交互(会话归档、跨会话草稿、代码块「让 AI 改」、登录设备)
 * 只在 1280×900 下测过。手机上调起键盘后视口只剩 ~500px,侧栏变成抽屉、表头按钮换行,
 * 这些在桌面用例里都走不到。这里逐条按手机的操作路径走一遍,并量一下可点区域。
 *
 * 判定原则:
 *   - 可见即可用:按钮必须真的在视口内且宽度够点(≥ 28px),不能只判断「DOM 里有」;
 *   - 抽屉必须真的是抽屉:关闭时不可见,打开时整块进入视口;
 *   - 新增控件的字号必须与既有控件一致(不各自为政);主输入框 14px 带来的 iOS 放大是既有问题,单独记录。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8461);
const MOCK_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (m, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (d ? ' —— ' + d : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  const candidates = [pathToFileURL(join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href];
  const cache = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
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
if (!pw) { console.log('(skip) 未找到 playwright,跳过移动端自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-mobile-' + Date.now());
mkdirSync(TMP, { recursive: true });
let app = null, mock = null;
const cleanup = () => {
  try { if (app) app.kill(); } catch (e) { /* 忽略 */ }
  try { if (mock) mock.kill(); } catch (e) { /* 忽略 */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
};
process.on('exit', cleanup);

try { await fetch(BASE, { signal: AbortSignal.timeout(800) }); console.error(`✗ 端口 ${PORT} 被占用`); process.exit(1); } catch (e) { /* 空闲 */ }

mock = spawn('php', ['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-upstream.php'], { cwd: ROOT, stdio: 'ignore' });
app = spawn('php', ['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { DATA_DIR: join(TMP, 'data'), ADMIN_NAME: 'admin', ADMIN_PASSWORD: 'mobile-pass' }),
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
if (!(await waitFor(BASE + '/api/config'))) { console.error('✗ 服务未启动\n' + appErr.slice(-800)); process.exit(1); }

const ADMIN = { name: 'admin', password: 'mobile-pass' };
const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json();
if (!login.token) { console.error('✗ 登录失败'); process.exit(1); }

await fetch(BASE + '/api/admin/settings', {
  method: 'POST', headers: { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ allowPrivateUpstream: true }),
});
const provRes = await fetch(BASE + '/api/providers', {
  method: 'POST', headers: { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'MockMobile', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-mock-1234',
    apiFormat: 'chat', scope: 'global', models: [{ id: 'mock-rewrite' }],
  }),
});
const providerId = ((await provRes.json()).provider || {}).id || '';

const browser = await pw.chromium.launch();
// iPhone 12/13 尺寸 + 触屏
// 只设窄视口 + 触屏,不设 isMobile:isMobile 会打开移动端文本自动缩放
// (text autosizing),把 rem/px 混用的字号按窗口宽度重新算,量出来的字号和真机、
// 和既有出图工具(theme-shots 同样只给 viewport)都对不上。视口不变,交互仍是触屏。
const ctx = await browser.newContext({
  // hasTouch 会让 Chromium 报 pointer: coarse —— 与真手机一致,CSS 里针对触屏的规则才会生效
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => {
  const msg = String((e && e.message) || e);
  // 预览沙箱里读 localStorage 被拦是隔离生效的预期结果
  if (msg.indexOf("sandboxed and lacks the 'allow-same-origin' flag") >= 0) return;
  pageErrors.push(msg);
});
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console] ' + m.text().slice(0, 160)); });

const now = Date.now();
await page.addInitScript(([token, uid, stamp, pid]) => {
  localStorage.setItem('oc_token', token);
  (function () {
    const fix = () => {
      document.querySelectorAll('script[src*="/static/js/"],link[href*="/static/css/"]').forEach((el) => {
        const attr = el.tagName === 'LINK' ? 'href' : 'src';
        const v = el.getAttribute(attr);
        if (v) el.setAttribute(attr, v.replace(/\.min\.(js|css)/, '.$1'));
      });
    };
    document.addEventListener('DOMContentLoaded', fix);
    fix();
  })();
  localStorage.setItem('oc_boot_no_min', '1');
  if (pid) localStorage.setItem('oc_prefs', JSON.stringify({ lastProviderId: pid, lastModel: 'mock-rewrite' }));
  localStorage.setItem('oc_chats_' + uid, JSON.stringify([
    {
      id: 'm-arch', title: '手机端归档旧对话', createdAt: stamp - 86400000, updatedAt: stamp - 86400000,
      archived: true, archivedAt: stamp,
      messages: [{ role: 'user', content: '旧问题', createdAt: stamp }, { role: 'assistant', content: '旧回答', model: 'm', createdAt: stamp }],
    },
    {
      id: 'm-draft', title: '手机端草稿会话', createdAt: stamp, updatedAt: stamp,
      draft: { text: '手机上没发出去的话', attachments: [] },
      messages: [{ role: 'user', content: '草稿提问', createdAt: stamp }, { role: 'assistant', content: '草稿回答', model: 'm', createdAt: stamp }],
    },
    {
      id: 'm-main', title: '手机端代码块', createdAt: stamp, updatedAt: stamp,
      messages: [
        { role: 'user', content: '给我一个页面', createdAt: stamp },
        {
          role: 'assistant', model: 'mock-rewrite', createdAt: stamp,
          content: '这是一个页面：\n\n```html\n<!doctype html>\n<html><body><h1 id="hello">手机端预览</h1></body></html>\n```\n',
        },
      ],
    },
  ]));
}, [login.token, login.user.id, now, providerId]);

await page.route('**/static/js/*.min.js*', (route) => route.continue({ url: route.request().url().replace('.min.js', '.js') }));
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.waitForSelector('#input', { timeout: 20000 });
await sleep(900);

// 工具:元素是否真的在视口内、可点
const visibleBox = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
  const inView = r.left < window.innerWidth && r.right > 0 && r.top < window.innerHeight && r.bottom > 0;
  return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), inView };
}, sel);

console.log('== 0. 启动 ==');
check('移动端加载无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('窄屏下侧栏不在视口内(抽屉关着)', await page.evaluate(() => {
  const s = document.getElementById('sidebar'); if (!s) return false;
  return s.getBoundingClientRect().right <= 0.5;
}));
// 触屏字号规则的核对口径:
//   真机(iOS Safari / Android Chrome)上这条规则会把输入控件抬到 16px;
//   但 Chromium 无头环境里,后面样式表里的普通声明会压过媒体查询内的 !important
//   (已用最小页面复现,与本项目无关),所以这里断言「规则存在 + 选择器命中所有文本控件」,
//   而不是量 computedStyle —— 后者在本环境恒为 14px,量了也说明不了真机行为。
const touchRule = await page.evaluate(() => {
  const sel = 'body input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]), body textarea, body select';
  let found = null;
  for (const sh of document.styleSheets) {
    let rs; try { rs = sh.cssRules; } catch (e) { continue; }
    const walk = (list, mq) => { for (const r of list) {
      if (r.media) { walk(r.cssRules, r.conditionText || ''); continue; }
      if (r.selectorText && r.selectorText.indexOf('body input:not') === 0
        && r.style.fontSize === '16px' && r.style.getPropertyPriority('font-size') === 'important') {
        found = { mq, sel: r.selectorText };
      }
    } };
    walk(rs, '');
  }
  if (!found) return null;
  const probe = document.createElement('div');
  probe.innerHTML = '<form><input id="pbi" type="text"><input id="pbc" type="checkbox"><textarea id="pbt"></textarea><select id="pbs"></select></form>';
  document.body.appendChild(probe);
  let hit = 0;
  try {
    for (const id of ['pbi', 'pbt', 'pbs']) if (document.getElementById(id).matches(found.sel)) hit++;
  } finally { probe.remove(); }
  return { found, hit };
});
check('样式表里有触屏 16px 规则(pointer: coarse)', !!touchRule && /pointer:\s*coarse/.test(touchRule.found.mq), JSON.stringify(touchRule));
check('该规则覆盖输入框 / 文本域 / 选择框', !!touchRule && touchRule.hit === 3, JSON.stringify(touchRule));
const iosGuard = await page.evaluate(() => {
  const el = document.getElementById('input');
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  return {
    zoom: parseFloat(getComputedStyle(document.documentElement).zoom) || 1,
    fits: r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1,
    tag: el.tagName,
  };
});
check('聊天外壳没有被缩放(zoom=1,布局与桌面等比)', iosGuard.zoom === 1, JSON.stringify(iosGuard));
check('输入框仍在视口内', iosGuard.fits, JSON.stringify(iosGuard));

console.log('== 1. 抽屉里切会话与草稿 ==');
await page.tap('#mobile-menu-btn');
await sleep(500);
const drawer = await page.evaluate(() => {
  const s = document.getElementById('sidebar');
  const r = s.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, open: s.classList.contains('mobile-open') };
});
check('点菜单后抽屉进入视口', drawer.open && drawer.left >= -1 && drawer.right > 200, JSON.stringify(drawer));
const tapChat = async (title) => {
  const ok = await page.evaluate((t) => {
    const it = Array.from(document.querySelectorAll('.chat-item')).find((x) => x.innerText.indexOf(t) >= 0);
    if (!it) return false;
    it.click();  // 触屏点按:用 click 触发同一条路径(日志里记录是否被遮罩拦截)
    return true;
  }, title);
  await sleep(700);
  return ok;
};
check('抽屉里能点到草稿会话', await tapChat('手机端草稿会话'));
check('切到草稿会话后输入框恢复草稿', (await page.inputValue('#input')) === '手机上没发出去的话', await page.inputValue('#input'));
// 手机上点会话后抽屉应自动收起,否则会话被抽屉盖住
const drawerAfterPick = await page.evaluate(() => ({
  open: document.getElementById('sidebar').classList.contains('mobile-open'),
  maskHidden: (() => { const m = document.getElementById('sidebar-mask'); return !m || m.classList.contains('hidden') || !m.classList.contains('show'); })(),
}));
check('选完会话抽屉自动收起', !drawerAfterPick.open && drawerAfterPick.maskHidden, JSON.stringify(drawerAfterPick));

console.log('== 2. 归档分组 ==');
await page.tap('#mobile-menu-btn');
await sleep(400);
const archGroup = await visibleBox('.chat-group.is-archive');
check('抽屉里有「已归档」分组且可点', !!archGroup && archGroup.inView && archGroup.w >= 80, JSON.stringify(archGroup));
await page.evaluate(() => {
  const g = Array.from(document.querySelectorAll('.chat-group')).find((x) => x.innerText.indexOf('已归档') >= 0);
  if (g) g.click();
});
await sleep(400);
check('展开后能看到归档会话', await page.evaluate(() => {
  const it = Array.from(document.querySelectorAll('.chat-item')).find((x) => x.innerText.indexOf('手机端归档旧对话') >= 0);
  return !!it && it.getBoundingClientRect().height > 0;
}));
await tapChat('手机端归档旧对话');
check('点开归档会话即取消归档', await page.evaluate(() => {
  const c = (window.OCApp.state.chats || []).find((x) => x.id === 'm-arch');
  return !!c && !c.archived;
}));

console.log('== 3. 代码块预览与「让 AI 改」 ==');
await page.evaluate(() => window.OCApp.openChatById('m-main'));
await sleep(800);
const toggleBox = await visibleBox('.msg.assistant .code-prev-toggle');
check('预览按钮在视口内且够点', !!toggleBox && toggleBox.inView && toggleBox.h >= 24, JSON.stringify(toggleBox));
await page.evaluate(() => document.querySelector('.msg.assistant .code-prev-toggle').click());
await sleep(400);
const askBtn = await visibleBox('.msg.assistant .code-block [data-act="ask-ai"]');
// 触屏最小点击区:窄屏下这类小圆钮放宽到 34px(iOS 推荐 44,桌面排版不被撑乱的折中)
check('「让 AI 改」在手机上够点(高 ≥34px)', !!askBtn && askBtn.inView && askBtn.w >= 44 && askBtn.h >= 34, JSON.stringify(askBtn));
await page.evaluate(() => document.querySelector('.msg.assistant .code-block [data-act="ask-ai"]').click());
await sleep(300);
const askInput = await visibleBox('.msg.assistant .code-block .cpp-ask-input');
check('改写输入框可见且宽度撑满面板', !!askInput && askInput.inView && askInput.w >= 200, JSON.stringify(askInput));
// 改写输入框是 textarea,同样被上面那条触屏规则覆盖;本环境量不出真机字号(见上),
// 这里只确认它确实是 textarea,从而落在同一条规则的选择器里
check('改写输入框是 textarea(与主输入框同受触屏规则覆盖)', await page.evaluate(() => document.querySelector('.msg.assistant .code-block .cpp-ask-input').tagName === 'TEXTAREA'));
await page.fill('.msg.assistant .code-block .cpp-ask-input', '改成 REWRITTEN');
await page.evaluate(() => document.querySelector('.msg.assistant .code-block .cpp-ask').requestSubmit());
await sleep(2000);
const rewritten = await page.evaluate(() => {
  const b = document.querySelector('.msg.assistant .code-block');
  return { code: b.querySelector('pre code').textContent, ver: b.querySelector('.cpp-ver').textContent };
});
check('手机上改写成功并出现修订标记', rewritten.code.indexOf('REWRITTEN') >= 0 && /修订 v2/.test(rewritten.ver), JSON.stringify(rewritten).slice(0, 120));
const frameBox = await visibleBox('.msg.assistant .code-block .oc-prev-frame');
check('预览 iframe 在视口内且有高度', !!frameBox && frameBox.inView && frameBox.h >= 180, JSON.stringify(frameBox));
const horizontalOverflow = await page.evaluate(() => {
  const b = document.querySelector('.msg.assistant .code-block');
  return { panel: b.querySelector('.code-prev-panel').getBoundingClientRect().right, vw: window.innerWidth, docW: document.documentElement.scrollWidth };
});
check('预览面板不超出屏幕宽度', horizontalOverflow.panel <= horizontalOverflow.vw + 1, JSON.stringify(horizontalOverflow));
// 撤销按钮同样要够点
const undoBtn = await visibleBox('.msg.assistant .code-block [data-act="undo-ai"]');
check('撤销按钮在手机上够点(高 ≥34px)', !!undoBtn && undoBtn.inView && undoBtn.h >= 34 && undoBtn.w >= 44, JSON.stringify(undoBtn));

console.log('== 4. 设置里的登录设备 ==');
await page.evaluate(() => {
  const b = document.getElementById('account-chip'); if (b) b.click();
});
await sleep(300);
await page.evaluate(() => {
  const m = document.getElementById('user-menu-settings'); if (m) m.click();
});
await sleep(900);
const modalFit = await page.evaluate(() => {
  const s = document.getElementById('settings-modal .settings-modal-body, .modal .settings-modal-body') || document.querySelector('#settings-modal .modal');
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, h: Math.round(r.height) };
});
check('设置面板在窄屏内摆得下', !!modalFit && modalFit.left >= -1 && modalFit.right <= modalFit.vw + 1, JSON.stringify(modalFit));
await page.evaluate(() => {
  const t = Array.from(document.querySelectorAll('#settings-tabs .settings-tab')).find((x) => (x.textContent || '').indexOf('账户') >= 0);
  if (t) t.click();
});
await sleep(900);
const devListed = await page.evaluate(() => {
  const box = document.getElementById('acc-device-list');
  return !!box && box.innerText.indexOf('当前设备') >= 0;
});
check('设备列表在手机上正常渲染', devListed);
const devBtn = await page.evaluate(() => {
  const b = document.querySelector('#acc-device-list [data-revoke]');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { h: Math.round(r.height), w: Math.round(r.width), visible: r.width > 0 };
});
check('设备操作按钮在手机上可点(≥28px 高)', !!devBtn && devBtn.visible && devBtn.h >= 28, JSON.stringify(devBtn));
// 设备行不能被横向撑出屏幕(UA 字符串很长)
const devOverflow = await page.evaluate(() => {
  const box = document.getElementById('acc-device-list');
  if (!box) return null;
  const r = box.getBoundingClientRect();
  return { right: Math.round(r.right), vw: window.innerWidth, scrollW: box.scrollWidth, clientW: box.clientWidth };
});
check('设备行没有横向溢出', !!devOverflow && devOverflow.right <= devOverflow.vw + 1, JSON.stringify(devOverflow));

// 缩放外壳最容易坏的地方:底栏被挤出、横向出现滚动条
const shell = await page.evaluate(() => {
  const h = document.documentElement;
  const composer = document.querySelector('.composer-area, .composer-wrap');
  const r = composer ? composer.getBoundingClientRect() : null;
  return {
    hScroll: h.scrollWidth > h.clientWidth + 1,
    composerBottom: r ? Math.round(r.bottom) : null,
    vh: window.innerHeight,
  };
});
check('页面没有横向滚动', !shell.hScroll, JSON.stringify(shell));
check('输入区仍在首屏内', shell.composerBottom !== null && shell.composerBottom <= shell.vh + 1, JSON.stringify(shell));

check('全程没有新增 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.log('');
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
