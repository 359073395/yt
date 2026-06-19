#!/usr/bin/env bash
set -euo pipefail

REPO_URL=""
DOMAIN=""
INSTALL_DIR="/opt/video-parser"
PUBLIC_PORT="8080"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --port)
      PUBLIC_PORT="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$REPO_URL" ]]; then
  REPO_URL="https://github.com/359073395/yt.git"
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if ! need_cmd docker; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required but was not found after Docker installation."
  exit 1
fi

if ! need_cmd git; then
  apt-get update
  apt-get install -y git
fi

mkdir -p "$INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

APP_DIR="$INSTALL_DIR/project/video-parser"
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

sed -i "s/^PUBLIC_PORT=.*/PUBLIC_PORT=${PUBLIC_PORT}/" .env
if grep -q "^AUTH_SECRET=change-this-auth-secret" .env; then
  SECRET="$(openssl rand -hex 32 2>/dev/null || date +%s%N | sha256sum | awk '{print $1}')"
  sed -i "s/^AUTH_SECRET=.*/AUTH_SECRET=${SECRET}/" .env
fi

docker compose up -d --build

SERVER_IP="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
echo
echo "影链工坊 is running."
if [[ -n "$DOMAIN" ]]; then
  echo "Point ${DOMAIN} to this server, then configure your reverse proxy to http://127.0.0.1:${PUBLIC_PORT}."
  echo "Health: http://${DOMAIN}/api/health"
else
  echo "URL: http://${SERVER_IP}:${PUBLIC_PORT}"
  echo "Health: http://${SERVER_IP}:${PUBLIC_PORT}/api/health"
fi
