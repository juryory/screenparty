// ScreenParty 前端 — WebRTC full mesh
//
// 连接模型:每对成员一条 RTCPeerConnection,固定 4 个 transceiver:
//   [0] mic 音频  [1] 屏幕视频  [2] 屏幕音频(游戏声)  [3] 摄像头视频
// 建连时一次性协商好全部 m-line,之后开/关共享只 replaceTrack,不重协商。
// 新加入者作为发起方,向房间内每个已有成员发 offer,天然无 glare。

'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  myId: null,
  myName: '',
  myUser: '',
  role: 'member',
  canShare: false, // 共享屏幕/摄像头权限(管理员后台开启)
  channelId: null,
  channelName: '',
  guild: null, // { guild:{name,icon,description}, categories:[], channels:[], me:{role} }
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  micTrack: null,
  screenStream: null,
  camStream: null,
  presence: {}, // channelId -> 当前人数(轮询 /api/presence)
  channelPw: {}, // channelId -> 本次会话里验证过的频道密码(内存缓存,重进免输)
  peers: new Map(), // id -> { name, sharing, camera, pc, senders, tile, camTile, videoStream, camStream, audioEl, sendQuality, viewReq }
  focusedId: null,  // 当前主舞台显示谁:peer id / id+':cam' / 'local' / 'local:cam' / null
};

const ROLE_LABEL = { owner: '所有者', admin: '管理员', member: '成员' };

const SCREEN_MAX_BITRATE = 3_500_000; // ~3.5 Mbps,主窗口(被人放大观看)的全码率
const THUMB_MAX_BITRATE = 300_000;    // 缩略图(没在主窗口看的共享)只发 ~300kbps
const THUMB_SCALE = 3;                // 且分辨率降到 1/3,低码率下更耐看
const CAM_MAX_BITRATE = 1_000_000;    // 摄像头固定 ~1 Mbps(人脸画面不需要屏幕那么高)

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
  if (!me) return location.replace('/login.html');
  state.myName = me.nickname;
  state.myUser = me.username;
  state.canShare = !!me.canShare;
  $('app').hidden = false;
  $('uNick').textContent = me.nickname;
  $('uAvatar').textContent = me.nickname.slice(0, 2);
  $('adminLink').hidden = !me.isAdmin;
  applyShareUi();
  setDrawer(true); // 手机端初始展开频道抽屉
  await loadGuild();
  loadPresence();
  setInterval(loadPresence, 10_000); // 频道人数轮询
  startStatsLoop();
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
  const noPerm = '共享权限未开启,请联系管理员在用户管理中开启';
  $('shareBtn').disabled = !state.canShare;
  $('shareBtn').title = state.canShare ? '' : noPerm;
  const cam = $('camBtn');
  cam.disabled = !state.canShare || !state.channelId;
  cam.title = !state.canShare ? noPerm : !state.channelId ? '进入频道后可开启摄像头' : state.camStream ? '关闭摄像头' : '摄像头';
}

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
  $('guildName').textContent = state.guild.guild.name;
  $('serverBadge').textContent = state.guild.guild.icon || '🎮';
  $('serverBadge').title = state.guild.guild.name;
  $('uRole').textContent = ROLE_LABEL[state.role] || '成员';
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
  if (!ch.hasPassword || canManage() || state.channelPw[ch.id]) {
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
    state.channelPw[ch.id] = pw;
    joinChannel(ch.id, ch.name, ch.topic);
  }, '进入');
}

