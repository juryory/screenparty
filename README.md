# ScreenParty · 开黑同屏

多人**同时**共享屏幕 + 语音的自托管网页工具,整套跑在 Cloudflare 上,无需自己的服务器:

- 画面与语音经 **Cloudflare Realtime SFU** 转发:共享者**只上传一份**,观看人数再多也不增加上行;每个观看者按自己在看什么自动选清晰度层(主窗口原画 / 缩略图低码率)
- 每月 1000 GB 下行免费(SFU 与 TURN 共用),小圈子开黑基本用不完;信令、账号等跑在 Workers + Durable Objects 免费额度内
- **国内用户注意**:Cloudflare 节点在境外,延迟比同城 P2P 高(通常几十到一百多毫秒)。追求同城最低延迟可用 [`tencent` 分支](../../tree/tencent):P2P 直连 + 自建国内 coturn 兜底
- 账号鉴权:支持**自助注册**,**所有注册用户都能共享屏幕/摄像头**;也可**游客进入**(免注册,可观看也可共享,但收/发画质都锁在游客档码率)
- **Discord / TeamSpeak 式界面**:服务器 → 分类 → 语音频道;角色分「所有者 / 管理员 / 成员」,管理员可在网页里直接建/改/删频道、改服务器信息、管成员角色
- **屏幕 + 摄像头**可同时共享:屏幕最高 1080p30,三层 simulcast(原画 / 半分辨率 / 缩略图)由 SFU 按观看者分发;摄像头 720p 独立一路
- **共享清晰度三档**(共享者自选,默认流畅):高清 1080p/3.5M · 清晰 1080p/2.5M · 流畅 720p/1.5M;清晰/流畅/游客三档码率**管理员可在服务器设置里调**
- 可在设置里**选择麦克风/摄像头设备**,通话中热切换;用户面板下有实时**麦克风电平表**(-24 ~ 0 dB),一眼确认有没有声
- 每个画面角落实时显示 分辨率 / 帧率 / 码率,方便排查网络问题

## 一、部署(约 3 分钟)

```bash
npm install -g wrangler   # 如已安装可跳过
wrangler login            # 浏览器授权登录 Cloudflare 账号
cd screenparty
wrangler deploy
```

部署完成后输出一个 `https://screenparty.<你的子域>.workers.dev` 地址。**首次部署后还需配置 Realtime SFU(下面)和管理员账号(见第二节),否则进不了频道 / 无人能登录。**

**配置 Cloudflare Realtime SFU(必配)**:

1. Cloudflare dashboard → **Realtime** → **SFU** → 创建应用,得到 **App ID** 和 **App Secret(API Token)**
2. 写入 Worker 密钥并重新部署:
   ```bash
   wrangler secret put REALTIME_APP_ID
   wrangler secret put REALTIME_APP_SECRET
   wrangler deploy
   ```

App Secret 只存在 Worker 里:浏览器经 `/api/sfu/*` 由 Worker 代为调用 SFU API,每个会话绑定登录用户(HMAC 令牌),别人拿到会话 ID 也无法替你发布或关闭轨道。未配置时进频道会提示「服务器还没配置 Cloudflare Realtime SFU」。

> **建议绑定自定义域名**:`*.workers.dev` 在国内偶发 DNS 污染。在 Cloudflare dashboard → Workers → screenparty → Settings → Domains & Routes 添加你自己的域名(任意已托管在 Cloudflare 的域名加个子域即可)。`wrangler.jsonc` 里的 `routes` 硬编码了一个示例域名,自部署时改成你自己的或删掉该字段。

## 二、账号鉴权(必配)

进房间必须有会话:登录账号,或在登录页点「游客进入」领取 12 小时的临时游客会话。普通用户可在登录页**自助注册**,注册后即可共享屏幕/摄像头。**注意:游客入口意味着拿到网址的任何人都能进入无密码频道**,不想对外开放的频道请设置频道密码。管理员账号通过 Cloudflare Secret 注入,首次访问时自动创建。

```bash
wrangler secret put ADMIN_USERNAME   # 例如 admin,该账号同时成为服务器「所有者」
wrangler secret put ADMIN_PASSWORD   # 至少 6 位,建议用强密码
wrangler secret put ADMIN_NICKNAME   # 可选,显示的名字,缺省用用户名
wrangler deploy                       # 重新部署使其生效
```

