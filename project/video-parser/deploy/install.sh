#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/359073395/yt.git"
DOMAIN=""
INSTALL_DIR="/opt/video-parser"
PUBLIC_PORT="8080"
PORT_WAS_SET=0
APP_VERSION="2.3.0"
IMAGE="ghcr.io/359073395/video-parser:${APP_VERSION}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --port) PUBLIC_PORT="${2:-}"; PORT_WAS_SET=1; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    *) echo "未知参数 / Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ "$INSTALL_DIR" != /* || "$INSTALL_DIR" == "/" || ${#INSTALL_DIR} -lt 8 ]]; then
  echo "拒绝不安全的安装目录: $INSTALL_DIR"
  exit 1
fi
if ! [[ "$PUBLIC_PORT" =~ ^[0-9]+$ ]] || (( PUBLIC_PORT < 1 || PUBLIC_PORT > 65535 )); then
  echo "端口必须是 1-65535。"
  exit 1
fi

need_cmd() { command -v "$1" >/dev/null 2>&1; }

if ! need_cmd docker; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "缺少 Docker Compose plugin。"
  exit 1
fi
if ! need_cmd git; then
  apt-get update
  apt-get install -y --no-install-recommends git ca-certificates curl
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --prune origin
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]] && [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "安装目录已存在且不是 Git 仓库，请人工确认: $INSTALL_DIR"
  exit 1
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

APP_DIR="$INSTALL_DIR/project/video-parser"
if [[ ! -d "$APP_DIR" ]]; then
  echo "仓库中没有 project/video-parser，无法继续。"
  exit 1
fi
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

env_value() {
  grep "^${1}=" .env 2>/dev/null | tail -n 1 | cut -d= -f2-
}
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
random_secret() {
  if need_cmd openssl; then
    openssl rand -hex 32
  else
    head -c 48 /dev/urandom | sha256sum | awk '{print $1}'
  fi
}

if (( PORT_WAS_SET == 0 )) && [[ -n "$(env_value PUBLIC_PORT)" ]]; then
  PUBLIC_PORT="$(env_value PUBLIC_PORT)"
fi
set_env PUBLIC_PORT "$PUBLIC_PORT"
set_env VIDEO_PARSER_IMAGE "$IMAGE"
set_env APP_HOST "0.0.0.0"
set_env APP_PORT "8080"
set_env APP_VERSION "$APP_VERSION"

if [[ "$(env_value AUTH_SECRET)" == "change-this-auth-secret" || -z "$(env_value AUTH_SECRET)" ]]; then
  set_env AUTH_SECRET "$(random_secret)"
fi
chmod 600 .env

OLD_IMAGE=""
if docker inspect video-parser >/dev/null 2>&1; then
  OLD_IMAGE="$(docker inspect --format '{{.Image}}' video-parser 2>/dev/null || true)"
  if [[ -n "$OLD_IMAGE" ]]; then
    docker image tag "$OLD_IMAGE" video-parser:rollback >/dev/null 2>&1 || true
  fi
fi

echo "正在获取影链工坊 2.3.0 镜像..."
DEPLOY_IMAGE="$IMAGE"
if VIDEO_PARSER_IMAGE="$IMAGE" docker compose pull video-parser; then
  :
else
  echo "预构建镜像暂不可用，改用本机源码构建。"
  DEPLOY_IMAGE="video-parser:local"
  VIDEO_PARSER_IMAGE="$DEPLOY_IMAGE" docker compose -f docker-compose.yml -f docker-compose.build.yml build --pull --no-cache video-parser
fi

# 1.x used root inside the container. Its persistent volume is therefore not
# writable by the unprivileged 2.x runtime until ownership is migrated once.
bash deploy/migrate-data-permissions.sh video-parser "$DEPLOY_IMAGE"

VIDEO_PARSER_IMAGE="$DEPLOY_IMAGE" docker compose up -d --remove-orphans --force-recreate

read_health() {
  local response=""
  response="$(curl -fsS --max-time 5 "http://127.0.0.1:${PUBLIC_PORT}/api/health" 2>/dev/null || true)"
  if [[ -z "$response" ]]; then
    response="$(docker exec video-parser python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=5).read().decode())" 2>/dev/null || true)"
  fi
  printf '%s' "$response"
}

healthy=0
HEALTH_JSON=""
for attempt in $(seq 1 90); do
  HEALTH_JSON="$(read_health)"
  if [[ "$HEALTH_JSON" == *"\"version\":\"${APP_VERSION}\""* ]]; then
    healthy=1
    break
  fi
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' video-parser 2>/dev/null || true)"
  if [[ "$state" == "exited" || "$state" == "dead" ]]; then
    break
  fi
  if (( attempt % 15 == 0 )); then
    echo "仍在等待服务启动... $((attempt * 2))/180 秒（容器状态: ${state:-unknown}）"
  fi
  sleep 2
done

if (( healthy == 0 )) && [[ "$(docker inspect --format '{{.State.Running}}' video-parser 2>/dev/null || true)" == "true" ]]; then
  echo "服务长时间未监听端口，正在执行一次恢复性重启..."
  docker restart video-parser >/dev/null
  for attempt in $(seq 1 60); do
    HEALTH_JSON="$(read_health)"
    if [[ "$HEALTH_JSON" == *"\"version\":\"${APP_VERSION}\""* ]]; then
      healthy=1
      break
    fi
    state="$(docker inspect --format '{{.State.Status}}' video-parser 2>/dev/null || true)"
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      break
    fi
    sleep 2
  done
fi

if (( healthy == 0 )); then
  echo "新版本健康检查失败，期望版本 ${APP_VERSION}。"
  echo "容器状态: $(docker inspect --format '{{.State.Status}} / {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' video-parser 2>/dev/null || echo unknown)"
  echo "健康接口返回: ${HEALTH_JSON:-无响应}"
  echo "Docker 健康检查记录:"
  docker inspect --format '{{range .State.Health.Log}}{{println .ExitCode .Output}}{{end}}' video-parser 2>/dev/null || true
  echo "容器日志:"
  docker logs --tail 80 video-parser 2>/dev/null || true
  echo "容器进程与资源:"
  docker top video-parser -eo pid,ppid,stat,etime,rss,vsz,args 2>/dev/null || true
  docker stats --no-stream video-parser 2>/dev/null || true
  echo "主机内存与磁盘:"
  free -m 2>/dev/null || true
  df -h "$APP_DIR" /var/lib/docker 2>/dev/null || true
  if [[ -n "$OLD_IMAGE" ]] && docker image inspect video-parser:rollback >/dev/null 2>&1; then
    echo "正在自动回滚上一版本..."
    VIDEO_PARSER_IMAGE="video-parser:rollback" docker compose up -d --force-recreate
  fi
  exit 1
fi

SERVER_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "影链工坊 2.3.0 已通过健康检查。"
echo "版本信息: http://${SERVER_IP}:${PUBLIC_PORT}/api/health"
if [[ -n "$DOMAIN" ]]; then
  echo "请把 ${DOMAIN} 反向代理到 http://127.0.0.1:${PUBLIC_PORT}"
else
  echo "访问地址: http://${SERVER_IP}:${PUBLIC_PORT}"
fi
