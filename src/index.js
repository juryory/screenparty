// ScreenParty — 信令服务 (Cloudflare Worker + Durable Object)
// 媒体流走 WebRTC mesh 点对点传输,本服务只负责:
//   1. /ws/:room   房间信令 (join / signal 转发 / 成员状态广播)
//   2. /api/turn   可选:签发 Cloudflare Realtime TURN 临时凭证
//   3. 其余路径    静态前端 (public/)

const MAX_PEERS = 8;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket 信令:每个房间一个 Durable Object 实例
    const wsMatch = url.pathname.match(/^\/ws\/([\w-]{1,64})$/);
    if (wsMatch) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const id = env.ROOM.idFromName(wsMatch[1]);
      return env.ROOM.get(id).fetch(request);
    }

    // TURN 临时凭证(未配置 secret 时返回纯 STUN,mesh 直连不受影响)
    if (url.pathname === '/api/turn') {
      return this.turnCredentials(env);
    }

    return env.ASSETS.fetch(request);
  },

  async turnCredentials(env) {
    const fallback = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    };
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
      return Response.json(fallback);
    }
    try {
      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      if (!r.ok) throw new Error(`turn api ${r.status}`);
      const data = await r.json();
      // 把 STUN 也带上,优先直连
      data.iceServers = [...fallback.iceServers, ...[].concat(data.iceServers)];
      return Response.json(data);
    } catch (e) {
      console.error('TURN credential error:', e.message);
      return Response.json(fallback);
    }
  },
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const peers = this.state.getWebSockets();
    if (peers.length >= MAX_PEERS) {
      return new Response('room full', { status: 409 });
    }
    const pair = new WebSocketPair();
    // Hibernation API:空闲时 DO 休眠,不消耗运行时配额
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const id = crypto.randomUUID().slice(0, 8);
        const name = String(msg.name || '玩家').slice(0, 24);
        ws.serializeAttachment({ id, name, sharing: false });

        // 告知新人:自己的 id + 房间里已有哪些人(新人将向他们逐一发起连接)
        const others = this.roster().filter((p) => p.id !== id);
        ws.send(JSON.stringify({ type: 'welcome', id, peers: others }));

        this.broadcast({ type: 'peer-joined', peer: { id, name, sharing: false } }, ws);
        break;
      }

      case 'signal': {
        // 点对点转发 SDP / ICE candidate
        const me = ws.deserializeAttachment();
        if (!me) return;
        const target = this.state
          .getWebSockets()
          .find((s) => s.deserializeAttachment()?.id === msg.to);
        target?.send(
          JSON.stringify({ type: 'signal', from: me.id, data: msg.data }),
        );
        break;
      }

      case 'state': {
        // 共享开始/结束等状态,广播给全房间
        const me = ws.deserializeAttachment();
        if (!me) return;
        me.sharing = !!msg.sharing;
        ws.serializeAttachment(me);
        this.broadcast(
          { type: 'peer-state', id: me.id, sharing: me.sharing },
          ws,
        );
        break;
      }
    }
  }

  webSocketClose(ws) {
    this.dropPeer(ws);
  }

  webSocketError(ws) {
    this.dropPeer(ws);
  }

  dropPeer(ws) {
    const me = ws.deserializeAttachment();
    if (me) this.broadcast({ type: 'peer-left', id: me.id }, ws);
    try {
      ws.close();
    } catch {}
  }

  roster() {
    return this.state
      .getWebSockets()
      .map((s) => s.deserializeAttachment())
      .filter(Boolean);
  }

  broadcast(obj, except) {
    const payload = JSON.stringify(obj);
    for (const s of this.state.getWebSockets()) {
      if (s === except) continue;
      try {
        s.send(payload);
      } catch {}
    }
  }
}
