# ScreenParty · 开黑同屏

多人**同时**共享屏幕 + 语音的自托管网页工具。为国内网络环境设计:

- 画面与语音在成员之间 **WebRTC P2P 直连**,不经过任何服务器,走各自家宽,同城延迟通常 5–30ms
- Cloudflare 只承担信令(进房间时交换连接信息的几 KB 流量),全部落在免费额度内
- 浏览器打开链接即用,无需安装、无需注册
- 每路屏幕最高 1080p30,针对游戏画面优化(H.264 硬编优先、运动内容提示、保帧率降级)
- 每个画面角落实时显示 分辨率 / 帧率 / 码率,方便排查网络问题

## 一、部署(约 3 分钟)

```bash
npm install -g wrangler   # 如已安装可跳过
wrangler login            # 浏览器授权登录 Cloudflare 账号
cd screenparty
wrangler deploy
```

部署完成后输出一个 `https://screenparty.<你的子域>.workers.dev` 地址,发给朋友即可开黑。

> **建议绑定自定义域名**:`*.workers.dev` 在国内偶发 DNS 污染。在 Cloudflare dashboard → Workers → screenparty → Settings → Domains & Routes 添加你自己的域名(你做投注平台用过的域名加个子域即可)。

## 二、放到 GitHub(可选,推荐)

```bash
cd screenparty
git init && git add -A && git commit -m "init"
git remote add origin git@github.com:<你的用户名>/screenparty.git
git push -u origin main
```

之后可在 Cloudflare dashboard → Workers → 创建应用时选择「Connect to Git」关联该仓库,
以后每次 push 自动部署,不再需要本地 wrangler。

## 三、TURN 兜底(可选,直连失败时再配)

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

**方案 B:国内 VPS 自建 coturn(约 ¥30/月,画质更好)**

在腾讯云/阿里云轻量服务器装 coturn 后,把中继地址加进 `src/index.js` 里
`turnCredentials` 返回的 `iceServers` 数组即可。

## 四、带宽要求

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
