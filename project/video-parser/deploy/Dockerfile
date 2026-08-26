FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM denoland/deno:bin-2.9.4 AS deno-runtime

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_HOST=0.0.0.0 \
    APP_PORT=8080 \
    DOWNLOAD_DIR=/data/downloads \
    STATIC_DIR=/app/static \
    XDG_CACHE_HOME=/data/cache \
    DENO_DIR=/data/cache/deno \
    CHROMIUM_PATH=/usr/bin/chromium \
    HOME=/tmp/yinglian

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates tini chromium \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deno-runtime /deno /usr/local/bin/deno

WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=frontend /src/frontend/dist ./static
RUN groupadd --gid 10001 yinglian \
    && useradd --uid 10001 --gid yinglian --no-create-home --shell /usr/sbin/nologin yinglian \
    && mkdir -p /data/downloads /data/cookies /data/cache /tmp/yinglian \
    && chown -R yinglian:yinglian /app /data /tmp/yinglian

EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "echo 'Starting Yinglian Workshop API...' && exec uvicorn app.main:app --host ${APP_HOST} --port ${APP_PORT}"]
