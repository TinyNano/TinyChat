'use strict';
/**
 * preview.js — HTML / SVG 代码块的「预览」标签页(对话、笔记预览、分享页共用),
 * 以及对话里的「让 AI 改」闭环(改完就地把新代码写回这个代码块)。
 *
 * 为什么必须放在不透明源沙箱里:
 *   模型输出的 HTML/SVG 是不可信内容,而本页面的 localStorage 里放着登录令牌(oc_token)。
 *   同源执行 = 把账号交出去。所以预览一律走 iframe 的 srcdoc + sandbox,且 sandbox 里
 *   **绝不能出现 allow-same-origin**(与用户工具箱同一套红线,见 tests/toolbox-sandbox.js)。
 *   SVG 单独作为文档加载时其中的 <script> 一样会执行,因此同样走沙箱。
 *
 * 与在线工具箱(toolbox.js)、Artifacts 面板(multimodal.js)的区别:
 *   那两个入口默认允许脚本。这里的预览是「看一眼长什么样」:默认不给 allow-scripts,
 *   代码里的动画/交互脚本会按需在沙箱内打开 —— 打开预览不会自己弹窗、跳转或死循环。
 *
 * 接入:R.enhance() 里调用 OCPreview.enhance(container)。面板状态(标签/展开/是否允许
 * 脚本)只存在 DOM 上,不进会话数据,不参与云同步。修订栈也存在代码块节点上,随节点生灭:
 * 消息重绘 / 换会话 / 刷新后回到模型原版 —— 回填后的代码与消息正文不同源,硬跟着会话走
 * 会出现「标记还在、内容却是原版」的幽灵修订,宁可诚实退回。
 */
