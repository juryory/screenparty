# ScreenParty · 开黑同屏

多人**同时**共享屏幕 + 语音的自托管网页工具。为国内网络环境设计:

- 画面与语音在成员之间 **WebRTC P2P 直连**,不经过任何服务器,走各自家宽,同城延迟通常 5–30ms
- Cloudflare 只承担信令(进房间时交换连接信息的几 KB 流量),全部落在免费额度内
- 账号鉴权:仅管理员分配的账号可登录使用,**禁止匿名与自助注册**(适合固定的开黑小圈子)
- 每路屏幕最高 1080p30,针对游戏画面优化(H.264 硬编优先、运动内容提示、保帧率降级)
- 每个画面角落实时显示 分辨率 / 帧率 / 码率,方便排查网络问题

## 一、部署(约 3 分钟)

```bash
npm install -g wrangler   # 如已安装可跳过
wrangler login            # 浏览器授权登录 Cloudflare 账号
cd screenparty
wrangler deploy
```

部署完成后输出一个 `https://screenparty.<你的子域>.workers.dev` 地址。**首次部署后还需配置管理员账号(见第二节),否则无人能登录。**

> **建议绑定自定义域名**:`*.workers.dev` 在国内偶发 DNS 污染。在 Cloudflare dashboard → Workers → screenparty → Settings → Domains & Routes 添加你自己的域名(你做投注平台用过的域名加个子域即可)。

## 二、账号鉴权(必配)

系统禁止匿名使用和自助注册:必须先有账号才能进房间。管理员账号通过 Cloudflare Secret 注入,首次访问时自动创建。

```bash
wrangler secret put ADMIN_USERNAME   # 例如 admin
wrangler secret put ADMIN_PASSWORD   # 至少 6 位,建议用强密码
wrangler secret put ADMIN_NICKNAME   # 可选,房间里显示的名字,缺省用用户名
wrangler deploy                       # 重新部署使其生效
```

- **本地开发**:把上面三项写进项目根目录的 `.dev.vars`(已被 `.gitignore` 忽略,不会提交),再 `npm run dev`。
- **管理其他用户**:用管理员登录后,点击大厅的「用户管理」进入 `/admin.html`,可**新增 / 改昵称 / 重置密码 / 启用停用 / 删除**普通用户。普通用户无管理权限,进房间的昵称由管理员设定、用户不可改。
- **安全说明**:密码仅以 PBKDF2 加盐哈希存储(不留明文),会话走 `HttpOnly; Secure` Cookie;停用或删除用户会立即使其在线会话失效。管理员账号一旦创建,改密走管理界面,再改环境变量不会覆盖已有账号。

## 三、放到 GitHub(可选,推荐)

```bash
cd screenparty
git init && git add -A && git commit -m "init"
git remote add origin git@github.com:<你的用户名>/screenparty.git
git push -u origin main
```

之后可在 Cloudflare dashboard → Workers → 创建应用时选择「Connect to Git」关联该仓库,
以后每次 push 自动部署,不再需要本地 wrangler。

## 四、TURN 兜底(可选,直连失败时再配)

先直接用:朋友之间同城/同运营商时 P2P 打洞成功率很高,大概率用不到 TURN。

如果某两人之间始终连不上(画面黑屏但其他人正常),按需选一种:

**方案 A:Cloudflare Realtime TURN(免费 1000 GB/月,但节点在境外)**

1. Cloudflare dashboard → Realtime → TURN → 创建 TURN key
2. 配置密钥:
   ```bash
   wrangler secret put TURN_KEY_ID
   wrangler secret put TURN_KEY_API_TOKEN
   ```
3. 重新部署。前端会自动从 `/api/turn` 拿到临时凭证,无需改代码。

**方案 B:国内 VPS 自建 coturn(推荐,国内节点延迟低、画质好)**

在腾讯云/阿里云轻量服务器上装 coturn,前端会自动从 `/api/turn` 拿到**临时凭证**
(基于 `use-auth-secret` 的 HMAC 签名,会过期,抓包也无法长期盗用你的中继带宽)。

1. **放行端口**(安全组 + 系统防火墙):
   - `3478` TCP/UDP —— STUN/TURN
   - `5349` TCP/UDP —— TURN over TLS(可选)
   - `49160-49200` UDP —— 中继端口段(与下方 `min-port/max-port` 一致)

