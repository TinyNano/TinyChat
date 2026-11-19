'use strict';
/**
 * preview.js — HTML / SVG 代码块的「预览」标签页(对话、笔记预览、分享页共用)。
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
 * 脚本)只存在 DOM 上,不进会话数据,不参与云同步。
 */
(function () {
  const P = {};

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

  function mount(block, kind) {
    block.dataset.prevMounted = '1';
    block.classList.add('has-preview');
    const header = block.querySelector(':scope > .code-header');
    if (!header) return;

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

    const panel = document.createElement('div');
    panel.className = 'code-prev-panel hidden';
    panel.innerHTML = '<div class="cpp-toolbar">'
      + '<div class="cpp-tabs" role="tablist">'
      + '<button type="button" class="cpp-tab active" data-tab="code" role="tab">代码</button>'
      + '<button type="button" class="cpp-tab" data-tab="preview" role="tab">预览</button>'
      + '</div>'
      + '<span class="cpp-spacer"></span>'
      + '<label class="cpp-scripts" title="在沙箱内运行代码里的脚本（仍然读不到本站任何数据）"><input type="checkbox"> 运行脚本</label>'
      + '<button type="button" class="cpp-btn" data-act="refresh" title="用当前代码重新加载预览">刷新</button>'
      + '</div>'
      + '<div class="cpp-body"><div class="cpp-frame-wrap hidden"></div></div>';
    block.appendChild(panel);

    const wrap = panel.querySelector('.cpp-frame-wrap');
    const codePre = block.querySelector(':scope > pre');
    let frame = null;
    let allowScripts = false;
    let tab = 'code';

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
        // 展开的预览会把下方内容推低,用户刚才点的按钮可能已在可视区外;滚回表头,
        // 让「再点一次收起」始终够得着
        if (typeof btn.scrollIntoView === 'function') btn.scrollIntoView({ block: 'nearest' });
      } else {
        reset();
        if (codePre) codePre.classList.remove('cpp-hidden');
      }
    };

    btn.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
    panel.addEventListener('click', (e) => {
      const t = e.target.closest('.cpp-tab');
      if (t) { showTab(t.dataset.tab); return; }
      const act = e.target.closest('[data-act="refresh"]');
      if (act) { reset(); renderFrame(); }
    });
    panel.querySelector('.cpp-scripts input').addEventListener('change', (e) => {
      allowScripts = !!e.target.checked;
      if (tab === 'preview') { reset(); renderFrame(); }
    });
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
