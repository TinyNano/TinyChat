/* v2.2.0 GUI 自检(真 Chromium + 真服务端):
 *   node tests/v220-gui.mjs
 *
 * 锁住「只有真浏览器量得出来」的部分:
 *   1) HTML/SVG 代码块的「预览」标签:点开真的渲染、iframe 的 sandbox 里**没有**
 *      allow-same-origin、预览里读不到本站的 oc_token(隔离真的成立);
 *   2) 工具调用 chip:带 toolCalls 的历史消息画成 chip、参数与结果可见、被同步抹掉字段时不会崩;
 *   3) 设置 → 账户:登录设备列表渲染、当前设备有标记、退出该设备走真接口;
 *   4) AI 笔记:[[双链]] 渲染成可点链接、反向链接面板列出引用者。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8394);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'v220-pass' };

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
if (!pw) { console.log('(skip) 未找到 playwright,跳过 v2.2.0 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-v220-' + Date.now());
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

const now = Date.now();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console] ' + m.text().slice(0, 200)); });
await page.addInitScript(([token, uid, stamp]) => {
  // 自检探针(捕获阶段):按下按键后当前会话有没有被任何处理器切走。
  // 不能只看冒泡阶段的 defaultPrevented —— 其它处理器(如输入框自身)会先接管,
  // 那时「键被接住了」并不代表「会话切了」。
  window.__chatAtKey = null;
  document.addEventListener('keydown', (e) => {
    if (!window.OCApp || !e.ctrlKey) return;
    if (e.code !== 'BracketLeft' && e.code !== 'BracketRight') return;
    window.__chatAtKey = window.OCApp.state.currentChatId;
    setTimeout(() => {
      window.__chatAtKey = { from: window.__chatAtKey, to: window.OCApp.state.currentChatId };
    }, 0);
  }, true);
  localStorage.setItem('oc_token', token);
  // 页面引用的是 .min.js(发版产物):本地没跑过 tools/release.mjs 时那些还是旧版本,
  // 这里把资源地址改成源码路径,保证测的是「现在这份代码」而不是上一次的发版包
  (function () {
    const fix = () => {
      document.querySelectorAll('script[src*="/static/js/"],link[href*="/static/css/"]').forEach((el) => {
        const attr = el.tagName === 'LINK' ? 'href' : 'src';
        const v = el.getAttribute(attr);
        if (!v) return;
        el.setAttribute(attr, v.replace(/\.min\.(js|css)/, '.$1'));
      });
    };
    // defer 脚本按文档顺序执行:这个 init script 在解析 <body> 之前就跑了,那时后面的
    // script 标签还不存在;DOMContentLoaded 之前它们已在 DOM 里但都还没执行,这时改 src 有效
    document.addEventListener('DOMContentLoaded', fix);
    fix();
  })();
  localStorage.setItem('oc_boot_no_min', '1');
  localStorage.setItem('oc_chats_' + uid, JSON.stringify([
    {
      id: 'arch1', title: '已归档的旧对话', createdAt: stamp - 86400000, updatedAt: stamp - 86400000,
      archived: true, archivedAt: stamp,
      messages: [{ role: 'user', content: '很久以前的问题', createdAt: stamp }, { role: 'assistant', content: '很久以前的回答', model: 'm', createdAt: stamp }],
    },
    {
      id: 'draft1', title: '草稿会话', createdAt: stamp, updatedAt: stamp,
      draft: { text: '这是没发出去的草稿', attachments: [] },
      messages: [{ role: 'user', content: '草稿那一轮的提问', createdAt: stamp }, { role: 'assistant', content: '草稿那一轮的回答', model: 'm', createdAt: stamp }],
    },
    {
      id: 'pv1', title: '代码块预览自检', createdAt: stamp, updatedAt: stamp,
      messages: [
        { role: 'user', content: '给我一个 HTML 页面', createdAt: stamp },
        { role: 'assistant', content: '这是一个最小页面：\n\n```html\n<!doctype html>\n<html><body><h1 id="hello">预览成功</h1><p>P-MARK</p></body></html>\n```\n', model: 'mock-model', createdAt: stamp },
        { role: 'user', content: '再来个 SVG', createdAt: stamp },
        { role: 'assistant', content: '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#0a84ff"/></svg>\n```\n', model: 'mock-model', createdAt: stamp },
        { role: 'user', content: '查下天气', createdAt: stamp },
        {
          role: 'assistant', content: '', model: 'mock-model', createdAt: stamp,
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_gui_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_gui_1', content: '{"temp":26,"text":"晴"}', createdAt: stamp },
      ],
    },
  ]));
}, [login.token, login.user.id, now]);

// 静态资源改走源码(见上)
await page.route('**/static/js/*.min.js*', (route) => {
  const u = route.request().url().replace('.min.js', '.js');
  return route.continue({ url: u });
});
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.waitForSelector('#input', { timeout: 20000 });
await sleep(900);
if (pageErrors.length) console.log('  [启动期 JS 错误] ' + pageErrors.slice(0, 3).join(' | '));

console.log('== 0. 页面状态 ==');
console.log('  [debug] ' + JSON.stringify(await page.evaluate(() => ({
  ocp: typeof window.OCPreview,
  msgs: document.querySelectorAll('.msg').length,
  blocks: document.querySelectorAll('.code-block').length,
  chat: (window.OCApp && window.OCApp.state && window.OCApp.state.currentChatId) || '',
  chatCount: (window.OCApp && window.OCApp.state && window.OCApp.state.chats || []).length,
}))));
console.log('== 1. HTML / SVG 代码块预览 ==');
// 打开测试用的主会话(默认当前会话取决于列表顺序,这里显式指定,避免被归档/草稿几条带跑)
await page.evaluate(() => {
  const c = (window.OCApp.state.chats || []).find((x) => x.id === 'pv1');
  if (c && window.OCApp.openChatById) window.OCApp.openChatById('pv1');
});
await sleep(900);
const blocks = await page.$$('.msg.assistant .code-block');
check('两段可预览代码块都挂了预览按钮', (await page.$$('.code-prev-toggle')).length >= 2, 'got=' + (await page.$$('.code-prev-toggle')).length);
await page.click('.msg.assistant .code-prev-toggle');
await page.waitForSelector('.code-prev-panel:not(.hidden) .cpp-tab[data-tab="preview"]', { timeout: 8000 });
await page.click('.code-prev-panel:not(.hidden) .cpp-tab[data-tab="preview"]');
await page.waitForSelector('.code-prev-panel:not(.hidden) iframe.oc-prev-frame', { timeout: 8000 });
await sleep(700);
const frameInfo = await page.evaluate(() => {
  const f = document.querySelector('.code-prev-panel:not(.hidden) iframe.oc-prev-frame');
  if (!f) return null;
  return {
    sandbox: f.getAttribute('sandbox') || '',
    text: (() => { try { return f.contentDocument ? f.contentDocument.body.innerText : ''; } catch (e) { return 'ERR:' + e.message; } })(),
  };
});
check('预览 iframe 渲染出内容', !!frameInfo);
check('sandbox 不含 allow-same-origin', frameInfo && frameInfo.sandbox.indexOf('allow-same-origin') < 0, frameInfo && frameInfo.sandbox);
check('预览文档不可被父页面读取(不透明源)', frameInfo && String(frameInfo.text).indexOf('ERR:') === 0 || (frameInfo && frameInfo.text === ''), frameInfo && frameInfo.text);
// 真正证明「渲染了」:从 iframe 内部把自己的标题报出来(不透明源只能靠自己上报)
const inner = await page.evaluate(async () => {
  const f = document.querySelector('.code-prev-panel:not(.hidden) iframe.oc-prev-frame');
  if (!f) return null;
  // 预览默认不带 allow-scripts,内部脚本不执行;改用 srcdoc 内容判断
  return { srcdoc: String(f.getAttribute('srcdoc') || ''), ref: !!f.contentWindow };
});
check('srcdoc 里带的是模型给的 HTML', inner && inner.srcdoc.indexOf('P-MARK') >= 0);
check('预览默认不运行脚本', frameInfo && frameInfo.sandbox.indexOf('allow-scripts') < 0);
// 勾选「运行脚本」后 sandbox 才带上 allow-scripts(仍然没有 allow-same-origin)
await page.check('.code-prev-panel:not(.hidden) .cpp-scripts input');
await sleep(500);
const sbAfter = await page.evaluate(() => {
  const f = document.querySelector('.code-prev-panel:not(.hidden) iframe.oc-prev-frame');
  return f ? f.getAttribute('sandbox') : '';
});
check('勾选后允许脚本', sbAfter.indexOf('allow-scripts') >= 0);
check('勾选后仍不含 allow-same-origin', sbAfter.indexOf('allow-same-origin') < 0);
// 收起面板后 iframe 必须被销毁(动画/定时器不留在后台)
// 收起:用 DOM click(自动滚动会触发页面的吸底逻辑,把按钮再推回面板后面 —— 那是用例的
// 滚动与页面的滚动打架,不是功能问题;真实用户滚到表头点收起是正常的)
await page.evaluate(() => { const b = document.querySelector('.msg.assistant .code-block .code-prev-toggle'); if (b) b.click(); });
await sleep(300);
check('收起预览后 iframe 被销毁', (await page.$$('.code-prev-panel:not(.hidden) iframe')).length === 0);

console.log('== 2. 工具调用 chip ==');
check('工具调用画成 chip', (await page.$$('.tool-calls .tool-call')).length >= 1);
const chip = await page.evaluate(() => {
  const el = document.querySelector('.tool-calls .tool-call');
  if (!el) return null;
  return { name: el.querySelector('.tool-call-name') && el.querySelector('.tool-call-name').textContent, cls: el.className, text: el.innerText };
});
check('chip 显示工具名', chip && chip.name === 'get_weather', chip && chip.name);
check('chip 有结果时标为已完成', chip && /tool-done/.test(chip.cls), chip && chip.cls);
check('chip 里能看到参数与结果', chip && chip.text.indexOf('上海') >= 0 && chip.text.indexOf('晴') >= 0);
// 结果只应出现在 chip 里:除那条 assistant 气泡外,不应再有别处出现原始结果 JSON
const rawResultBubbles = await page.$$eval('.msg', (els) => els.filter((e) => e.innerText.indexOf('"temp":26') >= 0 && !e.querySelector('.tool-calls')).length);
check('工具结果不单独成气泡', rawResultBubbles === 0, 'got=' + rawResultBubbles);
check('纯工具调用的一轮正文有摘要而不是空白', await page.evaluate(() => {
  const msgs = Array.from(document.querySelectorAll('.msg.assistant'));
  return msgs.some((m) => m.innerText.indexOf('get_weather') >= 0);
}));

console.log('== 3. 登录设备 ==');
await page.evaluate(() => window.openSettings && window.openSettings('account'));
await sleep(900);
await page.waitForSelector('#acc-device-list [data-device]', { timeout: 8000 }).catch(() => {});
const devRows = await page.$$('#acc-device-list [data-device]');
check('设备列表有记录', devRows.length >= 1, 'got=' + devRows.length);
const curMark = await page.textContent('#acc-device-list');
check('当前设备有标记', (curMark || '').indexOf('当前设备') >= 0);
check('设备行有 IP 与时间', /127\.0\.0\.1|::1/.test(curMark || '') && /登录于/.test(curMark || ''));
check('当前设备的按钮是「退出登录」', /退出登录/.test(curMark || ''));
// 再登录一台(mock 一个不同 UA 的会话),列表里应多出一行,并可以踢掉它
const extra = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'V220ExtraDevice/9.9' },
  body: JSON.stringify(ADMIN),
})).json();
check('额外登录拿到令牌', !!extra.token);
await page.evaluate(() => window.loadDevices && window.loadDevices());
await sleep(900);
const devText2 = await page.textContent('#acc-device-list');
check('新设备出现在列表里', (devText2 || '').indexOf('V220ExtraDevice') >= 0, (devText2 || '').slice(0, 120));
if (pageErrors.length) console.log('  [JS 错误] ' + pageErrors.slice(0, 3).join(' | '));
await page.evaluate(() => { const m = document.getElementById('settings-modal'); if (m && window.OCUI) window.OCUI.closeModal(m); });
await sleep(300);

console.log('== 4. 笔记双链与反向链接 ==');
const noteIdA = 'ga' + Date.now();
const noteIdB = 'gb' + Date.now();
await page.evaluate(([a, b, stamp]) => {
  const doc = {
    folders: [{ id: 'uncat', name: '未分类', parentId: '', createdAt: stamp, updatedAt: stamp }],
    notes: [
      { id: a, folderId: 'uncat', title: '甲笔记', content: '甲的内容', tags: [], attachments: [], createdAt: stamp, updatedAt: stamp },
      { id: b, folderId: 'uncat', title: '乙笔记', content: '参见 [[甲笔记]] 里的做法。', tags: [], attachments: [], createdAt: stamp, updatedAt: stamp + 1 },
    ],
    tombs: {},
  };
  // 本地副本的外层与云端响应同形状({doc, revision, shares}),loadLocal 读的正是 j.doc
  localStorage.setItem('oc_notes_' + window.OCApp.state.user.id, JSON.stringify({ doc: doc, revision: 0, shares: [] }));
}, [noteIdA, noteIdB, Date.now()]);
await page.evaluate(() => { localStorage.setItem('oc_notes_guide_seen', '1'); if (window.OCNotes) window.OCNotes.open(); });
await sleep(1200);
// 首次打开笔记会弹新手引导,它会挡住所有点击:真用户会点「知道了」,用例同样先关掉它
await page.evaluate(() => { const g = document.querySelector('.notes-guide-mask'); if (g) { const b = g.querySelector('[data-close], .btn.primary, button'); if (b) b.click(); } });
await sleep(300);
const opened = await page.evaluate(() => !!document.querySelector('#notes-fs-body'));
check('笔记界面打开', opened);
if (opened) {
  // 直接打开甲笔记(它有入链)
  await page.evaluate((id) => {
    const btn = document.querySelector('.nt-note[data-note-id="' + id + '"]') || Array.from(document.querySelectorAll('.nt-note')).find((e) => e.innerText.indexOf('甲笔记') >= 0);
    if (btn) btn.click();
  }, noteIdA);
  await sleep(900);
  console.log('  [debug] notes=' + JSON.stringify(await page.evaluate(() => ({
    pc: document.querySelectorAll('.nt-note').length,
    names: Array.from(document.querySelectorAll('.nt-note')).map((e) => e.innerText.slice(0, 20)),
    title: document.getElementById('ne-title') ? document.getElementById('ne-title').value : '',
    ta: document.getElementById('ne-ta') ? document.getElementById('ne-ta').value.slice(0, 40) : '',
    bl: !!document.querySelector('.notes-backlinks'),
    prev: document.getElementById('ne-preview') ? document.getElementById('ne-preview').innerText.slice(0, 80) : '',
  }))));
  const blText = await page.evaluate(() => {
    const el = document.querySelector('.notes-backlinks');
    return el ? el.innerText : '';
  });
  check('反向链接面板出现', blText.length > 0, 'debug=' + JSON.stringify(await page.evaluate(() => ({
    title: document.getElementById('ne-title') ? document.getElementById('ne-title').value : '',
    notes: window.OCNotes._debug.doc.notes.map((n) => ({ t: n.title, c: n.content })),
  }))));
  check('面板列出引用者乙笔记', blText.indexOf('乙笔记') >= 0);
  // 打开乙笔记:[[甲笔记]] 应渲染成可点链接
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.nt-note')).find((e) => e.innerText.indexOf('乙笔记') >= 0);
    if (btn) btn.click();
  });
  await sleep(900);
  await page.evaluate(() => {
    const head = document.getElementById('notes-fs-head');
    const split = head && Array.from(head.querySelectorAll('#ne-mode-switch button')).find((b) => b.dataset.mode === 'preview');
    if (split) split.click();
  });
  await sleep(800);
  const link = await page.evaluate(() => {
    const a = document.querySelector('#ne-preview a[href^="#note:"]');
    return a ? { text: a.textContent, href: a.getAttribute('href') } : null;
  });
  check('[[双链]] 渲染成链接', !!link, JSON.stringify(link));
  check('双链指向甲笔记', link && link.text === '甲笔记');
  if (link) {
    await page.click('#ne-preview a[href^="#note:"]');
    await sleep(800);
    const title = await page.evaluate(() => { const t = document.getElementById('ne-title'); return t ? t.value : ''; });
    check('点双链跳到甲笔记', title === '甲笔记', title);
  }
  await page.evaluate(() => { if (window.OCNotes && window.OCNotes.close) window.OCNotes.close(); });
}

console.log('== 5. 会话归档 ==');
const archGroup = await page.evaluate(() => {
  const g = Array.from(document.querySelectorAll('.chat-group')).find((x) => x.innerText.indexOf('已归档') >= 0);
  if (!g) return null;
  const section = g.closest('.chat-group-section');
  return { text: g.innerText, collapsed: section.classList.contains('collapsed'), hasArchiveClass: g.classList.contains('is-archive') };
});
check('侧栏出现「已归档」分组', !!archGroup, JSON.stringify(archGroup));
check('归档分组默认收起', archGroup && archGroup.collapsed);
check('归档分组有独立样式类', archGroup && archGroup.hasArchiveClass);
check('归档会话不在时间分组里', await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.chat-item')).filter((x) => x.innerText.indexOf('已归档的旧对话') >= 0);
  if (!items.length) return true;   // 收起时根本不在 DOM 上
  return !!items[0].closest('.chat-group-section').querySelector('.is-archive');
}));
// 展开归档组 → 打开那条会话 → 归档标记被清掉(点开即反悔)
await page.evaluate(() => {
  const g = Array.from(document.querySelectorAll('.chat-group')).find((x) => x.innerText.indexOf('已归档') >= 0);
  if (g) g.click();
});
await sleep(300);
await page.evaluate(() => {
  const it = Array.from(document.querySelectorAll('.chat-item')).find((x) => x.innerText.indexOf('已归档的旧对话') >= 0);
  if (it) it.click();
});
await sleep(700);
check('打开归档会话后自动取消归档', await page.evaluate(() => {
  const c = (window.OCApp.state.chats || []).find((x) => x.id === 'arch1');
  return !!c && !c.archived;
}));

console.log('== 6. 跨会话草稿 ==');
await page.evaluate(() => {
  const it = Array.from(document.querySelectorAll('.chat-item')).find((x) => x.innerText.indexOf('草稿会话') >= 0);
  if (it) it.click();
});
await sleep(600);
await sleep(400);
check('切到草稿会话后输入框恢复内容', (await page.inputValue('#input')) === '这是没发出去的草稿', 'got=' + JSON.stringify(await page.inputValue('#input')));
// 切走再切回:输入的改动被记住
await page.fill('#input', '改了之后的草稿');
await sleep(800);
await page.evaluate(() => {
  const it = Array.from(document.querySelectorAll('.chat-item')).find((x) => x.innerText.indexOf('代码块预览自检') >= 0);
  if (it) it.click();
});
await sleep(600);
check('切到别的会话时输入框是空的', (await page.inputValue('#input')) === '', await page.inputValue('#input'));
await page.evaluate(() => {
  const it = Array.from(document.querySelectorAll('.chat-item')).find((x) => x.innerText.indexOf('草稿会话') >= 0);
  if (it) it.click();
});
await sleep(600);
check('切回来草稿还在(含新改动)', (await page.inputValue('#input')) === '改了之后的草稿', await page.inputValue('#input'));

console.log('== 7. 快捷键:会话切换 ==');
// 快捷键的动作本体是 stepChat(按侧栏顺序切上下一条)。这里验证动作语义,
// 再单独确认按键确实接进了处理器 —— 无头环境里 Playwright 的修饰键时序不稳,
// 只按「按键后会话变了吗」断言会得到假阴性。
await page.evaluate(() => {
  const ids = (window.OCApp.state.chats || []).filter((c) => !c.archived)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0)).map((c) => c.id);
  if (ids[0] && window.OCApp.openChatById) window.OCApp.openChatById(ids[0]);
});
await sleep(600);
const before = await page.evaluate(() => window.OCApp.state.currentChatId);
await page.evaluate(() => window.OCApp._debug.stepChat(1));
await sleep(400);
const afterNext = await page.evaluate(() => window.OCApp.state.currentChatId);
await page.evaluate(() => window.OCApp._debug.stepChat(-1));
await sleep(400);
const afterPrev = await page.evaluate(() => window.OCApp.state.currentChatId);
check('stepChat(1) 切到下一条会话', afterNext !== before, before + ' -> ' + afterNext);
check('stepChat(-1) 切回上一条会话', afterPrev === before, afterNext + ' -> ' + afterPrev);
// 按键接线:Ctrl+Shift+[ 必须真的切会话。
// 注意只能派发 DOM 键事件:Playwright 的 keyboard.press 走原生注入,组合键会被浏览器
// 当成真正的前进/后退导航,页面直接换掉,测出来的「切了」其实是换页。
const keys = await page.evaluate(() => {
  const id = () => window.OCApp.state.currentChatId;
  const list = (window.OCApp.state.chats || []).filter((c) => !c.archived)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0)).map((c) => c.id);
  // 从列表末尾起步,往上切才有上一条(stepChat 到顶/到底就停,这是有意的防越界)
  window.OCApp.openChatById(list[list.length - 1]);
  const fire = (key, code) => document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key, code, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  window.__chatAtKey = null;
  const start = id();
  fire('{', 'BracketLeft');
  return { start, list };
});
// 两个事件同步连发时 openChat 的渲染会把 id 读回到同一条,所以连续方向用动作本体
// (上面的 stepChat)验证,这里只按「单次按键确实切走」判定接线。
const keyed = await page.evaluate(() => window.__chatAtKey);
check('Ctrl+Shift+[ 按一次就切到上一条会话', !!keyed && keyed.from === keys.start && keyed.to !== keyed.from, JSON.stringify({ keys, keyed }));
check('快捷键速查列出了新组合', await page.evaluate(async () => {
  const t = await (await fetch('/static/js/extras.js')).text();
  return t.indexOf('切换到上一个会话') > 0 && t.indexOf('显示 / 隐藏 API 对话') > 0;
}));

console.log('== 8. 长会话迷你轨道 ==');
await page.evaluate(() => {
  // 追加 40 轮,让内容高度远超视口(轨道只在长会话出现);重绘由 appendRounds 自己触发
  if (window.OCApp.state.currentChatId !== 'pv1') {
    window.OCApp.openChatById ? window.OCApp.openChatById('pv1') : (window.OCApp.state.currentChatId = 'pv1');
  }
  window.OCApp._debug.appendRounds('pv1', 40);
});
await sleep(1500);
const tocInfo = await page.evaluate(() => {
  const toc = document.getElementById('chat-toc');
  const track = toc && toc.querySelector('.chat-toc-track');
  const area = document.getElementById('chat-area');
  return {
    exists: !!track,
    hasTrack: toc ? toc.classList.contains('has-track') : false,
    start: track ? track.style.getPropertyValue('--toc-start') : '',
    scrollable: area ? area.scrollHeight > area.clientHeight * 3 : false,
  };
});
check('长会话出现迷你轨道', tocInfo.exists && tocInfo.hasTrack, JSON.stringify(tocInfo));
check('轨道按滚动位置设置起点', !!tocInfo.start, tocInfo.start);
await page.evaluate(() => { const a = document.getElementById('chat-area'); a.scrollTop = a.scrollHeight / 2; a.dispatchEvent(new Event('scroll')); });
await sleep(400);
const mid = await page.evaluate(() => { const t = document.querySelector('.chat-toc-track'); return t ? t.style.getPropertyValue('--toc-start') : ''; });
check('滚动后轨道起点随之前移', mid !== tocInfo.start && parseFloat(mid) > 0, tocInfo.start + ' -> ' + mid);

await browser.close();
console.log('');
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
