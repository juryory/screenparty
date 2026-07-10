// ScreenParty 登录页 — 登录成功后跳转到大厅 /
'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// 已登录则直接跳回大厅(保留邀请链接里的房间名)
(async function () {
  try {
    const r = await fetch('/api/me');
    if (r.ok) return go();
  } catch {}
  $('login').hidden = false;
  $('loginUser').focus();
})();

function go() {
  const room = params.get('room');
  location.replace(room ? `/?room=${encodeURIComponent(room)}` : '/');
}

$('loginBtn').addEventListener('click', doLogin);
[$('loginUser'), $('loginPass')].forEach((el) =>
  el.addEventListener('keydown', (e) => e.key === 'Enter' && doLogin()),
);

async function doLogin() {
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  if (!username || !password) return showError('请输入用户名和密码');
  $('loginBtn').disabled = true;
  showError('');
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      showError(j.error || '登录失败');
      $('loginBtn').disabled = false;
      return;
    }
    go();
  } catch {
    showError('网络错误,请重试');
    $('loginBtn').disabled = false;
  }
}

function showError(text) {
  const el = $('loginError');
  el.textContent = text;
  el.hidden = !text;
}
