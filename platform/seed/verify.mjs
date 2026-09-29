#!/usr/bin/env node
// 基线校验：镜像构建期与冒烟都会跑。
//
// 守三件事：
//   1. provider 形态完整（baseUrl / api 类型 / 两个模型 id 大小写正确）；
//   2. apiKey 只写环境变量名，不写字面量——仓库与镜像公开，写进去一次就是永久泄漏；
//   3. 整个目录里没有像密钥的长串（顺带拦手滑粘贴）。
//
// 只校验"是不是形态对"，不校验"密钥有没有效"——后者只能真发一次请求。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] || process.env.PI_CODING_AGENT_DIR || "/opt/agent-seed/agent-home";
const failures = [];

function read(rel) {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    failures.push(`缺少文件：${rel}`);
    return "";
  }
}

const models = read("models.yml");
const config = read("config.yml");

// ── provider 形态 ───────────────────────────────────────────────────────
if (models) {
  if (!/^\s*yun777:\s*$/m.test(models)) failures.push("models.yml 里没有 provider `yun777`");
  if (!models.includes("baseUrl: https://api.boboa.top/v1")) {
    failures.push("models.yml 的 baseUrl 不是 https://api.boboa.top/v1");
  }
  if (!models.includes("api: openai-responses")) {
    failures.push("models.yml 缺少 `api: openai-responses`（777ai 走 Responses 端点）");
  }
  for (const id of ["GLM-5.3-Flash", "glm-5.3"]) {
    if (!models.includes(`id: ${id}`)) failures.push(`models.yml 缺少模型 id：${id}（大小写敏感）`);
  }
}

// ── 密钥只引用不写值 ────────────────────────────────────────────────────
if (models) {
  const match = /^\s*apiKey:\s*(.+)$/m.exec(models);
  if (!match) {
    failures.push("models.yml 缺少 apiKey");
  } else {
    const value = match[1].trim().replace(/^["']|["']$/g, "");
    if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
      failures.push(`models.yml 的 apiKey 必须是环境变量名（形如 AGENT_PROVIDER_API_KEY），当前是：${value}`);
    }
  }
}

// ── 模型角色 ────────────────────────────────────────────────────────────
if (config) {
  if (!/modelRoles:/.test(config)) failures.push("config.yml 缺少 modelRoles");
  if (!/default:\s*["']?yun777\/GLM-5\.3-Flash["']?/.test(config)) {
    failures.push('config.yml 的默认档不是 "yun777/GLM-5.3-Flash"');
  }
  if (!/advisor:[\s\S]*enabled:\s*true/.test(config)) {
    failures.push("config.yml 没有打开 advisor");
  }
}

// ── 目录扫描：长串密钥特征 ──────────────────────────────────────────────
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{20,}/, "形如 sk-... 的密钥"],
  [/[A-Fa-f0-9]{40,}/, "长十六进制串"],
  [/eyJ[A-Za-z0-9_-]{30,}/, "JWT"],
];

function scan(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scan(full);
      continue;
    }
    const text = readFileSync(full, "utf8");
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(text)) failures.push(`${full} 里出现${label}`);
    }
  }
}
try {
  scan(root);
} catch (error) {
  failures.push(`扫描失败：${error.message}`);
}

if (failures.length > 0) {
  console.error("基线校验失败：");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`基线校验通过：${root}（provider yun777、api openai-responses、2 个模型、默认档与 advisor 已设）`);
