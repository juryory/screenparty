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
  room: '',
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  micTrack: null,
  screenStream: null,
  peers: new Map(), // id -> { name, sharing, pc, senders, tile, videoStream, audioEl, stats }
};

const SCREEN_MAX_BITRATE = 3_500_000; // ~3.5 Mbps,5 人 mesh 下每人上行约 14 Mbps

// ---------- 鉴权 / 登录 ----------

const params = new URLSearchParams(location.search);
if (params.get('room')) $('roomInput').value = params.get('room');

// 启动:查当前身份 —— 未登录跳转到独立的登录页,登录后才回到本页(大厅)
bootstrapAuth();

async function bootstrapAuth() {
  let me = null;
  try {
    const r = await fetch('/api/me');
    if (r.ok) me = (await r.json()).user;
  } catch {}
  if (me) showLobby(me);
  else {
    const room = params.get('room');
    location.replace(room ? `/login.html?room=${encodeURIComponent(room)}` : '/login.html');
  }
}

function showLobby(me) {
  state.myName = me.nickname;
  $('lobby').hidden = false;
  $('lobbyNick').textContent = me.nickname;
  $('adminLink').hidden = !me.isAdmin;
}

$('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {}
  location.replace('/login.html');
});

// ---------- 加入流程 ----------

$('joinBtn').addEventListener('click', join);
$('roomInput').addEventListener('keydown', (e) => e.key === 'Enter' && join());

async function join() {
  const room = $('roomInput').value.trim();
  if (!state.myName) return showLobbyError('登录状态已失效,请重新登录');
  if (!room) return showLobbyError('请填写房间名');
  if (!/^[\w\u4e00-\u9fff-]{1,32}$/.test(room))
    return showLobbyError('房间名只能包含中英文、数字、下划线和连字符');

  $('joinBtn').disabled = true;
  showLobbyError('');

  // 没有麦克风时不阻塞进房:只共享/观看画面、收听别人语音
  state.micTrack = await acquireMic();

  try {
    const r = await fetch('/api/turn');
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.iceServers) && j.iceServers.length) state.iceServers = j.iceServers;
    }
  } catch {}

  state.room = room; // state.myName 已在登录后锁定为账号昵称
  connectSignaling();
}

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

function showLobbyError(text) {
  const el = $('lobbyError');
  el.textContent = text;
  el.hidden = !text;
}

// ---------- 信令 ----------

