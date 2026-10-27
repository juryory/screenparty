// ScreenParty 前端 — Cloudflare Realtime SFU
//
// 连接模型:每人一条上行连接把自己的麦克风/屏幕/摄像头发布到 SFU(屏幕三层 simulcast),
// 一条下行连接按房间信令里公布的轨道订阅别人。共享者只上传一份,与观看人数无关。
// 详见下方「Cloudflare Realtime SFU」一节。P2P mesh 版本在 tencent 分支。

'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  myId: null,
  myName: '',
  myUser: '',
  role: 'member',
  canShare: false, // 能否共享屏幕/摄像头(目前所有登录者含游客皆可)
  isGuest: false,  // 游客:收/发画质都锁到游客档码率
  quality: { clear: 2500, smooth: 1500, guest: 800 }, // 画质档码率 kbps(从 /api/guild 加载)
  shareTier: (() => { try { return localStorage.getItem('sp-tier') || 'smooth'; } catch { return 'smooth'; } })(), // 我的共享清晰度:hd/clear/smooth,默认流畅
  // 质量-速度滑杆 0..4(0=最保画质,4=最保流畅),默认 1 = 画质优先
  tradeoff: (() => { try { const v = Number(localStorage.getItem('sp-tradeoff') ?? 1); return v >= 0 && v <= 4 ? Math.round(v) : 1; } catch { return 1; } })(),
  channelId: null,
  channelName: '',
  guild: null, // { guild:{name,icon,description}, categories:[], channels:[], me:{role} }
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  micTrack: null,
  screenStream: null,
  camStream: null,
  presence: {}, // channelId -> 当前人数(轮询 /api/presence)
  channelTicket: {}, // channelId -> 密码校验通过后服务端签发的通行凭证(内存缓存,重进/重连免输;不存密码本身)
  peers: new Map(), // id -> { name, sharing, camera, pub, tile, camTile, videoStream, camStream, screenAudioTrack, audioEl }
  focusedId: null,  // 当前主舞台显示谁:peer id / id+':cam' / 'local' / 'local:cam' / null
};

const ROLE_LABEL = { owner: '所有者', admin: '管理员', member: '成员' };

const SCREEN_MAX_BITRATE = 3_500_000; // ~3.5 Mbps,高清档 f 层(主窗口观看)码率
const THUMB_MAX_BITRATE = 300_000;    // q 层(缩略图)~300kbps
const CAM_MAX_BITRATE = 1_000_000;    // 摄像头固定 ~1 Mbps(人脸画面不需要屏幕那么高)

// 质量-速度滑杆各档:带宽/CPU 吃紧时编码器怎么退让(作用于 f 层,即主窗口观看者收到的那层)
//   pref   degradationPreference:maintain-resolution 掉帧保分辨率 / balanced 两头都让 /
//          maintain-framerate 降分辨率保帧率(会 1080→810→540→405 逐级掉,回升慢)
//   fps    帧率上限:限帧后每帧分到的码率更多,画面更干净
//   maxH   主动把分辨率压到这个高度以内,留出余量保流畅(null = 不限)
const TRADEOFFS = [
  { label: '极致画质', pref: 'maintain-resolution', fps: 20, maxH: null },
  { label: '画质优先', pref: 'maintain-resolution', fps: 30, maxH: null },
  { label: '平衡', pref: 'balanced', fps: 30, maxH: null },
  { label: '流畅优先', pref: 'maintain-framerate', fps: 30, maxH: null },
  { label: '极致流畅', pref: 'maintain-framerate', fps: 30, maxH: 720 },
];

// 调试模式:地址加 ?debug=1 开启(记在本机,?debug=0 关闭),画面角标显示 <video> 的完整播放状态
const DEBUG = (() => {
  try {
    const q = new URLSearchParams(location.search).get('debug');
    if (q !== null) localStorage.setItem('sp-debug', q === '1' ? '1' : '');
    return localStorage.getItem('sp-debug') === '1';
  } catch {
    return false;
  }
})();

// ---------- Safari 自动播放兜底 ----------
// Safari 拦截带声 autoplay(play() 拒绝后连画面都不解码,表现为黑屏)。
// 兜底:被拒就先静音播出画面,等用户下一次点击页面(Safari 认的手势)统一解除静音重播。
const pendingUnmute = new Set();

function safePlay(el) {
  el.play().catch(() => {
    if (el.muted) return;
    el.muted = true;
    pendingUnmute.add(el);
    el.play().catch(() => {});
  });
}

document.addEventListener(
  'pointerdown',
  () => {
    for (const el of pendingUnmute) {
      el.muted = false;
      el.play().catch(() => {});
    }
    pendingUnmute.clear();
    // 静音后仍被拦下(iOS 低电量模式等)的画面:借这次点击手势一并播起来
    for (const v of document.querySelectorAll('.tile video')) if (v.paused) v.play().catch(() => {});
  },
  true
);

// ---------- 启动 / 鉴权 ----------

bootstrapAuth();

async function bootstrapAuth() {
  let me = null;
  try {
    const r = await fetch('/api/me');
    if (r.ok) me = (await r.json()).user;
  } catch {}
  if (!me) {
    // 未登录:带上邀请链接里的频道,登录/注册后自动跳回该频道
    const c = new URLSearchParams(location.search).get('c');
    return location.replace('/login.html' + (c ? `?c=${encodeURIComponent(c)}` : ''));
  }
  state.myName = me.nickname;
  state.myUser = me.username;
  state.canShare = !!me.canShare;
  state.isGuest = !!me.isGuest;
  $('app').hidden = false;
  $('uNick').textContent = me.nickname;
  $('uAvatar').textContent = me.nickname.slice(0, 2);
  $('adminLink').hidden = !me.isAdmin;
  $('registerBtn').hidden = !me.isGuest; // 游客可就地注册升级为正式账号(即改名)
  applyShareUi();
  setDrawer(true); // 手机端初始展开频道抽屉
  await loadGuild();
  maybeAutoJoin(); // 邀请链接 ?c=<频道id>:自动进入该频道
  loadPresence();
  // 频道人数轮询:页面在后台时不拉(省 DO 请求额度),切回前台立即补一次
  setInterval(() => document.hidden || loadPresence(), 10_000);
  document.addEventListener('visibilitychange', () => document.hidden || loadPresence());
  startStatsLoop();
}

// 邀请链接自动进频道:找到对应频道并进入(有密码会照常弹框),随后清掉 URL 参数
function maybeAutoJoin() {
  const c = new URLSearchParams(location.search).get('c');
  if (!c || !state.guild) return;
  history.replaceState(null, '', '/');
  const ch = state.guild.channels.find((x) => x.id === c);
  if (ch && ch.type !== 'text') tryJoinChannel(ch);
}

// 拉各频道当前人数;自己所在频道用本地实时数(state.peers),其余用轮询结果
async function loadPresence() {
  try {
    const r = await fetch('/api/presence');
    if (!r.ok) return;
    state.presence = (await r.json()).counts || {};
  } catch {
    return;
  }
  renderChannels();
}

function channelCount(id) {
  if (id === state.channelId && state.myId) return state.peers.size + 1;
  return state.presence[id] || 0;
}

// 共享按钮可用性:无权限禁用并提示(服务端同样会拦截,这里只是界面反馈);
// 摄像头按钮常驻左下角,还需进了频道才可用
function applyShareUi() {
  const noPerm = '游客只能观看,注册账号后即可共享';
  $('shareBtn').disabled = !state.canShare;
  $('shareBtn').title = state.canShare ? '' : noPerm;
  const cam = $('camBtn');
  cam.disabled = !state.canShare || !state.channelId;
  cam.title = !state.canShare ? noPerm : !state.channelId ? '进入频道后可开启摄像头' : state.camStream ? '关闭摄像头' : '摄像头';
  // 清晰度档选择器:游客隐藏(游客档位锁定,不可自选)
  const sel = $('shareTier');
  if (sel) {
    sel.hidden = !state.canShare || state.isGuest;
    sel.value = state.shareTier;
  }
  // 质量-速度滑杆:同样游客隐藏(游客路固定保帧率)
  $('tradeoffBox').hidden = !state.canShare || state.isGuest;
  $('tradeoff').value = state.tradeoff;
  $('tradeoffBox').title = `带宽/性能不够时的取舍:${TRADEOFFS[state.tradeoff].label}`;
}
$('shareTier').addEventListener('change', () => setShareTier($('shareTier').value));
$('tradeoff').addEventListener('input', () => setTradeoff(Number($('tradeoff').value)));

// 拉服务器结构(名称/图标/分类/频道/我的角色)并渲染频道列表
async function loadGuild() {
  try {
    const r = await fetch('/api/guild');
    if (!r.ok) return;
    state.guild = await r.json();
  } catch {
    return;
  }
  state.role = state.guild.me?.role || 'member';
  if (state.guild.guild.quality) state.quality = state.guild.guild.quality;
  $('guildName').textContent = state.guild.guild.name;
  $('serverBadge').textContent = state.guild.guild.icon || '🎮';
  $('serverBadge').title = state.guild.guild.name;
  $('uRole').textContent = state.isGuest ? '游客' : ROLE_LABEL[state.role] || '成员';
  $('guildMenuBtn').hidden = !canManage();
  renderChannels();
}

