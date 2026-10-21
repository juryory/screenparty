#!/usr/bin/env bash
# ScreenParty 服务器端一键安装(Docker 版 coturn + party 管理命令)
#
#   curl -fsSL https://cdn.jsdelivr.net/gh/juryory/screenparty@main/deploy/install.sh | sudo bash
#
# 可选环境变量:
#   PARTY_DIR        部署目录,默认 /opt/screenparty
#   SCREENPARTY_REF  拉取的分支 / tag / commit,默认 main(jsDelivr 对 @main 有缓存,急用可换 commit 短哈希)
#   SCREENPARTY_SRC  本地仓库路径:从本地复制文件而不下载(离线 / 测试用)
#   TURN_PUBLIC_IP / TURN_PRIVATE_IP / TURN_SECRET / TURN_CERT_DIR
#                    无人值守安装时预填 party init 的答案(注意 sudo 会清环境变量,写在 sudo 之后:
#                    curl … | sudo TURN_PUBLIC_IP=1.2.3.4 bash)
#
# 重复运行是安全的:只更新部署文件,不覆盖已有的 .env 配置。

set -euo pipefail

DIR=${PARTY_DIR:-/opt/screenparty}
REF=${SCREENPARTY_REF:-main}
BASE="https://cdn.jsdelivr.net/gh/juryory/screenparty@$REF"
SRC=${SCREENPARTY_SRC:-}

if [ "$(id -u)" -ne 0 ]; then
  echo "✗ 请用 root 运行(在命令前加 sudo)" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'EOF'
✗ 未安装 Docker。可任选其一安装后重新运行本脚本:
  · 宝塔面板 → Docker → 安装
  · 官方脚本(国内用阿里云源):curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun
EOF
  exit 1
fi
if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  echo "✗ 缺少 docker compose 插件:apt install -y docker-compose-plugin(或在宝塔 Docker 里安装)" >&2
  exit 1
fi

# 取一个文件:本地仓库优先,否则从 jsDelivr 下载
fetch() { # fetch <仓库内路径> <目标路径>
  if [ -n "$SRC" ]; then
    cp "$SRC/$1" "$2"
  else
    curl -fsSL "$BASE/$1" -o "$2"
  fi
}

echo "→ 安装到 $DIR"
mkdir -p "$DIR/coturn" "$DIR/certs"
fetch deploy/docker-compose.yml "$DIR/docker-compose.yml"
fetch deploy/.env.example "$DIR/.env.example"
fetch deploy/coturn/entrypoint.sh "$DIR/coturn/entrypoint.sh"
fetch scripts/party /usr/local/bin/party
chmod 0755 /usr/local/bin/party "$DIR/coturn/entrypoint.sh"
# 自定义部署目录写进 party 的默认值,之后直接敲 party 就能找到
sed -i "s|^DIR=\${PARTY_DIR:-/opt/screenparty}|DIR=\${PARTY_DIR:-$DIR}|" /usr/local/bin/party
echo "✓ 部署文件与 party 命令已就位"

export PARTY_DIR="$DIR"
# 管道安装(curl | bash)时 stdin 不是终端,init 会用默认值;从 /dev/tty 读才能交互
if [ -t 0 ]; then
  party init
elif (exec </dev/tty) 2>/dev/null; then
  party init </dev/tty
else
  party init # 无终端:全用默认值 / 环境变量(见 party init)
fi

echo
echo "→ 拉取镜像并启动(Docker Hub 拉不动时,编辑 $DIR/.env 的 TURN_IMAGE 换镜像地址后 party start)"
party start
echo
party status
