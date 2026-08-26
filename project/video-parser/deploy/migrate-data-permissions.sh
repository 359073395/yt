#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER_NAME="${1:-video-parser}"
IMAGE="${2:-}"

if [[ -z "$IMAGE" ]]; then
  echo "用法: $0 [容器名称] <镜像>"
  exit 2
fi

if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  exit 0
fi

DATA_MOUNT_TYPE="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
DATA_MOUNT_SOURCE="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"

if [[ -z "$DATA_MOUNT_TYPE" || -z "$DATA_MOUNT_SOURCE" ]]; then
  exit 0
fi
if [[ "$DATA_MOUNT_TYPE" != "volume" && "$DATA_MOUNT_TYPE" != "bind" ]]; then
  echo "不支持的数据挂载类型: $DATA_MOUNT_TYPE"
  exit 1
fi

echo "正在迁移旧版数据卷权限（保留下载记录与配置）..."
docker run --rm \
  --network none \
  --user 0:0 \
  --entrypoint sh \
  --mount "type=${DATA_MOUNT_TYPE},source=${DATA_MOUNT_SOURCE},target=/data" \
  "$IMAGE" \
  -c 'set -eu
      mkdir -p /data/downloads /data/cookies /data/cache
      chown -R 10001:10001 /data
      chmod u+rwx /data /data/downloads /data/cookies /data/cache'

docker run --rm \
  --network none \
  --user 10001:10001 \
  --entrypoint sh \
  --mount "type=${DATA_MOUNT_TYPE},source=${DATA_MOUNT_SOURCE},target=/data" \
  "$IMAGE" \
  -c 'set -eu
      test -w /data
      test -w /data/downloads
      test -w /data/cookies
      test -w /data/cache'

echo "旧版数据卷权限迁移完成。"
