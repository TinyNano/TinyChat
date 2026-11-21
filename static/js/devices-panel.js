/*! devices-panel.js — 设置 → 账户 里的「登录设备」面板(从 app.js 拆出,逻辑未改)。
 *
 * 服务端维护每账号最近 20 次登录(见 lib/devices.php)。这里只做展示与三类动作:
 *   「退出该设备」踢自己 = 退出登录;踢别的设备后对方下一次请求就会 401 并被引导重新登录;
 *   「设为常用」让该浏览器之后登录不再发新设备提醒。
 *
 * 依赖 app.js 里已有的全局:state / api / toast / escapeHtml / logout。
 * 放在 app.js 之后加载,因为它读 state、用 app.js 的 api();只是推迟到用户打开设置时才会调用。
 */
(function () {
  'use strict';
  // app.js 的 $ 是顶层 const(const/let 不挂 window),跨脚本不可见,自带一份;
  // escapeHtml 在 app.js 里是 function 声明(会挂到 window,本就可跨脚本用),
  // 这里仍保留本地副本,让本文件不依赖「app.js 先于本文件加载」的顺序。
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');
  let devicesLoading = false;
  function fmtDeviceTime(ts) {
    const t = Number(ts) || 0;
    if (!t) return '';
    const d = new Date(t);
    const diff = Date.now() - t;
    if (diff < 60000) return '刚刚活跃';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前活跃';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前活跃';
    return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  function renderDevices(list, limit) {
    const box = $('acc-device-list');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<p class="muted small" style="margin:8px 0 0">没有可显示的设备记录（本次登录尚未登记，或已在别处全部下线）。</p>';
      return;
    }
    box.innerHTML = list.map((d) => {
      // 备注名是用户自己起的(「我的笔记本」);UA 推导名(Chrome · Windows)对多设备
      // 用户几乎无法区分,只在有备注时作为补充信息展示
      const hasName = !!(d.customName && String(d.customName).trim());
      const title = (hasName ? escapeHtml(d.customName) : escapeHtml(d.label || '未知设备'))
        + (d.current ? ' <span class="badge">当前设备</span>' : '')
        + (d.trusted ? ' <span class="badge default" title="这台设备登录时不再发送新设备提醒">常用</span>' : '');
      const meta = [
        hasName ? escapeHtml(d.label) : '',
        d.ip ? escapeHtml(d.ip) : '未知 IP',
        '登录于 ' + new Date(d.createdAt).toLocaleString('zh-CN'),
        fmtDeviceTime(d.lastActiveAt),
      ].filter(Boolean).join(' · ');
      return '<div class="row-between" data-device="' + escapeHtml(d.id) + '" style="padding:6px 0;border-bottom:1px solid var(--hairline)">'
        + '<div style="min-width:0"><div>' + title + '</div>'
        + '<div class="muted small" style="word-break:break-all">' + meta + '</div>'
        + (d.ua ? '<div class="muted small" style="opacity:.7;word-break:break-all">' + escapeHtml(d.ua) + '</div>' : '')
        + '</div>'
        + '<span class="dev-actions">'
        + '<button class="btn small" data-rename="' + escapeHtml(d.id) + '" data-name="' + escapeAttr(hasName ? d.customName : '') + '" type="button" title="给这台设备起个好认的名字">备注</button>'
        + '<button class="btn small" data-trust="' + escapeHtml(d.id) + '" data-on="' + (d.trusted ? '1' : '0') + '" type="button"'
        + ' title="' + (d.trusted ? '取消后,这台设备下次登录会重新发提醒邮件' : '标为常用后,这台设备登录时不再发新设备提醒') + '">'
        + (d.trusted ? '取消常用' : '设为常用') + '</button>'
        + '<button class="btn small' + (d.current ? '' : ' danger') + '" data-revoke="' + escapeHtml(d.id) + '" type="button">'
        + (d.current ? '退出登录' : '退出该设备') + '</button></span></div>';
    }).join('');
    const note = $('acc-device-note');
    if (note) note.textContent = '最多保留最近 ' + (limit || 20) + ' 次登录记录';
    // 常用设备:按浏览器指纹整台生效(见 lib/devices.php tc_api_me_device_trust)。
    // 标为常用后,这台设备登录不再触发「新设备登录」提醒邮件。
    box.querySelectorAll('[data-trust]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const on = btn.dataset.on !== '1';
        btn.disabled = true;
        try {
          const r = await api('/api/me/devices/' + encodeURIComponent(btn.dataset.trust) + '/trust', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trusted: on }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return toast((d.error && d.error.message) || '操作失败', true);
          toast(on ? '已设为常用设备，之后在这台设备登录不再发提醒' : '已取消常用设备');
          loadDevices();
        } catch (e) { toast('操作失败: ' + e.message, true); }
        finally { btn.disabled = false; }
      });
    });
    // 备注名:让多设备用户认得出「这是哪台机器」。留空提交 = 清除备注。
    box.querySelectorAll('[data-rename]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const current = btn.dataset.name || '';
        const name = window.OCUI && OCUI.prompt
          ? await OCUI.prompt({ title: '设备备注', message: '只在设备列表里展示，方便你自己认出这台机器。', value: current, maxlength: 40, confirmText: '保存' })
          : prompt('设备备注（留空清除）', current);
        if (name === null) return;   // 用户取消
        btn.disabled = true;
        try {
          const r = await api('/api/me/devices/' + encodeURIComponent(btn.dataset.rename) + '/label', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: String(name) }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return toast((d.error && d.error.message) || '操作失败', true);
          toast(String(name).trim() ? '已更新设备备注' : '已清除设备备注');
          loadDevices();
        } catch (e) { toast('操作失败: ' + e.message, true); }
        finally { btn.disabled = false; }
      });
    });
    box.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('[data-device]');
        const isCur = !!(row && row.textContent.indexOf('当前设备') >= 0);
        const ok = window.OCUI && OCUI.confirm
          ? await OCUI.confirm({
            title: isCur ? '退出登录' : '退出该设备',
            message: isCur ? '这台设备将退出登录，需要重新输入密码。' : '该设备上的登录会立即失效，需要重新输入密码。',
            danger: !isCur, confirmText: isCur ? '退出登录' : '退出',
          })
          : confirm(isCur ? '确认退出登录？' : '确认让该设备下线？');
        if (!ok) return;
        try {
          const r = await api('/api/me/devices/' + encodeURIComponent(btn.dataset.revoke), { method: 'DELETE' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return toast((d.error && d.error.message) || '操作失败', true);
          if (d.current) { logout(); return; }
          toast('该设备已退出登录');
          loadDevices();
        } catch (e) { toast('操作失败: ' + e.message, true); }
      });
    });
  }
  function loadDevices() {
    if (devicesLoading) return;
    const box = $('acc-device-list');
    if (!box || !state.token) return;
    devicesLoading = true;
    api('/api/me/devices').then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
      renderDevices(Array.isArray(d.devices) ? d.devices : [], d.limit);
    }).catch((e) => {
      if (box) box.innerHTML = '<p class="muted small" style="margin:8px 0 0">设备列表读取失败：' + escapeHtml(e.message || '') + '</p>';
    }).finally(() => { devicesLoading = false; });
  }
  (function initDevices() {
    const others = $('acc-device-revoke-others');
    if (others) others.addEventListener('click', async () => {
      const ok = window.OCUI && OCUI.confirm
        ? await OCUI.confirm({ title: '退出其它全部设备', message: '除这台设备外的所有登录都会失效。', danger: true, confirmText: '全部退出' })
        : confirm('确认退出其它全部设备？');
      if (!ok) return;
      try {
        const r = await api('/api/me/devices', { method: 'DELETE' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return toast((d.error && d.error.message) || '操作失败', true);
        toast(d.removed ? ('已退出 ' + d.removed + ' 台设备') : '没有其它设备在线');
        loadDevices();
      } catch (e) { toast('操作失败: ' + e.message, true); }
    });
  })();

  // 设置面板每次打开都会调(见 app.js 的 openSettings)
  window.OCLoadDevices = loadDevices;
})();