// ---------- 手机端频道抽屉 ----------
// ≤640px 时频道栏是抽屉(CSS 控制,桌面端此 class 无效果)。
// 没进频道时保持展开(否则满屏空舞台无处可点),进频道自动收起。
function setDrawer(open) {
  $('app').classList.toggle('drawer-open', open);
}
$('drawerBtn').addEventListener('click', () => setDrawer(true));
$('drawerBackdrop').addEventListener('click', () => {
  if (state.channelId) setDrawer(false);
});

// 设置菜单(退出登录 / 用户管理)
$('settingsBtn').addEventListener('click', () => {
  const m = $('userMenu');
  m.hidden = !m.hidden;
  $('settingsBtn').setAttribute('aria-expanded', String(!m.hidden));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.userbar')) $('userMenu').hidden = true;
});
$('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {}
  location.replace('/login.html');
});

// 游客就地注册:输入用户名/昵称/密码即注册为正式账号(也就是「改名」)。成功后刷新页面换上新身份。
$('registerBtn').addEventListener('click', () => {
  $('userMenu').hidden = true;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:14px';
  const uUser = textInput('', '字母/数字/下划线', 32);
  const uNick = textInput(state.isGuest ? '' : state.myName, '频道里显示的名字', 24);
  const uPass = textInput('', '至少 6 位', 128);
  uPass.type = 'password';
  const err = document.createElement('p');
  err.className = 'lobby-error';
  err.hidden = true;
  wrap.append(
    field('用户名', uUser),
    field('显示昵称', uNick),
    field('密码', uPass),
    err,
  );
  openModal('注册账号', wrap, async () => {
    const username = uUser.value.trim();
    const nickname = uNick.value.trim();
    const password = uPass.value;
    const fail = (t) => { err.textContent = t; err.hidden = false; return false; };
    if (!username || !password) return fail('请输入用户名和密码');
    if (!nickname) return fail('请填写显示昵称');
    if (password.length < 6) return fail('密码至少 6 位');
    try {
      const r = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, nickname, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return fail(j.error || '注册失败'); // 用户名/昵称重复等会在此提示
      location.reload(); // 换上正式账号身份重新进入
      return true;
    } catch {
      return fail('网络错误,请重试');
    }
  }, '注册并使用');
});

// ---------- 频道列表 ----------

function renderChannels() {
  const list = $('channelList');
  list.innerHTML = '';
  const { categories, channels } = state.guild;
  const byCat = new Map();
  const uncategorized = [];
  for (const ch of channels) {
    if (ch.categoryId && categories.some((c) => c.id === ch.categoryId)) {
      if (!byCat.has(ch.categoryId)) byCat.set(ch.categoryId, []);
      byCat.get(ch.categoryId).push(ch);
    } else {
      uncategorized.push(ch);
    }
  }
  for (const ch of uncategorized) list.appendChild(channelItem(ch));
  for (const cat of categories) {
    const head = document.createElement('div');
    head.className = 'cat-head';
    const label = document.createElement('span');
    label.textContent = cat.name;
    head.appendChild(label);
    if (canManage()) addCategoryActions(head, cat);
    list.appendChild(head);
    for (const ch of byCat.get(cat.id) || []) list.appendChild(channelItem(ch));
  }
  renderMembers(); // 重画后补回当前频道的成员列表(channelMembers 容器是新建的空盒子)
}

function channelItem(ch) {
  const wrap = document.createElement('div');
  wrap.className = 'channel-item';
  const row = document.createElement('div');
  row.className = 'channel-row';
  row.dataset.channel = ch.id;
  row.classList.toggle('is-active', ch.id === state.channelId);
  row.innerHTML = `<span class="ch-glyph">${ch.type === 'text' ? '#' : '🔊'}</span><span class="ch-label"><span class="ch-name-txt"></span><span class="ch-lock" title="需要密码">🔒</span><span class="ch-count"></span></span>`;
  row.querySelector('.ch-name-txt').textContent = ch.name;
  row.querySelector('.ch-lock').hidden = !ch.hasPassword;
  const n = channelCount(ch.id);
  row.querySelector('.ch-count').textContent = n ? ` (${n})` : '';
  if (ch.type !== 'text') row.addEventListener('click', () => tryJoinChannel(ch));
  if (canManage()) addChannelActions(row, ch);
  wrap.appendChild(row);
  if (ch.id === state.channelId) {
    const mem = document.createElement('div');
    mem.className = 'channel-members';
    mem.id = 'channelMembers';
    wrap.appendChild(mem);
  }
  return wrap;
}

// ---------- 进入 / 离开频道 ----------

// 带锁频道:普通成员先验密码(owner/admin 免密,服务端同样放行)
function tryJoinChannel(ch) {
  if (!ch.hasPassword || canManage() || state.channelTicket[ch.id]) {
    return joinChannel(ch.id, ch.name, ch.topic);
  }
  const input = textInput('', '频道密码', 64);
  input.type = 'password';
  const body = document.createElement('div');
  body.append(field(`「${ch.name}」需要密码`, input));
  openModal('输入频道密码', body, async () => {
    const pw = input.value;
    const r = await api('POST', `/api/channels/${ch.id}/verify`, { password: pw });
    if (!r.ok) return (alert(r.error || '密码错误'), false);
    state.channelTicket[ch.id] = r.data.ticket;
    joinChannel(ch.id, ch.name, ch.topic);
  }, '进入');
}

async function joinChannel(id, name, topic) {
  if (state.channelId === id) return;
  if (state.channelId) leaveChannel(false);

  // 每次进频道刷新一次服务器设置:管理员改了「强制中继」等,其他人下次进频道即生效,无需刷新页面
  await loadGuild();
  if (state.guild && !state.guild.sfuConfigured) {
    alert('服务器还没配置 Cloudflare Realtime SFU(REALTIME_APP_ID / REALTIME_APP_SECRET),暂时无法进入频道');
    return;
  }
  // 没有麦克风时不阻塞:只共享/观看画面、收听别人语音
  if (!state.micTrack) state.micTrack = await acquireMic();
  if (state.iceServers.length <= 1) {
    try {
      const r = await fetch('/api/turn');
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.iceServers) && j.iceServers.length) state.iceServers = j.iceServers;
      }
    } catch {}
  }

  state.channelId = id;
  state.channelName = name;
  $('channelBar').hidden = false;
  $('curChannel').textContent = name;
  $('curTopic').textContent = topic || '';
  $('emptyMain').textContent = '还没有人在共享画面';
  applyMicUi();
  applyShareUi();
  startMeter();
  setDrawer(false); // 进频道收起抽屉,把屏幕让给画面
  renderChannels();
  connectSignaling();
}

function leaveChannel(rerender = true) {
  stopHeartbeat();
  clearTimeout(reconnectTimer);
  $('netStatus').hidden = true;
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
    $('shareBtn').setAttribute('aria-pressed', 'false');
    $('shareBtn').querySelector('span').textContent = '共享屏幕';
  }
  if (state.camStream) {
    state.camStream.getTracks().forEach((t) => t.stop());
    state.camStream = null;
    camUi(false);
  }
  for (const [, p] of state.peers) detachAll(p);
  state.peers.clear();
  stopMedia(); // SFU 会话不用显式关:连接断开后轨道 30s 无数据即被回收
  localTile?.remove();
  localTile = null;
  localCamTile?.remove();
  localCamTile = null;
  stopMeter();
  try {
    state.ws?.close();
  } catch {}
  state.ws = null;
  state.myId = null;
  state.channelId = null;
  state.channelName = '';
  state.focusedId = null;
  $('channelBar').hidden = true;
  applyShareUi();
  setDrawer(true); // 离开频道重新展开抽屉(手机端)
  $('emptyMain').textContent = '← 选一个语音频道开始开黑';
  $('emptyState').hidden = false;
  $('rail').innerHTML = '';
  if (rerender) renderChannels();
}

// 麦克风按钮 UI:无设备则禁用;有设备按静音态更新
function applyMicUi() {
  const b = $('micToggle');
  if (!state.micTrack) {
    b.disabled = true;
    b.classList.add('is-off');
    b.setAttribute('aria-pressed', 'false');
    b.title = '未检测到麦克风';
    return;
  }
  const muted = !state.micTrack.enabled;
  b.disabled = false;
  b.classList.toggle('is-off', muted);
  b.setAttribute('aria-pressed', String(!muted));
  b.title = muted ? '已静音' : '麦克风';
}

$('micToggle').addEventListener('click', () => {
  if (!state.micTrack) return;
  state.micTrack.enabled = !state.micTrack.enabled;
  applyMicUi();
});

// ---------- 麦克风电平表(-24dB ~ 0dB) ----------
// WebAudio 采样本地麦克风算 RMS 转 dBFS;静音(track.enabled=false)时轨道输出静默,表自然回落。
const meter = { ac: null, src: null, analyser: null, data: null, raf: 0 };