async function joinChannel(id, name, topic) {
  if (state.channelId === id) return;
  if (state.channelId) leaveChannel(false);

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
  for (const [, p] of state.peers) {
    clearTimeout(p.recoverTimer);
    p.pc?.close();
    p.audioEl && (p.audioEl.srcObject = null);
    p.tile?.remove();
    p.camTile?.remove();
  }
  state.peers.clear();
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
  const pw = state.channelPw[state.channelId];
  const ws = new WebSocket(
    `${proto}://${location.host}/ws/${encodeURIComponent(state.channelId)}${pw ? `?pw=${encodeURIComponent(pw)}` : ''}`,
  );
  state.ws = ws;

  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: state.myName }));

  ws.onmessage = async (e) => {
    if (state.ws !== ws) return; // 快速切频道时旧连接的迟到消息,直接丢弃
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'welcome':
        state.myId = msg.id;
        renderMembers();
        // 新人主动向每个已有成员发起连接
        for (const p of msg.peers) {
          addPeer(p);
          await makeOffer(p.id);
        }
        break;
      case 'peer-joined':
        addPeer(msg.peer); // 被动等待对方的 offer
        blip(true);
        break;
      case 'peer-left':
        removePeer(msg.id);
        blip(false);
        break;
      case 'peer-state': {
        const p = state.peers.get(msg.id);
        if (p) {
          p.sharing = msg.sharing;
          p.camera = !!msg.camera;
          refreshTiles();
        }
        break;
      }
      case 'signal':
        await handleSignal(msg.from, msg.data);
        break;
    }
  };

  ws.onclose = (e) => {
    if (state.ws !== ws) return;
    // 同账号在别处进了频道,本连接被服务器顶掉:退出本地频道状态
    // (其他断线不动:媒体是 P2P 的,信令断开不影响通话,由自愈逻辑处理)
    if (e.reason === 'replaced') return leaveChannel();
    // 从未收到 welcome 就被关 = 连接被拒(如密码已被管理员改掉):清缓存退出
    if (!state.myId && state.channelId) {
      delete state.channelPw[state.channelId];
      leaveChannel();
      alert('进入频道失败,密码可能已更改,请重试');
    }
  };
}

function sendSignal(to, data) {
  state.ws?.send(JSON.stringify({ type: 'signal', to, data }));
}

// ---------- WebRTC mesh ----------

function createPeerConnection(peerId) {
  const peer = state.peers.get(peerId);
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  peer.pc = pc;
  peer.videoStream = new MediaStream();
  peer.camStream = new MediaStream();

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { ice: e.candidate });
  };

  pc.ontrack = (e) => {
    const idx = pc.getTransceivers().indexOf(e.transceiver);

    // Safari 黑屏修复:对方停止共享→重新共享走的是 replaceTrack,接收端不会再有
    // ontrack,只是同一条 track 先 muted 再 unmuted。WebKit 对「挂载时还是 muted、
    // 之后才恢复」的轨道不会自动开始渲染,必须在 unmute(数据恢复)时重挂流强制刷新。
    if (idx === 1 || idx === 3) {
      e.track.onunmute = () => {
        refreshTiles(); // 信令若晚到,先按当前状态补瓦片
        const tile = idx === 3 ? peer.camTile : peer.tile;
        const v = tile?.querySelector('video');
        if (v) {
          v.srcObject = idx === 3 ? peer.camStream : peer.videoStream;
          safePlay(v);
        }
      };
    }

    if (idx === 0) {
      // 对方麦克风
      peer.audioEl = peer.audioEl || new Audio();
      peer.audioEl.autoplay = true;
      peer.audioEl.srcObject = new MediaStream([e.track]);
      safePlay(peer.audioEl);
    } else if (idx === 3) {
      // 对方摄像头
      peer.camStream.addTrack(e.track);
      const oldTile = peer.camTile;
      refreshTiles();
      if (peer.camTile && peer.camTile === oldTile) {
        const v = peer.camTile.querySelector('video');
        if (v) {
          v.srcObject = peer.camStream;
          safePlay(v);
        }
      }
    } else {
      // 对方屏幕(视频 + 游戏声),合入同一条流保证音画同步
      peer.videoStream.addTrack(e.track);
      const oldTile = peer.tile;
      refreshTiles();
      // WebKit:流挂上 <video> 后再 addTrack 可能不刷新画面;复用旧瓦片时重设 srcObject 兜底
      // (新建的瓦片 makeTile 里已挂流并 safePlay,无需重复)
      if (peer.tile && peer.tile === oldTile) {
        const v = peer.tile.querySelector('video');
        if (v) {
          v.srcObject = peer.videoStream;
          safePlay(v);
        }
      }
    }
  };

  // 断连自愈:disconnected/failed 时重新协商、重新收集候选(可切到 TURN 中继)。
  // 关键——单纯 restartIce() 不会自动重发 offer,必须由发起方主动重连。
  const onStateChange = () => {
    const st = pc.connectionState;
    const ist = pc.iceConnectionState;
    if (st === 'failed' || ist === 'failed') recoverPeer(peerId, 0);
    else if (st === 'disconnected' || ist === 'disconnected') recoverPeer(peerId, 4000);
  };
  pc.onconnectionstatechange = onStateChange;
  pc.oniceconnectionstatechange = onStateChange;

  return pc;
}

