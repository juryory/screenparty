// ScreenParty — 信令服务 (Cloudflare Worker + Durable Object)
// 媒体流走 WebRTC mesh 点对点传输,本服务只负责:
//   1. 鉴权     账号登录 / 会话 / 管理员用户管理(禁止匿名与自助注册)
//   2. /ws/:room   房间信令 (join / signal 转发 / 成员状态广播)
//   3. /api/turn   可选:签发 TURN 临时凭证(自建 coturn / Cloudflare Realtime)
//   4. 其余路径    静态前端 (public/)

import { DurableObject } from 'cloudflare:workers';

const MAX_PEERS = 8;

const SESSION_COOKIE = 'sp_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// coturn REST API 临时凭证(use-auth-secret 模式):
//   username   = 过期时间戳(unix 秒),coturn 会校验其未过期
//   credential = base64( HMAC-SHA1(static-auth-secret, username) )
// 凭证会过期,即使被抓包也无法长期盗用中继带宽。
async function coturnCredential(secret, ttlSeconds = 86400) {
  const username = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return { username, credential };
}

// ---------- 密码哈希(WebCrypto PBKDF2-SHA256,加盐,只存 hash) ----------

const PBKDF2_ITERATIONS = 100_000;

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return { salt: bytesToHex(salt), hash: bytesToHex(new Uint8Array(bits)) };
}

async function verifyPassword(password, saltHex, expectedHash) {
  const { hash } = await hashPassword(password, saltHex);
  if (hash.length !== expectedHash.length) return false;
  let diff = 0; // 常量时间比较
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return diff === 0;
}

// 只对外暴露安全字段,绝不含 pw_hash / pw_salt
function publicUser(row) {
  return {
    username: row.username,
    nickname: row.nickname,
    isAdmin: !!row.is_admin,
    enabled: !!row.enabled,
    createdAt: row.created_at,
  };
}

// ---------- Cookie ----------

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}
function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}
function clearedCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ---------- Worker 入口 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const auth = env.AUTH.get(env.AUTH.idFromName('global'));

    // 登录 / 登出 / 当前身份
    if (url.pathname === '/api/login' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const res = await auth.login(String(body.username || ''), String(body.password || ''));
      if (!res) {
        return Response.json({ error: '用户名或密码错误,或账号已停用' }, { status: 401 });
      }
      return Response.json({ user: res.user }, { headers: { 'Set-Cookie': sessionCookie(res.token) } });
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      const token = getCookie(request, SESSION_COOKIE);
      if (token) await auth.logout(token);
      return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearedCookie() } });
    }

    if (url.pathname === '/api/me') {
      const user = await auth.verify(getCookie(request, SESSION_COOKIE));
      if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ user });
    }

    // 管理员:用户增删改查(需登录且 isAdmin)
    if (url.pathname === '/api/admin/users' || url.pathname.startsWith('/api/admin/users/')) {
      const user = await auth.verify(getCookie(request, SESSION_COOKIE));
      if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (!user.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 });
      return this.adminUsers(request, url, auth);
    }

    // WebSocket 信令:需有效会话,禁止匿名。校验后注入可信昵称,忽略客户端自报身份。
    const wsMatch = url.pathname.match(/^\/ws\/([\w-]{1,64})$/);
    if (wsMatch) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const user = await auth.verify(getCookie(request, SESSION_COOKIE));
      if (!user) return new Response('unauthorized', { status: 401 });

      const headers = new Headers(request.headers);
      headers.set('X-SP-Nick', encodeURIComponent(user.nickname)); // 覆盖任何客户端伪造值
      headers.set('X-SP-User', user.username);
      const id = env.ROOM.idFromName(wsMatch[1]);
      return env.ROOM.get(id).fetch(new Request(request, { headers }));
    }

    // TURN 临时凭证:同样需登录,杜绝匿名占用中继带宽
    if (url.pathname === '/api/turn') {
      const user = await auth.verify(getCookie(request, SESSION_COOKIE));
      if (!user) return new Response('unauthorized', { status: 401 });
      return this.turnCredentials(env);
    }

    return env.ASSETS.fetch(request);
  },

  async adminUsers(request, url, auth) {
    const method = request.method;

    if (url.pathname === '/api/admin/users') {
      if (method === 'GET') {
        return Response.json({ users: await auth.listUsers() });
      }
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const r = await auth.createUser(body);
        return Response.json(r.ok ? { ok: true } : { error: r.error }, {
          status: r.ok ? 200 : r.status || 400,
        });
      }
      return new Response('method not allowed', { status: 405 });
    }

    const target = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length));
    if (method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      const r = await auth.updateUser(target, body);
      return Response.json(r.ok ? { ok: true } : { error: r.error }, {
        status: r.ok ? 200 : r.status || 400,
      });
    }
    if (method === 'DELETE') {
      const r = await auth.deleteUser(target);
      return Response.json(r.ok ? { ok: true } : { error: r.error }, {
        status: r.ok ? 200 : r.status || 400,
      });
    }
    return new Response('method not allowed', { status: 405 });
  },

  async turnCredentials(env) {
    // STUN 永远放最前:让浏览器优先尝试 P2P 直连,连不上才回落到 TURN 中继
    const iceServers = [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
    ];

    // ① 自建 coturn(如腾讯云 VPS):配置 COTURN_HOST + COTURN_SECRET 即启用
    if (env.COTURN_HOST && env.COTURN_SECRET) {
      try {
        const { username, credential } = await coturnCredential(env.COTURN_SECRET);
        const host = env.COTURN_HOST; // 域名或公网 IP,不含端口
        const port = env.COTURN_PORT || '3478';
        iceServers.push(
          { urls: `turn:${host}:${port}?transport=udp`, username, credential },
          { urls: `turn:${host}:${port}?transport=tcp`, username, credential },
        );
        // 有 TLS 证书时再暴露 turns://(走 443/5349,穿透只放行 HTTPS 的严格网络)
        if (env.COTURN_TLS_HOST) {
          const tlsPort = env.COTURN_TLS_PORT || '5349';
          iceServers.push({
            urls: `turns:${env.COTURN_TLS_HOST}:${tlsPort}?transport=tcp`,
            username,
            credential,
          });
        }
      } catch (e) {
        console.error('coturn credential error:', e.message);
      }
    }

    // ② Cloudflare Realtime TURN(可选,与自建可并存;境外节点,国内延迟略高)
    if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
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
        iceServers.push(...[].concat(data.iceServers));
      } catch (e) {
        console.error('Cloudflare TURN credential error:', e.message);
      }
    }

    return Response.json({ iceServers });
  },
};

