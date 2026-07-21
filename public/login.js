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
  const c = params.get('c'); // 邀请链接里的频道 id:登录/注册后自动跳回该频道
  if (c) return location.replace(`/?c=${encodeURIComponent(c)}`);
  const room = params.get('room'); // 兼容旧的 ?room= 链接
  location.replace(room ? `/?room=${encodeURIComponent(room)}` : '/');
}

// 登录 / 注册模式切换
let registering = false;
$('modeToggle').addEventListener('click', (e) => {
  e.preventDefault();
  registering = !registering;
  $('nickLabel').hidden = $('loginNick').hidden = !registering;
  $('regHint').hidden = !registering;
  $('brandSub').textContent = registering ? '注册新账号' : '请使用账号登录';
  $('loginBtn').textContent = registering ? '注册并进入' : '登录';
  $('modeToggle').textContent = registering ? '已有账号?去登录' : '没有账号?注册一个';
  showError('');
});

$('loginBtn').addEventListener('click', doSubmit);
[$('loginUser'), $('loginNick'), $('loginPass')].forEach((el) =>
  el.addEventListener('keydown', (e) => e.key === 'Enter' && doSubmit()),
);

async function doSubmit() {
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  const nickname = $('loginNick').value.trim();
  if (!username || !password) return showError('请输入用户名和密码');
  if (registering && !nickname) return showError('请填写显示昵称');
  $('loginBtn').disabled = true;
  showError('');
  try {
    const r = await fetch(registering ? '/api/register' : '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registering ? { username, nickname, password } : { username, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      showError(j.error || (registering ? '注册失败' : '登录失败'));
      $('loginBtn').disabled = false;
      return;
    }
    go();
  } catch {
    showError('网络错误,请重试');
    $('loginBtn').disabled = false;
  }
}

// 游客进入:创建临时游客会话(只能观看、720p),成功后走与登录相同的跳转
$('guestBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  showError('');
  try {
    const r = await fetch('/api/guest', { method: 'POST' });
    if (r.ok) return go();
    showError('游客进入失败,请重试');
  } catch {
    showError('网络错误,请重试');
  }
});

function showError(text) {
  const el = $('loginError');
  el.textContent = text;
  el.hidden = !text;
}