// 触发重连:发起方直接重启 ICE;应答方发信令请发起方重启(避免双方同时发 offer 撞车)
function triggerRestart(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer?.pc) return;
  const now = Date.now();
  if (peer.restartCooldownUntil && now < peer.restartCooldownUntil) return; // 防重连风暴
  peer.restartCooldownUntil = now + 6000;
  if (peer.isOfferer) doIceRestart(peerId);
  else sendSignal(peerId, { restart: true });
}

// 等 delay 毫秒后若仍未恢复,才真正重连(disconnected 常能自愈,先给它机会)
function recoverPeer(peerId, delay) {
  const peer = state.peers.get(peerId);
  if (!peer?.pc) return;
  clearTimeout(peer.recoverTimer);
  peer.recoverTimer = setTimeout(() => {
    const pc = peer.pc;
    if (!pc) return;
    const good = pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
    if (!good) triggerRestart(peerId);
  }, delay);
}

// 发起方重新协商 + 重新收集候选(iceRestart:true 会生成新 ICE 凭证,重跑连通性检查)
async function doIceRestart(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer?.pc) return;
  try {
    const offer = await peer.pc.createOffer({ iceRestart: true });
    await peer.pc.setLocalDescription(offer);
    sendSignal(peerId, { sdp: peer.pc.localDescription });
  } catch {}
}

function setupTransceivers(pc, asOfferer) {
  if (asOfferer) {
    // 无麦克风时用 'audio' 占位,方向仍 sendrecv:自己不发声,但能接收对方语音
    const mic = pc.addTransceiver(state.micTrack || 'audio', { direction: 'sendrecv' });
    const video = pc.addTransceiver('video', { direction: 'sendrecv' });
    const audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const cam = pc.addTransceiver('video', { direction: 'sendrecv' });
    preferH264(video);
    preferH264(cam);
    return { mic: mic.sender, video: video.sender, screenAudio: audio.sender, camera: cam.sender };
  }
  // answer 端:transceiver 由远端 offer 创建,按相同顺序取用(cam 兜底:对面是旧版页面时只有 3 条)
  const [mic, video, audio, cam] = pc.getTransceivers();
  [mic, video, audio, cam].filter(Boolean).forEach((t) => (t.direction = 'sendrecv'));
  mic.sender.replaceTrack(state.micTrack);
  preferH264(video);
  if (cam) preferH264(cam);
  return { mic: mic.sender, video: video.sender, screenAudio: audio.sender, camera: cam?.sender };
}

function preferH264(transceiver) {
  try {
    const codecs = RTCRtpReceiver.getCapabilities('video').codecs;
    const h264 = codecs.filter((c) => /h264/i.test(c.mimeType));
    if (h264.length) {
      transceiver.setCodecPreferences([
        ...h264,
        ...codecs.filter((c) => !/h264/i.test(c.mimeType)),
      ]);
    }
  } catch {}
}

async function makeOffer(peerId) {
  const peer = state.peers.get(peerId);
  peer.isOfferer = true; // 我发起,断连时由我负责重启 ICE
  const pc = createPeerConnection(peerId);
  peer.senders = setupTransceivers(pc, true);
  await attachScreenTo(peer); // 若自己已在共享,直接带上
  await attachCameraTo(peer);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal(peerId, { sdp: pc.localDescription });
}

