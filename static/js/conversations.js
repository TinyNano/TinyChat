'use strict';
/**
 * conversations.js — 会话管理增强
 *  - 侧边栏搜索 / 置顶 / 重命名 / 删除
 *  - 对话分支（Branch）
 *  - 键盘快捷键
 *  - 对话历史持久化
 */

(function () {
  const C = {};

  // ============ 统一线标(见 icons.js) ============
  const ic = window.OC ? window.OC.icon : function (n) { return ''; };
  const I = {
    chat: ic('chat', 15),
    pin: ic('pin', 15),
    pinOff: ic('pinOff', 15),
    rename: ic('edit', 15),
    branch: ic('branch', 15),
    del: ic('trash', 15),
    group: {
      '今天': ic('clock', 14),
      '昨天': ic('sun', 14),
      '本周': ic('calendar', 14),
      '更早': ic('refresh', 14),
    },
  };
  // 服务端搜索结果(见 C.searchList):本地过滤只看得到「这台浏览器上有的」会话,
  // 隐私模式下没同步的、别的设备上聊的、量大后被本地裁剪掉的都搜不到。
  // 服务端片段里命中处用 <mark></mark> 包住(FTS5 snippet 的标记),这里只认这一对标签,
  // 其余内容一律按纯文本转义 —— 会话正文是模型输出,不能直接拼进 innerHTML。
  function renderSnippet(snip) {
    if (!snip) return '';
    const marked = String(snip).split(/(<mark>|<\/mark>)/i);
    let out = '';
    let inB = false;
    marked.forEach((part) => {
      const low = part.toLowerCase();
      if (low === '<mark>') { inB = true; return; }
      if (low === '</mark>') { inB = false; return; }
      const text = escapeHtml(part);
      out += inB ? '<mark>' + text + '</mark>' : text;
    });
    return out;
  }
  C.renderSnippet = renderSnippet;

  const ITEM_HTML = (c, activeCls) => {
    // 群聊会话用群聊图标标识;普通对话优先显示所用模型的 logo
    const logo = c.groupId
      ? (window.OC && OC.icon ? OC.icon('group', 15) : I.chat)
      : (window.OC && OC.chatLogo && OC.logoImg ? OC.logoImg(OC.chatLogo(c), 'chat-logo') : (c.pinned ? I.pin : I.chat));
    // 置顶标识:模型 logo 会盖住旧的 pin 图标方案,这里独立挂在标题后,始终可见
    const pinMark = c.pinned
      ? '<span class="chat-pin-mark" data-tip="已置顶" aria-label="已置顶">' + (window.OC && OC.icon ? OC.icon('pinMark', 12) : I.pin) + '</span>'
      : '';
    // 草稿指示:这条会话有没发出去的输入时亮一个点 —— 草稿随会话存了,
    // 但找回来要挨个点开试,侧栏上先给个信号
    const draftMark = (c.draft && String(c.draft.text || '').trim())
      ? '<span class="chat-draft-dot" data-tip="有未发送的草稿" aria-label="有未发送的草稿"></span>'
      : '';
    return '<span class="chat-icon">' + logo + '</span>'
      + '<span class="chat-title">' + escapeHtml(c.title || '新对话') + '</span>'
      + pinMark + draftMark;
  };
  const MENU_HTML = '<button class="menu-btn more-btn" data-act="more" data-tip="更多操作" aria-label="更多操作">' + ic('more', 16) + '</button>';

  // 点击「更多」按钮弹出操作菜单(复用全局下拉组件,支持外点/Esc/滚动关闭)
  function openItemMenu(trigger, c, item, opts) {
    const items = [
      { value: 'pin', label: c.pinned ? '取消置顶' : '置顶', sub: c.pinned ? '已置顶' : '' },
      { value: 'rename', label: '重命名' },
      { value: 'share', label: '分享对话', sub: '生成公开链接' },
      { value: 'branch', label: '创建分支', sub: '复制全部消息' },
      { value: 'export', label: '导出 Markdown', sub: '保存为 .md 文件' },
      // 归档 = 从时间分组里收起来,但内容不进墓碑、搜索照旧能搜到。
      // 之前只有「删除」一条清理手段,而删除会同步到所有设备且服务端只留 300 条 ——
      // 想「先收起来以后再说」的用户没有出路。
      c.archived
        ? { value: 'unarchive', label: '取消归档', sub: '放回时间分组' }
        : { value: 'archive', label: '归档', sub: '从列表收起，仍可搜索' },
      { value: 'del', label: '删除', sub: '不可恢复' },
    ];
    if (!window.OC || !window.OC.openSelect) return;
    window.OC.openSelect(trigger, items, {
      selected: null,
      onSelect: (value) => {
        if (value === 'pin' && opts.onTogglePin) opts.onTogglePin(c);
        else if (value === 'rename' && opts.onRename) opts.onRename(c, item);
        else if (value === 'share' && opts.onShare) opts.onShare(c);
        else if (value === 'branch' && opts.onBranch) opts.onBranch(c);
        else if (value === 'export' && opts.onExport) opts.onExport(c);
        else if (value === 'archive' && opts.onArchive) opts.onArchive(c);
        else if (value === 'unarchive' && opts.onArchive) opts.onArchive(c);
        else if (value === 'del' && opts.onDelete) opts.onDelete(c);
      },
    });
  }

  C.normalize = function (chats) {
    return (chats || []).map((c) => ({
      pinned: false,
      branchOf: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...c,
    }));
  };

  // ============ 侧边栏渲染（含搜索/置顶/重命名） ============
  /**
   * @param {HTMLElement} listEl #chat-list
   * @param {Array} chats
   * @param {object} opts {currentId, onSelect, onDelete, onRename, onTogglePin, onShare, onBranch}
   */
  // ============ 服务端搜索结果列表(GET /api/chats/search) ============
  // hits: [{id, title, snippet}]。点一条直接打开该会话(必须来自本地列表,否则先拉取);
  // 本地没有的会话用 chat:null 标记,由调用方按 id 去云端取。
  C.searchList = function (listEl, kw, hits, opts = {}) {
    listEl.innerHTML = '';
    const searchBox = document.createElement('div');
    searchBox.className = 'chat-search';
    searchBox.innerHTML = (window.OC ? window.OC.icon('search', 13) : '')
      + '<input type="search" id="chat-search-input" placeholder="搜索对话…" value="" autocomplete="off" spellcheck="false">';
    listEl.appendChild(searchBox);
    const input = searchBox.querySelector('input');
    input.value = kw || '';
    C._searchKeyword = input.value;
    input.addEventListener('input', () => {
      C._searchKeyword = input.value;
      if (typeof opts.onKeyword === 'function') opts.onKeyword(input.value);
    });
    const head = document.createElement('div');
    head.className = 'chat-search-scope';
    head.innerHTML = '<span>全文搜索</span><span class="chat-search-scope-note">含未在本机打开的会话</span>';
    listEl.appendChild(head);
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-list-empty';
      empty.textContent = '无匹配对话';
      listEl.appendChild(empty);
      return;
    }
    hits.forEach((h) => {
      const wrap = document.createElement('div');
      wrap.className = 'chat-item-wrap';
      const item = document.createElement('div');
      item.className = 'chat-item chat-search-hit' + (h.id === opts.currentId ? ' active' : '');
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      const title = document.createElement('span');
      title.className = 'chat-title';
      title.textContent = h.title || '新对话';
      const row = document.createElement('div');
      row.className = 'chat-hit-main';
      row.appendChild(title);
      if (h.snippet) {
        const sn = document.createElement('span');
        sn.className = 'chat-hit-snippet';
        sn.innerHTML = renderSnippet(h.snippet);
        row.appendChild(sn);
      }
      // 语义命中单独标一下:用户要知道这条是「意思相近」而不是字面匹配
      if (h.semantic) {
        const tag = document.createElement('span');
        tag.className = 'chat-hit-tag';
        tag.textContent = '语义';
        row.appendChild(tag);
      }
      item.appendChild(row);
      wrap.appendChild(item);
      listEl.appendChild(wrap);
      const open = () => { if (typeof opts.onOpenHit === 'function') opts.onOpenHit(h); };
      item.addEventListener('click', open);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  };

  C.renderList = function (listEl, chats, opts = {}) {
    const sorted = [...chats].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const prevInput = document.getElementById('chat-search-input');
    const prevKeyword = prevInput ? prevInput.value : (C._searchKeyword || '');
    const keepFocus = !!(prevInput && document.activeElement === prevInput);
    const keepSelStart = keepFocus ? prevInput.selectionStart : null;
    const keepSelEnd = keepFocus ? prevInput.selectionEnd : null;

    listEl.innerHTML = '';

    const filterInput = document.createElement('div');
    filterInput.className = 'chat-search';
    filterInput.innerHTML = (window.OC ? window.OC.icon('search', 13) : '')
      + '<input type="search" id="chat-search-input" placeholder="搜索对话…" value="" autocomplete="off" spellcheck="false">';
    listEl.appendChild(filterInput);

    const searchInput = filterInput.querySelector('input');
    let keyword = prevKeyword;
    C._searchKeyword = keyword;
    searchInput.value = keyword;
    if (keepFocus) {
      requestAnimationFrame(() => {
        searchInput.focus();
        if (keepSelStart != null) {
          try { searchInput.setSelectionRange(keepSelStart, keepSelEnd); } catch (e) { /* ignore */ }
        }
      });
    }

    // 会话项的可访问性:div 上的 click 只对鼠标生效,键盘用户完全打不开会话。
    // 统一挂上 role=button + tabindex + Enter/Space 处理,两条渲染分支共用。
    const wireItem = (item, c, opts) => {
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.addEventListener('click', (e) => {
        if (e.target.closest('.chat-item-menu')) return;
        // 点到内联重命名输入框不能当成「选中会话」:选中会重渲染整份列表,正在编辑的
        // 输入框被换掉 → 触发 blur → 立刻按原值提交。用户看到的就是「点一下输入框,
        // 还没改就保存了,根本没法点进去修改」。
        if (e.target.closest('.rename-input')) return;
        if (opts.onSelect) opts.onSelect(c);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        // 焦点在菜单按钮/内联重命名输入框上时,回车归它们
        if (e.target !== item) return;
        e.preventDefault();
        if (opts.onSelect) opts.onSelect(c);
      });
    };

    const renderItems = () => {
      // 移除旧列表(保留搜索框)
      listEl.querySelectorAll('.chat-item-wrap, .chat-group, .chat-group-section').forEach((el) => el.remove());
      const kw = keyword.trim().toLowerCase();
      // 多模态消息的 content 可能是数组,不能直接 toLowerCase
      const filtered = sorted.filter((c) => !kw || (c.title || '').toLowerCase().includes(kw)
        || (c.messages || []).some((m) => typeof m.content === 'string' && m.content.toLowerCase().includes(kw)));
      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'chat-list-empty';
        empty.textContent = kw ? '无匹配对话' : '暂无对话,点击上方「新建对话」开始';
        listEl.appendChild(empty);
        return;
      }
      // 搜索模式下按更新时间倒序平铺;非搜索模式按时间分块
      if (kw) {
        filtered.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach((c) => {
          const wrap = document.createElement('div');
          wrap.className = 'chat-item-wrap';
          const item = document.createElement('div');
          item.className = 'chat-item' + (c.id === opts.currentId ? ' active' : '');
          item.innerHTML = ITEM_HTML(c);
          const menu = document.createElement('div');
          menu.className = 'chat-item-menu';
          menu.innerHTML = MENU_HTML;
          item.appendChild(menu);
          wrap.appendChild(item);
          listEl.appendChild(wrap);
          wireItem(item, c, opts);
          menu.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!e.target.closest('.more-btn')) return;
            openItemMenu(menu, c, item, opts);
          });
        });
        return;
      }
      // ---- 时间分块:今天 / 昨天 / 本周 / 更早 ----
      const timeGroupOf = function (ts) {
        const t = Number(ts) || Date.now();
        const now = new Date();
        const d = new Date(t);
        const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const todayStart = startOfDay(now);
        const yesterdayStart = todayStart - 86400000;
        const day = (now.getDay() + 6) % 7;
        const weekStart = todayStart - day * 86400000;
        if (t >= todayStart) return '今天';
        if (t >= yesterdayStart) return '昨天';
        if (t >= weekStart) return '本周';
        return '更早';
      };
      // 开放 API 产生的会话(调用 /v1 接口时服务端顺手记下的那份,聊天记录上带 apiKey)
      // 在每个时间段里再单独成一组:「今天 API」紧跟「今天」、「昨天 API」紧跟「昨天」……
      // 一个渠道一天可能攒下几十条接口调用,和手动聊的会话混在同一块里会把手动的挤到看不见。
      // 判定交给 opts.isApiChat(app.js 与「显示 API 对话」开关同一口径),没给就全按普通对话
      // 分组 —— 退化成加这个功能之前的样子,而不是崩掉。
      const API_SUFFIX = ' API';
      const GROUP_ORDER = [];
      ['今天', '昨天', '本周', '更早'].forEach((base) => { GROUP_ORDER.push(base, base + API_SUFFIX); });
      const p2 = (n) => String(n).padStart(2, '0');
      const isApiOpt = typeof opts.isApiChat === 'function' ? opts.isApiChat : null;
      // 「已归档」单列一组:不按时间再拆,也不与 API 组混排;位置固定在所有时间分组之后,
      // 默认收起。搜索态(下方命中列表)不隐藏归档,否则「搜得到却看不到」。
      const ARCHIVE_GROUP = '已归档';
      const groups = {};
      filtered.forEach((c) => {
        if (c.archived) { (groups[ARCHIVE_GROUP] = groups[ARCHIVE_GROUP] || []).push(c); return; }
        const base = timeGroupOf(c.updatedAt || c.createdAt);
        const g = (isApiOpt && isApiOpt(c)) ? base + API_SUFFIX : base;
        (groups[g] = groups[g] || []).push(c);
      });
      GROUP_ORDER.push(ARCHIVE_GROUP);
      GROUP_ORDER.forEach((g) => {
        const list = groups[g] || [];
        if (!list.length) return;
        const isArchived = g === ARCHIVE_GROUP;
        const isApi = !isArchived && g.slice(-API_SUFFIX.length) === API_SUFFIX;
        const baseGroup = isArchived ? ARCHIVE_GROUP : (isApi ? g.slice(0, -API_SUFFIX.length) : g);
        // 归档组默认收起(有内容时);其余按「今天展开、更早收起」的既有规则
        const defaultCollapsed = isArchived ? true : (baseGroup !== '今天');
        // 分组折叠:今天默认展开,昨天及更早默认折叠(状态记忆在 localStorage)。
        // 「今天 API」按「今天」的默认展开(折叠状态仍各记各的,收起一个不影响另一个)。
        const COLLAPSE_KEY = 'oc_chat_group_collapsed';
        let collapsedMap = {};
        try { collapsedMap = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch (e) { collapsedMap = {}; }
        const isCollapsed = collapsedMap[g] !== undefined ? collapsedMap[g] : defaultCollapsed;
        const section = document.createElement('div');
        section.className = 'chat-group-section' + (isCollapsed ? ' collapsed' : '');
        const title = document.createElement('div');
        title.className = 'chat-group' + (baseGroup === '今天' ? ' is-today' : '') + (isApi ? ' is-api' : '') + (isArchived ? ' is-archive' : '');
        title.setAttribute('role', 'button');
        title.setAttribute('tabindex', '0');
        title.setAttribute('aria-expanded', String(!isCollapsed));
        // 「展开今天 API 对话」比「展开今天 API对话」好读,Latin 后缀前后各留一个空格
        const tipName = isArchived ? '已归档对话' : (isApi ? baseGroup + ' API 对话' : g + '对话');
        title.setAttribute('data-tip', (isCollapsed ? '展开' : '收起') + tipName);
        title.innerHTML = '<span class="chat-group-chev">' + ic('chevronDown', 11) + '</span>'
          + '<span class="chat-group-label">' + g + '</span>'
          + '<span class="chat-group-count">' + list.length + '</span>';
        const toggle = () => {
          const cur = section.classList.contains('collapsed');
          section.classList.toggle('collapsed', !cur);
          title.setAttribute('aria-expanded', String(cur));
          title.setAttribute('data-tip', (cur ? '收起' : '展开') + tipName);
          collapsedMap[g] = !cur;
          try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedMap)); } catch (e) {}
          if (window.OCSettingsSync) window.OCSettingsSync.touchUi('chatGroupCollapsed');
        };
        // 归档组的「全部取消归档」:整理完旧对话后一个个点开反悔太笨。
        // 按钮嵌在分组标题里,点击要先拦下(标题自身的 click 是折叠开关)
        if (isArchived) {
          const unarch = document.createElement('span');
          unarch.className = 'chat-group-unarch';
          unarch.setAttribute('data-tip', '把这一组全部放回时间分组');
          unarch.textContent = '全部取消归档';
          title.appendChild(unarch);
        }
        title.addEventListener('click', (e) => {
          if (e.target.closest('.chat-group-unarch')) {
            e.stopPropagation();
            if (opts.onUnarchiveAll) opts.onUnarchiveAll(list);
            return;
          }
          toggle();
        });
        title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        section.appendChild(title);
        listEl.appendChild(section);
        list.forEach((c) => {
          const wrap = document.createElement('div');
          wrap.className = 'chat-item-wrap';
          const item = document.createElement('div');
          item.className = 'chat-item' + (c.id === opts.currentId ? ' active' : '');
          item.innerHTML = ITEM_HTML(c);
          const menu = document.createElement('div');
          menu.className = 'chat-item-menu';
          menu.innerHTML = MENU_HTML;
          item.appendChild(menu);
          wrap.appendChild(item);
          section.appendChild(wrap);
          wireItem(item, c, opts);
          menu.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!e.target.closest('.more-btn')) return;
            openItemMenu(menu, c, item, opts);
          });
        });
      });
    };
    renderItems();
    searchInput.addEventListener('input', () => {
      keyword = searchInput.value;
      C._searchKeyword = keyword;
      renderItems();
      // 服务端全文搜索:本地过滤之外再问一次服务端(防抖,取消上一次未返回的请求)
      if (typeof opts.onKeyword === 'function') opts.onKeyword(keyword);
    });
  };

  // 内联重命名
  C.renameInline = function (chatItem, currentTitle, onDone) {
    const titleEl = chatItem.querySelector('.chat-title');
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = currentTitle || '';
    input.maxLength = 60;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    // 只允许第一次结果生效:Esc 取消后 input 被移除会再触发 blur,不能把编辑内容又保存回去
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      onDone(value);
    };
    const commit = () => finish(input.value.trim() || currentTitle);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 中文输入法组词确认
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(currentTitle); }
    });
    input.addEventListener('blur', () => { if (!finished) commit(); });
  };

  // ============ 对话分支 ============
  /**
   * 从指定消息处创建分支
   * @param {object} chat 原对话
   * @param {number} msgIndex 分支起点（该消息之后的将被替换）
   */
  C.createBranch = function (chat, msgIndex) {
    const branch = {
      id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
      title: chat.title ? chat.title + ' (分支)' : '新对话',
      messages: (chat.messages || []).slice(0, msgIndex + 1),
      pinned: false,
      branchOf: chat.id,
      assistantId: chat.assistantId || null,
      assistantName: chat.assistantName || '',
      systemPrompt: chat.systemPrompt || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return branch;
  };

  // ============ 键盘快捷键 ============
  // Ctrl/⌘+K 搜索会话 · Ctrl/⌘+Shift+O 新会话 · Ctrl/⌘+L 聚焦输入框 ·
  // Ctrl/⌘+P 开关侧栏 · Ctrl/⌘+Enter 发送 · ?(非输入态) 呼出快捷键速查
  C.initShortcuts = function (handlers) {
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      // 弹窗打开时不劫持快捷键:避免后台新建会话/切换侧栏等动作穿透到弹窗之下的页面
      if (window.OCUI && typeof window.OCUI.isModalOpen === 'function' && window.OCUI.isModalOpen()) return;
      const k = e.key.toLowerCase();
      // 避免输入框内快捷键冲突（保留必要项）
      const target = e.target;
      const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if (mod && e.shiftKey && k === 'o' && !inInput) {
        e.preventDefault();
        if (handlers.onNewChat) handlers.onNewChat();
      } else if (mod && k === 'k' && !inInput) {
        e.preventDefault();
        if (handlers.onFocusSearch) handlers.onFocusSearch();
      } else if (mod && k === 'l') {
        e.preventDefault();
        if (handlers.onFocusInput) handlers.onFocusInput();
      } else if (mod && k === 'p' && !inInput) {
        e.preventDefault();
        if (handlers.onToggleSidebar) handlers.onToggleSidebar();
      } else if (mod && k === 'enter' && inInput) {
        // Cmd/Ctrl+Enter 发送（输入框内）
        if (handlers.onSend) handlers.onSend();
      } else if (!mod && !inInput && e.key === '?') {
        e.preventDefault();
        if (handlers.onShortcuts) handlers.onShortcuts();
      } else if (mod && k === ',' && !inInput) {
        e.preventDefault();
        if (handlers.onOpenSettings) handlers.onOpenSettings();
      } else if (mod && (e.code === 'BracketLeft' || k === '[' || k === '{')) {
        // 上一个会话(Shift+[)。按物理键位判定:Shift 下 e.key 在多数键盘是 '{',
        // 中文输入法/不同布局下还可能变成 '｛' 或 '“',只比 key 会在这些环境静默失效。
        // 这里比的是「裸字母键」的 key,所以在输入框里而没按 Shift 时不应触发。
        if (!e.shiftKey && inInput) return;
        e.preventDefault();
        if (handlers.onPrevChat) handlers.onPrevChat();
      } else if (mod && (e.code === 'BracketRight' || k === ']' || k === '}')) {
        if (!e.shiftKey && inInput) return;
        e.preventDefault();
        if (handlers.onNextChat) handlers.onNextChat();
      } else if (mod && e.shiftKey && k === 'a' && !inInput) {
        // 切换「显示 API 对话」:API 会话一多就糊住侧栏,给一个不必进设置的开关
        e.preventDefault();
        if (handlers.onToggleApiChats) handlers.onToggleApiChats();
      }
    });
  };

  // ============ 标题自动生成 ============
  C.autoTitle = function (text) {
    const clean = (text || '').replace(/[#*`>|~]/g, '').trim();
    return clean.length > 20 ? clean.slice(0, 20) + '…' : (clean || '新对话');
  };

  window.OCConversations = C;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();