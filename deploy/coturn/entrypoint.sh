#!/bin/sh
# 按 .env 生成 coturn 配置并启动(容器入口,挂载进官方 coturn 镜像使用)
set -eu

die() { echo "[screenparty-turn] $*" >&2; exit 1; }

[ -n "${TURN_PUBLIC_IP:-}" ] || die "TURN_PUBLIC_IP 未设置(运行 party init 或编辑 .env)"
[ -n "${TURN_SECRET:-}" ] || die "TURN_SECRET 未设置(运行 party init 或编辑 .env)"

# 云服务器网卡只有内网 IP、公网走 NAT:必须做 公网/内网 映射
EXTERNAL_IP="$TURN_PUBLIC_IP"
[ -n "${TURN_PRIVATE_IP:-}" ] && EXTERNAL_IP="$TURN_PUBLIC_IP/$TURN_PRIVATE_IP"
# 中继地址钉死在主网卡:host 网络下 coturn 会把 docker0(172.17.0.1)等也当中继地址,
# 分到那上面的中继候选外网根本访问不到
RELAY_IP="${TURN_PRIVATE_IP:-$TURN_PUBLIC_IP}"

CONF=/tmp/turnserver.conf
umask 077
cat > "$CONF" <<EOF
listening-port=${TURN_PORT:-3478}
external-ip=$EXTERNAL_IP
relay-ip=$RELAY_IP
min-port=${TURN_MIN_PORT:-49160}
max-port=${TURN_MAX_PORT:-49400}
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=${TURN_REALM:-$TURN_PUBLIC_IP}
fingerprint
no-cli
no-tcp-relay
log-file=stdout
simple-log
# 收敛滥用面:禁止被拿去中继内网 / 回环 / 云元数据
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
EOF

# 证书目录里有证书就开 TLS(turns://),否则显式关掉,省得 coturn 刷告警
if [ -r /certs/fullchain.pem ] && [ -r /certs/privkey.pem ]; then
  cat >> "$CONF" <<EOF
tls-listening-port=${TURN_TLS_PORT:-5349}
cert=/certs/fullchain.pem
pkey=/certs/privkey.pem
EOF
  echo "[screenparty-turn] TLS 已启用,端口 ${TURN_TLS_PORT:-5349}"
else
  printf 'no-tls\nno-dtls\n' >> "$CONF"
fi

# 以 root 启动(为读证书)时,初始化后降权到 nobody
if [ "$(id -u)" = 0 ]; then
  printf 'proc-user=nobody\nproc-group=nogroup\n' >> "$CONF"
  chown nobody:nogroup "$CONF"
fi

echo "[screenparty-turn] external-ip=$EXTERNAL_IP 监听 ${TURN_PORT:-3478} 中继 ${TURN_MIN_PORT:-49160}-${TURN_MAX_PORT:-49400}"
exec turnserver -c "$CONF"