2. **安装并配置 coturn**(Ubuntu/Debian):
   ```bash
   sudo apt update && sudo apt install -y coturn
   sudo sed -i 's/#TURNSERVER_ENABLED/TURNSERVER_ENABLED/' /etc/default/coturn

   SECRET=$(openssl rand -hex 32)   # 记下来,稍后要填到 Worker
   sudo tee /etc/turnserver.conf >/dev/null <<EOF
   listening-port=3478
   # 腾讯云网卡是内网 IP、公网走 NAT,必须做 公网/内网 映射:
   external-ip=<公网IP>/<内网IP>
   min-port=49160
   max-port=49200
   use-auth-secret
   static-auth-secret=$SECRET
   realm=turn.你的域名
   no-cli
   no-tcp-relay
   # 防止被人拿去中继内网/云元数据,收敛滥用面:
   no-multicast-peers
   denied-peer-ip=10.0.0.0-10.255.255.255
   denied-peer-ip=192.168.0.0-192.168.255.255
   denied-peer-ip=169.254.0.0-169.254.255.255
   EOF
   sudo systemctl enable --now coturn
   echo "静态密钥(填到 Worker 的 COTURN_SECRET):$SECRET"
   ```

3. **把服务器接进 Worker**(在本仓库目录执行):
   ```bash
   wrangler secret put COTURN_SECRET       # 粘贴上一步生成的 SECRET
   # COTURN_HOST 用域名或公网 IP,放到 wrangler.jsonc 的 vars,或也用 secret:
   echo 'COTURN_HOST=turn.你的域名' # 见下方 wrangler.jsonc 的 vars 写法
   wrangler deploy
   ```
   在 `wrangler.jsonc` 里加(不敏感,用 `vars` 即可):
   ```jsonc
   "vars": {
     "COTURN_HOST": "turn.你的域名"       // 或公网 IP,不带端口
     // 若配了 TLS 证书,再加 "COTURN_TLS_HOST": "turn.你的域名"
   }
   ```
   部署后打开 `https://你的站点/api/turn`,能看到 `turn:...` 且带 `username`/`credential`,即接入成功。

> **带宽**:每路屏幕 ~3.5 Mbps,一对中转连接在服务器上约占 **3.5 Mbps 入 + 3.5 Mbps 出**。
> 200M 峰值带宽可轻松扛住十几路中转;而且 TURN 只对**少数打洞失败的成员对**生效,绝大多数人仍是 P2P 直连,不经过这台机器。

### 怎么判断某人是不是走了 relay(以及值不值得自建 coturn)

先用免费的 Cloudflare TURN(方案 A)顶上,别急着为兜底单开机器。是否需要自建,用**数据**决定,别靠猜:

**看单次连接走没走中继** —— 画面卡的那个人,浏览器地址栏输入 `chrome://webrtc-internals`(共享/观看期间打开),找到对应的 `RTCPeerConnection` → 展开 `candidate-pair (… , succeeded)`(nominated=true 那条)→ 看两端 candidate 的 `candidateType`:

| 本地/远端候选类型 | 含义 | 是否吃 TURN 带宽 |
|------------------|------|-----------------|
| `host` / `srflx`(server-reflexive) | **P2P 直连打洞成功** | 否,不经过服务器 |
| 任意一端是 `relay` | **走 TURN 中继**了 | 是 |

也可以看画面统计:直连的 `currentRoundTripTime` 通常是本地网络的几~几十 ms;走境外 Cloudflare relay 会明显偏高(往返绕境外)。

**判断值不值得自建的标准**(满足才考虑上方案 B 自建 coturn):

- 是**固定某几个人**每次都命中 `relay`(而非偶发),说明他们之间 P2P 长期打不通;**并且**
- 这些人反映境外 relay 的延迟/卡顿实际影响了开黑体验。

只有上面两条同时成立,自建国内 coturn 才划算——把那几对人的中继路径从境外拉回国内。否则维持 Cloudflare 免费兜底即可,零运维。

## 五、带宽要求

每路屏幕限制在 3.5 Mbps。N 人房间中,**正在共享的人**上行 ≈ 3.5 × (N−1) Mbps:

| 房间人数 | 共享者上行需求 |
|---------|--------------|
| 3 人 | ~7 Mbps |
| 5 人 | ~14 Mbps |

100M 及以上家宽(上行普遍 20–40 Mbps)可以从容应对 5 人局。如有人上行偏弱,
可把 `public/app.js` 顶部的 `SCREEN_MAX_BITRATE` 调低(如 2_500_000)。

房间人数上限在 `src/index.js` 的 `MAX_PEERS` 中设置(默认 8;mesh 架构不建议超过 6 人同时共享)。

## 使用提示

- 共享时在浏览器弹窗中勾选「同时共享系统音频」(整屏)或「共享标签页音频」,朋友就能听到你的游戏声
- 单击画面 = 聚焦放大;双击 = 全屏
- 游戏建议使用「无边框窗口」模式,方便被浏览器捕获
- 浏览器要求:Chrome / Edge 桌面版(屏幕采集 + H.264 硬编支持最好)

## 架构

```
浏览器 ──(WSS 信令,仅建连时)──► Cloudflare Worker ──► Durable Object(每房间一个)
   │
   └──(音视频,持续)──► 其他成员浏览器(WebRTC P2P 直连,打洞失败走 TURN)
```