(function () {
  const P = {};

  // 「让 AI 改」的入口由 app.js 注册(它知道模型与请求格式;这个文件只出现在分享页时也
  // 能正常加载,所以不能在这里直接依赖 OCApp)
  let rewriteHandler = null;
  P.setRewriteHandler = function (fn) { rewriteHandler = typeof fn === 'function' ? fn : null; };

  // 走预览的语言集合(小写)。xml 不进来:它通常是配置文件而不是页面。
  const HTML_LANGS = { html: 1, htm: 1, xhtml: 1, vue: 1, svelte: 1 };
  const SVG_LANGS = { svg: 1 };
  // 未标注语言的块:内容看着就是一个页面才认。宁可漏判也不要误判 —— 一段讨论标签的
  // 普通文本被当页面渲染,用户看到的是一堆被浏览器「修好」的标签,比没有预览更糟。
  const MARKUP_HEAD = /<!doctype\s+html|<html[\s>]|<body[\s>]|<svg[\s>]/i;

  // 代码块内容:取 <code> 的文本(高亮后与原代码一致),不含表头按钮
  function codeOf(block) {
    const code = block.querySelector('pre > code');
    return code ? code.textContent : '';
  }
  P.codeOf = codeOf;

  // 该块的预览类型;'' 表示不提供预览
  P.kindOf = function (block) {
    const lang = String((block && block.getAttribute('data-lang')) || '').trim().toLowerCase().split(/\s+/)[0];
    if (HTML_LANGS[lang]) return 'html';
    if (SVG_LANGS[lang]) return 'svg';
    return '';
  };

  // 未标注/标成 text 的块只有在「首行就是文档声明」时才当页面(片段不猜,避免误伤)
  P.looksLikeMarkup = function (text) {
    const src = String(text || '').trim();
    if (!src || src.length > 500000) return false;
    return MARKUP_HEAD.test(src.slice(0, 400)) && /<\/[a-z][\w:-]*>/i.test(src);
  };

  function buildDoc(kind, code, dark) {
    const bg = dark ? '#1c1c1e' : '#ffffff';
    const fg = dark ? '#f5f5f7' : '#1d1d1f';
    const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
    const base = '<style>html,body{margin:0;background:' + bg + ';color:' + fg
      + ';font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}'
      + 'body{padding:12px}svg{max-width:100%;height:auto;display:block;margin:0 auto}</style>';
    const src = String(code || '');
    if (kind === 'svg') {
      // SVG 源码外面套一层最小文档壳:背景色与缩放行为与 HTML 预览一致;
      // 已带 <?xml 声明的原样放进 body(浏览器按 HTML 解析时会忽略声明)。
      return '<!doctype html><html><head>' + head + base + '</head><body>' + src + '</body></html>';
    }
    // 完整文档:只在 <head> 里补一段兜底样式(原有内容一概不动)
    if (/<!doctype\s+html|<html[\s>]/i.test(src)) {
      if (/<head[\s>]/i.test(src)) return src.replace(/<head([^>]*)>/i, '<head$1>' + head + base);
      return src.replace(/<html([^>]*)>/i, '<html$1><head>' + head + base + '</head>');
    }
    return '<!doctype html><html><head>' + head + base + '</head><body>' + src + '</body></html>';
  }
  P.buildDoc = buildDoc;

  // srcdoc + sandbox:唯一的安全边界。禁止项与工具箱同一套理由:
  //   allow-same-origin        → 变回同源,读得到 oc_token
  //   allow-popups-to-escape   → 弹窗完全脱离沙箱
  //   allow-top-navigation*    → 可把本站整页导航走(钓鱼)
  //   allow-downloads          → 与 allow-popups 组合是已知偷跑手法
  P.sandboxFor = function (allowScripts) {
    const common = 'allow-forms allow-modals';
    return allowScripts ? (common + ' allow-scripts') : common;
  };

  function themeDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  // ---------- 代码块的文本读写(改写回填与「撤销 AI 修改」共用) ----------
  // 只替换 <code> 的内容,不换代码块节点:表头按钮(复制/预览/Artifact)的监听、修订栈、
  // 预览面板全部挂在原节点上。整块 replaceWith 会让 mount 闭包里的 block 变成孤儿节点,
  // 第二次改写与撤销就会悄悄作用在看不见的旧节点上(v2.3.0 的真实缺陷,当时被
  // R.highlight 抛错掩盖 —— 报错走了纯文本兜底,恰好不换节点,bug 才没露头)。
  function replaceCode(block, text) {
    const codeEl = block.querySelector('pre > code');
    if (!codeEl) return false;
    const lang = String(block.getAttribute('data-lang') || '');
    const R = window.OCRenderer;
    let done = false;
    if (R && typeof R.highlight === 'function' && lang && lang !== 'text') {
      try {
        const html = R.highlight(String(text), lang);
        if (html) {
          const tmp = document.createElement('div');
          tmp.innerHTML = html;
          const freshCode = tmp.querySelector('.code-block pre > code');
          if (freshCode) {
            codeEl.className = freshCode.className;
            codeEl.innerHTML = freshCode.innerHTML;   // 高亮 span 一起带过来
            done = true;
          }
        }
      } catch (e) { /* 高亮失败:内容照换,只是没有着色 */ }
    }
    if (!done) codeEl.textContent = String(text);
    // 行数变了:重置「超长折叠」状态,避免留着一个写着旧行数的展开按钮
    const pre = codeEl.closest('pre');
    if (pre) {
      pre.classList.remove('code-collapsed');
      const exp = pre.parentElement && pre.parentElement.querySelector('.code-expand');
      if (exp) exp.remove();
    }
    return true;
  }
  P.replaceCode = replaceCode;

  // 未完结的代码围栏:模型偶尔会忘了收尾,原样留着会把后面整段回答吞进代码块里
  P.closeFences = function (text) {
    let src = String(text || '').replace(/\r\n/g, '\n').trim();
    const fence = /^(`{3,}|~{3,})/;
    const lines = src.split('\n');
    let open = '';
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(fence);
      if (!m) continue;
      const mark = m[1];
      if (!open) open = mark;
      else if (mark[0] === open[0] && mark.length >= open.length) open = '';
    }
    if (open) src += '\n' + open;
    return src;
  };

  // 从模型回答里取出完整代码:优先取与原来同语言的围栏块,其次干净的全文。
  // 「只回代码」是提示词的要求,但模型经常裹一层 ```html 或加一句说明 —— 两处都得兜住。
  P.extractCode = function (reply, lang) {
    const raw = String(reply || '').replace(/\r\n/g, '\n');
    const want = String(lang || '').toLowerCase();
    const re = /(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n?\1/g;
    let m;
    let fallback = '';
    while ((m = re.exec(raw))) {
      const tag = String(m[2] || '').trim().toLowerCase().split(/\s+/)[0];
      const body = m[3];
      if (tag === want && want) return body;
      if (!fallback) fallback = body;
    }
    if (fallback) return fallback;
    // 没有围栏:只有当回答里确实有完整文档片段时才算「给了代码」。
    // 只允许剥掉前面的英文说明(「Here is the updated file:」);中文说明不剥 ——
    // 说明里常带语法片段(如「把 <h1> 改成 …」),拿它回填会把一句话变成整段代码。
    let src = raw.trim();
    const head = src.search(/<!doctype|<html[\s>]|<svg[\s>]/i);
    if (head < 0) return '';
    if (head > 0 && (head > 400 || /[一-鿿]/.test(src.slice(0, head)))) return '';
    src = src.slice(head);
    // 带结束标签的整段标记才算完整页面/图形(单个自闭合 <svg/> 也认)
    if (!/<\/[a-z][\w:-]*>/i.test(src) && !/<svg[\s>][\s\S]*\/>/i.test(src)) return '';
    return src;
  };

  // ---------- 修订栈(存在代码块节点上) ----------
  // { orig: 原始代码, stack: [{code, prompt}], out: 当前代码 }
  // 「撤销 AI 修改」= 弹出一层回到上一版;全部弹出后回到 orig。
  function historyOf(block) {
    let h = block._ocPrevHistory;
    if (!h || typeof h !== 'object') {
      h = { orig: codeOf(block), stack: [], out: '' };
      block._ocPrevHistory = h;
    }
    return h;
  }
  P.historyOf = historyOf;
  P.applyRevision = function (block, code) {
    if (!replaceCode(block, code)) return false;
    const h = historyOf(block);
    h.out = String(code);
    return true;
  };

  // 「有没有改动」用宽松口径:只差空白与行尾时也算没改(模型常把整段重新缩进一遍)
  function coarseChanged(a, b) {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return !!norm(b) && norm(a) !== norm(b);
  }

  function refreshToolbar(block, panel, lang) {
    const h = block._ocPrevHistory || { stack: [] };
    const depth = (h.stack || []).length;
    const badge = panel.querySelector('.cpp-ver');
    if (badge) {
      badge.classList.toggle('hidden', !depth);
      badge.textContent = depth ? '修订 v' + (depth + 1) : '';
      badge.title = depth ? (h.stack[depth - 1].prompt || '按你的要求修改') : '';
    }
    const undo = panel.querySelector('[data-act="undo-ai"]');
    if (undo) {
      undo.classList.toggle('hidden', !depth && !(h.out && h.out !== h.orig));
      undo.textContent = depth > 1 ? '回退 (v' + depth + ')' : '撤销 AI 修改';
    }
    // 「让 AI 改」只对能预览的块给(改写本来就是围绕页面/图形这两个场景设计的)
    const aiBtn = panel.querySelector('[data-act="ask-ai"]');
    if (aiBtn) {
      aiBtn.classList.toggle('hidden', !rewriteHandler || !kindOk(lang));
      aiBtn.title = rewritableHint(lang);
    }
  }
  function kindOk(lang) {
    const l = String(lang || '').toLowerCase();
    return !!(HTML_LANGS[l] || SVG_LANGS[l]);
  }
  function rewritableHint(lang) {
    if (!kindOk(lang)) return '只能对 HTML / SVG 代码块使用';
    if (!rewriteHandler) return '在对话里打开才能让 AI 修改';
    return '描述想要的改动，AI 会直接改这段代码';
  }

  function mount(block, kind) {
    block.dataset.prevMounted = '1';
    block.classList.add('has-preview');
    const header = block.querySelector(':scope > .code-header');
    if (!header) return;
    block._ocPrevHistory = { orig: codeOf(block), stack: [], out: '' };

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-prev-toggle';
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = kind === 'svg' ? '预览图形' : '预览';
    const actions = header.querySelector('.code-actions');
    if (actions) actions.insertBefore(btn, actions.firstChild);
    else {
      const box = document.createElement('span');
      box.className = 'code-actions';
      box.appendChild(btn);
      header.appendChild(box);
    }

    // 树内的 <button> 都显式写 type:分享页/笔记页的代码块不一定在表单外
    const panel = document.createElement('div');
    panel.className = 'code-prev-panel hidden';
    panel.innerHTML = '<div class="cpp-toolbar">'
      + '<div class="cpp-tabs" role="tablist">'
      + '<button type="button" class="cpp-tab active" data-tab="code" role="tab">代码</button>'
      + '<button type="button" class="cpp-tab" data-tab="preview" role="tab">预览</button>'
      + '</div>'
      + '<span class="cpp-ver hidden"></span>'
      + '<span class="cpp-spacer"></span>'
      + '<label class="cpp-scripts" title="在沙箱内运行代码里的脚本（仍然读不到本站任何数据）"><input type="checkbox"> 运行脚本</label>'
      + '<button type="button" class="cpp-btn hidden" data-act="undo-ai">撤销 AI 修改</button>'
      + '<button type="button" class="cpp-btn hidden" data-act="ask-ai">让 AI 改</button>'
      + '<button type="button" class="cpp-btn" data-act="refresh" title="用当前代码重新加载预览">刷新</button>'
      + '</div>'
      + '<form class="cpp-ask hidden">'
      + '<textarea class="cpp-ask-input" rows="2" placeholder="说说想怎么改，例如：把背景换成深色、按钮改成圆角"></textarea>'
      + '<div class="cpp-ask-row"><span class="cpp-ask-tip">AI 改写的代码会直接替换本块，可随时撤销</span>'
      + '<button type="button" class="cpp-btn cpp-send" data-act="send-ai">发送</button></div>'
      + '</form>'
      + '<div class="cpp-body"><div class="cpp-frame-wrap hidden"></div></div>';
    block.appendChild(panel);

    const wrap = panel.querySelector('.cpp-frame-wrap');
    const codePre = block.querySelector(':scope > pre');
    const askForm = panel.querySelector('.cpp-ask');
    const askInput = panel.querySelector('.cpp-ask-input');
    let frame = null;
    let allowScripts = false;
    let tab = 'code';
    let busy = false;

    const renderFrame = () => {
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'oc-prev-frame';
        frame.setAttribute('title', '代码预览');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        wrap.appendChild(frame);
      }
      // sandbox 必须在设 srcdoc 之前定好:后改 sandbox 不会对已加载的文档生效
      frame.setAttribute('sandbox', P.sandboxFor(allowScripts));
      frame.srcdoc = buildDoc(kind, codeOf(block), themeDark());
    };
    const reset = () => { wrap.innerHTML = ''; frame = null; };

    const showTab = (next) => {
      tab = next;
      panel.querySelectorAll('.cpp-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === next));
      if (codePre) codePre.classList.toggle('cpp-hidden', next === 'preview');
      wrap.classList.toggle('hidden', next !== 'preview');
      if (next === 'preview') renderFrame();
    };

    const setOpen = (open) => {
      panel.classList.toggle('hidden', !open);
      block.classList.toggle('preview-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('active', open);
      if (open) {
        showTab(tab);
        refreshToolbar(block, panel, block.getAttribute('data-lang'));
        // 展开的预览会把下方内容推低,用户刚才点的按钮可能已在可视区外;滚回表头,
        // 让「再点一次收起」始终够得着
        if (typeof btn.scrollIntoView === 'function') btn.scrollIntoView({ block: 'nearest' });
      } else {
        reset();
        askForm.classList.add('hidden');
        if (codePre) codePre.classList.remove('cpp-hidden');
      }
    };

    const setBusy = (on) => {
      busy = on;
      const send = panel.querySelector('[data-act="send-ai"]');
      if (send) send.disabled = on;
      askForm.classList.toggle('is-busy', on);
    };

    // 回填:改写结果替换 <code> 内容并记入修订栈(撤销/回退用)。
    // replaceCode 是原地更新,block / codePre / panel 等闭包引用始终有效。
    const applyRewrite = (code, prompt) => {
      const h = historyOf(block);
      h.stack.push({ code: String(code), prompt: String(prompt || '') });
      if (!replaceCode(block, code)) return false;
      h.out = String(code);
      refreshToolbar(block, panel, block.getAttribute('data-lang'));
      return true;
    };

    const undoRewrite = () => {
      const h = historyOf(block);
      if (h.stack && h.stack.length) h.stack.pop();
      const back = h.stack && h.stack.length ? h.stack[h.stack.length - 1].code : h.orig;
      if (!replaceCode(block, back)) return;
      h.out = back;
      refreshToolbar(block, panel, block.getAttribute('data-lang'));
      // 代码已换,预览开着就同步刷新(否则显示的还是旧版本)
      if (tab === 'preview') { reset(); renderFrame(); }
    };

    btn.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
    panel.addEventListener('click', (e) => {
      const t = e.target.closest('.cpp-tab');
      if (t) { showTab(t.dataset.tab); return; }
      if (e.target.closest('[data-act="refresh"]')) { reset(); renderFrame(); return; }
      if (e.target.closest('[data-act="undo-ai"]')) { undoRewrite(); return; }
      if (e.target.closest('[data-act="ask-ai"]')) {
        if (busy) return;
        const opening = askForm.classList.contains('hidden');
        askForm.classList.toggle('hidden', !opening);
        if (opening && askInput) askInput.focus();
        return;
      }
      if (e.target.closest('[data-act="send-ai"]')) askForm.requestSubmit ? askForm.requestSubmit() : sendAsk();
    });
    panel.querySelector('.cpp-scripts input').addEventListener('change', (e) => {
      allowScripts = !!e.target.checked;
      if (tab === 'preview') { reset(); renderFrame(); }
    });
    askForm.addEventListener('keydown', (e) => {
      // Ctrl/⌘+Enter 发送;单独回车留给换行(改动描述常常要分几条写)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); askForm.requestSubmit(); }
    });

    function sendAsk() {
      if (busy || !rewriteHandler) return;
      const prompt = String(askInput.value || '').trim();
      if (!prompt) { if (askInput) askInput.focus(); return; }
      setBusy(true);
      const lang = String(block.getAttribute('data-lang') || '');
      Promise.resolve(rewriteHandler({ code: codeOf(block), prompt, lang, kind }))
        .then((reply) => {
          const code = P.extractCode(reply, lang);
          if (!coarseChanged(codeOf(block), code)) {
            // 模型原样返回 = 没改成。不要静默把「没变化」当成成功,否则用户以为改了
            if (window.OCApp && window.OCApp.toast) window.OCApp.toast('AI 没有给出新的代码，换个说法再试试', true);
            return;
          }
          applyRewrite(code, prompt);
          askInput.value = '';
          askForm.classList.add('hidden');
          // 直接切到预览看结果(改写的目的就是看新样子)
          showTab('preview');
          if (window.OCApp && window.OCApp.toast) window.OCApp.toast('已按你的要求改写，可随时撤销');
        })
        .catch((err) => {
          const msg = (err && err.message) ? String(err.message) : '改写失败';
          if (window.OCApp && window.OCApp.toast) window.OCApp.toast(msg, true);
        })
        .then(() => setBusy(false));
    }
    askForm.addEventListener('submit', (e) => { e.preventDefault(); sendAsk(); });

    refreshToolbar(block, panel, block.getAttribute('data-lang'));
  }

  // 给容器里所有可预览的代码块挂面板。R.enhance 每次重绘都会调用,已挂过的跳过
  // (面板是代码块的子节点,重绘后随 DOM 一起丢弃,所以只需要防同一次内的重复调用)。
  P.enhance = function (container) {
    if (!container || !container.querySelectorAll) return;
    container.querySelectorAll('.code-block').forEach((block) => {
      if (block.dataset.prevMounted === '1') return;
      let kind = P.kindOf(block);
      if (!kind) {
        const lang = String(block.getAttribute('data-lang') || '').toLowerCase();
        if (lang && lang !== 'text' && lang !== 'plaintext') return;
        if (!P.looksLikeMarkup(codeOf(block))) return;
        const head = codeOf(block).slice(0, 400);
        kind = (/<svg[\s>]/i.test(head) && !/<html[\s>]|<!doctype/i.test(head)) ? 'svg' : 'html';
      }
      mount(block, kind);
    });
  };

  window.OCPreview = P;
})();
