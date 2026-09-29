FROM node:24-bookworm-slim

# 构建期可换 registry（CI 用默认，本地区网络受限时传镜像源）
ARG NPM_REGISTRY=https://registry.npmjs.org

# ── 系统依赖 ────────────────────────────────────────────────────────────
# git/ripgrep：agent 的日常工具；gh：仓库操作（本阶段只装工具，不配 token）；
# gopls：Go 语言服务（Debian 自带包，不必装整套 Go 工具链）
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep jq procps less gh gopls \
 && rm -rf /var/lib/apt/lists/*

# ── 语言服务（TypeScript / JavaScript）─────────────────────────────────
# omp 内置语言服务器定义，会按 cwd 的根标记自动探测；只要二进制在 PATH 上就生效，
# 所以这里只装二进制，不写 lsp 配置。
RUN npm install -g --no-fund --no-audit --registry=${NPM_REGISTRY} \
      typescript@5.9.3 \
      typescript-language-server@6.0.1 \
      @biomejs/biome@2.5.14

# ── Bun ─────────────────────────────────────────────────────────────────
# omp 的 SDK 以 TypeScript 源码发布并依赖 bun: 内置模块，omp-web 的服务端跑在 Bun 上
RUN npm install -g --no-fund --no-audit --registry=${NPM_REGISTRY} bun@1.3.14

# ── 浏览器面 ────────────────────────────────────────────────────────────
# 内含 omp 自己的 SDK（@oh-my-pi/pi-*），进程内跑 agent；不装 omp 官方二进制
RUN npm install -g --no-fund --no-audit --registry=${NPM_REGISTRY} omp-web@0.4.4

# ── 出厂基线与运行时代码 ────────────────────────────────────────────────
COPY platform /app/platform
COPY platform/seed/agent-home /opt/agent-seed/agent-home

RUN node /app/platform/seed/verify.mjs /opt/agent-seed/agent-home \
 && mkdir -p /data/agent-home /data/home /data/workspace

WORKDIR /data/workspace

# agent 目录落卷；HOSTNAME 必须绑定 0.0.0.0 且白名单要包含对外域名，
# 否则非 loopback 的 Host 一律 403（见 modelman docs/omp-instance.md）。
# HOME 也指向卷：omp-web 的"默认工作目录"建在 $HOME/omp-cwd-<日期> 下，
# 留在容器可写层就会随重启丢掉。
ENV PI_CODING_AGENT_DIR=/data/agent-home \
    SEED_DIR=/opt/agent-seed/agent-home \
    HOME=/data/home \
    OMP_WEB_HOSTNAME=0.0.0.0 \
    OMP_WEB_AUTHENTICATED=1 \
    OMP_WEB_NO_OPEN=1 \
    PORT=30141

EXPOSE 30141

ENTRYPOINT ["node", "/app/platform/runtime/entrypoint.mjs"]
