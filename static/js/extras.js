'use strict';
/**
 * extras.js — 功能扩展集(全部增量挂载,不侵入既有管线)
 *   · 回复朗读(TTS,speechSynthesis,零服务器成本)
 *   · 语音输入(STT,Web Speech API)
 *   · 输入框斜杠指令(/ 翻译 / 总结 / 润色 …)
 *   · 跨对话记忆:对话后的自动提取 + 设置里的记忆管理面板
 *   · 提示词优化器(先对照预览,确认才替换输入框)
 *   · 快捷键速查(?) / 每日摘要卡片
 * 依赖:window.OCApp(state/api/toast/aiComplete)、window.OCUI、window.OC(icon)。
 * 在 index.html 里排到 app.js 之后加载,由 app.js boot 末尾调用 OCExtras.init()。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n, s) => (window.OC && window.OC.icon ? window.OC.icon(n, s || 14) : '');
  const A = () => window.OCApp || null;
  const toast = (m, bad) => { if (A()) A().toast(m, bad); else if (window.toast) window.toast(m, bad); };
  const pref = (k, d) => { try { const U = window.OCUI; return U && U.getPref ? U.getPref(k, d) : d; } catch (e) { return d; } };
  const setPref = (k, v) => { try { const U = window.OCUI; if (U && U.setPref) U.setPref(k, v); } catch (e) { /* 忽略 */ } };

  // ============================================================
  // 回复朗读(TTS):浏览器 speechSynthesis,不支持的环境自动隐藏按钮
  // ============================================================
  const TTS = {
    current: null,
    btn: null,
    supported() { return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined'; },
    stripMarkdown(text) {
      let t = String(text || '');
      t = t.replace(/```[\s\S]*?```/g, ' (代码块略) ');
      t = t.replace(/`([^`]+)`/g, '$1');
      t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
      t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
      t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
      t = t.replace(/^\s*[-*+]\s+/gm, '');
      t = t.replace(/\|/g, ' ');
      t = t.replace(/[*_~>#]+/g, '');
      t = t.replace(/\$\$?([^$]+)\$\$?/g, '$1');
      return t.trim();
    },
    stop() {
      try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
      if (TTS.btn) TTS.btn.classList.remove('active');
      TTS.current = null;
      TTS.btn = null;
    },
    toggleForMsg(msg, btn) {
      if (!TTS.supported()) return toast('当前浏览器不支持语音朗读', true);
      // 再点一次 = 停止
      if (TTS.current && TTS.current === msg) { TTS.stop(); return; }
      TTS.stop();
      const text = TTS.stripMarkdown(msg && msg.content);
      if (!text) return toast('这条回复没有可朗读的内容', true);
      // 超长回复截断:speechSynthesis 对超长文本会静默失败,按 ~6k 字符分段朗读
      const MAX = 6000;
      const speak = (part, isLast) => {
        const u = new SpeechSynthesisUtterance(part);
        const lang = (navigator.language || 'zh-CN');
        u.lang = lang.indexOf('zh') === 0 ? lang : 'zh-CN';
        const rate = Number(pref('ttsRate', 1)) || 1;
        u.rate = Math.min(2.5, Math.max(0.5, rate));
        u.onend = () => {
          if (!isLast || TTS.current !== msg) { if (isLast && TTS.current === msg) TTS.stop(); return; }
        };
        u.onerror = () => { if (TTS.current === msg) TTS.stop(); };
        window.speechSynthesis.speak(u);
      };
      TTS.current = msg;
      TTS.btn = btn || null;
      if (btn) btn.classList.add('active');
      if (text.length <= MAX) speak(text, true);
      else {
        const parts = [];
        for (let i = 0; i < text.length; i += MAX) parts.push(text.slice(i, i + MAX));
        parts.forEach((p, i) => speak(p, i === parts.length - 1));
      }
      toast('开始朗读,再点一次停止');
    },
  };

  // ============================================================
  // 语音输入(STT):Web Speech API,识别结果写进输入框可再编辑
  // ============================================================
  const STT = {
    rec: null,
    active: false,
    baseText: '',
    supported() {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    },
    toggle() {
      if (!STT.supported()) return toast('当前浏览器不支持语音输入(可用 Chrome / Edge)', true);
      if (STT.active) { try { STT.rec.stop(); } catch (e) { /* 忽略 */ } return; }
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      rec.lang = (navigator.language || 'zh-CN').indexOf('zh') === 0 ? (navigator.language || 'zh-CN') : 'zh-CN';
      rec.continuous = true;
      rec.interimResults = true;
      const input = $('input');
      if (!input) return;
      STT.baseText = input.value ? input.value.replace(/\s+$/, '') + ' ' : '';
      rec.onstart = () => {
        STT.active = true;
        const b = $('stt-btn');
        if (b) b.classList.add('recording');
        toast('正在听写,再次点击结束');
      };
      rec.onresult = (e) => {
        let finalText = '';
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        const merged = STT.baseText + (finalText || interim);
        input.value = merged;
        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (er) { /* 忽略 */ }
      };
      rec.onerror = (e) => {
        if (e && e.error === 'not-allowed') toast('麦克风权限被拒绝,请在浏览器地址栏允许麦克风', true);
        else if (e && e.error !== 'aborted' && e.error !== 'no-speech') toast('语音输入出错: ' + (e.error || ''), true);
      };
      rec.onend = () => {
        STT.active = false;
        const b = $('stt-btn');
        if (b) b.classList.remove('recording');
        if (input) input.focus();
      };
      STT.rec = rec;
      try { rec.start(); } catch (e) { toast('语音输入启动失败', true); }
    },
  };

  // ============================================================
  // 斜杠指令:输入框以 / 开头时浮出模板菜单,选中回填输入框
  // ============================================================
  const SLASH_COMMANDS = [
    { cmd: '/翻译', label: '翻译', tpl: '请把下面的内容翻译成中文(若原文是中文则翻译成英文),保留专有名词与格式:\n\n' },
    { cmd: '/总结', label: '总结', tpl: '请用要点列表总结下面的内容:\n\n' },
    { cmd: '/润色', label: '润色', tpl: '请润色下面的文字,保持原意,使表达更流畅自然:\n\n' },
    { cmd: '/扩写', label: '扩写', tpl: '请把下面的内容扩写成更详细的段落,补充必要的背景与细节:\n\n' },
    { cmd: '/解释', label: '解释', tpl: '请用通俗的语言解释下面的概念或代码:\n\n' },
    { cmd: '/代码审查', label: '代码审查', tpl: '请审查下面这段代码,指出 bug、边界问题与可改进之处:\n\n' },
    { cmd: '/续写', label: '续写', tpl: '请接着下面的内容自然地续写下去:\n\n' },
    { cmd: '/大纲', label: '大纲', tpl: '请为下面的主题拟一份写作大纲:\n\n' },
    { cmd: '/优化提示词', label: '优化提示词(AI 改写我的提问)', tpl: '__OPTIMIZE__' },
  ];
  const Slash = {
    box: null,
    index: 0,
    items: [],
    close() {
      if (Slash.box) { Slash.box.remove(); Slash.box = null; }
      Slash.items = [];
      Slash.index = 0;
    },
    visible() { return !!Slash.box; },
    show() {
      const input = $('input');
      if (!input) return;
      Slash.close();
      const box = document.createElement('div');
      box.className = 'slash-menu';
      box.setAttribute('role', 'listbox');
      Slash.box = box;
      document.body.appendChild(box);
      Slash.fill('');
      Slash.position();
    },
    position() {
      const input = $('input');
      const box = Slash.box;
      if (!input || !box) return;
      const r = input.getBoundingClientRect();
      box.style.left = Math.max(12, r.left) + 'px';
      box.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    },
    fill(q) {
      const box = Slash.box;
      if (!box) return;
      const kw = String(q || '').toLowerCase();
      Slash.items = SLASH_COMMANDS.filter((c) => !kw || c.cmd.toLowerCase().indexOf(kw) >= 0 || c.label.toLowerCase().indexOf(kw) >= 0);
      if (!Slash.items.length) return Slash.close();
      Slash.index = Math.min(Slash.index, Slash.items.length - 1);
      box.innerHTML = Slash.items.map((c, i) =>
        '<button type="button" class="slash-item' + (i === Slash.index ? ' active' : '') + '" role="option" data-cmd="' + esc(c.cmd) + '">'
        + '<span class="slash-cmd">' + esc(c.cmd) + '</span>'
        + '<span class="slash-desc">' + esc(c.label) + '</span></button>'
      ).join('');
      box.querySelectorAll('.slash-item').forEach((el) => {
        el.addEventListener('click', () => Slash.apply(el.getAttribute('data-cmd')));
      });
    },
    move(d) {
      if (!Slash.items.length) return;
      Slash.index = (Slash.index + d + Slash.items.length) % Slash.items.length;
      const box = Slash.box;
      box.querySelectorAll('.slash-item').forEach((el, i) => el.classList.toggle('active', i === Slash.index));
      const cur = box.querySelectorAll('.slash-item')[Slash.index];
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    },
    apply(cmd) {
      const input = $('input');
      const c = SLASH_COMMANDS.find((x) => x.cmd === cmd);
      Slash.close();
      if (!input || !c) return;
      if (c.tpl === '__OPTIMIZE__') {
        // 提示词优化:不需要模板,直接对当前输入做 AI 改写
        if (input.value.trim()) PromptOptimizer.run(input.value.trim());
        else toast('先输入你的问题,再选择「优化提示词」', true);
        return;
      }
      input.value = c.tpl;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* 忽略 */ }
      input.focus();
      // 光标落在模板末尾,方便接着粘贴内容
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* 忽略 */ }
    },
    // 输入框 input/keydown 钩子(app.js 调用)
    onInput() {
      const input = $('input');
      if (!input) return;
      const v = String(input.value || '');
      if (/^\/[^\s]*$/.test(v)) {
        if (!Slash.box) Slash.show();
        Slash.index = 0;
        Slash.fill(v.slice(1));
        Slash.position();
      } else if (Slash.box) {
        Slash.close();
      }
    },
    onKeydown(e) {
      if (!Slash.box) return false;
      if (e.key === 'ArrowDown') { e.preventDefault(); Slash.move(1); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); Slash.move(-1); return true; }
      if (e.key === 'Escape') { Slash.close(); return true; }
      if ((e.key === 'Enter' || e.key === 'Tab') && Slash.items.length) {
        e.preventDefault();
        Slash.apply(Slash.items[Slash.index].cmd);
        return true;
      }
      return false;
    },
  };

  // ============================================================
  // 提示词优化器:AI 把口语化提问改写成结构化 prompt,先对照预览再回填
  // ============================================================
  const PromptOptimizer = {
    running: false,
    async run(text) {
      if (PromptOptimizer.running) return toast('正在优化中,请稍候', true);
      const app = A();
      if (!app) return;
      PromptOptimizer.running = true;
      toast('正在优化提示词…');
      try {
        const out = await app.aiComplete([
          { role: 'system', content: '你是提示词优化专家。把用户的口语化提问改写成一个清晰、结构化、信息完整的提示词:补全意图、明确输出格式与约束,不编造用户没有给出的需求。只输出改写后的提示词本身,不要解释,不要加引号。' },
          { role: 'user', content: String(text || '').slice(0, 4000) },
        ], { purpose: 'prompt-opt', maxTokens: 1200 });
        const optimized = String(out || '').trim();
        if (!optimized) throw new Error('模型返回了空内容');
        PromptOptimizer.preview(text, optimized);
      } catch (e) {
        toast(e.message || '优化失败,请稍后再试', true);
      } finally {
        PromptOptimizer.running = false;
      }
    },
    preview(before, after) {
      const U = window.OCUI;
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">'
        + '<div class="modal-header"><h3>优化提示词 · 修改前 / 修改后</h3><button class="icon-btn" type="button" data-act="x" aria-label="关闭">' + ic('close', 16) + '</button></div>'
        + '<div class="modal-body">'
        + '<div class="ai-diff-grid">'
        + '<div><div class="muted small" style="margin-bottom:6px">修改前</div><div class="ai-diff-pane">' + esc(before) + '</div></div>'
        + '<div><div class="muted small" style="margin-bottom:6px">修改后</div><div class="ai-diff-pane ai-diff-after">' + esc(after) + '</div></div>'
        + '</div></div>'
        + '<div class="modal-footer">'
        + '<button class="btn" data-act="cancel">放弃</button>'
        + '<button class="btn primary" data-act="apply">应用到输入框</button>'
        + '</div></div>';
      document.body.appendChild(mask);
      if (U && U.openModal) U.openModal(mask);
      const close = () => { if (U && U.closeModal) U.closeModal(mask); setTimeout(() => mask.remove(), 340); };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return close();
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'x' || act.dataset.act === 'cancel') return close();
        if (act.dataset.act === 'apply') {
          const input = $('input');
          if (input) {
            input.value = after;
            try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (er) { /* 忽略 */ }
            input.focus();
          }
          close();
          toast('已应用到输入框');
        }
      });
    },
  };

  // ============================================================
  // 跨对话记忆:自动提取 + 管理面板
  // ============================================================
  const Memory = {
    cfg: { enabled: true },
    async refreshCfg() {
      try {
        const app = A();
        if (!app) return;
        const r = await app.api('/api/memories');
        const d = await r.json();
        Memory.cfg = { enabled: !!d.enabled, max: d.max || 50 };
        // 设置面板显示「记忆条目（N）」用
        try { app.state._memCount = (d.items || []).length; } catch (e) { /* 忽略 */ }
      } catch (e) { /* 离线时保持上次状态 */ }
    },
    // 一轮对话结束后调用(节流:每 3 轮提取一次,最少间隔 5 分钟)
    maybeExtract(chat) {
      if (!pref('memoryOn', true)) return;
      if (Memory.cfg.enabled === false) return;
      const app = A();
      if (!app || !app.state || !app.state.user || app.state.user.guest) return;
      let turns = 0;
      try { turns = parseInt(localStorage.getItem('oc_mem_turns') || '0', 10) || 0; } catch (e) { /* 忽略 */ }
      let last = 0;
      try { last = parseInt(localStorage.getItem('oc_mem_last') || '0', 10) || 0; } catch (e) { /* 忽略 */ }
      const now = Date.now();
      turns += 1;
      if (turns < 3 || now - last < 5 * 60 * 1000) { try { localStorage.setItem('oc_mem_turns', String(turns)); } catch (e) { /* 忽略 */ } return; }
      try { localStorage.setItem('oc_mem_turns', '0'); localStorage.setItem('oc_mem_last', String(now)); } catch (e) { /* 忽略 */ }
      const msgs = (chat && chat.messages) || [];
      const lastU = [...msgs].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
      const lastA = [...msgs].reverse().find((m) => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
      if (!lastU || !lastA) return;
      Memory.extract(lastU.content, lastA.content);
    },
    async extract(userText, aiText) {
      const app = A();
      if (!app) return;
      try {
        const out = await app.aiComplete([
          { role: 'system', content: '你负责维护用户的长期记忆库。从这段对话里找出值得长期记住的、关于用户本人的稳定事实(身份/职业、偏好、正在进行的项目、重要约定)。只提取确定的信息,不要猜测。输出一个 JSON 字符串数组,例如 ["用户是研究生","偏好简洁的中文回答"];没有值得记的就输出 []。只输出 JSON,不要解释。' },
          { role: 'user', content: '用户说:' + String(userText || '').slice(0, 2000) + '\n\nAI 回答:' + String(aiText || '').slice(0, 2000) },
        ], { purpose: 'memory', maxTokens: 500 });
        const m = String(out || '').match(/\[[\s\S]*?\]/);
        if (!m) return;
        let arr;
        try { arr = JSON.parse(m[0]); } catch (e) { return; }
        if (!Array.isArray(arr) || !arr.length) return;
        const items = arr.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8);
        if (!items.length) return;
        const r = await app.api('/api/memories/auto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.added > 0) toast('已记住 ' + d.added + ' 条新记忆(可在 设置 → 对话 → 记忆 里查看)');
      } catch (e) { /* 提取失败静默:不打断对话 */ }
    },
    openPanel() {
      const U = window.OCUI;
      const app = A();
      if (!U || !app) return;
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">'
        + '<div class="modal-header"><h3>跨对话记忆</h3><button class="icon-btn" type="button" data-act="x" aria-label="关闭">' + ic('close', 16) + '</button></div>'
        + '<div class="modal-body">'
        + '<p class="muted small" style="margin-top:0">对话结束后会自动提取值得记住的信息,并注入之后的每一次对话。这里也可以手动添加或删除。</p>'
        + '<div class="add-provider-form"><div style="display:flex;gap:8px">'
        + '<input id="oc-mem-new" placeholder="例如:我在准备考研,偏好简洁回答" maxlength="500" style="flex:1">'
        + '<button class="btn primary small" data-act="add" type="button">添加</button>'
        + '</div></div>'
        + '<div id="oc-mem-list" class="apikey-list" style="margin-top:10px"><div class="muted small">加载中…</div></div>'
        + '</div>'
        + '<div class="modal-footer">'
        + '<button class="btn danger" data-act="clear">清空全部</button>'
        + '<button class="btn" data-act="done">完成</button>'
        + '</div></div>';
      document.body.appendChild(mask);
      U.openModal(mask);
      U.bindModal(mask, { onClose: () => setTimeout(() => mask.remove(), 340) });
      const list = mask.querySelector('#oc-mem-list');
      const renderList = (items, enabled) => {
        if (!items.length) {
          list.innerHTML = '<div class="muted small">还没有记忆。正常聊几句天,或在上面的输入框手动添加。</div>';
          return;
        }
        list.innerHTML = items.map((it) =>
          '<div class="apikey-item" data-id="' + esc(it.id) + '">'
          + '<div style="flex:1;min-width:0"><div style="word-break:break-all">' + esc(it.content) + '</div>'
          + '<div class="muted small">' + (it.source === 'auto' ? '自动提取' : '手动添加') + ' · ' + new Date(it.createdAt).toLocaleString('zh-CN') + '</div></div>'
          + '<button class="icon-btn" data-del="' + esc(it.id) + '" type="button" aria-label="删除">' + ic('trash', 14) + '</button>'
          + '</div>'
        ).join('');
        list.querySelectorAll('[data-del]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const r = await app.api('/api/memories/' + encodeURIComponent(btn.getAttribute('data-del')), { method: 'DELETE' });
            if (r.ok) { const d = await r.json(); renderList(d.items || [], true); }
          });
        });
      };
      (async () => {
        try {
          const r = await app.api('/api/memories');
          const d = await r.json();
          if (d.enabled === false) {
            mask.querySelector('#oc-mem-list').innerHTML = '<div class="muted small">本站已关闭跨对话记忆功能,历史条目保留但不再注入对话。</div>';
            return;
          }
          renderList(d.items || []);
        } catch (e) {
          mask.querySelector('#oc-mem-list').innerHTML = '<div class="muted small">加载失败,请稍后重试</div>';
        }
      })();
      mask.addEventListener('click', async (e) => {
        if (e.target === mask) return;
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const a = act.dataset.act;
        if (a === 'x' || a === 'done') { U.closeModal(mask); setTimeout(() => mask.remove(), 340); }
        else if (a === 'add') {
          const input = mask.querySelector('#oc-mem-new');
          const text = String((input && input.value) || '').trim();
          if (!text) return;
          const r = await app.api('/api/memories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return toast((d.error && d.error.message) || '添加失败', true);
          if (input) input.value = '';
          renderList(d.items || []);
        } else if (a === 'clear') {
          const ok = await U.confirm({ title: '清空记忆', message: '确认清空全部跨对话记忆?此操作不可恢复。', danger: true, confirmText: '清空' });
          if (!ok) return;
          await app.api('/api/memories', { method: 'DELETE' });
          renderList([], true);
        }
      });
    },
  };

  // ============================================================
  // 快捷键速查
  // ============================================================
  const SHORTCUT_ROWS = [
    ['Ctrl / ⌘ + K', '搜索会话'],
    ['Ctrl / ⌘ + Shift + O', '新建对话'],
    ['Ctrl / ⌘ + L', '聚焦输入框'],
    ['Ctrl / ⌘ + P', '开关侧栏'],
    ['Ctrl / ⌘ + ,', '打开设置'],
    ['Ctrl / ⌘ + Enter', '发送消息'],
    ['Enter / Shift + Enter', '发送 / 换行'],
    ['双击 Backspace', '停止生成'],
    ['?', '呼出这份速查'],
    ['/', '输入框斜杠指令'],
  ];
  function openShortcutsModal() {
    const U = window.OCUI;
    if (!U) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal modal-sm" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>键盘快捷键</h3><button class="icon-btn" type="button" data-act="x" aria-label="关闭">' + ic('close', 16) + '</button></div>'
      + '<div class="modal-body"><table class="oc-shortcut-table"><tbody>'
      + SHORTCUT_ROWS.map((r) => '<tr><td><kbd>' + esc(r[0]) + '</kbd></td><td>' + esc(r[1]) + '</td></tr>').join('')
      + '</tbody></table></div>'
      + '<div class="modal-footer"><button class="btn primary" data-act="x">知道了</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    U.openModal(mask);
    U.bindModal(mask, { onClose: () => setTimeout(() => mask.remove(), 340) });
    mask.addEventListener('click', (e) => {
      if (e.target === mask) { U.closeModal(mask); setTimeout(() => mask.remove(), 340); return; }
      if (e.target.closest('[data-act="x"]')) { U.closeModal(mask); setTimeout(() => mask.remove(), 340); }
    });
  }

  // ============================================================
  // 每日摘要:每天首次加载拉一次昨天的用量,有内容时在空态上方展示一张卡片
  // ============================================================
  const Digest = {
    async maybeShow() {
      const app = A();
      if (!app || !app.state || !app.state.user || app.state.user.guest) return;
      let shown = '';
      try { shown = localStorage.getItem('oc_digest_shown') || ''; } catch (e) { /* 忽略 */ }
      const today = new Date();
      const key = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      if (shown === key) return;
      try { localStorage.setItem('oc_digest_shown', key); } catch (e) { /* 忽略 */ }
      const r = await app.api('/api/me/digest');
      if (!r.ok) return;
      const d = await r.json();
      const empty = !d.calls && !(d.chats && d.chats.length);
      if (empty) return;
      Digest.renderCard(d);
    },
    renderCard(d) {
      const holder = $('digest-card-holder');
      if (!holder) return;
      const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
      const chatsHtml = (d.chats || []).map((c) => '<span class="digest-chip" data-chat="' + esc(c.id) + '" title="' + esc(c.title || '') + '">' + esc(String(c.title || '未命名').slice(0, 18)) + '</span>').join('');
      const el = document.createElement('div');
      el.className = 'digest-card';
      el.innerHTML =
        '<div class="digest-head">' + ic('calendar', 15) + '<b>昨日概要</b><span class="muted small">' + esc(d.date || '') + '</span>'
        + '<button class="icon-btn digest-x" type="button" aria-label="关闭">' + ic('close', 14) + '</button></div>'
        + '<div class="digest-body">'
        + '<span>' + fmt(d.calls) + ' 次调用</span><span>消耗 ' + fmt(d.cost) + ' 次</span>'
        + (d.completion ? '<span>生成 ' + fmt(d.completion) + ' tokens</span>' : '')
        + '</div>'
        + (chatsHtml ? '<div class="digest-chats">' + chatsHtml + '</div>' : '');
      holder.appendChild(el);
      holder.classList.remove('hidden');
      const x = el.querySelector('.digest-x');
      if (x) x.addEventListener('click', () => el.remove());
      el.querySelectorAll('.digest-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const id = chip.getAttribute('data-chat');
          if (window.OCExtras && window.OCExtras.openChatById) window.OCExtras.openChatById(id);
        });
      });
    },
  };

  // ============================================================
  // 收藏:按钮回调由 app.js 实现(需要写回对话消息),这里提供面板
  // ============================================================
  const Favorites = {
    openPanel() {
      const U = window.OCUI;
      const app = A();
      if (!U || !app) return;
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">'
        + '<div class="modal-header"><h3>我的收藏</h3><button class="icon-btn" type="button" data-act="x" aria-label="关闭">' + ic('close', 16) + '</button></div>'
        + '<div class="modal-body"><div id="oc-fav-list" class="apikey-list"><div class="muted small">加载中…</div></div></div>'
        + '<div class="modal-footer"><button class="btn" data-act="done">完成</button></div>'
        + '</div>';
      document.body.appendChild(mask);
      U.openModal(mask);
      U.bindModal(mask, { onClose: () => setTimeout(() => mask.remove(), 340) });
      const list = mask.querySelector('#oc-fav-list');
      const render = (items) => {
        if (!items.length) {
          list.innerHTML = '<div class="muted small">还没有收藏。点 AI 回复操作栏里的 ★ 即可收藏,收藏会随账号同步。</div>';
          return;
        }
        list.innerHTML = items.map((it) =>
          '<div class="apikey-item oc-fav-item" data-fid="' + esc(it.id) + '" data-chat="' + esc(it.chatId) + '" data-msg="' + esc(it.msgId) + '">'
          + '<div style="flex:1;min-width:0">'
          + '<div class="oc-fav-content">' + esc(String(it.content || '').slice(0, 220)) + '</div>'
          + '<div class="muted small">' + esc(it.chatTitle || '已删除的对话') + (it.model ? ' · ' + esc(it.model) : '') + ' · ' + new Date(it.createdAt).toLocaleString('zh-CN') + '</div>'
          + '</div>'
          + '<div style="display:flex;gap:4px;flex-shrink:0">'
          + '<button class="icon-btn" data-go="1" type="button" data-tip="跳到原对话" aria-label="跳到原对话">' + ic('arrowDown', 14) + '</button>'
          + '<button class="icon-btn" data-copy="1" type="button" data-tip="复制内容" aria-label="复制内容">' + ic('copy', 14) + '</button>'
          + '<button class="icon-btn" data-del="1" type="button" data-tip="删除收藏" aria-label="删除收藏">' + ic('trash', 14) + '</button>'
          + '</div></div>'
        ).join('');
      };
      (async () => {
        try {
          const r = await app.api('/api/favorites');
          const d = await r.json();
          render(d.items || []);
        } catch (e) {
          list.innerHTML = '<div class="muted small">加载失败,请稍后重试</div>';
        }
      })();
      list.addEventListener('click', async (e) => {
        const item = e.target.closest('.oc-fav-item');
        if (!item) return;
        if (e.target.closest('[data-go]')) {
          const ok = window.OCExtras.openChatById(item.getAttribute('data-chat'));
          if (!ok) toast('原对话已不存在(可能已被删除)', true);
          else { U.closeModal(mask); setTimeout(() => mask.remove(), 340); }
        } else if (e.target.closest('[data-copy]')) {
          const text = item.querySelector('.oc-fav-content');
          try { await navigator.clipboard.writeText(text ? text.textContent : ''); toast('已复制'); } catch (er) { toast('复制失败', true); }
        } else if (e.target.closest('[data-del]')) {
          const r = await app.api('/api/favorites/' + encodeURIComponent(item.getAttribute('data-fid')), { method: 'DELETE' });
          if (r.ok) {
            const d = await r.json();
            render(d.items || []);
            if (window.OCExtras.refreshFavCache) window.OCExtras.refreshFavCache(d.items || []);
          }
        }
      });
      mask.addEventListener('click', (e) => {
        if (e.target === mask) { U.closeModal(mask); setTimeout(() => mask.remove(), 340); return; }
        const act = e.target.closest('[data-act]');
        if (act && (act.dataset.act === 'x' || act.dataset.act === 'done')) { U.closeModal(mask); setTimeout(() => mask.remove(), 340); }
      });
    },
  };

  // ============================================================
  // 初始化与对外出口
  // ============================================================
  window.OCExtras = {
    toggleSpeak: (msg, btn) => TTS.toggleForMsg(msg, btn),
    ttsSupported: () => TTS.supported(),
    openShortcutsModal,
    openMemoryPanel: () => Memory.openPanel(),
    openFavoritesPanel: () => Favorites.openPanel(),
    openPromptOptimizer: (text) => PromptOptimizer.run(text),
    onInputChanged: () => Slash.onInput(),
    onInputKeydown: (e) => Slash.onKeydown(e),
    afterReplyTurn: (chat) => Memory.maybeExtract(chat),
    refreshMemoryCfg: () => Memory.refreshCfg(),
    maybeShowDigest: () => Digest.maybeShow(),
    openChatById: (id) => {
      const app = A();
      if (!app) return false;
      const st = app.state;
      const c = (st.chats || []).find((x) => x.id === id);
      if (!c) return false;
      if (st.streaming && typeof window.OCExtras._stopStreaming === 'function') window.OCExtras._stopStreaming();
      st.currentChatId = id;
      if (window.OCExtras._rerender) window.OCExtras._rerender();
      return true;
    },
    // app.js 在 boot 时注入内部渲染函数
    _attach: (fns) => Object.assign(window.OCExtras, fns),
    refreshFavCache: (items) => {
      const app = A();
      if (!app) return;
      app.state._favSet = new Set((items || []).map((it) => it.chatId + ':' + it.msgId));
      app.state._favItems = items || [];
    },
    init() {
      Memory.refreshCfg();
      // STT 按钮:支持才显示
      const sttBtn = $('stt-btn');
      if (sttBtn) {
        if (STT.supported()) {
          sttBtn.classList.remove('hidden');
          sttBtn.addEventListener('click', () => STT.toggle());
        }
      }
      // Esc/切页停止朗读
      window.addEventListener('beforeunload', () => { try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ } });
      window.addEventListener('resize', () => { if (Slash.box) Slash.position(); });
      document.addEventListener('click', (e) => {
        if (!Slash.box) return;
        if (e.target.closest('.slash-menu') || e.target === $('input')) return;
        Slash.close();
      });
      // 每日摘要(登录态下,首次加载)
      setTimeout(() => { Digest.maybeShow(); }, 2500);
    },
  };

  // 本文件排在 app.js 之后(defer 顺序):DOMContentLoaded 时所有 defer 脚本已就绪
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.OCExtras.init());
  else window.OCExtras.init();
})();