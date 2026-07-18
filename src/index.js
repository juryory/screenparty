// ScreenParty — 信令服务 (Cloudflare Worker + Durable Object)
// 媒体流走 WebRTC mesh 点对点传输,本服务只负责:
//   1. 鉴权     账号登录 / 自助注册 / 会话 / 管理员用户管理(禁止匿名;
//               新注册账号默认无共享屏幕/摄像头权限,由管理员开启)
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

// 短随机 id(分类/频道用)
function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

// 只对外暴露安全字段,绝不含 pw_hash / pw_salt。管理员天然有共享权限。
function publicUser(row) {
  return {
    username: row.username,
    nickname: row.nickname,
    isAdmin: !!row.is_admin,
    enabled: !!row.enabled,
    canShare: !!row.can_share || !!row.is_admin,
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

    // 自助注册:创建普通账号(无共享权限)并直接登录
    if (url.pathname === '/api/register' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const r = await auth.register(body);
      if (!r.ok) return Response.json({ error: r.error }, { status: r.status || 400 });
      const res = await auth.login(String(body.username || ''), String(body.password || ''));
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

    // 服务器(单例):树 / 设置 / 分类 / 频道 / 成员角色(需登录)
    if (
      url.pathname === '/api/guild' ||
      url.pathname.startsWith('/api/categories') ||
      url.pathname.startsWith('/api/channels') ||
      url.pathname === '/api/members' ||
      url.pathname.startsWith('/api/members/')
    ) {
      const user = await auth.verify(getCookie(request, SESSION_COOKIE));
      if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const guild = env.GUILD.get(env.GUILD.idFromName('global'));
      return this.guildApi(request, url, guild, auth, user);
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

      // 频道密码校验(owner/admin 免密):不通过直接拒绝升级,改前端也绕不过
      const guildDO = env.GUILD.get(env.GUILD.idFromName('global'));
      const allowed = await guildDO.canEnter(wsMatch[1], user.username, url.searchParams.get('pw') || '');
      if (!allowed) return new Response('channel password required', { status: 403 });

      const headers = new Headers(request.headers);
      headers.set('X-SP-Nick', encodeURIComponent(user.nickname)); // 覆盖任何客户端伪造值
      headers.set('X-SP-User', user.username);
      headers.set('X-SP-Share', user.canShare ? '1' : '0'); // 共享权限,Room 据此拦截无权者的共享广播
      const id = env.ROOM.idFromName(wsMatch[1]);
      return env.ROOM.get(id).fetch(new Request(request, { headers }));
    }

    // 各频道当前人数(频道列表显示「大厅 (5)」):逐个问询 Room DO
    if (url.pathname === '/api/presence') {
      const user = await auth.verify(getCookie(request, SESSION_COOKIE));
      if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const guild = env.GUILD.get(env.GUILD.idFromName('global'));
      const { channels } = await guild.tree();
      const entries = await Promise.all(
        channels.map(async (ch) => {
          try {
            const r = await env.ROOM.get(env.ROOM.idFromName(ch.id)).fetch('https://room/count');
            return [ch.id, (await r.json()).count || 0];
          } catch {
            return [ch.id, 0];
          }
        }),
      );
      return Response.json({ counts: Object.fromEntries(entries) });
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

  // 服务器结构 API:GET 树对所有登录者开放;增删改需 owner/admin;改角色需 owner
  async guildApi(request, url, guild, auth, user) {
    const method = request.method;
    const role = await guild.roleOf(user.username);
    const canManage = role === 'owner' || role === 'admin';
    const forbidden = () => Response.json({ error: 'forbidden' }, { status: 403 });
    const done = (r) =>
      Response.json(r.ok ? { ok: true, id: r.id } : { error: r.error }, { status: r.ok ? 200 : r.status || 400 });
    const body = () => request.json().catch(() => ({}));

    // 整棵树 + 我的角色
    if (url.pathname === '/api/guild' && method === 'GET') {
      return Response.json({
        ...(await guild.tree()),
        me: { username: user.username, nickname: user.nickname, role },
      });
    }
    if (url.pathname === '/api/guild' && method === 'PATCH') {
      if (!canManage) return forbidden();
      return done(await guild.updateGuild(await body()));
    }

    // 分类
    if (url.pathname === '/api/categories' && method === 'POST') {
      if (!canManage) return forbidden();
      return done(await guild.createCategory(await body()));
    }
    if (url.pathname.startsWith('/api/categories/')) {
      if (!canManage) return forbidden();
      const id = decodeURIComponent(url.pathname.slice('/api/categories/'.length));
      if (method === 'PATCH') return done(await guild.updateCategory(id, await body()));
      if (method === 'DELETE') return done(await guild.deleteCategory(id));
    }

    // 频道密码预校验(普通用户进带锁频道前调用,拿到明确的对错提示)
    const verifyMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/verify$/);
    if (verifyMatch && method === 'POST') {
      const chId = decodeURIComponent(verifyMatch[1]);
      const ok = await guild.canEnter(chId, user.username, String((await body()).password || ''));
      return ok ? Response.json({ ok: true }) : Response.json({ error: '频道密码错误' }, { status: 403 });
    }

    // 频道
    if (url.pathname === '/api/channels' && method === 'POST') {
      if (!canManage) return forbidden();
      return done(await guild.createChannel(await body()));
    }
    if (url.pathname.startsWith('/api/channels/')) {
      if (!canManage) return forbidden();
      const id = decodeURIComponent(url.pathname.slice('/api/channels/'.length));
      if (method === 'PATCH') return done(await guild.updateChannel(id, await body()));
      if (method === 'DELETE') return done(await guild.deleteChannel(id));
    }

    // 成员与角色(合并账号列表 + 服务器角色)
    if (url.pathname === '/api/members' && method === 'GET') {
      const users = await auth.listUsers();
      const roles = await guild.allRoles();
      return Response.json({ members: users.map((u) => ({ ...u, role: roles[u.username] || 'member' })) });
    }
    if (url.pathname.startsWith('/api/members/') && method === 'PATCH') {
      if (role !== 'owner') return forbidden();
      const target = decodeURIComponent(url.pathname.slice('/api/members/'.length));
      return done(await guild.setMemberRole(target, (await body()).role));
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
        can_share  INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`);
      // 迁移:旧库补 can_share 列。存量用户都是管理员手工建的可信小圈子,保留其共享能力;
      // 新库建表时已含该列,ALTER 抛错跳过,不会误放行。
      try {
        this.sql.exec('ALTER TABLE users ADD COLUMN can_share INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('UPDATE users SET can_share = 1');
      } catch {}
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
      'INSERT INTO users (username, nickname, pw_hash, pw_salt, is_admin, enabled, can_share, created_at) VALUES (?, ?, ?, ?, 1, 1, 1, ?)',
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
      .exec('SELECT username, nickname, is_admin, enabled, can_share, created_at FROM users ORDER BY is_admin DESC, created_at ASC')
      .toArray()
      .map(publicUser);
  }

  // 自助注册:强制普通用户 + 无共享权限(需管理员后台开启)
  async register({ username, nickname, password } = {}) {
    return this.createUser({ username, nickname, password, enabled: true, canShare: false });
  }

  async createUser({ username, nickname, password, enabled, canShare } = {}) {
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
      'INSERT INTO users (username, nickname, pw_hash, pw_salt, is_admin, enabled, can_share, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      username,
      nickname,
      hash,
      salt,
      enabled === false ? 0 : 1,
      canShare ? 1 : 0,
      Date.now(),
    );
    return { ok: true };
  }

  async updateUser(username, { nickname, password, enabled, canShare } = {}) {
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
    if (canShare !== undefined) {
      this.sql.exec('UPDATE users SET can_share = ? WHERE username = ?', canShare ? 1 : 0, username);
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

// ---------- 服务器(单例):分类 / 频道 / 成员角色(SQLite) ----------

const CHANNEL_TYPES = ['voice', 'text'];
const ASSIGNABLE_ROLES = ['admin', 'member'];

export class Guild extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS guild (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT '🎮',
        description TEXT NOT NULL DEFAULT ''
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        category_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'voice',
        topic TEXT NOT NULL DEFAULT '',
        password TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0
      )`);
      // 迁移:旧库补频道密码列(新库建表已含,ALTER 抛错跳过)
      try {
        this.sql.exec("ALTER TABLE channels ADD COLUMN password TEXT NOT NULL DEFAULT ''");
      } catch {}
      this.sql.exec(`CREATE TABLE IF NOT EXISTS members (
        username TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'member'
      )`);
      await this.seed();
    });
  }

  // 首次启动播种:服务器信息 + 所有者(播种的管理员)+ 默认分类与频道
  async seed() {
    if (this.sql.exec('SELECT id FROM guild WHERE id = 1').toArray().length) return;
    this.sql.exec(
      'INSERT INTO guild (id, name, icon, description) VALUES (1, ?, ?, ?)',
      this.env.GUILD_NAME || 'ScreenParty',
      '🎮',
      '一起开黑同屏',
    );
    if (this.env.ADMIN_USERNAME) {
      this.sql.exec('INSERT OR IGNORE INTO members (username, role) VALUES (?, ?)', this.env.ADMIN_USERNAME, 'owner');
    }
    const cat = newId();
    this.sql.exec('INSERT INTO categories (id, name, position) VALUES (?, ?, 0)', cat, '常规');
    this.sql.exec('INSERT INTO channels (id, category_id, name, type, position) VALUES (?, ?, ?, ?, 0)', newId(), cat, '大厅', 'voice');
    this.sql.exec('INSERT INTO channels (id, category_id, name, type, position) VALUES (?, ?, ?, ?, 1)', newId(), cat, '游戏', 'voice');
  }

  roleOf(username) {
    const r = this.sql.exec('SELECT role FROM members WHERE username = ?', username).toArray()[0];
    return r ? r.role : 'member';
  }

  allRoles() {
    const map = {};
    for (const r of this.sql.exec('SELECT username, role FROM members').toArray()) map[r.username] = r.role;
    return map;
  }

  tree() {
    const guild =
      this.sql.exec('SELECT name, icon, description FROM guild WHERE id = 1').toArray()[0] ||
      { name: 'ScreenParty', icon: '🎮', description: '' };
    const categories = this.sql.exec('SELECT id, name, position FROM categories ORDER BY position, name').toArray();
    const channels = this.sql
      .exec('SELECT id, category_id AS categoryId, name, type, topic, password, position FROM channels ORDER BY position, name')
      .toArray()
      // 只暴露"有没有密码",绝不下发密码本身
      .map(({ password, ...ch }) => ({ ...ch, hasPassword: !!password }));
    return { guild, categories, channels };
  }

  // 进入频道校验:无密码放行;owner/admin 免密;其余比对密码。
  // 未登记的房间名放行(保持旧行为,反正那是另一个房间,不构成绕过)。
  canEnter(channelId, username, pw) {
    const ch = this.sql.exec('SELECT password FROM channels WHERE id = ?', channelId).toArray()[0];
    if (!ch || !ch.password) return true;
    const role = this.roleOf(username);
    if (role === 'owner' || role === 'admin') return true;
    return String(pw) === ch.password;
  }

  updateGuild({ name, icon, description } = {}) {
    if (name !== undefined) {
      const n = String(name).trim().slice(0, 32);
      if (!n) return { ok: false, status: 400, error: '服务器名不能为空' };
      this.sql.exec('UPDATE guild SET name = ? WHERE id = 1', n);
    }
    if (icon !== undefined) this.sql.exec('UPDATE guild SET icon = ? WHERE id = 1', String(icon).slice(0, 8));
    if (description !== undefined) this.sql.exec('UPDATE guild SET description = ? WHERE id = 1', String(description).slice(0, 200));
    return { ok: true };
  }

  createCategory({ name } = {}) {
    const n = String(name || '').trim().slice(0, 24);
    if (!n) return { ok: false, status: 400, error: '分类名不能为空' };
    const id = newId();
    const pos = this.sql.exec('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories').toArray()[0]?.p || 0;
    this.sql.exec('INSERT INTO categories (id, name, position) VALUES (?, ?, ?)', id, n, pos);
    return { ok: true, id };
  }

  updateCategory(id, { name, position } = {}) {
    if (!this.sql.exec('SELECT id FROM categories WHERE id = ?', id).toArray().length)
      return { ok: false, status: 404, error: '分类不存在' };
    if (name !== undefined) {
      const n = String(name).trim().slice(0, 24);
      if (!n) return { ok: false, status: 400, error: '分类名不能为空' };
      this.sql.exec('UPDATE categories SET name = ? WHERE id = ?', n, id);
    }
    if (position !== undefined) this.sql.exec('UPDATE categories SET position = ? WHERE id = ?', Number(position) | 0, id);
    return { ok: true };
  }

  deleteCategory(id) {
    // 分类下的频道移到"未分类"(category_id = NULL),不删频道
    this.sql.exec('UPDATE channels SET category_id = NULL WHERE category_id = ?', id);
    this.sql.exec('DELETE FROM categories WHERE id = ?', id);
    return { ok: true };
  }

  createChannel({ name, type, categoryId, password } = {}) {
    const n = String(name || '').trim().slice(0, 24);
    if (!n) return { ok: false, status: 400, error: '频道名不能为空' };
    const t = CHANNEL_TYPES.includes(type) ? type : 'voice';
    let cat = categoryId ? String(categoryId) : null;
    if (cat && !this.sql.exec('SELECT id FROM categories WHERE id = ?', cat).toArray().length) cat = null;
    const id = newId();
    const pos = this.sql.exec('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels').toArray()[0]?.p || 0;
    this.sql.exec(
      'INSERT INTO channels (id, category_id, name, type, password, position) VALUES (?, ?, ?, ?, ?, ?)',
      id, cat, n, t, String(password || '').slice(0, 64), pos,
    );
    return { ok: true, id };
  }

  updateChannel(id, { name, topic, categoryId, position, password } = {}) {
    if (!this.sql.exec('SELECT id FROM channels WHERE id = ?', id).toArray().length)
      return { ok: false, status: 404, error: '频道不存在' };
    if (name !== undefined) {
      const n = String(name).trim().slice(0, 24);
      if (!n) return { ok: false, status: 400, error: '频道名不能为空' };
      this.sql.exec('UPDATE channels SET name = ? WHERE id = ?', n, id);
    }
    if (topic !== undefined) this.sql.exec('UPDATE channels SET topic = ? WHERE id = ?', String(topic).slice(0, 120), id);
    // 空字符串 = 清除密码
    if (password !== undefined) this.sql.exec('UPDATE channels SET password = ? WHERE id = ?', String(password).slice(0, 64), id);
    if (categoryId !== undefined) {
      let cat = categoryId ? String(categoryId) : null;
      if (cat && !this.sql.exec('SELECT id FROM categories WHERE id = ?', cat).toArray().length) cat = null;
      this.sql.exec('UPDATE channels SET category_id = ? WHERE id = ?', cat, id);
    }
    if (position !== undefined) this.sql.exec('UPDATE channels SET position = ? WHERE id = ?', Number(position) | 0, id);
    return { ok: true };
  }

  deleteChannel(id) {
    this.sql.exec('DELETE FROM channels WHERE id = ?', id);
    return { ok: true };
  }

  setMemberRole(username, role) {
    if (!ASSIGNABLE_ROLES.includes(role)) return { ok: false, status: 400, error: '角色只能是 admin 或 member' };
    if (this.roleOf(username) === 'owner') return { ok: false, status: 400, error: '不能修改所有者的角色' };
    this.sql.exec(
      'INSERT INTO members (username, role) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET role = ?',
      username,
      role,
      role,
    );
    return { ok: true };
  }
}