function startMeter() {
  if (!state.micTrack) return stopMeter();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    meter.ac ||= new AC();
    meter.ac.resume?.().catch(() => {});
    meter.src?.disconnect();
    meter.analyser ||= meter.ac.createAnalyser();
    meter.analyser.fftSize = 1024;
    meter.src = meter.ac.createMediaStreamSource(new MediaStream([state.micTrack]));
    meter.src.connect(meter.analyser); // 只分析不外放,不接 destination
    meter.data ||= new Float32Array(meter.analyser.fftSize);
    $('micMeter').hidden = false;
    cancelAnimationFrame(meter.raf);
    const tick = () => {
      meter.analyser.getFloatTimeDomainData(meter.data);
      let sum = 0;
      for (let i = 0; i < meter.data.length; i++) sum += meter.data[i] * meter.data[i];
      const db = 20 * Math.log10(Math.sqrt(sum / meter.data.length) || 1e-7);
      const pct = Math.max(0, Math.min(1, (db + 24) / 24)); // -24dB→0%,0dB→100%
      $('meterCover').style.left = (pct * 100).toFixed(1) + '%';
      meter.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    stopMeter();
  }
}

function stopMeter() {
  cancelAnimationFrame(meter.raf);
  meter.raf = 0;
  meter.src?.disconnect();
  meter.src = null;
  $('meterCover').style.left = '0%';
  $('micMeter').hidden = true;
}

// 记忆的设备偏好(设备设置弹窗保存);ideal 而非 exact:设备拔掉时自动回退默认
function prefDevice(key) {
  const id = localStorage.getItem(key);
  return id ? { ideal: id } : undefined;
}

// 尝试获取麦克风;拿不到就返回 null(不阻塞进房)。
// 不设短超时:移动端弹授权框 + 用户手动点「允许」常超过几秒,超时会把已授权的麦克风
// 误判为无设备丢弃,导致"允许了却说不了话"。无麦克风机器靠 getUserMedia 自身报错处理。
async function acquireMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: prefDevice('sp_micId'), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return stream.getAudioTracks()[0] || null;
  } catch {
    return null; // 拒绝授权 / 无麦克风设备:按无麦克风处理(仍可共享/观看/收听)
  }
}

// ---------- 信令 ----------

function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ticket = state.channelTicket[state.channelId];
  const ws = new WebSocket(
    `${proto}://${location.host}/ws/${encodeURIComponent(state.channelId)}${ticket ? `?t=${encodeURIComponent(ticket)}` : ''}`,
  );
  state.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name: state.myName }));
    startHeartbeat(ws);
  };

  ws.onmessage = async (e) => {
    if (state.ws !== ws) return; // 快速切频道时旧连接的迟到消息,直接丢弃
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'welcome':
        state.myId = msg.id;
        reconnectDelay = 1000; // 重连成功,退避归位
        $('netStatus').hidden = true;
        for (const p of msg.peers) addPeer(p);
        renderMembers();
        // 首次进频道:建 SFU 连接并发布麦克风等;信令重连:SFU 连接还在,只需向房间重新报一次发布信息
        if (!sfu.pub) {
          startMedia();
          await publishCurrent();
        } else {
          sendPublish();
        }
        syncSubscriptions();
        break;
      case 'peer-joined':
        addPeer(msg.peer); // 对方发布轨道后会收到 peer-state,届时再订阅
        blip(true);
        break;
      case 'peer-left':
        removePeer(msg.id);
        blip(false);
        syncSubscriptions();
        break;
      case 'peer-state': {
        const p = state.peers.get(msg.id);
        if (p) {
          p.sharing = msg.sharing;
          p.camera = !!msg.camera;
          p.pub = msg.pub || null;
          syncSubscriptions();
          refreshTiles();
        }
        break;
      }
    }
  };

  ws.onclose = (e) => {
    if (state.ws !== ws) return;
    stopHeartbeat();
    // 同账号在别处进了频道,本连接被服务器顶掉:退出本地频道状态
    if (e.reason === 'replaced') return leaveChannel();
    // 从未收到 welcome 就被关 = 连接被拒(密码被管理员改掉 / 凭证过期):清缓存退出
    if (!state.myId && state.channelId) {
      delete state.channelTicket[state.channelId];
      leaveChannel();
      alert('进入频道失败,密码可能已更改或验证已过期,请重新输入');
      return;
    }
    // 意外断线(网络波动 / 被服务器判超时):自动重连本频道
    if (state.channelId) scheduleReconnect();
  };
}

// ---------- 心跳 / 断线重连 ----------

let heartbeatTimer = null;
function startHeartbeat(ws) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 8000);
}
function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

let reconnectTimer = null;
let reconnectDelay = 1000;
// 信令断线重连:成员 id 会重新分配,清掉旧成员(订阅随之在下次同步时关闭),退避重试进入本频道。
// SFU 媒体连接独立于信令,不受影响。
function scheduleReconnect() {
  if (!state.channelId) return;
  $('netStatus').hidden = false;
  resetPeers();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!state.channelId) return;
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    connectSignaling();
  }, reconnectDelay);
}

// 清掉当前所有成员(重连前),保留本地频道 / 共享状态
function resetPeers() {
  for (const [, p] of state.peers) {
    p.audioEl && (p.audioEl.srcObject = null);
    p.tile?.remove();
    p.camTile?.remove();
  }
  state.peers.clear();
  state.myId = null;
  state.focusedId = null;
  refreshTiles();
}

// ---------- Cloudflare Realtime SFU ----------
//
// 每人两条 PeerConnection 连到 Cloudflare 边缘:
//   pub  只发:麦克风 / 屏幕(画面三层 simulcast + 游戏声)/ 摄像头,各自是一个具名轨道
//   sub  只收:按房间里别人公布的「会话 ID + 轨道名」订阅
// SFU API 由 Worker 代调(/api/sfu/*,App Secret 不出服务端)。
// 同一会话的操作必须串行:上一个操作的 SDP 交换完成前不能发起下一个,所以每条连接一个串行队列。

const sfu = {
  pub: null, // SfuConn
  sub: null, // SfuConn
  published: {}, // kind -> { trackName, transceiver }   kind: mic / screen / screenAudio / cam
  subs: new Map(), // key -> { key, peerId, kind, sessionId, trackName, mid, rid }
  byMid: new Map(), // 下行连接的 mid -> 订阅,ontrack 据此找到是谁的哪路
  seq: 0, // 轨道名序号:每次重新共享用新名字,不复用已关闭的轨道
  syncQueued: false,
  restarting: false,
};

// 屏幕三层 simulcast:f 原始/滑杆限定分辨率,h 一半(游客观看),q 缩略图
const SCREEN_LAYERS = ['f', 'h', 'q'];

class SfuConn {
  constructor(onTrack) {
    this.pc = new RTCPeerConnection(iceConfig());
    this.session = null; // { sessionId, token }
    this.queue = Promise.resolve();
    if (onTrack) this.pc.ontrack = onTrack;
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      clearTimeout(this.lostTimer);
      if (st === 'failed') restartMedia();
      else if (st === 'disconnected') this.lostTimer = setTimeout(restartMedia, 5000); // disconnected 常能自愈,先等 5s
    };
  }
  // 串行执行:fn 内的 API 调用 + SDP 交换整体完成后才轮到下一个
  run(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }
  async ensureSession() {
    if (!this.session) this.session = await sfuCall('session', {});
    return this.session;
  }
  call(op, body) {
    return sfuCall(op, { ...body, sessionId: this.session.sessionId, token: this.session.token });
  }
  close() {
    clearTimeout(this.lostTimer);
    this.pc.onconnectionstatechange = null;
    this.pc.ontrack = null;
    this.pc.close();
  }
}

async function sfuCall(op, body) {
  const r = await fetch('/api/sfu/' + op, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.errorCode) throw new Error(data.error || data.errorDescription || data.errorCode || `SFU ${op} ${r.status}`);
  return data;
}

// SFU 发来 offer(订阅新轨道等):应答并回传
async function answerSfuOffer(conn, offer) {
  await conn.pc.setRemoteDescription(offer);
  await conn.pc.setLocalDescription(await conn.pc.createAnswer());
  await conn.call('renegotiate', { sessionDescription: conn.pc.localDescription });
}

function startMedia() {
  sfu.pub = new SfuConn();
  sfu.sub = new SfuConn(onRemoteTrack);
}

function stopMedia() {
  sfu.pub?.close();
  sfu.sub?.close();
  sfu.pub = sfu.sub = null;
  sfu.published = {};
  sfu.subs.clear();
  sfu.byMid.clear();
  sfu.syncQueued = false;
}

// 媒体连接断了(网络切换等):整套重建 — 新会话、重新发布、重新订阅
async function restartMedia() {
  if (sfu.restarting || !state.channelId || !sfu.pub) return;
  sfu.restarting = true;
  $('netStatus').hidden = false;
  try {
    for (const p of state.peers.values()) detachAll(p);
    stopMedia();
    await new Promise((r) => setTimeout(r, 1000));
    if (!state.channelId) return;
    startMedia();
    await publishCurrent();
    syncSubscriptions();
    $('netStatus').hidden = true;
  } finally {
    sfu.restarting = false;
  }
}

// 把当前本地的麦克风 / 屏幕 / 摄像头全部发布出去(进频道、媒体重建时)
async function publishCurrent() {
  const entries = [];
  if (state.micTrack) entries.push(...micEntries());
  if (state.screenStream) entries.push(...screenEntries());
  if (state.camStream) entries.push(...camEntries());
  if (entries.length) {
    try {
      await publishTracks(entries);
    } catch (e) {
      console.warn('SFU 发布失败', e);
      alert('连接媒体服务器失败:' + e.message);
    }
  }
  if (state.screenStream) applyScreenParams();
  sendPublish();
}

