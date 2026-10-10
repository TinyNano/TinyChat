/* v2.0.165 新功能的源码契约自检: node tests/new-features-contracts.js
 *
 * 这批功能横跨前后端十几处接线,「少接一根线」表现为静默失效(按钮点不动、端点 404、
 * 设置不回显),diff 里极难看漏却极易发生。这里把关键接线钉成源码契约:
 *   1) TOTP:登录流程带 mfa 中间票据,两个登录入口都消费它;新端点已注册路由;
 *   2) 记忆:端点路由存在,proxy 注入点走 tc_append_system_text,前端有提取与管理面板;
 *   3) 收藏:幂等开关端点 + 消息操作栏按钮 + 用户菜单入口;
 *   4) 截断续写:流式与非流式都记录 finish_reason,操作栏有 continue 按钮;
 *   5) 新设置项:后台面板有表单、保存 payload 带字段、归一化有钳制(php 测试覆盖);
 *   6) 默认主题:/api/config 下发 defaultThemePack,app.js 与 login.js 都在「未自选」时应用;
 *   7) extras.js 资源已挂进 index.html(漏挂 = 整个扩展模块静默消失)。
 * 任何一项不合规即失败,退出码非 0,供 CI 使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { fail++; console.log('  ✗ ' + m + (d ? ' —— ' + d : '')); };
const check = (m, c, d) => { if (c) ok(m); else bad(m, d); };
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const loginJs = read('static/js/login.js');
const appJs = read('static/js/app.js');
const uiJs = read('static/js/ui.js');
const messagesJs = read('static/js/messages.js');
const conversationsJs = read('static/js/conversations.js');
const extrasJs = read('static/js/extras.js');
const notesJs = read('static/js/notes.js');
const adminJs = read('static/js/admin.js');
const adminHtml = read('admin.html');
const indexHtml = read('index.html');
const indexPhp = read('index.php');
const apiPhp = read('lib/api.php');
const corePhp = read('lib/core.php');
const proxyPhp = read('lib/proxy.php');
const noteShareHtml = read('note-share.html');

console.log('== 1. TOTP 两步验证 ==');
check('登录响应带 mfa 中间票据(api.php)', /totpSecret.*\n[\s\S]{0,400}tc_json\(200, array\('mfa' => 'totp'/.test(apiPhp) || apiPhp.includes("'mfa' => 'totp'"), 'api.php 缺少 mfa 票据响应');
check('密码通过后对开启 TOTP 的用户不发正式 token', /if \(!empty\(\$found\['totpSecret'\]\)\)/.test(apiPhp));
check('/api/auth/mfa 已注册路由', indexPhp.includes("array('POST', '#^/api/auth/mfa$#', 'tc_api_auth_mfa')"));
check('登录页消费 mfa 票据(login.js)', loginJs.includes("data.mfa === 'totp' && data.ticket"));
check('主站登录弹窗消费 mfa 票据(app.js)', appJs.includes("d.mfa === 'totp' && d.ticket"));
check('共用验证码弹窗 UI.totpGate(ui.js)', uiJs.includes('UI.totpGate = function (ticket, onSuccess'));
check('TOTP 启用需验证码确认', /totp\/enable/.test(indexPhp) && /tc_api_me_totp_enable/.test(apiPhp));
check('TOTP 密钥不随 sanitize 下发', !/['"]totpSecret['"]\s*=>/.test(corePhp.split('function tc_sanitize_user')[1] ? corePhp.split('function tc_sanitize_user')[1].split('}')[0] : ''), 'sanitize_user 白名单泄漏了密钥');

console.log('== 2. 跨对话记忆 ==');
check('记忆端点路由已注册', indexPhp.includes("'tc_api_memories_list'") && indexPhp.includes("'tc_api_memories_auto'") && indexPhp.includes("'tc_api_memories_delete'"));
check('proxy 在事务内拼好注入文本', proxyPhp.includes("'memoryPrompt'") && proxyPhp.includes('tc_memories_prompt_text'));
check('proxy 只对正式对话注入(_purpose 为空)', /!empty\(\$db\['settings'\]\['memoryEnabled'\]\) && isset\(\$b\['_purpose'\]\) && \(string\) \$b\['_purpose'\] === ''/.test(proxyPhp));
check('注入走 tc_append_system_text(两种格式兼容)', /if \(!empty\(\$ctx\['memoryPrompt'\]\)\) \{\s*\n\s*tc_append_system_text\(\$body, \$format, \$ctx\['memoryPrompt'\]\);/.test(proxyPhp));
check('前端对话后有节流提取钩子', appJs.includes('window.OCExtras.afterReplyTurn(chat)'));
check('设置面板有记忆开关与管理入口', indexHtml.includes("id=\"pref-memory\"") && indexHtml.includes('pref-memory-manage'));
check('记忆偏好随云同步白名单(api.php)', apiPhp.includes("'memoryOn'") && apiPhp.includes("'customInstructions'"));

console.log('== 3. 消息收藏 ==');
check('收藏端点路由已注册(幂等开关)', indexPhp.includes("'tc_api_favorites_toggle'") && indexPhp.includes("'tc_api_favorites_list'"));
check('消息操作栏有收藏按钮', messagesJs.includes('data-act="fav"'));
check('操作栏接线 onFav hook(app.js)', appJs.includes('toggleFavoriteMessage(mm, chat, btn, willFav)'));
check('用户菜单有收藏入口', indexHtml.includes('user-menu-favorites'));
check('亮星缓存按 chatId:msgId 判定(buildMsgNode)', appJs.includes("state._favSet.has((chat.id || '') + ':' + (m._id || ''))"));

console.log('== 4. 截断续写 ==');
check('流式记录 finish_reason(chat 格式)', appJs.includes('captureFinishReason') && /j\.choices\[0\]\.finish_reason/.test(appJs));
check('非流式同样记录 finish_reason', /data\.choices\[0\]\.finish_reason/.test(appJs));
check('anthropic 的 max_tokens 也归一为 length', /stop_reason === 'max_tokens' \? 'length'/.test(appJs));
check('操作栏有继续生成按钮(length 才显示)', messagesJs.includes("data-act=\"continue\"") && /msg\.finishReason === 'length' && hooks\.onContinue/.test(messagesJs));
check('继续生成走 continueFrom 管线', /async function continueAssistantReply[\s\S]{0,600}\{ continueFrom: msg \}/.test(appJs));

console.log('== 5. 新设置项(后台) ==');
check('后台有功能与安全区块', adminHtml.includes('memory-enabled') && adminHtml.includes('totp-enabled') && adminHtml.includes('login-alert-enabled'));
check('后台保存 payload 带新字段', /memoryEnabled:!\!\(\$\('memory-enabled'\)/.test(adminJs) && /defaultThemePack:\(\$\('default-theme-pack'\)/.test(adminJs));
check('后台回显新字段', adminJs.includes("set('default-theme-pack', s.defaultThemePack || 'default')"));
check('core 默认值表带新键', corePhp.includes("'memoryEnabled' => true") && corePhp.includes("'defaultThemePack' => 'default'") && corePhp.includes("'quotaWarnBelow' => 0"));
check('额度预警挂进结算路径', /tc_quota_warn_check\(\$db, \$db\['users'\]\[\$i\]\)/.test(corePhp) && /tc_quota_warn_check\(\$db, \$user\)/.test(corePhp));
check('邮件队列在 shutdown 阶段投递', indexPhp.includes("register_shutdown_function('tc_mailq_shutdown_drain')") && corePhp.includes('function tc_mailq_shutdown_drain'));
check('审计埋点落在管理员端点', (apiPhp.match(/tc_audit\(/g) || []).length >= 10, '审计调用不足 10 处');
check('日志端点支持 kind 筛选', apiPhp.includes("isset($q['kind'])"));

console.log('== 6. 站点默认主题 ==');
check('/api/config 下发 defaultThemePack', apiPhp.includes("'defaultThemePack' => isset($s['defaultThemePack'])"));
check('app.js 在未自选主题时应用默认主题', appJs.includes("window.OCUI.applyThemePack(pack, { persist: false })"));
check('login.js 同样应用默认主题', loginJs.includes('defaultThemePack'));
check('用户自选过的主题不被覆盖(检查 themePack 触碰判断)', /raw\.themePack !== undefined/.test(appJs) && /raw\.themePack !== undefined/.test(loginJs));
check('方块主题文件存在且被主题目录引用', fs.existsSync(path.join(root, 'static/css/theme-block.css')));

console.log('== 7. extras.js 接线 ==');
check('extras.js 已挂进 index.html', indexHtml.includes('static/js/extras.min.js'));
check('朗读按钮与语音输入按钮已接线', messagesJs.includes('data-act="speak"') && indexHtml.includes('id="stt-btn"'));
check('斜杠指令挂进输入事件', appJs.includes('window.OCExtras.onInputChanged()') && appJs.includes('window.OCExtras.onInputKeydown(e)'));
check('快捷键:Ctrl+K 搜索 / Ctrl+Shift+O 新会话 / ? 速查', conversationsJs.includes("handlers.onFocusSearch") && conversationsJs.includes("e.shiftKey && k === 'o'") && conversationsJs.includes("e.key === '?'"));
check('快捷键速查弹窗出口存在', extrasJs.includes('openShortcutsModal'));
check('每日摘要卡片挂载点存在', indexHtml.includes('digest-card-holder'));
check('会话右键菜单有导出项', conversationsJs.includes("'export', label: '导出 Markdown'") && appJs.includes('onExport: (c) =>'));
check('用量页有 14 天趋势容器', indexHtml.includes('usage2-trend') && appJs.includes('usage-trend-bar'));
check('笔记分享可勾选允许留言', notesJs.includes("id=\"ns-comments\"") && apiPhp.includes("'allowComments' => $allowComments"));
check('分享页有留言表单与发送端点', noteShareHtml.includes('share-cmt-send') && noteShareHtml.includes("/api/notes/shared/' + token + '/comment"));
check('笔记云端版本推送与恢复', notesJs.includes('/api/notes/versions') && apiPhp.includes('tc_api_note_versions_push') && indexPhp.includes("'tc_api_note_versions_push'"));
check('ntv: 分片键接入装配与提交', corePhp.includes("strncmp($k, 'ntv:', 4)") && corePhp.includes("'ntv:' . $uid"));

console.log('');
if (fail) { console.log('失败 ' + fail + ' 项'); process.exit(1); }
console.log('全部通过');