async function handleSignal(from, data) {
  let peer = state.peers.get(from);
  if (!peer) return;

  // 对方告诉我:把发给他的这一路调成高清(他放主窗口)还是缩略图
  if (data.want) {
    peer.sendQuality = data.want === 'high' ? 'high' : 'low';
    applySendQuality(peer);
    return;
  }

  // 应答方检测到断连,请我(发起方)重启 ICE
  if (data.restart) {
    if (peer.isOfferer) triggerRestart(from);
    return;
  }

  if (data.sdp) {
    if (data.sdp.type === 'offer') {
      const isNew = !peer.pc;
      const pc = peer.pc || createPeerConnection(from);
      if (isNew) peer.isOfferer = false; // 我应答,断连时请对方重启
      await pc.setRemoteDescription(data.sdp);
      if (isNew) {
        // 仅首次建连时建立 transceiver / 附加屏幕;ICE 重启的 offer 只需重新应答
        peer.senders = setupTransceivers(pc, false);
        await attachScreenTo(peer);
        await attachCameraTo(peer);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { sdp: pc.localDescription });
    } else {
      await peer.pc.setRemoteDescription(data.sdp);
    }
  } else if (data.ice) {
    try {
      await peer.pc.addIceCandidate(data.ice);
    } catch {}
  }
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

  for (const peer of state.peers.values()) await attachScreenTo(peer);

  sendState();
  $('shareBtn').setAttribute('aria-pressed', 'true');
  $('shareBtn').querySelector('span').textContent = '停止共享';
  refreshTiles();
}

// 共享屏幕/摄像头状态上报(服务端会对无权限账号强制压成 false)
function sendState() {
  state.ws?.send(JSON.stringify({ type: 'state', sharing: !!state.screenStream, camera: !!state.camStream }));
}

async function attachScreenTo(peer) {
  if (!peer.senders || !state.screenStream) return;
  const vt = state.screenStream.getVideoTracks()[0];
  const at = state.screenStream.getAudioTracks()[0];
  if (vt) {
    await peer.senders.video.replaceTrack(vt);
    applySendQuality(peer);
  }
  if (at) await peer.senders.screenAudio.replaceTrack(at);
}