- **本地开发**(可选,与上面互不影响):`wrangler secret put` 只作用于线上部署;本地 `npm run dev` 读不到线上 secret,需另外复制 `.dev.vars.example` 为 `.dev.vars`(已被 `.gitignore` 忽略,不会提交)填好同名变量。只部署不本地开发的话跳过这条。可选 `GUILD_NAME` 设置服务器显示名。
- **角色与权限**:`ADMIN_USERNAME` 是服务器**所有者**(唯一,可任命管理员);**管理员**能建/改/删频道分类、改服务器信息;**成员**只能进频道开黑。角色在网页左下用户面板 → 设置,或服务器名旁的 ⌄ 菜单 →「成员与角色」里管理(仅所有者可改)。
- **频道管理**:所有者/管理员在频道名上 hover 出现 `⋯`,或用服务器 ⌄ 菜单新建频道/分类、编辑、删除。可给频道**设置密码**(新建/编辑弹窗里填):成员进入时需输入密码,owner/admin 免密。频道密码只存 PBKDF2 哈希;校验通过后服务端签发 24 小时有效的通行凭证,WebSocket 连接只带凭证不带密码,改密码后旧凭证立即失效。
- **管理其他账号**:用管理员登录后,左下用户面板 → 设置齿轮 →「用户管理」进入 `/admin.html`,可**新增 / 改昵称 / 重置密码 / 启用停用 / 删除**普通用户。删除账号会同时清掉其服务器角色,之后有人注册同名账号也只是普通成员。
- **安全说明**:密码仅以 PBKDF2 加盐哈希存储(不留明文),会话走 `HttpOnly; Secure` Cookie;停用或删除用户会立即使其在线会话失效。管理员账号一旦创建,改密走管理界面,再改环境变量不会覆盖已有账号。
- **限流**:登录每 IP、每用户名每分钟各 10 次;注册 / 游客进入每 IP 每分钟合计 5 次;频道密码尝试每人每频道每分钟 10 次。超限返回 429「操作太频繁」。阈值在 `wrangler.jsonc` 的 `ratelimits` 里改(Workers Rate Limiting,按边缘节点近似计数)。

## 三、放到 GitHub(可选,推荐)

```bash
cd screenparty
git init && git add -A && git commit -m "init"
git remote add origin git@github.com:<你的用户名>/screenparty.git
git push -u origin main
```

之后可在 Cloudflare dashboard → Workers → 创建应用时选择「Connect to Git」关联该仓库,
以后每次 push 自动部署,不再需要本地 wrangler。

## 四、TURN 兜底(可选)

浏览器默认直接用 UDP 连到 Cloudflare SFU,一般不需要 TURN。只有个别成员所在网络屏蔽 UDP(部分公司 / 校园网)连不上 SFU 时,才需要 TURN 帮他「先连 TURN,再到 SFU」。按需选一种:

**方案 A:Cloudflare Realtime TURN(推荐:和 SFU 同一张网,与 SFU 共用每月 1000 GB 免费额度)**

1. Cloudflare dashboard → Realtime → TURN → 创建 TURN key
2. 配置密钥:
   ```bash
   wrangler secret put TURN_KEY_ID
   wrangler secret put TURN_KEY_API_TOKEN
   ```
3. 重新部署。前端会自动从 `/api/turn` 拿到临时凭证,无需改代码。

**方案 B:自建 coturn(国内 VPS)—— Docker 一键部署**

> SFU 模式下 coturn 只负责把连不上 SFU 的成员先接进来,对多数人用不到。它主要服务于 [`tencent` 分支](../../tree/tencent) 的 P2P 模式,这里也能用。

> 适用:一台国内云服务器(腾讯云等,Ubuntu/Debian),已装 Docker(宝塔 → Docker 一键装,或 `curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun`)。宝塔可选(看负载、放行端口、申请 TLS 证书)。前端会自动从 `/api/turn` 拿到**临时凭证**(`use-auth-secret` 的 HMAC 签名,会过期,抓包也无法长期盗用你的中继带宽)。全程约 5 分钟。
>
> 部署内容都在 [`deploy/`](deploy/):官方 `coturn/coturn` 镜像 + 启动时按 `.env` 生成配置(含完整的内网黑名单、中继地址固定在主网卡),**host 网络**运行(大段 UDP 中继端口不走 Docker 端口映射),coturn 启动后自动降权到 `nobody`。以后上 SFU 也会加在同一个 compose 里。

