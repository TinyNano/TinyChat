/* v2.2.0 功能源码契约自检:
 *   node tests/v220-contracts.js
 *
 * 这一批功能里有好几处「接错一根线、功能照常、只是不再成立」的地方,读 diff 看不出来:
 *   1) HTML/SVG 预览 iframe 的 sandbox 少一个词(allow-same-origin)就不再隔离;
 *   2) 工具调用在同步白名单里漏放行,服务端一保存就把 tool_calls 抹掉,会话从此发不出去;
 *   3) 设备令牌里的 sid 没被校验,「退出该设备」等于没做;
 *   4) 发新会话的每条路径(tc_set_chats)都该刷新搜索索引,漏一处就搜不到新内容;
 * 这些用源码断言钉住,真实行为由 tests/e2e.sh 管。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let fail = 0;
const check = (m, c, d) => {
  if (c) console.log('  ✓ ' + m);
  else { fail++; console.log('  ✗ ' + m + (d ? ' —— ' + d : '')); }
};
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------- 1) 代码块实时预览 ----------
const preview = read('static/js/preview.js');
check('preview.js 存在且导出 OCPreview', /window\.OCPreview\s*=\s*P/.test(preview));
const sb = preview.match(/P\.sandboxFor\s*=\s*function[\s\S]*?\n  \};/);
check('找到 sandboxFor', !!sb);
const sbSrc = sb ? sb[0] : '';
check('预览 sandbox 不带 allow-same-origin', !/allow-same-origin/.test(sbSrc.replace(/\/\/.*$/gm, '')), '带上了就等于把 oc_token 交给模型输出');
check('预览 sandbox 不带 allow-popups-to-escape-sandbox', !/allow-popups-to-escape-sandbox/.test(sbSrc));
check('预览 sandbox 不带 allow-top-navigation', !/allow-top-navigation/.test(sbSrc));
check('脚本按需开启(默认不带 allow-scripts)', /allowScripts\s*\?\s*\(common \+ ' allow-scripts'\)/.test(sbSrc));
check('srcdoc 用属性赋值而不是拼进 innerHTML', /frame\.srcdoc\s*=/.test(preview) && !/innerHTML\s*=.*srcdoc/.test(preview));
check('渲染器在 enhance 里挂预览', /OCPreview\.enhance\(container\)/.test(read('static/js/renderer.js')));
check('index.html 引入 preview.min.js', /static\/js\/preview\.min\.js/.test(read('index.html')));
check('分享页也引入 preview.min.js(分享出去的 HTML 代码块同样能预览)', /static\/js\/preview\.min\.js/.test(read('share.html')) && /static\/js\/preview\.min\.js/.test(read('note-share.html')));

// ---------- 2) Function calling 透传 ----------
const api = read('lib/api.php');
const chatSan = api.slice(api.indexOf('function tc_sanitize_chats'));
const chatSanBody = chatSan.slice(0, chatSan.indexOf('\nfunction ', 10));
check('同步白名单放行 role=tool', /array\('user', 'assistant', 'system', 'tool'\)/.test(chatSanBody));
check('同步白名单保留 tool_call_id', /\$msg\['tool_call_id'\]/.test(chatSanBody));
check('同步白名单保留 toolCalls', /\$msg\['toolCalls'\]/.test(chatSanBody));
const proxy = read('lib/proxy.php');
check('上游请求体不做 tools 字段的删改', !/\$k === 'tools'|\$k === 'tool_choice'/.test(proxy), 'tc_prepare_upstream_body 不能过滤 tools/tool_choice');
check('响应体原样回传(非流式直接 echo)', /echo \$res\['body'\];/.test(proxy));
check('API 会话落库保留工具调用', /tool_call_id/.test(proxy) && /toolCalls/.test(proxy));
const app = read('static/js/app.js');
check('前端流式累加 tool_calls', /OCTools\.applyStreamDelta/.test(app));
check('前端请求体回放 tool_calls', /chatApiMessage\(m, format\)/.test(app));
check('上下文裁剪时工具结果跟随调用方', /withToolPairs\(/.test(app));
check('工具结果消息不单独成气泡', /isToolMessage\(msgs\[i\]\)\) continue;/.test(app));
check('index.html 引入 tools.min.js', /static\/js\/tools\.min\.js/.test(read('index.html')));

// ---------- 3) 会话搜索 ----------
const idxRoute = read('index.php');
check('注册会话搜索路由', /'tc_api_chats_search'/.test(idxRoute));
check('注册重建索引路由', /'tc_api_chats_search_reindex'/.test(idxRoute));
const saveSec = api.slice(api.indexOf('function tc_api_sync_save_chats'));
const saveBody = saveSec.slice(0, saveSec.indexOf('\nfunction ', 10));
check('保存会话后刷新搜索索引', /tc_search_refresh_after_save\(\$user\['id'\], \$chats\)/.test(saveBody));
const search = read('lib/search.php');
check('FTS5 未启用时返回 false 而不是抛错', /catch \(Throwable \$e\) \{\s*\n\s*\$ready = false;/.test(search));
check('索引剔除 base64 图片', /base64,/.test(search) && /preg_replace/.test(search));
const conv = read('static/js/conversations.js');
check('服务端搜索结果单独渲染', /C\.searchList\s*=/.test(conv));
check('搜索片段只认 <mark> 标签', /<mark>/.test(conv) && !/split\(\/\(<b>/.test(conv));

// ---------- 4) 登录设备管理 ----------
const core = read('lib/core.php');
check('令牌里写入 sid', /\$payload\['sid'\]\s*=\s*\(string\) \$sid/.test(core));
check('验证令牌时核对 sid', /tc_device_session_ok\(\$u, \$payload\)/.test(core));
const dev = read('lib/devices.php');
check('设备名单有上限', /TC_SESSIONS_MAX/.test(dev) && /array_slice\(\$list, 0, TC_SESSIONS_MAX, true\)/.test(dev));
check('退出设备接口校验归属', /不存在|已下线/.test(dev));
check('注册路由齐全', /tc_api_me_devices'/.test(idxRoute) && /tc_api_me_devices_revoke_others'/.test(idxRoute) && /tc_api_me_device_revoke'/.test(idxRoute));
check('登录/注册/游客/第三方/两步验证都登记设备', ['tc_api_register', 'tc_api_login', 'tc_api_guest_login', 'tc_api_auth_mfa'].every((fn) => {
  const sec = api.slice(api.indexOf('function ' + fn));
  return /tc_device_register\(/.test(sec.slice(0, sec.indexOf('\nfunction ', 10)));
}) && /tc_device_register\(/.test(read('lib/oauth.php')));
check('改密码保留当前设备、只踢其它设备', /旧行为是 tv\+1/.test(api));

// ---------- 5) 语义搜索 ----------
const sem = read('lib/semantic.php');
check('向量运算不走外部扩展(纯 PHP 点积)', /function tc_vec_dot/.test(sem) && /sqrt\(/.test(sem));
check('向量按用户存文件并原子写入', /rename\(\$tmp, \$file\)/.test(sem));
check('未开启时接口安全回退', /function tc_semantic_public/.test(sem) && /'enabled' => \(bool\) \$cfg\['enabled'\]/.test(sem));
check('/api/me 下发 semantic 开关', /'semantic' => function_exists\('tc_semantic_public'\)/.test(api));
check('内容未变不重复烧额度', /sha1\(\$text\)/.test(sem) && /'indexed' => 0/.test(sem));

// ---------- 6) 笔记反向链接 ----------
const notes = read('static/js/notes.js');
check('支持 [[标题]] 双链', /LINK_RE/.test(notes) && /wikilinkToMarkdown/.test(notes));
check('渲染时先替换双链再进渲染管线', /const src = wikilinkToMarkdown\(md\)/.test(notes));
check('反向链接面板', /function renderBacklinks/.test(notes));
check('双链点击不跳出笔记界面', /a\[href\^="#note:"\]/.test(notes));

console.log('');
console.log(fail ? '结果: ' + fail + ' 条不通过' : '结果: 全部通过');
process.exit(fail ? 1 : 0);