function nextTrackName(kind) {
  return `${kind}-${++sfu.seq}`;
}
function micEntries() {
  return [{ kind: 'mic', track: state.micTrack, init: {} }];
}
function screenEntries() {
  const vt = state.screenStream.getVideoTracks()[0];
  const at = state.screenStream.getAudioTracks()[0];
  const out = [
    {
      kind: 'screen',
      track: vt,
      init: { sendEncodings: SCREEN_LAYERS.map((rid, i) => ({ rid, scaleResolutionDownBy: 2 ** i })) },
    },
  ];
  if (at) out.push({ kind: 'screenAudio', track: at, init: {} });
  return out;
}
function camEntries() {
  return [{ kind: 'cam', track: state.camStream.getVideoTracks()[0], init: { sendEncodings: [{ maxBitrate: CAM_MAX_BITRATE }] } }];
}

// 发布:加 transceiver → 本地 offer → tracks/new → 应用 SFU 的 answer
function publishTracks(entries) {
  const conn = sfu.pub;
  return conn.run(async () => {
    await conn.ensureSession();
    const added = entries.map((e) => ({ ...e, trackName: nextTrackName(e.kind), transceiver: conn.pc.addTransceiver(e.track, { direction: 'sendonly', ...e.init }) }));
    await conn.pc.setLocalDescription(await conn.pc.createOffer());
    const res = await conn.call('tracks', {
      sessionDescription: conn.pc.localDescription,
      tracks: added.map((a) => ({ location: 'local', mid: a.transceiver.mid, trackName: a.trackName })),
    });
    await conn.pc.setRemoteDescription(res.sessionDescription);
    const failed = (res.tracks || []).filter((t) => t.errorCode);
    for (const a of added) {
      if (failed.some((t) => t.trackName === a.trackName)) continue;
      sfu.published[a.kind] = { trackName: a.trackName, transceiver: a.transceiver };
    }
    if (failed.length) throw new Error(failed[0].errorDescription || failed[0].errorCode);
  });
}

// 取消发布:停掉 transceiver → 本地 offer → tracks/close(带 SDP 协商关闭)→ 应用 answer
function unpublish(kinds) {
  const conn = sfu.pub;
  const items = kinds.map((k) => sfu.published[k]).filter(Boolean);
  kinds.forEach((k) => delete sfu.published[k]);
  if (!conn || !items.length) return Promise.resolve();
  return conn
    .run(async () => {
      const mids = items.map((i) => i.transceiver.mid).filter(Boolean);
      items.forEach((i) => i.transceiver.stop());
      await conn.pc.setLocalDescription(await conn.pc.createOffer());
      try {
        const res = await conn.call('close', { mids, sessionDescription: conn.pc.localDescription });
        if (res.sessionDescription) await conn.pc.setRemoteDescription(res.sessionDescription);
      } catch (e) {
        // 协商关闭失败:回滚本地 offer,改用强制关闭,保证 SFU 不再转发
        await conn.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        await conn.call('close', { mids }).catch(() => {});
        throw e;
      }
    })
    .catch((e) => console.warn('SFU 取消发布失败', e));
}

// 向房间公布我发布了哪些轨道(其他人据此订阅)
function sendPublish() {
  const tracks = {};
  for (const [kind, p] of Object.entries(sfu.published)) tracks[kind] = p.trackName;
  const pub = sfu.pub?.session ? { sessionId: sfu.pub.session.sessionId, tracks } : null;
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'publish', pub }));
}

// ---- 订阅 ----

// 我要看谁的屏幕:主窗口看原画(游客看半分辨率层),其余只要缩略图层
function wantRid(peerId) {
  return state.focusedId === peerId ? (state.isGuest ? 'h' : 'f') : 'q';
}
// 降层策略跟随我自己的「质量-速度」滑杆:
//   偏质量(0~2):priorityOrdering none — SFU 估计我下行不够时也坚持发首选层,宁可卡一下也不糊
//   偏速度(3~4):asciibetical — 带宽不够就按 f→h→q 自动降层,宁可糊也不卡
// 发布方暂停了首选层(其上行不够)时都按 f→h→q 找替代(ridNotAvailable),否则会直接黑屏
function simulcastFor(peerId) {
  return {
    preferredRid: wantRid(peerId),
    priorityOrdering: state.tradeoff <= 2 ? 'none' : 'asciibetical',
    ridNotAvailable: 'asciibetical',
  };
}
// 订阅当前生效的选层设置,变了就要 tracks/update
function simKey(peerId) {
  const c = simulcastFor(peerId);
  return `${c.preferredRid}/${c.priorityOrdering}`;
}

// 期望的订阅集合:房间里每个人公布的每条轨道
function desiredSubs() {
  const want = new Map();
  for (const [peerId, p] of state.peers) {
    if (!p.pub?.sessionId) continue;
    for (const [kind, trackName] of Object.entries(p.pub.tracks || {})) {
      const key = `${peerId}|${kind}|${p.pub.sessionId}|${trackName}`;
      want.set(key, { key, peerId, kind, sessionId: p.pub.sessionId, trackName });
    }
  }
  return want;
}

// 把实际订阅对齐到期望:关掉多余的、补上缺的、调整屏幕清晰度层。
// 进串行队列,且同时只排一个(执行时读最新状态,多次触发合并成一次)。
function syncSubscriptions() {
  if (!sfu.sub || sfu.syncQueued) return;
  sfu.syncQueued = true;
  const conn = sfu.sub;
  conn
    .run(async () => {
      sfu.syncQueued = false;
      if (sfu.sub !== conn) return;
      await reconcileSubs(conn);
    })
    .catch((e) => console.warn('SFU 订阅同步失败', e));
}

async function reconcileSubs(conn) {
  const want = desiredSubs();

  // 1. 关掉不再需要的(对方停止共享 / 离开 / 换了新轨道)
  const stale = [...sfu.subs.values()].filter((s) => !want.has(s.key));
  if (stale.length) {
    for (const s of stale) {
      sfu.subs.delete(s.key);
      sfu.byMid.delete(s.mid);
      detachSub(s);
    }
    await conn.call('close', { mids: stale.map((s) => s.mid) }).catch(() => {});
  }

  // 2. 订阅新的
  const add = [...want.values()].filter((w) => !sfu.subs.has(w.key));
  if (add.length) {
    await conn.ensureSession();
    const res = await conn.call('tracks', {
      tracks: add.map((w) => ({
        location: 'remote',
        sessionId: w.sessionId,
        trackName: w.trackName,
        ...(w.kind === 'screen' ? { simulcast: simulcastFor(w.peerId) } : {}),
      })),
    });
    // 先登记 mid → 订阅,再应用 offer(ontrack 在 setRemoteDescription 期间触发)
    for (const t of res.tracks || []) {
      if (t.errorCode || !t.mid) continue;
      const w = add.find((a) => a.trackName === t.trackName && a.sessionId === t.sessionId);
      if (!w) continue;
      const s = { ...w, mid: t.mid, rid: w.kind === 'screen' ? wantRid(w.peerId) : null, sim: w.kind === 'screen' ? simKey(w.peerId) : null };
      sfu.subs.set(s.key, s);
      sfu.byMid.set(s.mid, s);
    }
    if (res.requiresImmediateRenegotiation && res.sessionDescription) await answerSfuOffer(conn, res.sessionDescription);
  }

  // 3. 屏幕清晰度层随焦点切换
  const ups = [...sfu.subs.values()].filter((s) => s.kind === 'screen' && s.sim !== simKey(s.peerId));
  if (ups.length) {
    const res = await conn.call('update', {
      tracks: ups.map((s) => ({ location: 'remote', sessionId: s.sessionId, trackName: s.trackName, mid: s.mid, simulcast: simulcastFor(s.peerId) })),
    });
    ups.forEach((s) => {
      s.rid = wantRid(s.peerId);
      s.sim = simKey(s.peerId);
    });
    if (res.requiresImmediateRenegotiation && res.sessionDescription) await answerSfuOffer(conn, res.sessionDescription);
  }
}

// 下行连接收到轨道:按 mid 找到是谁的哪一路,挂到对应的播放元素
function onRemoteTrack(e) {
  const s = sfu.byMid.get(e.transceiver.mid);
  const p = s && state.peers.get(s.peerId);
  if (!p) return;
  const track = e.track;
  if (s.kind === 'mic') {
    p.audioEl = p.audioEl || new Audio();
    p.audioEl.autoplay = true;
    p.audioEl.srcObject = new MediaStream([track]);
    safePlay(p.audioEl);
    return;
  }
  // Safari:轨道挂载时还是 muted、之后才来数据,WebKit 不会自动开始渲染,unmute 时重挂一次
  track.onunmute = () => {
    const tile = s.kind === 'cam' ? p.camTile : p.tile;
    const v = tile?.querySelector('video');
    if (v) {
      v.srcObject = s.kind === 'cam' ? p.camStream : p.videoStream;
      safePlay(v);
    }
  };
  if (s.kind === 'screen') {
    // 屏幕画面 + 游戏声合成一条流保证音画同步;新共享换新流、重建瓦片
    p.videoStream = new MediaStream(p.screenAudioTrack ? [track, p.screenAudioTrack] : [track]);
    p.tile?.remove();
    p.tile = null;
  } else if (s.kind === 'screenAudio') {
    p.screenAudioTrack = track;
    if (p.videoStream) {
      p.videoStream.addTrack(track);
      const v = p.tile?.querySelector('video');
      if (v) {
        v.srcObject = p.videoStream;
        safePlay(v);
      }
    }
  } else if (s.kind === 'cam') {
    p.camStream = new MediaStream([track]);
    p.camTile?.remove();
    p.camTile = null;
  }
  refreshTiles();
}