**第 1 步 · 一键安装**(在服务器上执行)
```bash
# 用 jsDelivr CDN(国内可达;raw.githubusercontent.com 在国内常连不上)
curl -fsSL https://cdn.jsdelivr.net/gh/juryory/screenparty@main/deploy/install.sh | sudo bash
```
脚本会:把部署文件放到 `/opt/screenparty`、安装 `party` 管理命令、运行 `party init` 交互填写(公网 IP 必填;内网 IP 自动探测;密钥自动生成;TLS 证书目录可留空),然后拉镜像启动。重复运行安全,不会覆盖已有 `.env`。

- **从旧版裸装 coturn 迁移**:`party init` 会自动读取 `/etc/turnserver.conf` 里的密钥和 IP 沿用(**Worker 的 secret 不用改**),并提示停止、禁用系统里的 coturn 服务以免端口冲突
- **Docker Hub 拉不动**(国内常见):编辑 `/opt/screenparty/.env` 的 `TURN_IMAGE`,换成镜像加速地址(如 `docker.m.daocloud.io/coturn/coturn:4.6.3`)或你自己同步到腾讯云 TCR 的地址,再 `sudo party start`
- jsDelivr 对 `@main` 有缓存(更新后可能延迟几小时);想立刻拿最新版,把 `@main` 换成 commit 短哈希

**第 2 步 · 放行端口(两层都要,少一层就连不上)**
- **腾讯云控制台 → 安全组 → 入站规则**:
  - `3478` TCP + UDP —— STUN/TURN
  - `49160-49400` UDP —— 中继端口段(开了「强制中继」时每对连接都占端口,范围别太小)
  - (配 TLS 才需要)`5349` TCP + UDP
- **宝塔面板 → 安全 → 防火墙**:放行同样端口,**务必勾选 UDP**(宝塔默认常只放 TCP,漏了 UDP 会连不上)

**第 3 步 · 接进 Worker**(在你本地电脑的本仓库目录执行,不是在 VPS 上)

服务器上 `sudo party worker` 会列出要填的值:
```bash
wrangler secret put COTURN_HOST       # 公网 IP 或你的域名,不带端口
wrangler secret put COTURN_SECRET     # party worker 显示的密钥
wrangler deploy                        # 重新部署使其生效
```

**第 4 步 · 验证**
- `sudo party status` 应显示「● coturn 运行中」、监听 3478
- 打开 `https://你的部署地址/api/turn`,看到 `turn:...` 且带 `username`/`credential` → 接入成功
- 想确认真能中继:用 [Trickle ICE 测试页](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) 填 `turn:你的公网IP:3478?transport=udp` + 上面的 `username`/`credential`,点 **Gather candidates**,出现 `relay` 类型候选 = 中继链路已通

**`party` 管理命令**(像宝塔的 bt 一样管服务;需 root,非 root 自动 sudo)

| 命令 | 作用 |
|------|------|
| `party` | **交互菜单**:输数字选操作,像宝塔那样 |
| `party status` | 看状态:运行/停止、开机自启、external-ip、监听端口、活跃连接数 |
| `party start` / `stop` / `restart` | 启动 / 关闭 / 重启(改完 `.env` 用 `restart` 生效) |
| `party on` / `off` | 开机自启 开 / 关 |
| `party log` | 实时日志(排查问题) |
| `party conf` | 查看当前生效的 coturn 配置(密钥隐藏) |
| `party init` | 重新配置(换公网 IP、加证书等) |
| `party update` | 拉取最新镜像并重建容器 |
| `party worker` | 显示 Worker 需要配置的 secret 值 |

配置都在 `/opt/screenparty/.env`(说明见 [`deploy/.env.example`](deploy/.env.example)),改完 `sudo party restart`。

**(进阶 · 可选)开启 TLS —— 让 `turns://` 穿透只放行 443/加密流量的严格网络**

需要一个域名(如 `turn.你的域名`)解析到这台服务器:

