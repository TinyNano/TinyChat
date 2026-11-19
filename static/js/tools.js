'use strict';
/**
 * tools.js — Function calling(tool_calls)在前台的呈现与回放。
 *
 * 服务端做的是「透传保障」(lib/proxy.php 的 tc_prepare_upstream_body / tc_upstream_auth_headers
 * 与流式分支都不动 tools 相关字段);这里负责三件事:
 *   1) 会话里**保存**工具调用与工具结果:刷新页面后模型的历史仍然完整,下一轮不会因为
 *      丢了 tool_call_id 而让上游报「tool 消息没有对应的调用」;
 *   2) 发请求时把它们**还原**成 OpenAI 的 assistant.tool_calls / role:"tool" 结构;
 *   3) 在气泡里画成紧凑的「工具调用过程」chip:调用了什么、参数、结果,失败标红。
 *
 * 字段形状(会话消息上的附加字段,随云同步一起走):
 *   assistant 消息: m.toolCalls = [{ id, type:'function', function:{ name, arguments } }]
 *   assistant 消息: m.finishReason = 'tool_calls'
 *   tool 消息:      { role:'tool', tool_call_id, name, content, toolError? }
 * tool 消息在界面上不单独占一个气泡,挂在发起它的那条 assistant 消息下面(见 app.js 渲染)。
 */
