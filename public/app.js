// ScreenParty 前端 — WebRTC full mesh
//
// 连接模型:每对成员一条 RTCPeerConnection,固定 3 个 transceiver:
//   [0] mic 音频  [1] 屏幕视频  [2] 屏幕音频(游戏声)
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
  channelId: null,
  channelName: '',
  guild: null, // { guild:{name,icon,description}, categories:[], channels:[], me:{role} }
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  micTrack: null,
  screenStream: null,
  peers: new Map(), // id -> { name, sharing, pc, senders, tile, videoStream, audioEl, sendQuality, viewReq }
  focusedId: null,  // 当前主舞台显示谁:peer id / 'local' / null
};

const ROLE_LABEL = { owner: '所有者', admin: '管理员', member: '成员' };

const SCREEN_MAX_BITRATE = 3_500_000; // ~3.5 Mbps,主窗口(被人放大观看)的全码率
const THUMB_MAX_BITRATE = 300_000;    // 缩略图(没在主窗口看的共享)只发 ~300kbps
const THUMB_SCALE = 3;                // 且分辨率降到 1/3,低码率下更耐看

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
  $('app').hidden = false;
  $('uNick').textContent = me.nickname;
  $('uAvatar').textContent = me.nickname.slice(0, 2);
  $('adminLink').hidden = !me.isAdmin;
  await loadGuild();
  startStatsLoop();
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
}

function channelItem(ch) {
  const wrap = document.createElement('div');
  wrap.className = 'channel-item';
  const row = document.createElement('div');
  row.className = 'channel-row';
  row.dataset.channel = ch.id;
  row.classList.toggle('is-active', ch.id === state.channelId);
  row.innerHTML = `<span class="ch-glyph">${ch.type === 'text' ? '#' : '🔊'}</span><span class="ch-label"></span>`;
  row.querySelector('.ch-label').textContent = ch.name;
  if (ch.type !== 'text') row.addEventListener('click', () => joinChannel(ch.id, ch.name, ch.topic));
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
  for (const [, p] of state.peers) {
    clearTimeout(p.recoverTimer);
    p.pc?.close();
    p.audioEl && (p.audioEl.srcObject = null);
    p.tile?.remove();
  }
  state.peers.clear();
  localTile?.remove();
  localTile = null;
  try {
    state.ws?.close();
  } catch {}
  state.ws = null;
  state.myId = null;
  state.channelId = null;
  state.channelName = '';
  state.focusedId = null;
  $('channelBar').hidden = true;
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

// 尝试获取麦克风;拿不到就返回 null(不阻塞进房)。
// 关键:无麦克风的机器上 getUserMedia 可能长时间挂起而不报错,所以先探测设备并加超时兜底。
async function acquireMic() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === 'audioinput')) return null; // 没有麦克风设备,直接跳过
  } catch {}
  const micPromise = navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  try {
    const stream = await Promise.race([
      micPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('mic-timeout')), 6000)),
    ]);
    return stream.getAudioTracks()[0] || null;
  } catch {
    // 超时后 getUserMedia 若迟到 resolve,顺手停掉,避免麦克风一直被占用(地址栏图标常亮)
    micPromise.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
    return null; // 拒绝授权 / 无设备 / 超时:均按无麦克风处理
  }
}

// ---------- 信令 ----------