1. 宝塔 → 网站 → 为 `turn.你的域名` 申请 Let's Encrypt 证书
2. `sudo party init`,证书目录填 `/www/server/panel/vhost/cert/turn.你的域名`(目录里需有 `fullchain.pem` 和 `privkey.pem`),端口默认 **5349**(别用 443,被宝塔的网站占着)
3. `sudo party restart`,日志里会出现「TLS 已启用」;然后在本地仓库目录执行 `wrangler secret put COTURN_TLS_HOST`(填 `turn.你的域名`),再 `wrangler deploy`
4. 证书续签后执行一次 `sudo party restart` 才会加载新证书(可在宝塔计划任务里每月跑一次)

**(可选)中继模式**:服务器 ⌄ 菜单 →「服务器设置」→「TURN 中继」三选一,每个人下次进频道时生效:
- **自动**(默认):直连 SFU,直连不上时自动经 TURN
- **强制经 TURN 中继**:所有人先经 TURN 再到 SFU,画面角标显示「SFU·TURN中继」。多一跳、占 TURN 流量,只在直连 SFU 线路差时用
- **不用 TURN**:只直连 SFU;屏蔽 UDP 的成员可能连不上

画面角标显示的是**你到 Cloudflare SFU 这条连接**:「SFU·IPv4」/「SFU·IPv6」/「SFU·TURN中继」。未配置 TURN(`COTURN_*` / `TURN_KEY_*`)时「强制」不可选。

## 五、带宽与费用

共享者把屏幕编成三层同时上传给 SFU,**与观看人数无关**:

| 档位 | 原画层 f | 半分辨率层 h | 缩略图层 q | 共享者上行合计 |
|------|---------|-------------|-----------|--------------|
| 高清 | 1080p · 3.5 Mbps | 540p · ≤游客档码率 | 360p · 0.3 Mbps | 约 4.6 Mbps |
| 流畅(默认) | 1080p · 1.5 Mbps | 540p · ≤游客档码率 | 360p · 0.3 Mbps | 约 2.6 Mbps |

观看者下行 = 自己正在看的那些层之和:主窗口一路原画 + 其余缩略图各 0.3 Mbps。

**Cloudflare 费用**:只按 SFU 发给观看者的流量计费,每月前 1000 GB 免费(与 TURN 共用),超出 $0.05/GB。例:3 人、1 人以 3.5 Mbps 共享、每天 3.5 小时 → 约 330 GB/月,免费。

房间人数上限在 `src/index.js` 的 `MAX_PEERS` 中设置(默认 12)。

## 使用提示

- 共享时在浏览器弹窗中勾选「同时共享系统音频」(整屏)或「共享标签页音频」,朋友就能听到你的游戏声
- **演讲者视图**:主画面放大显示当前聚焦的一路,右侧胶片栏是其他成员;**单击右侧任意画面/头像 = 切到主画面**,双击 = 全屏
- **省带宽**:只有你放在主画面的那一路收原画层,右侧缩略图自动只收 ~300kbps 的缩略图层,游客观看收半分辨率层。看谁就给谁要高清,不看的自动省流量——由 SFU 按观看者选层,共享者不用为每个人单独编码。画面角标里的 [原画] / [缩略] 显示当前收的是哪一层
- 游戏建议使用「无边框窗口」模式,方便被浏览器捕获
- 浏览器要求:共享用 Chrome / Edge 桌面版;观看各主流浏览器均可(含 iOS Safari)

## 架构

```
浏览器 ──(WSS 信令)──► Cloudflare Worker ──► Durable Object
   │                       │                ├─ Room(每频道一个:成员进出、各人发布了哪些轨道)
   │                       │                ├─ Auth(单例:账号 / 会话)
   │                       │                └─ Guild(单例:服务器 / 分类 / 频道 / 角色)
   │                       └─(/api/sfu/*,持 App Secret)──► Realtime SFU API
   │
   ├──(上行 PeerConnection:麦克风 / 屏幕三层 / 摄像头)──► Cloudflare Realtime SFU
   └──(下行 PeerConnection:按需订阅别人的轨道)◄────────── Cloudflare Realtime SFU
```

每人两条连接:上行只发、下行只收;同一条连接上的 SFU 操作串行执行(上一轮 SDP 交换完成才开始下一轮)。

全部 Durable Object 均为 SQLite 存储,Workers 免费计划即可运行。

## 许可证

[MIT](./LICENSE) © juryory
