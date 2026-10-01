# 出厂基线（omp 实例）

这个目录是 omp 实例镜像的**能力基线**：构建期校验、烘进只读种子目录 `/opt/agent-seed/agent-home`，
运行期由启动对账复制到卷上的 agent 目录（`PI_CODING_AGENT_DIR=/data/agent-home`），卷覆盖基线。

## 里面有什么

| 文件 | 内容 | 为什么 |
|---|---|---|
| `models.yml` | provider 定义：`yun777`（`https://api.boboa.top/v1`）与 `deepseek`（`https://new.9-u.cn/v1`），两者都走 `api: openai-responses`；共 3 个模型 id | omp 读 `models.yml`；写在这里才不用进容器手配 |
| `config.yml` | 模型角色：`default` 与 `advisor` 都指向 `yun777/GLM-5.3-Flash`，并打开 advisor | 默认档最省，与主工作台习惯一致 |

## 密钥只引用不写值

`models.yml` 里 `apiKey: AGENT_PROVIDER_API_KEY` 是**环境变量名**：omp 先看同名环境变量，没有才当字面量。
仓库与镜像都是公开的，所以 `verify.mjs` 会拦住字面量密钥——写进去一次就是永久泄漏。

两个 provider 共用同一个变量名：值由 cops 的 Secret 注入，轮换密钥只需换 Secret，不动基线。

## 改基线前先改校验表

`verify.mjs` 顶部有一张 `EXPECTED_PROVIDERS` 期望表（provider 名 / baseUrl / 模型 id）。
加 provider 或加模型时**两边都要改**：只改 `models.yml` 会在构建期校验失败，镜像根本出不来。
期望值写死在表里而不是解析 YAML，是为了让校验拦住"YAML 还能解析但内容被改坏"的情况。

## 模型名大小写敏感

`GLM-5.3-Flash`、`glm-5.3`、`deepseek-v4.1-flash` 都是从各自 `/v1/models` 实测拿到的 id，不要凭印象改。
`contextWindow`/`maxTokens` 由 omp 目录按 id 解析（`GLM-5.3-Flash` 实测 1M 上下文 / 131K 输出）。

## 不进基线的东西

omp 运行期会在同一个目录写 `sessions/`、`agent.db`（SQLite 凭据）、`models.db`、`models.json`
（omp-web 同步给 SDK 的产物）。这些都**不属于镜像**，回滚镜像不会回滚它们。

## 校验

```bash
node platform/seed/verify.mjs platform/seed/agent-home          # 校验种子目录
PI_CODING_AGENT_DIR=/data/agent-home node platform/seed/verify.mjs   # 校验运行期 agent 目录
```

校验三件事：provider 形态与模型 id 完整、`apiKey` 只是引用、没有字面量密钥。
镜像冒烟里跑一次，改基线不跑校验就会在构建期失败。

注意运行期那一版会**额外**扫出卷上的 `models.json`（omp-web 同步给 SDK 的产物）。
它里面存的是**解析后**的密钥（如果基线用了字面量），所以那条命令本来就会报密钥特征——
它只在手工排查时用，不在 CI 里跑。