function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(state.room)}`);
  state.ws = ws;

  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: state.myName }));

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'welcome':
        state.myId = msg.id;
        enterRoom();
        // 新人主动向每个已有成员发起连接
        for (const p of msg.peers) {
          addPeer(p);
          await makeOffer(p.id);
        }
        break;
      case 'peer-joined':
        addPeer(msg.peer); // 被动等待对方的 offer
        break;
      case 'peer-left':
        removePeer(msg.id);
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
    if (document.getElementById('room').hidden) {
      $('joinBtn').disabled = false;
      showLobbyError('房间已满或连接失败,请稍后重试');
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
    } else {
      // 对方屏幕(视频 + 游戏声),合入同一条流保证音画同步
      peer.videoStream.addTrack(e.track);
      refreshTiles();
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };

  return pc;
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

  if (data.sdp) {
    if (data.sdp.type === 'offer') {
      const pc = peer.pc || createPeerConnection(from);
      await pc.setRemoteDescription(data.sdp);
      peer.senders = setupTransceivers(pc, false);
      await attachScreenTo(peer);
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
    const p = peer.senders.video.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = SCREEN_MAX_BITRATE;
    p.degradationPreference = 'maintain-framerate'; // 带宽不足时降分辨率保帧率
    await peer.senders.video.setParameters(p).catch(() => {});
  }
  if (at) await peer.senders.screenAudio.replaceTrack(at);
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

$('micBtn').addEventListener('click', () => {
  if (!state.micTrack) return; // 无麦克风设备,按钮已禁用
  const on = !(state.micTrack.enabled = !state.micTrack.enabled);
  $('micBtn').setAttribute('aria-pressed', String(!on));
  $('micBtn').classList.toggle('is-off', on);
  $('micBtn').querySelector('span').textContent = on ? '已静音' : '麦克风';
});

$('leaveBtn').addEventListener('click', () => location.reload());

$('copyLinkBtn').addEventListener('click', async () => {
  const url = `${location.origin}/?room=${encodeURIComponent(state.room)}`;
  try {
    await navigator.clipboard.writeText(url);
    $('copyLinkBtn').textContent = '已复制 ✓';
    setTimeout(() => ($('copyLinkBtn').textContent = '复制邀请链接'), 1500);
  } catch {
    prompt('复制此链接发给朋友:', url);
  }
});

// ---------- 成员与画面渲染 ----------

function enterRoom() {
  $('lobby').hidden = true;
  $('room').hidden = false;
  $('roomLabel').textContent = state.room;
  history.replaceState(null, '', `/?room=${encodeURIComponent(state.room)}`);
  if (!state.micTrack) {
    const b = $('micBtn');
    b.disabled = true;
    b.classList.add('is-off');
    b.setAttribute('aria-pressed', 'false');
    b.title = '未检测到麦克风设备';
    b.querySelector('span').textContent = '无麦克风';
  }
  renderMembers();
  startStatsLoop();
}

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
  const ul = $('memberList');
  ul.innerHTML = '';
  const me = document.createElement('li');
  me.textContent = `${state.myName}(我)`;
  me.classList.toggle('is-sharing', !!state.screenStream);
  ul.appendChild(me);
  for (const p of state.peers.values()) {
    const li = document.createElement('li');
    li.textContent = p.name;
    li.classList.toggle('is-sharing', p.sharing);
    ul.appendChild(li);
  }
}

let localTile = null;

function refreshTiles() {
  const grid = $('grid');

  // 本地预览
  if (state.screenStream && !localTile) {
    localTile = makeTile(`${state.myName}(我)`, state.screenStream, true);
    grid.appendChild(localTile);
  } else if (!state.screenStream && localTile) {
    localTile.remove();
    localTile = null;
  }

  // 远端画面:sharing 且已收到视频 track 才显示
  for (const [id, p] of state.peers) {
    const shouldShow = p.sharing && p.videoStream?.getVideoTracks().length;
    if (shouldShow && !p.tile) {
      p.tile = makeTile(p.name, p.videoStream, false);
      p.tile.dataset.peer = id;
      grid.appendChild(p.tile);
    } else if (!shouldShow && p.tile) {
      p.tile.remove();
      p.tile = null;
    }
  }

  const count = grid.querySelectorAll('.tile').length;
  grid.dataset.count = String(Math.min(count, 6));
  if (count < 2) exitFocus();
  renderMembers();
}

function makeTile(name, stream, muted) {
  const tile = $('tileTemplate').content.firstElementChild.cloneNode(true);
  const video = tile.querySelector('video');
  video.srcObject = stream;
  video.muted = muted; // 本地预览静音,防回声
  tile.querySelector('.umd-name').textContent = name;
  tile.classList.add('on-air');
  tile.addEventListener('click', () => toggleFocus(tile));
  tile.addEventListener('dblclick', () => video.requestFullscreen?.());
  return tile;
}

function toggleFocus(tile) {
  const grid = $('grid');
  if (tile.classList.contains('is-focus')) return exitFocus();
  grid.querySelectorAll('.tile').forEach((t) => t.classList.remove('is-focus'));
  tile.classList.add('is-focus');
  grid.classList.add('focused');
}

function exitFocus() {
  $('grid').classList.remove('focused');
  $('grid').querySelectorAll('.tile').forEach((t) => t.classList.remove('is-focus'));
}

// ---------- 实时统计(分辨率 / fps / 码率) ----------

function startStatsLoop() {
  const last = new Map(); // pc -> bytes
  setInterval(async () => {
    for (const p of state.peers.values()) {
      if (!p.pc || !p.tile) continue;
      try {
        const stats = await p.pc.getStats();
        stats.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            const prev = last.get(p.pc) || 0;
            const kbps = Math.round(((s.bytesReceived - prev) * 8) / 2000);
            last.set(p.pc, s.bytesReceived);
            p.tile.querySelector('.tile-stats').textContent =
              `${s.frameWidth || '?'}×${s.frameHeight || '?'} ` +
              `${s.framesPerSecond || 0}fps ${kbps}kbps`;
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