function detachSub(s) {
  const p = state.peers.get(s.peerId);
  if (!p) return;
  if (s.kind === 'mic' && p.audioEl) p.audioEl.srcObject = null;
  if (s.kind === 'screen') p.videoStream = null;
  if (s.kind === 'screenAudio') p.screenAudioTrack = null;
  if (s.kind === 'cam') p.camStream = null;
  refreshTiles();
}

function detachAll(p) {
  if (p.audioEl) p.audioEl.srcObject = null;
  p.videoStream = p.camStream = p.screenAudioTrack = null;
  p.tile?.remove();
  p.camTile?.remove();
  p.tile = p.camTile = null;
}

// 按服务器的中继模式生成 PeerConnection 配置(连 Cloudflare SFU 用):
//   force → 只用 relay 候选(确实拿到 TURN 凭证时;没有 TURN 退回 all,否则连不上)
//   off   → 去掉 TURN 服务器,只直连 SFU
//   auto  → STUN + TURN,直连 SFU 失败时经 TURN 中继
function iceConfig() {
  const isTurn = (s) => [].concat(s.urls).some((u) => /^turns?:/.test(u));
  const g = state.guild?.guild || {};
  const mode = g.relayMode || (g.forceRelay ? 'force' : 'auto');
  if (mode === 'off') return { iceServers: state.iceServers.filter((s) => !isTurn(s)) };
  const relay = mode === 'force' && state.iceServers.some(isTurn);
  return { iceServers: state.iceServers, iceTransportPolicy: relay ? 'relay' : 'all' };
}

// ---------- 屏幕共享 ----------

$('shareBtn').addEventListener('click', () =>
  state.screenStream ? stopShare() : startShare(),
);

async function startShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: true, // 同时捕获系统/标签页声音(游戏声)
    });
  } catch {
    return; // 用户取消了选择
  }

  state.screenStream = stream;
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = 'motion'; // 游戏画面:告知编码器按运动内容优化,保帧率
  vt.onended = stopShare; // 用户从浏览器悬浮条点了"停止共享"

  $('shareBtn').setAttribute('aria-pressed', 'true');
  $('shareBtn').querySelector('span').textContent = '停止共享';
  refreshTiles();

  if (!sfu.pub) return; // 还没连上 SFU:连上后 publishCurrent 会带上
  try {
    await publishTracks(screenEntries());
    applyScreenParams();
  } catch (e) {
    alert('共享失败:' + e.message);
    return stopShare();
  }
  sendPublish();
}

// 共享者的码率上限(kbps):主窗口观看者收到的 f 层
function myShareKbps() {
  if (state.isGuest) return state.quality.guest;   // 游客共享:锁在游客档
  if (state.shareTier === 'hd') return SCREEN_MAX_BITRATE / 1000; // 高清 3.5M
  if (state.shareTier === 'clear') return state.quality.clear;    // 清晰(管理员可配)
  return state.quality.smooth;                                    // 流畅(默认,管理员可配)
}

// 缩略图层 / 游客观看层的目标高度
const THUMB_HEIGHT = 360;
const GUEST_VIEW_HEIGHT = 720;

// 设置屏幕三层编码参数(共享开始、切清晰度档、拖滑杆时调用):
//   f 主窗口:档位码率,分辨率按滑杆(极致流畅压到 720p),帧率/退让策略按滑杆
//   h 游客观看:f 的一半分辨率,码率不超过游客档
//   q 缩略图:约 360p、300kbps
// setParameters 必须串行:上一次还没完成时再调,浏览器会因参数过期拒绝后一次(切档后立刻拖滑杆就会丢设置)
let paramsChain = Promise.resolve();
function applyScreenParams() {
  paramsChain = paramsChain.then(setScreenParams).catch((e) => console.warn('设置编码参数失败', e));
}

async function setScreenParams() {
  const sender = sfu.published.screen?.transceiver.sender;
  if (!sender || !state.screenStream) return;
  const srcH = state.screenStream.getVideoTracks()[0]?.getSettings().height || 1080;
  const t = TRADEOFFS[state.tradeoff] || TRADEOFFS[1];
  const fKbps = myShareKbps();
  const fScale = Math.max(1, srcH / (state.isGuest ? GUEST_VIEW_HEIGHT : t.maxH || srcH));
  const layer = {
    f: { scaleResolutionDownBy: fScale, maxBitrate: fKbps * 1000, maxFramerate: state.isGuest ? 30 : t.fps },
    h: { scaleResolutionDownBy: fScale * 2, maxBitrate: Math.min(state.quality.guest, fKbps) * 1000, maxFramerate: 30 },
    q: { scaleResolutionDownBy: Math.max(fScale * 2, srcH / THUMB_HEIGHT), maxBitrate: THUMB_MAX_BITRATE, maxFramerate: 30 },
  };
  const p = sender.getParameters();
  if (!p.encodings?.length) return;
  for (const enc of p.encodings) Object.assign(enc, layer[enc.rid] || layer.f);
  p.degradationPreference = state.isGuest ? 'maintain-framerate' : t.pref;
  await sender.setParameters(p);
}

// 拖动质量-速度滑杆(共享中立即生效)
function setTradeoff(v) {
  state.tradeoff = v;
  try { localStorage.setItem('sp-tradeoff', String(v)); } catch {}
  $('tradeoffBox').title = `带宽/性能不够时的取舍:${TRADEOFFS[v].label}`;
  applyScreenParams(); // 我作为共享者的编码取舍
  updateViewQuality(); // 我作为观看者的降层策略
}

// 切换共享清晰度档(共享中立即生效)
function setShareTier(tier) {
  state.shareTier = tier;
  try { localStorage.setItem('sp-tier', tier); } catch {}
  applyScreenParams();
}

function stopShare() {
  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  unpublish(['screen', 'screenAudio']).then(sendPublish);
  $('shareBtn').setAttribute('aria-pressed', 'false');
  $('shareBtn').querySelector('span').textContent = '共享屏幕';
  refreshTiles();
}

// ---------- 摄像头 ----------

$('camBtn').addEventListener('click', () =>
  state.camStream ? stopCamera() : startCamera(),
);

async function startCamera() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: prefDevice('sp_camId'), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch {
    return; // 拒绝授权 / 无摄像头
  }
  state.camStream = stream;
  stream.getVideoTracks()[0].onended = stopCamera;
  camUi(true);
  refreshTiles();
  if (!sfu.pub) return;
  try {
    await publishTracks(camEntries());
  } catch (e) {
    alert('开启摄像头失败:' + e.message);
    return stopCamera();
  }
  sendPublish();
}

function stopCamera() {
  state.camStream?.getTracks().forEach((t) => t.stop());
  state.camStream = null;
  unpublish(['cam']).then(sendPublish);
  camUi(false);
  refreshTiles();
}

function camUi(on) {
  const b = $('camBtn');
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('is-on', on);
  applyShareUi();
}

// ---------- 麦克风 / 离开 ----------

$('leaveBtn').addEventListener('click', () => leaveChannel());

// 复制当前频道邀请链接:朋友打开后登录/注册即自动进本频道
$('inviteBtn').addEventListener('click', async () => {
  if (!state.channelId) return;
  const url = `${location.origin}/?c=${encodeURIComponent(state.channelId)}`;
  const span = $('inviteBtn').querySelector('span');
  try {
    await navigator.clipboard.writeText(url);
    span.textContent = '已复制 ✓';
    setTimeout(() => (span.textContent = '邀请'), 1500);
  } catch {
    prompt('复制此频道链接发给朋友:', url);
  }
});

// ---------- 成员与画面渲染 ----------

function addPeer(p) {
  state.peers.set(p.id, { name: p.name, sharing: !!p.sharing, camera: !!p.camera, pub: p.pub || null, videoStream: null, camStream: null });
  renderMembers();
  refreshTiles();
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  detachAll(peer);
  state.peers.delete(id); // 其订阅在下次 syncSubscriptions 时关闭
  renderMembers();
  refreshTiles();
}

function renderMembers() {
  const box = document.getElementById('channelMembers');
  if (!box) return;
  box.innerHTML = '';
  const add = (name, sharing, isMe, camera) => {
    const el = document.createElement('div');
    el.className = 'cm-row';
    el.classList.toggle('is-sharing', !!sharing);
    const dot = document.createElement('span');
    dot.className = 'cm-dot';
    const nm = document.createElement('span');
    nm.className = 'cm-name';
    nm.textContent = isMe ? `${name}(我)` : name;
    el.append(dot, nm);
    if (camera) {
      const cam = document.createElement('span');
      cam.className = 'cm-cam';
      cam.textContent = '📷';
      el.appendChild(cam);
    }
    box.appendChild(el);
  };
  if (state.channelId) add(state.myName, !!state.screenStream, true, !!state.camStream);
  for (const p of state.peers.values()) add(p.name, p.sharing, false, p.camera);

  // 同步更新当前频道行的人数(成员进出时即时变化,不等轮询)
  const countEl = document.querySelector(`.channel-row[data-channel="${state.channelId}"] .ch-count`);
  if (countEl) countEl.textContent = ` (${state.peers.size + 1})`;
}

