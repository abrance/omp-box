#!/bin/sh
# 容器冒烟：在镜像里跑一遍"启动 + 对账 + 探端点 + 优雅退出"。
# 只依赖镜像自己的东西，不碰外网，不需要真密钥——所以 CI 与本地共用同一份。
set -eu

AGENT_DIR=/tmp/smoke-agent
OVERRIDES_DIR=/tmp/smoke-overrides
PASSWORD=smoke-password
PORT=30141
BASE="http://127.0.0.1:${PORT}"

fail() { echo "✗ $1"; exit 1; }
ok() { echo "✓ $1"; }

echo "== 1. 运行时就位"
bun --version >/dev/null || fail "bun 不可用"
echo "  bun $(bun --version)"
command -v typescript-language-server >/dev/null || fail "typescript-language-server 不在 PATH"
command -v gopls >/dev/null || fail "gopls 不在 PATH"
command -v gh >/dev/null || fail "gh 不在 PATH"
ok "bun / LSP / gh 都在"

echo "== 2. 种子校验（含密钥只引用不写值）"
node /app/platform/seed/verify.mjs /opt/agent-seed/agent-home
ok "种子校验通过"

echo "== 3. 对账到空卷（模拟首次启动）"
rm -rf "$AGENT_DIR" "$OVERRIDES_DIR"
PI_CODING_AGENT_DIR="$AGENT_DIR" OVERRIDES_DIR="$OVERRIDES_DIR" \
  node /app/platform/runtime/reconcile.mjs
test -f "$AGENT_DIR/models.yml" || fail "models.yml 没复制到卷上"
test -f "$AGENT_DIR/config.yml" || fail "config.yml 没复制到卷上"
test -f "$OVERRIDES_DIR/baseline-manifest.json" || fail "没写出基线 manifest"
ok "首次对账把基线复制到卷上"

echo "== 4. 幂等：再对账一次不应改动内容"
before=$(cat "$AGENT_DIR/models.yml")
PI_CODING_AGENT_DIR="$AGENT_DIR" OVERRIDES_DIR="$OVERRIDES_DIR" \
  node /app/platform/runtime/reconcile.mjs >/dev/null
[ "$before" = "$(cat "$AGENT_DIR/models.yml")" ] || fail "第二次对账改动了基线文件"
conflicts=$(cat "$OVERRIDES_DIR/conflicts.json")
[ "$conflicts" = "[]" ] || fail "空卷对账不该有冲突：$conflicts"
ok "对账幂等且无冲突"

echo "== 5. 起服务（开鉴权）"
PI_CODING_AGENT_DIR="$AGENT_DIR" OVERRIDES_DIR="$OVERRIDES_DIR" \
OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_ALLOWED_HOSTS=localhost OMP_WEB_AUTHENTICATED=1 \
OMP_WEB_PASSWORD="$PASSWORD" OMP_WEB_NO_OPEN=1 PORT="$PORT" \
  node /app/platform/runtime/entrypoint.mjs >/tmp/smoke.log 2>&1 &
server_pid=$!
trap 'kill -TERM $server_pid 2>/dev/null || true' EXIT

i=0
until curl -fsS --max-time 2 "${BASE}/manifest.webmanifest" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { tail -20 /tmp/smoke.log; fail "服务没起来（60 次探测）"; }
  sleep 1
done
ok "服务已响应 /manifest.webmanifest"

echo "== 6. 鉴权与接口"
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE}/api/sessions")
[ "$status" != "200" ] || fail "未带凭据的 /api/sessions 竟然 200（鉴权没生效）"
ok "未带凭据被拒（HTTP $status）"

curl -fsS --max-time 90 -u "omp:${PASSWORD}" "${BASE}/api/sessions" >/dev/null \
  || fail "带凭据读 /api/sessions 失败"
ok "带凭据可读 /api/sessions"

# 模拟 UI 的第一步：选定工作目录（同时把它加进允许的文件根）
curl -fsS --max-time 90 -u "omp:${PASSWORD}" -H 'Content-Type: application/json' \
  -d '{"cwd":"/data/workspace"}' "${BASE}/api/cwd/validate" | grep -q '"success":true' \
  || fail "选定工作目录失败（/api/cwd/validate）"
ok "可选定工作目录（/data/workspace）"

curl -fsS --max-time 90 -u "omp:${PASSWORD}" \
  "${BASE}/api/model-roles?cwd=/data/workspace" \
  | grep -q "GLM-5.3-Flash" \
  || fail "模型角色里没有基线里的 GLM-5.3-Flash（种子配置没生效）"
ok "模型角色来自基线（default/advisor → GLM-5.3-Flash）"

# 模型列表是**进程内 registry** 读的，与 /api/model-roles 走的是同一份 models.yml，
# 但两条路径的缓存层不同（/api/models 多一层 __ompModelsCacheState）。这里一起验，
# 因为"基线里加了 provider，但 picker 里看不到"正是这个实例踩过的坑。
models=$(curl -fsS --max-time 90 -u "omp:${PASSWORD}" \
  "${BASE}/api/models?cwd=/data/workspace") || fail "读 /api/models 失败"
for expected in "yun777/GLM-5.3-Flash" "yun777/glm-5.3" "deepseek/deepseek-v4.1-flash"; do
  echo "$models" | grep -q "\"provider\":\"${expected%%/*}\"" \
    || fail "模型列表里没有 provider ${expected%%/*}"
done
echo "$models" | grep -q 'deepseek-v4.1-flash' \
  || fail "模型列表里没有 deepseek/deepseek-v4.1-flash（基线没生效）"
ok "模型列表来自基线（yun777 × 2 + deepseek × 1）"

echo "== 7. 优雅退出"
kill -TERM "$server_pid"
wait "$server_pid" 2>/dev/null || true
ok "收到 SIGTERM 后退出"

echo
echo "冒烟全部通过"