// ---------- 账号/会话存储:单例 Durable Object(SQLite) ----------

export class Auth extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS users (
        username   TEXT PRIMARY KEY,
        nickname   TEXT NOT NULL,
        pw_hash    TEXT NOT NULL,
        pw_salt    TEXT NOT NULL,
        is_admin   INTEGER NOT NULL DEFAULT 0,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        username   TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
      await this.seedAdmin();
    });
  }

  // 首次启动用环境变量播种管理员;已存在则不覆盖(改密走管理界面)
  async seedAdmin() {
    const username = this.env.ADMIN_USERNAME;
    const password = this.env.ADMIN_PASSWORD;
    if (!username || !password) return;
    const existing = this.sql.exec('SELECT username FROM users WHERE username = ?', username).toArray();
    if (existing.length) return;
    const { salt, hash } = await hashPassword(password);
    const nickname = this.env.ADMIN_NICKNAME || username;
    this.sql.exec(
      'INSERT INTO users (username, nickname, pw_hash, pw_salt, is_admin, enabled, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)',
      username,
      nickname,
      hash,
      salt,
      Date.now(),
    );
  }

  async login(username, password) {
    const rows = this.sql.exec('SELECT * FROM users WHERE username = ?', username).toArray();
    const user = rows[0];
    if (!user || !user.enabled) return null;
    if (!(await verifyPassword(password, user.pw_salt, user.pw_hash))) return null;
    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
    this.sql.exec(
      'INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)',
      token,
      username,
      Date.now() + SESSION_TTL_MS,
    );
    return { token, user: publicUser(user) };
  }

  async logout(token) {
    this.sql.exec('DELETE FROM sessions WHERE token = ?', token);
  }

  // 校验会话:过期/停用/被删的账号一律返回 null(即时失效)
  async verify(token) {
    if (!token) return null;
    this.sql.exec('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    const s = this.sql.exec('SELECT username FROM sessions WHERE token = ?', token).toArray()[0];
    if (!s) return null;
    const user = this.sql.exec('SELECT * FROM users WHERE username = ?', s.username).toArray()[0];
    if (!user || !user.enabled) return null;
    return publicUser(user);
  }

  async listUsers() {
    return this.sql
      .exec('SELECT username, nickname, is_admin, enabled, created_at FROM users ORDER BY is_admin DESC, created_at ASC')
      .toArray()
      .map(publicUser);
  }

  async createUser({ username, nickname, password, enabled } = {}) {
    username = String(username || '').trim();
    nickname = String(nickname || '').trim().slice(0, 24);
    password = String(password || '');
    if (!/^[\w.-]{1,32}$/.test(username)) {
      return { ok: false, status: 400, error: '用户名只能含字母、数字、下划线、点、连字符(1-32 位)' };
    }
    if (!nickname) return { ok: false, status: 400, error: '请填写显示昵称' };
    if (password.length < 6) return { ok: false, status: 400, error: '密码至少 6 位' };
    const dup = this.sql.exec('SELECT username FROM users WHERE username = ?', username).toArray();
    if (dup.length) return { ok: false, status: 409, error: '用户名已存在' };
    const { salt, hash } = await hashPassword(password);
    this.sql.exec(
      'INSERT INTO users (username, nickname, pw_hash, pw_salt, is_admin, enabled, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      username,
      nickname,
      hash,
      salt,
      enabled === false ? 0 : 1,
      Date.now(),
    );
    return { ok: true };
  }

  async updateUser(username, { nickname, password, enabled } = {}) {
    const user = this.sql.exec('SELECT * FROM users WHERE username = ?', username).toArray()[0];
    if (!user) return { ok: false, status: 404, error: '用户不存在' };
    if (user.is_admin && enabled === false) {
      return { ok: false, status: 400, error: '不能停用管理员账号' };
    }
    if (nickname !== undefined) {
      const n = String(nickname).trim().slice(0, 24);
      if (!n) return { ok: false, status: 400, error: '昵称不能为空' };
      this.sql.exec('UPDATE users SET nickname = ? WHERE username = ?', n, username);
    }
    if (password !== undefined && password !== '') {
      if (String(password).length < 6) return { ok: false, status: 400, error: '密码至少 6 位' };
      const { salt, hash } = await hashPassword(String(password));
      this.sql.exec('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE username = ?', hash, salt, username);
    }
    if (enabled !== undefined) {
      this.sql.exec('UPDATE users SET enabled = ? WHERE username = ?', enabled ? 1 : 0, username);
      // 停用即踢下线:清掉其现有会话
      if (!enabled) this.sql.exec('DELETE FROM sessions WHERE username = ?', username);
    }
    return { ok: true };
  }

  async deleteUser(username) {
    const user = this.sql.exec('SELECT * FROM users WHERE username = ?', username).toArray()[0];
    if (!user) return { ok: false, status: 404, error: '用户不存在' };
    if (user.is_admin) return { ok: false, status: 400, error: '不能删除管理员账号' };
    this.sql.exec('DELETE FROM sessions WHERE username = ?', username);
    this.sql.exec('DELETE FROM users WHERE username = ?', username);
    return { ok: true };
  }
}

// ---------- 房间信令:每个房间一个 Durable Object 实例 ----------

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const peers = this.state.getWebSockets();
    if (peers.length >= MAX_PEERS) {
      return new Response('room full', { status: 409 });
    }
    // 可信昵称由 Worker 鉴权后注入,客户端无法伪造
    const nick = decodeURIComponent(request.headers.get('X-SP-Nick') || '') || '玩家';
    const pair = new WebSocketPair();
    // Hibernation API:空闲时 DO 休眠,不消耗运行时配额
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ nick });
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
        const att = ws.deserializeAttachment() || {};
        const id = crypto.randomUUID().slice(0, 8);
        const name = att.nick || '玩家'; // 用服务端可信昵称,忽略 msg.name
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
        if (!me || !me.id) return;
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
        if (!me || !me.id) return;
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
    if (me && me.id) this.broadcast({ type: 'peer-left', id: me.id }, ws);
    try {
      ws.close();
    } catch {}
  }

  roster() {
    return this.state
      .getWebSockets()
      .map((s) => s.deserializeAttachment())
      .filter((a) => a && a.id);
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
