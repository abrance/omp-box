# omp-box —— omp 实例（第二个工作台）的镜像

在 cloud3 上跑一套只走浏览器的 omp 工作台，域名 `omp.xiaoyxq.top`。
设计、实测证据与取舍都在 modelman 仓库的 `docs/omp-instance.md`，这里是它的镜像实现。

## 是什么

| 项 | 取值 |
|---|---|
| 浏览器面 | npm `omp-web@0.4.4`（进程内跑 **omp 自己的 SDK** `@oh-my-pi/pi-*`，不是在浏览器里跑 pi） |
| 运行时 | Bun `1.3.14`（omp SDK 是 TypeScript 源码 + `bun:` 内置） |
| agent 目录 | `PI_CODING_AGENT_DIR=/data/agent-home`（卷），出厂基线在镜像的 `/opt/agent-seed/agent-home` |
| 对外端口 | `30141` |
| 语言服务 | TypeScript/JavaScript（`typescript-language-server` + `biome`）、Go（`gopls`）——omp 内置服务器定义会按 cwd 自动探测，无需 lsp 配置 |
| 不装 | omp 官方二进制（不需要：omp-web 不 spawn 它）、Chromium、MCP、Rust 工具链 |

## 目录

```
platform/docker/Dockerfile   镜像定义（含构建期基线校验）
platform/docker/smoke.sh     容器冒烟（对账 + 起服务 + 鉴权 + 模型角色 + 优雅退出）
platform/runtime/            entrypoint（先对账再起服务）与 reconcile（种子 → 卷）
platform/seed/               出厂基线：models.yml（provider 定义）、config.yml（模型角色与 advisor）
.github/workflows/           tag `omp/vX.Y.Z` → 构建 + 冒烟 + 推 GHCR
```

## 构建与冒烟

```bash
docker build -f platform/docker/Dockerfile -t omp-web:dev .
docker run --rm --entrypoint sh omp-web:dev /app/platform/docker/smoke.sh
```

冒烟不需要真密钥、不碰外网：它只验证对账、服务起来、鉴权生效、模型角色来自基线。
真正连通 provider 的那一步在部署后验收（见 modelman `docs/omp-instance.md` 的切片 3）。

## 密钥

`models.yml` 里 `apiKey: AGENT_PROVIDER_API_KEY` 只写**环境变量名**，值由 cops 的 Secret 注入；
入口密码走 `OMP_WEB_PASSWORD`。仓库与镜像公开，`platform/seed/verify.mjs` 会在构建期拦住字面量密钥。

## 环境变量（部署侧）

| 变量 | 作用 |
|---|---|
| `OMP_WEB_ALLOWED_HOSTS` | 必须含 `omp.xiaoyxq.top`，否则非 loopback 的 Host 一律 403 |
| `OMP_WEB_AUTHENTICATED` / `OMP_WEB_PASSWORD` | 入口密码（镜像默认已开鉴权） |
| `PI_CODING_AGENT_DIR` | 卷上的 agent 目录，镜像已设 |
| `AGENT_PROVIDER_API_KEY` | provider 密钥，只由 Secret 注入 |

## 版本

| 组件 | 版本 |
|---|---|
| omp-web | 0.4.4 |
| Bun | 1.3.14 |
| typescript / typescript-language-server / biome | 7.0.2 起按镜像内实际构建为准 |

升 omp-web 前先重跑 modelman `docs/omp-instance.md` 的实测表（数据面兼容、Host 白名单、探针端点）。