let localTile = null;
let localCamTile = null;

// 演讲者视图:焦点那块进主舞台(#stage),其余(含未共享成员的占位块)进右侧胶片栏(#rail)。
function refreshTiles() {
  const stage = $('stage');
  const rail = $('rail');

  // 本地共享的预览瓦片
  if (state.screenStream && !localTile) {
    localTile = makeTile(`${state.myName}(我)`, state.screenStream, true, 'local');
  } else if (!state.screenStream && localTile) {
    if (state.focusedId === 'local') state.focusedId = null;
    localTile.remove();
    localTile = null;
  }

  // 本地摄像头预览瓦片(镜像显示)
  if (state.camStream && !localCamTile) {
    localCamTile = makeCamTile(`${state.myName}(我)`, state.camStream, 'local:cam');
    localCamTile.classList.add('is-cam-local');
  } else if (!state.camStream && localCamTile) {
    if (state.focusedId === 'local:cam') state.focusedId = null;
    localCamTile.remove();
    localCamTile = null;
  }

  // 每个成员:屏幕瓦片(共享中)+ 摄像头瓦片(开镜头)各自独立;两者皆无才放占位瓦片
  for (const [id, p] of state.peers) {
    const hasVideo = p.sharing && p.videoStream?.getVideoTracks().length;
    const hasCam = p.camera && p.camStream?.getVideoTracks().length;

    if (hasCam && !p.camTile) {
      p.camTile = makeCamTile(p.name, p.camStream, id + ':cam');
    } else if (!hasCam && p.camTile) {
      if (state.focusedId === id + ':cam') state.focusedId = null;
      p.camTile.remove();
      p.camTile = null;
    }

    const kind = hasVideo ? 'video' : hasCam ? null : 'placeholder';
    if (p.tile && p.tileKind !== kind) {
      p.tile.remove();
      p.tile = null;
    }
    if (kind && !p.tile) {
      p.tile = kind === 'video'
        ? makeTile(p.name, p.videoStream, false, id)
        : makePlaceholder(p.name, id);
    }
    p.tileKind = kind;
  }

  // 焦点失效(那块没了)则自动挑一个:优先别人的共享,其次自己的共享,再没有就留空
  const tiles = collectTiles();
  if (!state.focusedId || !tiles.has(state.focusedId)) {
    state.focusedId = pickDefaultFocus();
  }

  // 放置:焦点进主舞台,其余进胶片栏(仅在父节点变化时移动,减少 video 重排)
  for (const [key, tile] of tiles) {
    const inStage = key === state.focusedId;
    tile.classList.toggle('is-main', inStage);
    const parent = inStage ? stage : rail;
    if (tile.parentElement !== parent) parent.appendChild(tile);
  }

  $('emptyState').hidden = !!state.focusedId;
  updateViewQuality();
  renderMembers();
}

function collectTiles() {
  const m = new Map();
  if (localTile) m.set('local', localTile);
  if (localCamTile) m.set('local:cam', localCamTile);
  for (const [id, p] of state.peers) {
    if (p.tile) m.set(id, p.tile);
    if (p.camTile) m.set(id + ':cam', p.camTile);
  }
  return m;
}

// 默认焦点优先级:别人的屏幕 > 自己的屏幕 > 别人的摄像头 > 自己的摄像头
function pickDefaultFocus() {
  for (const [id, p] of state.peers)
    if (p.sharing && p.videoStream?.getVideoTracks().length) return id;
  if (state.screenStream) return 'local';
  for (const [id, p] of state.peers)
    if (p.camera && p.camStream?.getVideoTracks().length) return id + ':cam';
  if (state.camStream) return 'local:cam';
  return null;
}

function setFocus(key) {
  state.focusedId = key;
  refreshTiles();
}

// 我在看谁 → 主窗口那路切到原画层,其余切到缩略图层(省下行带宽);实际切换在订阅同步里做
function updateViewQuality() {
  for (const s of sfu.subs.values()) {
    if (s.kind === 'screen' && s.sim !== simKey(s.peerId)) return syncSubscriptions();
  }
}

function makeTile(name, stream, muted, key) {
  const tile = $('tileTemplate').content.firstElementChild.cloneNode(true);
  const video = tile.querySelector('video');
  video.srcObject = stream;
  video.muted = muted; // 本地预览静音,防回声
  safePlay(video);
  tile.querySelector('.umd-name').textContent = name;
  tile.classList.add('on-air');
  tile.dataset.key = key;
  tile.addEventListener('click', () => setFocus(key));
  tile.addEventListener('dblclick', () => video.requestFullscreen?.());
  return tile;
}

// 摄像头瓦片:无音轨(声音走 mic 那路),静音以确保各浏览器自动播放
function makeCamTile(name, stream, key) {
  const tile = makeTile(name, stream, true, key);
  tile.querySelector('.umd-tally').textContent = 'CAM';
  return tile;
}

function makePlaceholder(name, key) {
  const tile = $('tileTemplate').content.firstElementChild.cloneNode(true);
  tile.classList.add('is-placeholder');
  tile.dataset.key = key;
  tile.querySelector('video').remove();
  tile.querySelector('.tile-route').remove(); // 无画面不显示线路角标
  const ph = document.createElement('div');
  ph.className = 'ph-body';
  ph.textContent = name.slice(0, 2);
  tile.insertBefore(ph, tile.firstChild);
  tile.querySelector('.umd-name').textContent = name;
  tile.querySelector('.umd-tally').textContent = '未共享';
  tile.addEventListener('click', () => setFocus(key));
  return tile;
}

// ---------- 实时统计(分辨率 / fps / 码率) ----------

// 调试信息:元素播放状态 / 尺寸 / 轨道状态 / 解码与丢帧,用于定位"有解码无画面"
function videoDebug(v, s) {
  const tracks = (v.srcObject?.getTracks() || []).map((t) => `${t.kind[0]}:${t.readyState}${t.muted ? '/muted' : ''}${t.enabled ? '' : '/off'}`);
  return [
    `paused=${v.paused} muted=${v.muted} rs=${v.readyState} t=${v.currentTime.toFixed(1)}`,
    `video=${v.videoWidth}×${v.videoHeight} box=${v.clientWidth}×${v.clientHeight}`,
    `tracks ${tracks.join(' ') || '无'}`,
    `dec=${s.framesDecoded ?? '?'} drop=${s.framesDropped ?? '?'} codec=${s.decoderImplementation || '?'}`,
    `ua=${/iPhone|iPad|Macintosh/.exec(navigator.userAgent)?.[0] || '?'} ${innerWidth}×${innerHeight}`,
  ].join('\n');
}

function startStatsLoop() {
  const last = new Map(); // mid / 'local:*' -> 上一轮的字节数 / 解码帧数
  const kbpsOf = (key, bytes) => {
    const kbps = Math.round(((bytes - (last.get(key) || 0)) * 8) / 2000);
    last.set(key, bytes);
    return Math.max(0, kbps);
  };
  setInterval(async () => {
    // ---- 下行:每路订阅的分辨率 / 帧率 / 码率 + 渲染自愈 ----
    if (sfu.sub && state.peers.size) {
      try {
        const stats = await sfu.sub.pc.getStats();
        stats.forEach((s) => {
          if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
          const sub = sfu.byMid.get(s.mid);
          const p = sub && state.peers.get(sub.peerId);
          if (!p) return;
          const isCam = sub.kind === 'cam';
          const tile = isCam ? p.camTile : p.tile;
          const kbps = kbpsOf(s.mid, s.bytesReceived);
          const decKey = s.mid + ':dec';
          const decoding = (s.framesDecoded || 0) > (last.get(decKey) || 0);
          last.set(decKey, s.framesDecoded || 0);
          const v = tile?.querySelector('video');
          // 画面状态诊断:在解码却没画面 = 渲染侧问题(iOS 常见:播放被暂停 / 流没刷新到 <video>)
          const paused = !!v && v.paused;
          const blank = !!v && !v.videoWidth;
          const layer = !isCam && sub.rid ? ` [${{ f: '原画', h: '中', q: '缩略' }[sub.rid]}]` : '';
          // 实际收到的分辨率明显低于这一路见过的最高值 = SFU 因下行带宽给我降了层(或发布方暂停了高层)
          if (s.frameHeight) sub.maxH = Math.max(sub.maxH || 0, s.frameHeight);
          const downgraded = !isCam && sub.rid === 'f' && s.frameHeight && s.frameHeight < sub.maxH * 0.8 ? ' ·SFU降档' : '';
          const statsEl = tile?.querySelector('.tile-stats');
          if (statsEl)
            statsEl.textContent =
              `${s.frameWidth || '?'}×${s.frameHeight || '?'} ` +
              `${s.framesPerSecond || 0}fps ${kbps}kbps${layer}${downgraded}` +
              (paused ? ' ⏸点画面播放' : blank ? ' ·未渲染' : '') +
              (DEBUG && v ? '\n' + videoDebug(v, s) : '');
          // 渲染自愈:连续 2 轮(~4s)在解码但 <video> 暂停或没画面 → 重挂流并重新播放
          if (v && decoding && (paused || blank || v.readyState < 2)) {
            const n = (p.renderTicks?.[decKey] || 0) + 1;
            p.renderTicks = { ...p.renderTicks, [decKey]: n };
            if (n >= 2) {
              p.renderTicks[decKey] = 0;
              v.srcObject = null;
              v.srcObject = isCam ? p.camStream : p.videoStream;
              safePlay(v);
            }
          } else if (p.renderTicks?.[decKey]) {
            p.renderTicks[decKey] = 0;
          }
        });

        // 线路指示:我到 Cloudflare SFU 这条连接走的是直连还是 TURN 中继、IPv4 还是 IPv6
        const route = routeLabel(stats);
        for (const p of state.peers.values()) {
          for (const t of [p.tile, p.camTile]) {
            const el = t?.querySelector('.tile-route');
            if (el) {
              el.textContent = route.text;
              el.classList.toggle('is-relay', route.relay);
            }
          }
        }
      } catch {}
    }

    // ---- 上行:屏幕三层合计码率;分辨率/帧率/受限原因看原画层 f ----
    const screenSender = sfu.published.screen?.transceiver.sender;
    if (localTile && screenSender) {
      try {
        const stats = await screenSender.getStats();
        let total = 0;
        let f = null;
        stats.forEach((s) => {
          if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
          total += kbpsOf('local:' + (s.rid || 'f'), s.bytesSent);
          if (!f || s.rid === 'f') f = s;
        });
        if (f) {
          // 编码受限原因 + 编码器实现:排查"为什么自动降分辨率/画面糊"
          const limit = { bandwidth: ' ·带宽受限', cpu: ' ·CPU受限', other: ' ·受限' }[f.qualityLimitationReason] || '';
          // 只取括号里的具体实现名(如 "SimulcastEncoderAdapter (libvpx, libvpx)" → libvpx, libvpx),避免挤爆角标
          const encName = (f.encoderImplementation || '').replace(/^[^(]*\(|\)[^)]*$/g, '').slice(0, 24);
          localTile.querySelector('.tile-stats').textContent =
            `↑ ${f.frameWidth || '?'}×${f.frameHeight || '?'} ` +
            `${f.framesPerSecond || 0}fps ${total}kbps →SFU${limit}${encName ? ' ' + encName : ''}`;
        }
      } catch {}
    }
  }, 2000);
}