(function () {
  const T = {};

  // 参数展示上限:工具参数常带整页 HTML / 长 JSON,整套塞进 chip 会把会话撑爆
  const ARGS_PREVIEW = 600;
  const RESULT_PREVIEW = 1200;

  function textOf(v) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return '';
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  // OpenAI 流式里 arguments 是**按片段**下发的字符串,必须按 index 拼接后再解析
  function parseArgs(raw) {
    const s = String(raw || '').trim();
    if (!s) return { ok: true, value: {} };
    try { return { ok: true, value: JSON.parse(s) }; } catch (e) { return { ok: false, value: s }; }
  }

  // 从非流式响应的 message 里取 tool_calls(+ 现存的旧式 function_call)
  T.fromMessage = function (msg) {
    if (!msg || typeof msg !== 'object') return [];
    const out = [];
    if (Array.isArray(msg.tool_calls)) {
      msg.tool_calls.forEach((c, i) => {
        if (!c || typeof c !== 'object') return;
        const fn = c.function && typeof c.function === 'object' ? c.function : {};
        out.push({
          id: String(c.id || ('call_' + i)),
          type: 'function',
          function: { name: String(fn.name || ''), arguments: textOf(fn.arguments) },
        });
      });
    }
    if (!out.length && msg.function_call && typeof msg.function_call === 'object') {
      out.push({
        id: 'call_legacy',
        type: 'function',
        function: { name: String(msg.function_call.name || ''), arguments: textOf(msg.function_call.arguments) },
      });
    }
    return out;
  };

  // 流式增量 → 累积到 assistantMsg.toolCalls。
  // 兼容两种下发形态:OpenAI 的 choices[0].delta.tool_calls[index],与部分网关
  // 在 Responses 里给的 output item(这里只处理 chat 风格的 name/arguments)。
  T.applyStreamDelta = function (msg, j) {
    if (!msg || !j) return false;
    const choice = (j.choices && j.choices[0]) || null;
    const delta = choice && choice.delta ? choice.delta : null;
    const list = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : null;
    if (!list) return false;
    if (!Array.isArray(msg.toolCalls)) msg.toolCalls = [];
    let changed = false;
    list.forEach((c, pos) => {
      if (!c || typeof c !== 'object') return;
      const idx = Number.isInteger(c.index) ? c.index : pos;
      while (msg.toolCalls.length <= idx) msg.toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
      const slot = msg.toolCalls[idx];
      if (c.id) slot.id = String(c.id);
      const fn = c.function || {};
      if (fn.name) slot.function.name += String(fn.name);
      if (typeof fn.arguments === 'string') slot.function.arguments += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') slot.function.arguments += textOf(fn.arguments);
      changed = true;
    });
    return changed;
  };

  // 请求体里还原历史:assistant 消息带回 tool_calls,tool 消息原样带上 tool_call_id。
  // 没有 id 的残缺调用会被跳过 —— 上游拿到「tool 消息对不上调用」会以 400 拒绝整段历史,
  // 一条残缺记录会让这个会话之后的每一轮都发不出去。
  T.toApiMessage = function (m, content) {
    if (!m || typeof m !== 'object') return null;
    if (m.role === 'tool') {
      const id = String(m.tool_call_id || '');
      if (!id) return null;
      return { role: 'tool', tool_call_id: id, content: textOf(m.content) };
    }
    if (m.role === 'assistant' && T.hasCalls(m)) {
      const calls = m.toolCalls.filter((c) => c && c.id && c.function && c.function.name).map((c) => ({
        id: String(c.id),
        type: 'function',
        // 参数一字不改地回传:Agent 框架会在下一轮校验自己发出的参数,格式化了就「对不上」
        function: { name: String(c.function.name), arguments: String(c.function.arguments || '') },
      }));
      if (!calls.length) return null;
      const out = { role: 'assistant', content: content === undefined ? textOf(m.content) : content, tool_calls: calls };
      return out;
    }
    return null;
  };

  T.hasCalls = function (msg) {
    return !!(msg && Array.isArray(msg.toolCalls) && msg.toolCalls.length);
  };

  // 参数 / 结果一段一段格式化,不把整块 JSON 压成一行看不懂的长串
  function prettyArgs(call) {
    const parsed = parseArgs(call && call.function ? call.function.arguments : '');
    if (parsed.ok) {
      try { return JSON.stringify(parsed.value, null, 2); } catch (e) { /* 落到原文 */ }
    }
    return textOf(parsed.value);
  }

  function statusOf(call, results) {
    const hit = results.find((r) => r.tool_call_id && r.tool_call_id === call.id);
    if (!hit) return 'pending';
    return hit.toolError ? 'error' : 'done';
  }

  const STATUS_TEXT = { pending: '等待结果', done: '已完成', error: '执行失败' };

  // 「工具调用过程」的给对面看的一行摘要:name + 参数开局。侧栏预览、搜索响应都用它。
  T.skeleton = function (m) {
    const calls = (m && m.toolCalls) || [];
    const brief = calls.slice(0, 3).map((c) => {
      const nm = (c.function && c.function.name) || '工具';
      const args = textOf(c.function && c.function.arguments).replace(/\s+/g, ' ');
      return nm + (args ? ' ' + (args.length > 60 ? args.slice(0, 60) + '…' : args) : '');
    }).join(' · ');
    const more = calls.length > 3 ? ' 等 ' + calls.length + ' 个' : '';
    return '🔧 ' + brief + more;
  };

  // 渲染一组工具调用 chip。results 是紧跟其后的 role:'tool' 消息。
  // 全部用 DOM API 组装并只用 textContent 写内容 —— 参数与结果都是模型/工具给的不可信文本。
  T.renderChips = function (container, calls, results) {
    if (!container || !Array.isArray(calls) || !calls.length) return;
    const box = document.createElement('div');
    box.className = 'tool-calls';
    calls.forEach((call, i) => {
      const name = (call.function && call.function.name) || '工具';
      const status = statusOf(call, results || []);
      const hit = (results || []).find((r) => r.tool_call_id && r.tool_call_id === call.id) || null;
      const chip = document.createElement('details');
      chip.className = 'tool-call tool-' + status;
      chip.dataset.callId = call.id || '';
      const sum = document.createElement('summary');
      sum.className = 'tool-call-head';
      const mark = document.createElement('span');
      mark.className = 'tool-call-mark';
      mark.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'tool-call-name';
      label.textContent = name;
      const st = document.createElement('span');
      st.className = 'tool-call-status';
      st.textContent = STATUS_TEXT[status];
      sum.appendChild(mark);
      sum.appendChild(label);
      sum.appendChild(st);
      chip.appendChild(sum);

      const argsText = prettyArgs(call);
      if (argsText) {
        const aw = document.createElement('div');
        aw.className = 'tool-call-block';
        const at = document.createElement('div');
        at.className = 'tool-call-label';
        at.textContent = '参数';
        const av = document.createElement('pre');
        av.className = 'tool-call-args';
        av.textContent = argsText.length > ARGS_PREVIEW ? argsText.slice(0, ARGS_PREVIEW) + '\n…(已省略)' : argsText;
        aw.appendChild(at);
        aw.appendChild(av);
        chip.appendChild(aw);
      }
      if (hit) {
        const rw = document.createElement('div');
        rw.className = 'tool-call-block';
        const rt = document.createElement('div');
        rt.className = 'tool-call-label';
        rt.textContent = hit.toolError ? '错误' : '结果';
        const rv = document.createElement('pre');
        rv.className = 'tool-call-result';
        const body = textOf(hit.content);
        rv.textContent = body.length > RESULT_PREVIEW ? body.slice(0, RESULT_PREVIEW) + '\n…(已省略)' : body;
        rw.appendChild(rt);
        rw.appendChild(rv);
        chip.appendChild(rw);
      }
      box.appendChild(chip);
      // 只有一条调用时默认展开(内容不多);多条时收起,避免一屏全是参数
      if (calls.length === 1 && i === 0) chip.open = true;
    });
    container.appendChild(box);
  };

  window.OCTools = T;
})();