// 按对方请求的清晰度设置发给他的这一路:主窗口=全码率全分辨率,缩略图=低码率+降分辨率。
// mesh 里每对成员是独立 PeerConnection、独立编码器,所以能对不同人发不同码率。
function applySendQuality(peer) {
  if (!peer.senders?.video || !state.screenStream) return;
  const high = peer.sendQuality === 'high';
  const p = peer.senders.video.getParameters();
  if (!p.encodings?.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = high ? SCREEN_MAX_BITRATE : THUMB_MAX_BITRATE;
  p.encodings[0].scaleResolutionDownBy = high ? 1 : THUMB_SCALE;
  p.degradationPreference = 'maintain-framerate'; // 带宽不足时降分辨率保帧率
  peer.senders.video.setParameters(p).catch(() => {});
}

function stopShare() {
  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  for (const peer of state.peers.values()) {
    peer.senders?.video.replaceTrack(null);
    peer.senders?.screenAudio.replaceTrack(null);
  }
  sendState();
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
  for (const peer of state.peers.values()) await attachCameraTo(peer);
  sendState();
  camUi(true);
  refreshTiles();
}

function stopCamera() {
  state.camStream?.getTracks().forEach((t) => t.stop());
  state.camStream = null;
  for (const peer of state.peers.values()) peer.senders?.camera?.replaceTrack(null);
  sendState();
  camUi(false);
  refreshTiles();
}

function camUi(on) {
  const b = $('camBtn');
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('is-on', on);
  applyShareUi();
}

async function attachCameraTo(peer) {
  if (!peer.senders?.camera || !state.camStream) return;
  const vt = state.camStream.getVideoTracks()[0];
  if (!vt) return;
  await peer.senders.camera.replaceTrack(vt);
  const p = peer.senders.camera.getParameters();
  if (!p.encodings?.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = CAM_MAX_BITRATE;
  peer.senders.camera.setParameters(p).catch(() => {});
}

// ---------- 麦克风 / 离开 ----------

$('leaveBtn').addEventListener('click', () => leaveChannel());

// ---------- 成员与画面渲染 ----------

function addPeer(p) {
  state.peers.set(p.id, { name: p.name, sharing: !!p.sharing, camera: !!p.camera, videoStream: null, camStream: null });
  renderMembers();
  refreshTiles();
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc?.close();
  peer.audioEl && (peer.audioEl.srcObject = null);
  peer.tile?.remove();
  peer.camTile?.remove();
  state.peers.delete(id);
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

// 我在看谁 → 告诉每个正在共享的人:把我当主窗口的发高清,其余发缩略图(省上行/下行带宽)
function updateViewQuality() {
  for (const [id, p] of state.peers) {
    if (!p.sharing) {
      p.viewReq = null;
      continue;
    }
    const want = state.focusedId === id ? 'high' : 'low';
    if (p.viewReq !== want) {
      p.viewReq = want;
      sendSignal(id, { want });
    }
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

function startStatsLoop() {
  const last = new Map(); // peerId+mid / 'local' -> bytes
  setInterval(async () => {
    for (const [id, p] of state.peers) {
      if (!p.pc || (!p.tile && !p.camTile)) continue;
      try {
        const stats = await p.pc.getStats();
        stats.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            // 一条连接里有两路视频:按 m-line 序号区分(1=屏幕,3=摄像头;旧端无 mid 按屏幕算)
            const isCam = s.mid === '3';
            const tile = isCam ? p.camTile : p.tile;
            const key = id + ':' + (s.mid ?? 'v');
            const prev = last.get(key) || 0;
            const delta = s.bytesReceived - prev;
            const kbps = Math.round((delta * 8) / 2000);
            last.set(key, s.bytesReceived);
            const statsEl = tile?.querySelector('.tile-stats');
            if (statsEl)
              statsEl.textContent =
                `${s.frameWidth || '?'}×${s.frameHeight || '?'} ` +
                `${s.framesPerSecond || 0}fps ${kbps}kbps`;
            // 卡死自愈兜底:对方在共享屏幕却连续多轮零字节(ICE 仍显示 connected 的僵死),强制重连
            if (!isCam && p.sharing) {
              if (delta <= 0) {
                p.stallTicks = (p.stallTicks || 0) + 1;
                if (p.stallTicks >= 8) { p.stallTicks = 0; triggerRestart(id); } // ~16s 无数据
              } else {
                p.stallTicks = 0;
              }
            }
          }
        });

        // 线路指示:当前选中的候选对里任一端是 relay = 走 TURN 中继,否则 P2P 直连
        let route = '';
        let isRelay = false;
        let pair = null;
        stats.forEach((s) => {
          if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
        });
        if (!pair)
          stats.forEach((s) => {
            if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
          });
        if (pair) {
          const lc = stats.get(pair.localCandidateId) || {};
          const rc = stats.get(pair.remoteCandidateId) || {};
          isRelay = lc.candidateType === 'relay' || rc.candidateType === 'relay';
          route = isRelay ? 'TURN中继' : 'P2P直连';
        }
        for (const t of [p.tile, p.camTile]) {
          const el = t?.querySelector('.tile-route');
          if (el) {
            el.textContent = route;
            el.classList.toggle('is-relay', isRelay);
          }
        }
      } catch {}
    }
    // 本地上行码率
    if (localTile && state.peers.size) {
      const first = [...state.peers.values()].find((p) => p.senders?.video?.track);
      if (first) {
        try {
          const stats = await first.pc.getStats(first.senders.video.track);
          stats.forEach((s) => {
            if (s.type === 'outbound-rtp' && s.kind === 'video') {
              const prev = last.get('local') || 0;
              const kbps = Math.round(((s.bytesSent - prev) * 8) / 2000);
              last.set('local', s.bytesSent);
              localTile.querySelector('.tile-stats').textContent =
                `↑ ${s.frameWidth || '?'}×${s.frameHeight || '?'} ` +
                `${s.framesPerSecond || 0}fps ${kbps}kbps ×${state.peers.size}路`;
            }
          });
        } catch {}
      }
    }
  }, 2000);
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
function openServerSettings() {
  const g = state.guild.guild;
  const name = textInput(g.name, '服务器名', 32);
  const icon = textInput(g.icon, '一个 emoji', 4);
  const desc = textInput(g.description, '描述(可选)', 200);
  const body = document.createElement('div');
  body.append(field('服务器名', name), field('图标(emoji)', icon), field('描述', desc));
  openModal('服务器设置', body, async () => {
    if (!name.value.trim()) return false;
    const r = await api('PATCH', '/api/guild', { name: name.value.trim(), icon: icon.value.trim(), description: desc.value.trim() });
    if (!r.ok) return (alert(r.error || '保存失败'), false);
    await loadGuild();
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
  for (const p of state.peers.values()) p.senders?.mic?.replaceTrack(fresh);
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
  for (const p of state.peers.values()) await attachCameraTo(p);
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