// 选中候选对 → 线路标识。对端是 Cloudflare 边缘,不再是别的成员
function routeLabel(stats) {
  let pair = null;
  stats.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
  });
  if (!pair)
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
  if (!pair) return { text: '', relay: false };
  const lc = stats.get(pair.localCandidateId) || {};
  const rc = stats.get(pair.remoteCandidateId) || {};
  const relay = lc.candidateType === 'relay' || rc.candidateType === 'relay';
  // 标出 IPv4 / IPv6(按选中候选对的实际地址;mDNS 匿名名或拿不到地址时不标)
  const ipv = (c) => {
    const a = c.address || c.ip || '';
    return a.endsWith('.local') ? '' : a.includes(':') ? 'IPv6' : /^\d+\.\d+\.\d+\.\d+$/.test(a) ? 'IPv4' : '';
  };
  const ver = ipv(rc) || ipv(lc);
  return { text: relay ? 'SFU·TURN中继' : ver ? `SFU·${ver}` : 'SFU', relay };
}

// ---------- 管理:弹窗 / 菜单 / 增删改(阶段 3) ----------

function canManage() {
  return state.role === 'owner' || state.role === 'admin';
}

async function api(method, path, body) {
  try {
    const r = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, data, error: data.error };
  } catch {
    return { ok: false, error: '网络错误' };
  }
}

// ---- 通用弹窗 ----
let modalSubmit = null;
function openModal(title, bodyEl, onOk, okLabel = '确定') {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  body.innerHTML = '';
  body.appendChild(bodyEl);
  $('modalOk').textContent = okLabel;
  modalSubmit = onOk; // 为 null 时,点确定/完成即关闭
  $('modal').hidden = false;
  body.querySelector('input, select, textarea')?.focus();
}
function closeModal() {
  $('modal').hidden = true;
  modalSubmit = null;
}
$('modalClose').addEventListener('click', closeModal);
$('modalCancel').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});
$('modalOk').addEventListener('click', async () => {
  if (!modalSubmit) return closeModal();
  const keep = await modalSubmit();
  if (keep !== false) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal();
});

function field(labelText, input) {
  const w = document.createElement('label');
  w.className = 'field';
  const t = document.createElement('span');
  t.className = 'field-label';
  t.textContent = labelText;
  w.append(t, input);
  return w;
}
function textInput(value = '', ph = '', maxLen = 32) {
  const i = document.createElement('input');
  i.className = 'field-input';
  i.value = value;
  i.placeholder = ph;
  i.maxLength = maxLen;
  return i;
}
function categorySelect(selId) {
  const s = document.createElement('select');
  s.className = 'field-input';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(未分类)';
  s.appendChild(none);
  for (const c of state.guild.categories) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    if (c.id === selId) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

// ---- 操作菜单 ----
function openMenu(evt, items) {
  const m = $('ctxMenu');
  m.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => {
      m.hidden = true;
      it.fn();
    });
    m.appendChild(b);
  }
  m.hidden = false;
  const w = m.offsetWidth || 180;
  m.style.left = Math.min(evt.clientX, window.innerWidth - w - 8) + 'px';
  m.style.top = Math.min(evt.clientY, window.innerHeight - m.offsetHeight - 8) + 'px';
}
document.addEventListener('click', () => ($('ctxMenu').hidden = true));

// ---- 频道 / 分类的 hover 操作 ----
function actionBtn(onClick) {
  const b = document.createElement('button');
  b.className = 'row-act';
  b.textContent = '⋯';
  b.title = '管理';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}
function addChannelActions(row, ch) {
  row.classList.add('has-act');
  row.appendChild(
    actionBtn((e) =>
      openMenu(e, [
        { label: '编辑频道', fn: () => openEditChannel(ch) },
        { label: '删除频道', danger: true, fn: () => confirmDelete(`删除频道「${ch.name}」?`, () => deleteChannel(ch.id)) },
      ]),
    ),
  );
}
function addCategoryActions(head, cat) {
  head.classList.add('has-act');
  head.appendChild(
    actionBtn((e) =>
      openMenu(e, [
        { label: '在此分类新建频道', fn: () => openCreateChannel(cat.id) },
        { label: '重命名分类', fn: () => openEditCategory(cat) },
        { label: '删除分类', danger: true, fn: () => confirmDelete(`删除分类「${cat.name}」?其中的频道会移到未分类。`, () => deleteCategory(cat.id)) },
      ]),
    ),
  );
}

// ---- 服务器管理菜单 ----
$('guildMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const items = [
    { label: '服务器设置', fn: openServerSettings },
    { label: '新建频道', fn: () => openCreateChannel(null) },
    { label: '新建分类', fn: openCreateCategory },
  ];
  if (state.role === 'owner') items.push({ label: '成员与角色', fn: openMembers });
  openMenu(e, items);
});

// ---- 具体操作 ----
function numInput(value) {
  const i = document.createElement('input');
  i.className = 'field-input';
  i.type = 'number';
  i.min = '200';
  i.max = '6000';
  i.step = '100';
  i.value = value;
  return i;
}

function openServerSettings() {
  const g = state.guild.guild;
  const q = g.quality || { clear: 2500, smooth: 1500, guest: 800 };
  const name = textInput(g.name, '服务器名', 32);
  const icon = textInput(g.icon, '一个 emoji', 4);
  const desc = textInput(g.description, '描述(可选)', 200);
  const clear = numInput(q.clear);
  const smooth = numInput(q.smooth);
  const guest = numInput(q.guest);
  // TURN 中继模式:自动 / 强制 / 关闭。没配置 TURN 时「强制」不可选
  const relay = document.createElement('select');
  relay.className = 'field-input';
  // 音视频都经 Cloudflare SFU 转发;这里只决定「连到 SFU」这一段要不要经 TURN
  const RELAY_NOTES = {
    auto: '直连 Cloudflare SFU;所在网络屏蔽 UDP 等直连不上时,自动经 TURN 中继转一道。',
    force: '所有人都先经 TURN 服务器再到 SFU:多一跳、占 TURN 流量,只在直连 SFU 线路差时使用。',
    off: '不用 TURN,只直连 SFU;网络严格(屏蔽 UDP)的成员可能连不上。',
  };
  for (const [val, label] of [['auto', '自动(推荐)'], ['force', '强制经 TURN 中继'], ['off', '不用 TURN']]) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    if (val === 'force' && !state.guild.relayAvailable) o.disabled = true;
    relay.append(o);
  }
  relay.value = g.relayMode || (g.forceRelay ? 'force' : 'auto');
  const relayNote = document.createElement('p');
  relayNote.className = 'field-note';
  const showRelayNote = () => {
    relayNote.textContent =
      RELAY_NOTES[relay.value] +
      (state.guild.relayAvailable ? '' : '(未配置 TURN 服务器 COTURN_* / TURN_KEY_*,无法强制中继。)') +
      ' 保存后,每个人下次进入频道时生效。';
  };
  relay.addEventListener('change', showRelayNote);
  showRelayNote();
  const relayLabel = field('TURN 中继', relay);
  const note = document.createElement('p');
  note.className = 'field-note';
  note.textContent = '各档「码率上限(kbps)」,分辨率由编码器按码率自动决定。高清档固定 3.5Mbps;以下三档可调:';
  const body = document.createElement('div');
  body.append(
    field('服务器名', name),
    field('图标(emoji)', icon),
    field('描述', desc),
    note,
    field('清晰档', clear),
    field('流畅档(默认)', smooth),
    field('游客档(游客共享/观看)', guest),
    relayLabel,
    relayNote,
  );
  openModal('服务器设置', body, async () => {
    if (!name.value.trim()) return false;
    const r = await api('PATCH', '/api/guild', {
      name: name.value.trim(),
      icon: icon.value.trim(),
      description: desc.value.trim(),
      clearKbps: +clear.value,
      smoothKbps: +smooth.value,
      guestKbps: +guest.value,
      relayMode: relay.value,
    });
    if (!r.ok) return (alert(r.error || '保存失败'), false);
    await loadGuild();
    applyScreenParams(); // 新码率立即生效
  }, '保存');
}

