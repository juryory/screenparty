// ScreenParty 管理面板 — 用户增删改查(仅管理员)
// 所有安全校验以服务端为准;此页非 admin 打开也会被后端 403。

'use strict';

const $ = (id) => document.getElementById(id);

// 进入前确认已登录且是管理员,否则跳回首页
(async function guard() {
  let me = null;
  try {
    const r = await fetch('/api/me');
    if (r.ok) me = (await r.json()).user;
  } catch {}
  if (!me || !me.isAdmin) {
    location.replace('/');
    return;
  }
  $('admin').hidden = false;
  loadUsers();
})();

// ---------- 列表 ----------

async function loadUsers() {
  try {
    const r = await fetch('/api/admin/users');
    if (!r.ok) throw new Error();
    const { users } = await r.json();
    renderUsers(users);
  } catch {
    showMsg('listMsg', '加载用户列表失败', true);
  }
}

function renderUsers(users) {
  const tbody = $('userRows');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(u.username));
    tr.appendChild(cell(u.nickname));
    tr.appendChild(cell(u.isAdmin ? '管理员' : '用户'));

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge ' + (u.enabled ? 'badge-on' : 'badge-off');
    badge.textContent = u.enabled ? '启用' : '停用';
    statusCell.appendChild(badge);
    tr.appendChild(statusCell);

    const shareCell = document.createElement('td');
    const shareBadge = document.createElement('span');
    shareBadge.className = 'badge ' + (u.canShare ? 'badge-on' : 'badge-off');
    shareBadge.textContent = u.canShare ? '允许' : '未开';
    shareCell.appendChild(shareBadge);
    tr.appendChild(shareCell);

    tr.appendChild(actionCell(u));
    tbody.appendChild(tr);
  }
  if (!users.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'admin-empty';
    td.textContent = '暂无用户';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function actionCell(u) {
  const td = document.createElement('td');
  td.className = 'admin-ops';

  // 改昵称
  const nickBtn = opBtn('改昵称', async () => {
    const nickname = prompt(`修改「${u.username}」的显示昵称:`, u.nickname);
    if (nickname == null) return;
    await patchUser(u.username, { nickname });
  });
  td.appendChild(nickBtn);

  // 重置密码
  const pwBtn = opBtn('重置密码', async () => {
    const password = prompt(`为「${u.username}」设置新密码(至少 6 位):`, '');
    if (!password) return;
    await patchUser(u.username, { password });
  });
  td.appendChild(pwBtn);

  if (!u.isAdmin) {
    // 共享权限开关(注册用户默认关,由这里开启)
    const share = opBtn(u.canShare ? '关闭共享' : '开启共享', async () => {
      await patchUser(u.username, { canShare: !u.canShare });
    });
    td.appendChild(share);

    // 启用/停用
    const toggle = opBtn(u.enabled ? '停用' : '启用', async () => {
      await patchUser(u.username, { enabled: !u.enabled });
    });
    td.appendChild(toggle);

    // 删除
    const del = opBtn('删除', async () => {
      if (!confirm(`确定删除用户「${u.username}」?此操作不可撤销。`)) return;
      await deleteUser(u.username);
    });
    del.classList.add('op-danger');
    td.appendChild(del);
  }

  return td;
}

function opBtn(label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn-ghost op-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ---------- 增 / 改 / 删 ----------

$('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    username: $('cUser').value.trim(),
    nickname: $('cNick').value.trim(),
    password: $('cPass').value,
    enabled: $('cEnabled').checked,
    canShare: $('cShare').checked,
  };
  try {
    const r = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return showMsg('createMsg', j.error || '创建失败', true);
    showMsg('createMsg', '创建成功', false);
    $('createForm').reset();
    $('cEnabled').checked = true;
    $('cShare').checked = true;
    loadUsers();
  } catch {
    showMsg('createMsg', '网络错误', true);
  }
});

async function patchUser(username, patch) {
  try {
    const r = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return showMsg('listMsg', j.error || '更新失败', true);
    showMsg('listMsg', '已更新', false);
    loadUsers();
  } catch {
    showMsg('listMsg', '网络错误', true);
  }
}

async function deleteUser(username) {
  try {
    const r = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return showMsg('listMsg', j.error || '删除失败', true);
    showMsg('listMsg', '已删除', false);
    loadUsers();
  } catch {
    showMsg('listMsg', '网络错误', true);
  }
}

function showMsg(id, text, isError) {
  const el = $(id);
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('is-error', !!isError);
}
