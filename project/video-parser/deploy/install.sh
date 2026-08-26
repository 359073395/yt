#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/359073395/yt.git"
DOMAIN=""
INSTALL_DIR="/opt/video-parser"
PUBLIC_PORT="8080"
PORT_WAS_SET=0
IMAGE="ghcr.io/359073395/video-parser:latest"

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

FIRST_INSTALL=0
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --prune origin
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]] && [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "安装目录已存在且不是 Git 仓库，请人工确认: $INSTALL_DIR"
  exit 1
else
  FIRST_INSTALL=1
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
set_env APP_VERSION "2.0.2"

GENERATED_PASSWORD=""
if [[ "$(env_value AUTH_SECRET)" == "change-this-auth-secret" || -z "$(env_value AUTH_SECRET)" ]]; then
  set_env AUTH_SECRET "$(random_secret)"
fi
if [[ "$(env_value ADMIN_PASSWORD)" == "change-this-admin-password" || "$(env_value ADMIN_PASSWORD)" == "lhw111111" || -z "$(env_value ADMIN_PASSWORD)" ]]; then
  GENERATED_PASSWORD="YL-$(random_secret | cut -c1-20)"
  set_env ADMIN_PASSWORD "$GENERATED_PASSWORD"
fi
chmod 600 .env

OLD_IMAGE=""
if docker inspect video-parser >/dev/null 2>&1; then
  OLD_IMAGE="$(docker inspect --format '{{.Image}}' video-parser 2>/dev/null || true)"
  if [[ -n "$OLD_IMAGE" ]]; then
    docker image tag "$OLD_IMAGE" video-parser:rollback >/dev/null 2>&1 || true
  fi
fi

echo "正在获取影链工坊 2.0 镜像..."
if VIDEO_PARSER_IMAGE="$IMAGE" docker compose pull video-parser; then
  VIDEO_PARSER_IMAGE="$IMAGE" docker compose up -d --remove-orphans --force-recreate
else
  echo "预构建镜像暂不可用，改用本机源码构建。"
  VIDEO_PARSER_IMAGE="video-parser:local" docker compose -f docker-compose.yml -f docker-compose.build.yml build --pull --no-cache video-parser
  VIDEO_PARSER_IMAGE="video-parser:local" docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --remove-orphans
fi

healthy=0
for _ in $(seq 1 40); do
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' video-parser 2>/dev/null || true)"
  if [[ "$state" == "healthy" ]]; then
    healthy=1
    break
  fi
  if [[ "$state" == "unhealthy" || "$state" == "exited" ]]; then
    break
  fi
  sleep 2
done

if (( healthy == 0 )); then
  echo "新版本健康检查失败。"
  docker logs --tail 80 video-parser 2>/dev/null || true
  if [[ -n "$OLD_IMAGE" ]] && docker image inspect video-parser:rollback >/dev/null 2>&1; then
    echo "正在自动回滚上一版本..."
    VIDEO_PARSER_IMAGE="video-parser:rollback" docker compose up -d --force-recreate
  fi
  exit 1
fi

SERVER_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "影链工坊 2.0 已通过健康检查。"
echo "版本信息: http://${SERVER_IP}:${PUBLIC_PORT}/api/health"
if [[ -n "$DOMAIN" ]]; then
  echo "请把 ${DOMAIN} 反向代理到 http://127.0.0.1:${PUBLIC_PORT}"
else
  echo "访问地址: http://${SERVER_IP}:${PUBLIC_PORT}"
fi
echo "管理员账号: $(env_value ADMIN_USERNAME)"
if [[ -n "$GENERATED_PASSWORD" ]]; then
  echo "首次管理员密码: $GENERATED_PASSWORD"
  echo "请立即登录并妥善保存；配置文件位于 $APP_DIR/.env"
elif (( FIRST_INSTALL == 1 )); then
  echo "管理员密码保存在 $APP_DIR/.env"
fi