function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(state.channelId)}`);
  state.ws = ws;

  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: state.myName }));

  ws.onmessage = async (e) => {
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
          refreshTiles();
        }
        break;
      }
      case 'signal':
        await handleSignal(msg.from, msg.data);
        break;
    }
  };

  ws.onclose = () => {
    // 频道断开:被动断线由自愈逻辑处理,主动离开已清理
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

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { ice: e.candidate });
  };

  pc.ontrack = (e) => {
    const idx = pc.getTransceivers().indexOf(e.transceiver);
    if (idx === 0) {
      // 对方麦克风
      peer.audioEl = peer.audioEl || new Audio();
      peer.audioEl.autoplay = true;
      peer.audioEl.srcObject = new MediaStream([e.track]);
      safePlay(peer.audioEl);
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
    preferH264(video);
    return { mic: mic.sender, video: video.sender, screenAudio: audio.sender };
  }
  // answer 端:transceiver 由远端 offer 创建,按相同顺序取用
  const [mic, video, audio] = pc.getTransceivers();
  [mic, video, audio].forEach((t) => (t.direction = 'sendrecv'));
  mic.sender.replaceTrack(state.micTrack);
  preferH264(video);
  return { mic: mic.sender, video: video.sender, screenAudio: audio.sender };
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

  state.ws?.send(JSON.stringify({ type: 'state', sharing: true }));
  $('shareBtn').setAttribute('aria-pressed', 'true');
  $('shareBtn').querySelector('span').textContent = '停止共享';
  refreshTiles();
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
  state.ws?.send(JSON.stringify({ type: 'state', sharing: false }));
  $('shareBtn').setAttribute('aria-pressed', 'false');
  $('shareBtn').querySelector('span').textContent = '共享屏幕';
  refreshTiles();
}

// ---------- 麦克风 / 离开 ----------

$('leaveBtn').addEventListener('click', () => leaveChannel());

// ---------- 成员与画面渲染 ----------

function addPeer(p) {
  state.peers.set(p.id, { name: p.name, sharing: !!p.sharing, videoStream: null });
  renderMembers();
  refreshTiles();
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc?.close();
  peer.audioEl && (peer.audioEl.srcObject = null);
  peer.tile?.remove();
  state.peers.delete(id);
  renderMembers();
  refreshTiles();
}

function renderMembers() {
  const box = document.getElementById('channelMembers');
  if (!box) return;
  box.innerHTML = '';
  const add = (name, sharing, isMe) => {
    const el = document.createElement('div');
    el.className = 'cm-row';
    el.classList.toggle('is-sharing', !!sharing);
    const dot = document.createElement('span');
    dot.className = 'cm-dot';
    const nm = document.createElement('span');
    nm.className = 'cm-name';
    nm.textContent = isMe ? `${name}(我)` : name;
    el.append(dot, nm);
    box.appendChild(el);
  };
  if (state.channelId) add(state.myName, !!state.screenStream, true);
  for (const p of state.peers.values()) add(p.name, p.sharing, false);
}

let localTile = null;

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

  // 每个成员一块瓦片:正在共享→视频瓦片;未共享→占位瓦片。共享状态切换时换瓦片类型。
  for (const [id, p] of state.peers) {
    const hasVideo = p.sharing && p.videoStream?.getVideoTracks().length;
    const kind = hasVideo ? 'video' : 'placeholder';
    if (p.tile && p.tileKind !== kind) {
      p.tile.remove();
      p.tile = null;
    }
    if (!p.tile) {
      p.tile = hasVideo
        ? makeTile(p.name, p.videoStream, false, id)
        : makePlaceholder(p.name, id);
      p.tileKind = kind;
    }
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
  for (const [id, p] of state.peers) if (p.tile) m.set(id, p.tile);
  return m;
}

function pickDefaultFocus() {
  for (const [id, p] of state.peers)
    if (p.sharing && p.videoStream?.getVideoTracks().length) return id;
  if (state.screenStream) return 'local';
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

function makePlaceholder(name, key) {
  const tile = $('tileTemplate').content.firstElementChild.cloneNode(true);
  tile.classList.add('is-placeholder');
  tile.dataset.key = key;
  tile.querySelector('video').remove();
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
  const last = new Map(); // pc -> bytes
  setInterval(async () => {
    for (const [id, p] of state.peers) {
      if (!p.pc || !p.tile) continue;
      try {
        const stats = await p.pc.getStats();
        stats.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            const prev = last.get(p.pc) || 0;
            const delta = s.bytesReceived - prev;
            const kbps = Math.round((delta * 8) / 2000);
            last.set(p.pc, s.bytesReceived);
            const statsEl = p.tile.querySelector('.tile-stats');
            if (statsEl)
              statsEl.textContent =
                `${s.frameWidth || '?'}×${s.frameHeight || '?'} ` +
                `${s.framesPerSecond || 0}fps ${kbps}kbps`;
            // 卡死自愈兜底:对方在共享却连续多轮零字节(ICE 仍显示 connected 的僵死),强制重连
            if (p.sharing) {
              if (delta <= 0) {
                p.stallTicks = (p.stallTicks || 0) + 1;
                if (p.stallTicks >= 8) { p.stallTicks = 0; triggerRestart(id); } // ~16s 无数据
              } else {
                p.stallTicks = 0;
              }
            }
          }
        });
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
  const body = document.createElement('div');
  body.append(field('频道名', name), field('所属分类', cat));
  openModal('新建语音频道', body, async () => {
    if (!name.value.trim()) return false;
    const r = await api('POST', '/api/channels', { name: name.value.trim(), type: 'voice', categoryId: cat.value || null });
    if (!r.ok) return (alert(r.error || '创建失败'), false);
    await loadGuild();
  }, '创建');
}

function openEditChannel(ch) {
  const name = textInput(ch.name, '频道名', 24);
  const topic = textInput(ch.topic || '', '频道简介(可选)', 120);
  const cat = categorySelect(ch.categoryId || '');
  const body = document.createElement('div');
  body.append(field('频道名', name), field('简介', topic), field('所属分类', cat));
  openModal('编辑频道', body, async () => {
    if (!name.value.trim()) return false;
    const r = await api('PATCH', '/api/channels/' + ch.id, { name: name.value.trim(), topic: topic.value.trim(), categoryId: cat.value || null });
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