// ---------- 房间信令:每个房间一个 Durable Object 实例 ----------

export class Room {
  constructor(state) {
    this.state = state;
    // 心跳:客户端每 ~10s 发 {type:'ping'},在 webSocketMessage 里刷新该连接的 lastSeen;
    // 定时 alarm 找出很久没 ping 的连接 = 已掉线(突然断网不会发关闭帧),清掉并广播离开。
  }

  // 首次有人连入时起定时器;之后每次 alarm 里按需续期
  async ensureAlarm() {
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + 10000);
    }
  }

  // 定时清理:超过 35s(约 3 个心跳)没 ping 的连接判为掉线,广播其离开并关闭
  async alarm() {
    const now = Date.now();
    const STALE_MS = 25000;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      const last = Math.max(a.lastSeen || 0, a.joinedAt || 0);
      if (now - last > STALE_MS) {
        if (a.id) this.broadcast({ type: 'peer-left', id: a.id }, ws);
        try {
          ws.close(1001, 'timeout');
        } catch {}
      }
    }
    if (this.state.getWebSockets().length) await this.state.storage.setAlarm(now + 10000);
  }

  async fetch(request) {
    // 非 WebSocket 请求 = 内部人数查询(/api/presence)
    if (request.headers.get('Upgrade') !== 'websocket') {
      return Response.json({ count: this.roster().length });
    }
    const peers = this.state.getWebSockets();
    if (peers.length >= MAX_PEERS) {
      return new Response('room full', { status: 409 });
    }
    // 可信昵称/账号/权限由 Worker 鉴权后注入,客户端无法伪造
    const nick = decodeURIComponent(request.headers.get('X-SP-Nick') || '') || '玩家';
    const user = request.headers.get('X-SP-User') || '';
    const canShare = request.headers.get('X-SP-Share') === '1';
    const pair = new WebSocketPair();
    // Hibernation API:空闲时 DO 休眠,不消耗运行时配额
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ nick, user, canShare, joinedAt: Date.now() });
    await this.ensureAlarm();
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
      case 'ping': {
        // 心跳:刷新存活时间戳(掉线检测靠它)
        const me = ws.deserializeAttachment();
        if (me) {
          me.lastSeen = Date.now();
          ws.serializeAttachment(me);
        }
        break;
      }

      case 'join': {
        const att = ws.deserializeAttachment() || {};
        const id = crypto.randomUUID().slice(0, 8);
        const name = att.nick || '玩家'; // 用服务端可信昵称,忽略 msg.name

        // 一账号一席:快速切频道时旧连接可能还没走完关闭握手(或同账号多开),
        // 会在成员列表里留下"分身"。踢掉旧连接并广播其离开。
        const kicked = new Set();
        for (const s of this.state.getWebSockets()) {
          if (s === ws) continue;
          const a = s.deserializeAttachment();
          if (a && a.id && a.user && a.user === att.user) {
            kicked.add(a.id);
            this.broadcast({ type: 'peer-left', id: a.id }, s);
            try {
              s.close(1000, 'replaced');
            } catch {}
          }
        }

        ws.serializeAttachment({ id, name, user: att.user, canShare: !!att.canShare, sharing: false, camera: false, joinedAt: att.joinedAt || Date.now(), lastSeen: Date.now() });

        // 告知新人:自己的 id + 房间里已有哪些人(新人将向他们逐一发起连接)
        const others = this.roster().filter((p) => p.id !== id && !kicked.has(p.id));
        ws.send(JSON.stringify({ type: 'welcome', id, peers: others }));

        this.broadcast({ type: 'peer-joined', peer: { id, name, sharing: false, camera: false } }, ws);
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
        // 共享屏幕/摄像头状态,广播给全房间;无共享权限的账号一律压成 false
        const me = ws.deserializeAttachment();
        if (!me || !me.id) return;
        if ('sharing' in msg) me.sharing = !!msg.sharing && !!me.canShare;
        if ('camera' in msg) me.camera = !!msg.camera && !!me.canShare;
        ws.serializeAttachment(me);
        this.broadcast(
          { type: 'peer-state', id: me.id, sharing: me.sharing, camera: !!me.camera },
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
      .filter((a) => a && a.id)
      .map((a) => ({ id: a.id, name: a.name, sharing: !!a.sharing, camera: !!a.camera }));
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
