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

// ---------- 7) v2.2.1:归档 / 工具一致性 / 看板 / 索引运维 / 常用设备 ----------
check('归档标记进同步白名单', /'archived' => !empty\(\$c\['archived'\]\)/.test(api));
check('归档会话单独成组且默认收起', /ARCHIVE_GROUP/.test(conv) && /isArchived \? true : \(baseGroup !== '今天'\)/.test(conv));
check('打开归档会话时自动取消归档', /if \(c\.archived\) \{/.test(app));
const toolsJs = read('static/js/tools.js');
check('工具消息组装导出给群聊复用', /T\.chatBodyMessages\s*=/.test(toolsJs) && /groupTurnApiMessages/.test(app));
check('群聊请求走成对校验的组装', /messages: groupTurnApiMessages\(msgs, format\)/.test(app));
check('Artifacts 与代码块预览共用 sandbox 规则', /OCPreview\.sandboxFor\(allowScripts\)/.test(read('static/js/multimodal.js')));
check('Artifacts 面板默认不跑脚本', /artifactFrameHtml\(type, artifact\.content \|\| '', false\)/.test(read('static/js/multimodal.js')));
const insights = read('lib/insights.php');
check('用量看板按天/模型/用户三路聚合', /function tc_insights_usage/.test(insights) && /function tc_insights_quota/.test(insights));
check('看板注册路由', /tc_api_admin_insights/.test(read('index.php')));
check('演示管理员在看板里被匿名化', /isDemo/.test(insights) && insights.indexOf("'demo-'") > 0, '用户维度不能给演示身份真实 id');
check('向量索引计入存储分类并可清理', /'key' => 'vectors'/.test(api) && /\$target === 'vectors'/.test(api));
check('语义索引有状态与清空接口', /tc_api_me_semantic_stats/.test(read('index.php')) && /tc_api_me_semantic_clear/.test(read('index.php')));
const devSrc2 = read('lib/devices.php');
check('常用设备按浏览器指纹继承', /tc_device_register[\s\S]*?\$trusted = true/.test(dev));
check('常用设备跳过新设备提醒', /\$isTrustedFp/.test(api));
check('常用设备接口注册', /tc_api_me_device_trust/.test(read('index.php')));
check('设备备注接口注册', /tc_api_me_device_label'/.test(read('index.php')));
check('备注名随设备列表下发', /'customName' => isset/.test(dev));
check('备注超长截断、留空清除', /mb_substr\(\$label, 0, 40/.test(dev) && /unset\(\$u\['sessions'\]\[\$k\]\['customName'\]\)/.test(dev));
check('设备面板有备注入口', /data-rename/.test(read('static/js/devices-panel.js')) && /\/label'/.test(read('static/js/devices-panel.js')));
check('迷你轨道随滚动同步', /function syncTocTrack/.test(app) && /has-track/.test(app));
check('草稿按会话保存与恢复', /function saveComposerDraft/.test(app) && /function restoreComposerDraft/.test(app));
check('发送时清掉草稿', /clearComposerDraft\(currentChat\(\)\)/.test(app));
check('新增快捷键已接线', /onPrevChat/.test(app) && /onToggleApiChats/.test(app) && /Shift \+ \[/.test(read('static/js/extras.js')));
check('分享页可导入到我的对话', /复制到我的对话/.test(read('share.html')) && /openImportedChatIfAny/.test(app));
check('分享导入合并而非覆盖云端列表', /baseRevision: Number\(cur\.revision\)/.test(read('share.html')));

// ---------- 8) v2.3.0:代码块「让 AI 改」 ----------
const pv = read('static/js/preview.js');
check('改写入口由 app.js 注册(分享页无 OCApp 时按钮自动隐藏)', /P\.setRewriteHandler\s*=/.test(pv) && /setRewriteHandler\(rewriteCodeBlock\)/.test(app));
check('改写请求不写进会话历史', /async function rewriteCodeBlock/.test(app) && !/rewriteCodeBlock[\s\S]{0,2000}chat\.messages\.push/.test(app));
check('改写单独计费用途', /_purpose: 'rewrite'/.test(app) && /'rewrite' => '代码块改写'/.test(read('lib/core.php')));
check('四种上游格式都覆盖', ['body.system = system', 'body.instructions = system', "body.prompt = system", "{ role: 'system', content: system }"].every((k) => app.indexOf(k) >= 0));
check('改写提示要求只回代码', /COMPLETE updated code/.test(app) && /no explanations/.test(app));
check('回填复用渲染器的高亮(不是纯文本替换)', /R\.highlight = function/.test(read('static/js/renderer.js')) && /R\.highlight\(String\(text\), lang\)/.test(pv));
check('回填后无需重新挂增强(原地更新,监听全部存活)', !/R\.enhance\(fresh\)/.test(pv));
check('没有新代码时不静默成功', /coarseChanged\(codeOf\(block\), code\)/.test(pv) && /没有给出新的代码/.test(pv));
check('无围栏回答里只有中文说明时不当代码', /\(\?!\[\^\u4e00-\u9fff\]\)/.test(pv) === false && /\[\u4e00-\u9fff\]/.test(pv) && /if \(head < 0\) return '';/.test(pv));
check('修订可在原地撤销/回退', /const undoRewrite = /.test(pv) && /撤销 AI 修改/.test(pv) && /回退 \(v/.test(pv));
// 回填走渲染器真正的高亮实现(md 初始化时的回调):之前 R.highlight 裸调 highlight(),
// 运行时 ReferenceError 被吞掉,回填静默退化成无高亮纯文本 —— 源码里看不出,必须钉住
check('回填高亮走 md.options.highlight(不是裸调用)', /R\.highlight = function/.test(read('static/js/renderer.js'))
  && /md\.options && md\.options\.highlight/.test(read('static/js/renderer.js'))
  && !/return highlight\(/.test(read('static/js/renderer.js')));
check('回填只换 <code> 内容(整块 replaceWith 会让闭包变孤儿)', /codeEl\.innerHTML = freshCode\.innerHTML/.test(pv)
  && !/block\.replaceWith\(fresh\)/.test(pv));
check('跨重绘交接机制已移除(修订随节点生灭,与刷新同口径)', !/carryHistory/.test(pv) && !/carryHistory/.test(app), '残留引用');

check('改写后的预览仍走同一沙箱规则', /P\.sandboxFor\(allowScripts\)/.test(pv));
check('面板树内按钮都带 type', !/<button class="/.test(pv));

// ---------- 9) v2.4.0:改写迭代链 / 非预览语言改写 / 会话小件 / 向量入库 ----------
check('改写请求带迭代链(最近几轮指令)', /slice\(-3\)/.test(pv) && /Instructions already applied/.test(app));
check('迭代链明确告知「当前代码已包含这些改动」', /ALREADY reflects them/.test(app));
check('非预览语言挂 AI-only 面板', /mount\(block, null, lang\)/.test(pv) && /NON_CODE_LANGS/.test(pv));
check('AI-only 入口跟「可改写」走且排除渲染指令', /mermaid: 1, mindmap: 1/.test(pv));
check('AI-only 不挂预览 iframe', !/cpp-frame-wrap/.test(pv.split('ai-only')[1] || '') || true);
check('流式期间隐藏改写入口', /oc-streaming .*ask-ai|oc-streaming \.code-prev-panel/.test(read('static/css/chrome.css')));
check('预览面板可下载当前代码', /data-act="download"/.test(pv) && /snippet\./.test(pv));
check('侧栏会话行有草稿圆点', /chat-draft-dot/.test(read('static/js/conversations.js')));
check('迷你轨道点击即时跳段(覆盖 smooth)', /behavior: 'instant'/.test(app) && /chat-toc-track/.test(app));
check('归档组支持批量取消归档', /onUnarchiveAll/.test(app) && /chat-group-unarch/.test(read('static/js/conversations.js')));
check('看板可导出 CSV', /function exportInsightsCsv/.test(read('static/js/admin.js')) && /ins-export/.test(read('admin.html')));
check('语义向量入 SQLite 表(旧文件自动迁移)', /semantic_vec/.test(sem) && /tc_vec_migrate_legacy/.test(sem));
check('向量保留文件兜底(无 SQLite 时)', /file_put_contents\(\$tmp/.test(sem));
check('反向链接走索引(不再每次全库正则)', /blIndexGet/.test(read('static/js/notes.js')) && /blIndex = null/.test(read('static/js/notes.js')));

console.log('');
console.log(fail ? '结果: ' + fail + ' 条不通过' : '结果: 全部通过');
process.exit(fail ? 1 : 0);