function openCreateChannel(categoryId) {
  const name = textInput('', '频道名', 24);
  const cat = categorySelect(categoryId || '');
  const pw = textInput('', '留空则无密码', 64);
  const body = document.createElement('div');
  body.append(field('频道名', name), field('所属分类', cat), field('频道密码(可选)', pw));
  openModal('新建语音频道', body, async () => {
    if (!name.value.trim()) return false;
    const r = await api('POST', '/api/channels', {
      name: name.value.trim(), type: 'voice', categoryId: cat.value || null, password: pw.value.trim(),
    });
    if (!r.ok) return (alert(r.error || '创建失败'), false);
    await loadGuild();
  }, '创建');
}

function openEditChannel(ch) {
  const name = textInput(ch.name, '频道名', 24);
  const topic = textInput(ch.topic || '', '频道简介(可选)', 120);
  const cat = categorySelect(ch.categoryId || '');
  const pw = textInput('', ch.hasPassword ? '已设置,留空不修改' : '留空则无密码', 64);
  const body = document.createElement('div');
  body.append(field('频道名', name), field('简介', topic), field('所属分类', cat), field('频道密码', pw));
  let clearPw = null;
  if (ch.hasPassword) {
    const wrap = document.createElement('label');
    wrap.className = 'field field-check';
    clearPw = document.createElement('input');
    clearPw.type = 'checkbox';
    const txt = document.createElement('span');
    txt.textContent = ' 清除密码(改回公开频道)';
    wrap.append(clearPw, txt);
    body.appendChild(wrap);
  }
  openModal('编辑频道', body, async () => {
    if (!name.value.trim()) return false;
    const patch = { name: name.value.trim(), topic: topic.value.trim(), categoryId: cat.value || null };
    if (clearPw?.checked) patch.password = '';
    else if (pw.value.trim()) patch.password = pw.value.trim();
    const r = await api('PATCH', '/api/channels/' + ch.id, patch);
    if (!r.ok) return (alert(r.error || '保存失败'), false);
    if (state.channelId === ch.id) $('curChannel').textContent = name.value.trim();
    await loadGuild();
  }, '保存');
}

async function deleteChannel(id) {
  const r = await api('DELETE', '/api/channels/' + id);
  if (!r.ok) return alert(r.error || '删除失败');
  if (state.channelId === id) leaveChannel(false);
  await loadGuild();
}

function openCreateCategory() {
  const name = textInput('', '分类名', 24);
  const body = document.createElement('div');
  body.append(field('分类名', name));
  openModal('新建分类', body, async () => {
    if (!name.value.trim()) return false;
    const r = await api('POST', '/api/categories', { name: name.value.trim() });
    if (!r.ok) return (alert(r.error || '创建失败'), false);
    await loadGuild();
  }, '创建');
}

function openEditCategory(cat) {
  const name = textInput(cat.name, '分类名', 24);
  const body = document.createElement('div');
  body.append(field('分类名', name));
  openModal('重命名分类', body, async () => {
    if (!name.value.trim()) return false;
    const r = await api('PATCH', '/api/categories/' + cat.id, { name: name.value.trim() });
    if (!r.ok) return (alert(r.error || '保存失败'), false);
    await loadGuild();
  }, '保存');
}

async function deleteCategory(id) {
  const r = await api('DELETE', '/api/categories/' + id);
  if (!r.ok) return alert(r.error || '删除失败');
  await loadGuild();
}

function confirmDelete(msg, fn) {
  const body = document.createElement('div');
  body.className = 'confirm-msg';
  body.textContent = msg;
  openModal('确认删除', body, async () => {
    await fn();
  }, '删除');
}

async function openMembers() {
  const r = await api('GET', '/api/members');
  const body = document.createElement('div');
  body.className = 'member-list';
  for (const m of r.data.members || []) {
    const row = document.createElement('div');
    row.className = 'member-row';
    const nm = document.createElement('span');
    nm.className = 'member-name';
    nm.textContent = `${m.nickname} (${m.username})`;
    row.appendChild(nm);
    if (m.role === 'owner' || state.role !== 'owner') {
      const tag = document.createElement('span');
      tag.className = 'role-tag' + (m.role === 'owner' ? ' role-owner' : '');
      tag.textContent = ROLE_LABEL[m.role] || '成员';
      row.appendChild(tag);
    } else {
      const sel = document.createElement('select');
      sel.className = 'field-input role-sel';
      for (const [val, label] of [['admin', '管理员'], ['member', '成员']]) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = label;
        if (m.role === val) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', async () => {
        const rr = await api('PATCH', '/api/members/' + encodeURIComponent(m.username), { role: sel.value });
        if (!rr.ok) alert(rr.error || '修改失败');
      });
      row.appendChild(sel);
    }
    body.appendChild(row);
  }
  if (!(r.data.members || []).length) body.textContent = '暂无成员';
  openModal('成员与角色', body, null, '完成');
}

// ---------- 设备选择(麦克风 / 摄像头) ----------

$('deviceBtn').addEventListener('click', () => {
  $('userMenu').hidden = true;
  openDeviceSettings();
});

async function openDeviceSettings() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {}

  const mkSel = (kind, savedKey, fallbackLabel) => {
    const s = document.createElement('select');
    s.className = 'field-input';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = '系统默认';
    s.appendChild(def);
    const saved = localStorage.getItem(savedKey) || '';
    let i = 0;
    for (const d of devices.filter((d) => d.kind === kind && d.deviceId)) {
      i++;
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${fallbackLabel} ${i}`;
      if (d.deviceId === saved) o.selected = true;
      s.appendChild(o);
    }
    return s;
  };

  const micSel = mkSel('audioinput', 'sp_micId', '麦克风');
  const camSel = mkSel('videoinput', 'sp_camId', '摄像头');
  const body = document.createElement('div');
  body.append(field('麦克风', micSel), field('摄像头', camSel));
  if (devices.length && devices.every((d) => !d.label)) {
    const tip = document.createElement('p');
    tip.className = 'confirm-msg';
    tip.textContent = '提示:进过一次频道(授权麦克风/摄像头)后,这里才能显示设备名称。';
    body.appendChild(tip);
  }

  openModal('音频视频设备', body, async () => {
    const micChanged = micSel.value !== (localStorage.getItem('sp_micId') || '');
    const camChanged = camSel.value !== (localStorage.getItem('sp_camId') || '');
    micSel.value ? localStorage.setItem('sp_micId', micSel.value) : localStorage.removeItem('sp_micId');
    camSel.value ? localStorage.setItem('sp_camId', camSel.value) : localStorage.removeItem('sp_camId');
    // 正在用的设备热切换:重新采集 + replaceTrack,不断连不重协商
    if (micChanged && state.micTrack) await switchMic();
    if (camChanged && state.camStream) await switchCamera();
  }, '保存');
}

async function switchMic() {
  const wasMuted = !state.micTrack.enabled;
  const old = state.micTrack;
  state.micTrack = null; // 先置空,acquireMic 失败时保持"无麦"状态
  const fresh = await acquireMic();
  if (!fresh) {
    state.micTrack = old; // 新设备拿不到,退回旧轨道
    applyMicUi();
    return;
  }
  fresh.enabled = !wasMuted;
  state.micTrack = fresh;
  old?.stop();
  sfu.published.mic?.transceiver.sender.replaceTrack(fresh); // 同一条已发布轨道换源,不用重新发布
  applyMicUi();
  if (state.channelId) startMeter();
}

async function switchCamera() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: prefDevice('sp_camId'), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch {
    return; // 新摄像头拿不到,保持原样
  }
  const old = state.camStream;
  state.camStream = stream;
  stream.getVideoTracks()[0].onended = stopCamera;
  await sfu.published.cam?.transceiver.sender.replaceTrack(stream.getVideoTracks()[0]);
  old?.getTracks().forEach((t) => t.stop());
  if (localCamTile) {
    const v = localCamTile.querySelector('video');
    v.srcObject = stream;
    safePlay(v);
  }
}

// ---------- 加入/离开提示音(阶段 4) ----------
function blip(up) {
  if (!state.channelId) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = (blip.ac ||= new AC());
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.value = up ? 660 : 400;
    o.connect(g);
    g.connect(ac.destination);
    const t = ac.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start(t);
    o.stop(t + 0.26);
  } catch {}
}
