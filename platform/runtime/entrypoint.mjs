#!/usr/bin/env node
// 容器入口：先对账（种子 → 卷），再起 omp-web。
//
// 与主工作台的入口同一形状：对账失败不静默放过（卷上少了基线配置，跑起来就是
// 一个"没配好 provider"的工作台，比启动失败更难查），所以对账抛错即退出非零。
//
// omp-web 是唯一对外进程；信号转发给它，避免 k8s 发 SIGTERM 时留下孤儿。

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const reconcile = spawnSync(process.execPath, [join(here, "reconcile.mjs")], {
  stdio: "inherit",
  env: process.env,
});
if (reconcile.status !== 0) {
  console.error(`[entrypoint] 启动对账失败（退出码 ${reconcile.status}），不启动服务`);
  process.exit(reconcile.status ?? 1);
}

// 只认 env：主机名白名单、绑定地址、端口、鉴权都由部署侧给，入口不写死对外形态
const port = process.env.PORT || "30141";
const hostname = process.env.OMP_WEB_HOSTNAME || "0.0.0.0";

const child = spawn("omp-web", ["--port", port, "--hostname", hostname, "--no-open"], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    console.log(`[entrypoint] omp-web 被信号 ${signal} 结束`);
    process.exit(0);
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`[entrypoint] 起不来 omp-web：${error.message}`);
  process.exit(1);
});
