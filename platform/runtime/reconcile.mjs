#!/usr/bin/env node
// 启动对账：把镜像里的只读种子（出厂基线）同步到卷上的组件目录。
//
// 与主工作台（pi-web fork）同一份实现：omp 的 agent 目录（~/.omp/agent）同样
// 由卷覆盖基线，运行期会往这里写 sessions/、agent.db、models.db、models.json，
// 那些都不是基线，回滚镜像不回滚它们。
//
// 规则（modelman 仓库 docs/platform.md 的 P1 / P7，omp 实例见 docs/omp-instance.md）：
//   卷上没有              → 复制
//   卷上有且 == 上次基线   → 覆盖为新基线（说明没被人改过）
//   卷上有且 != 上次基线   → 保留本地版，记一条 conflict（不静默覆盖）
//
// manifest 记的是"上次基线哈希"，不是文件时间：时间戳在镜像重建、卷迁移、
// 时间跳变下都不可靠。对账只增不删——卷上多出来的东西是用户的能力与包。
//
// npm/ 这类安装树按**目录**整体对账：它内部有 npm 自己造的符号链接（.bin），
// 逐文件比对既没意义又会被链接卡住；它"有没有被本地改过"用 lockfile 签名判断。

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SEED = resolve(process.env.SEED_DIR || "/opt/agent-seed/agent-home");
const TARGET = resolve(process.env.PI_CODING_AGENT_DIR || "/data/agent-home");
const OVERRIDES = resolve(process.env.OVERRIDES_DIR || "/data/overrides");
const MANIFEST = join(OVERRIDES, "baseline-manifest.json");
const CONFLICTS = join(OVERRIDES, "conflicts.json");

// 按目录整体对账的子树（内部有 npm 自己的相对符号链接，逐文件比对没意义）
const SUBTREES = ["npm"];
// 判断子树有没有被本地改过：这两个是 npm 自己的账本，装一个包就会变
const SUBTREE_LEDGERS = ["package.json", "package-lock.json"];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function subtreeSignature(dir) {
  const parts = [];
  for (const ledger of SUBTREE_LEDGERS) {
    const file = join(dir, ledger);
    parts.push(`${ledger}=${existsSync(file) ? sha256(file) : "-"}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function listFiles(root, skip = new Set()) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(full)) continue;
        walk(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // 我们自己放进种子的内容不该有符号链接（镜像里会断）；npm 那棵树已按目录跳过。
        throw new Error(`种子里有符号链接：${full}`);
      }
      if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  return files;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function reconcile() {
  if (!existsSync(SEED)) {
    throw new Error(`种子目录不存在：${SEED}`);
  }

  const previous = readJson(MANIFEST, { version: 1, files: {} });
  const knownBaseline = previous.files ?? {};
  const next = { version: 1, files: {} };
  const conflicts = [];
  const summary = {
    seed: SEED,
    target: TARGET,
    initialized: !existsSync(TARGET),
    copied: 0,
    updated: 0,
    kept: 0,
    unchanged: 0,
  };

  mkdirSync(TARGET, { recursive: true });
  mkdirSync(OVERRIDES, { recursive: true });

  const subtrees = SUBTREES.filter((name) => existsSync(join(SEED, name)));
  const skip = new Set(subtrees.map((name) => join(SEED, name)));

  for (const name of subtrees) {
    const seedDir = join(SEED, name);
    const destDir = join(TARGET, name);
    const signature = subtreeSignature(seedDir);
    // 保留 npm 自己造的相对链接
    const copy = () =>
      cpSync(seedDir, destDir, { recursive: true, verbatimSymlinks: true });

    if (!existsSync(destDir)) {
      copy();
      next.files[name] = { baseline: signature };
      summary.copied += 1;
      continue;
    }

    const destSignature = subtreeSignature(destDir);
    const previousBaseline = knownBaseline[name]?.baseline;

    if (destSignature === signature) {
      next.files[name] = { baseline: signature };
      summary.unchanged += 1;
      continue;
    }

    if (previousBaseline !== undefined && destSignature === previousBaseline) {
      rmSync(destDir, { recursive: true, force: true });
      copy();
      next.files[name] = { baseline: signature };
      summary.updated += 1;
      continue;
    }

    next.files[name] = { baseline: signature };
    conflicts.push({
      path: name,
      reason: previousBaseline === undefined ? "unmanaged-local" : "local-modified",
    });
    summary.kept += 1;
  }

  for (const file of listFiles(SEED, skip)) {
    const rel = relative(SEED, file).split(sep).join("/");
    const dest = join(TARGET, rel);
    const seedHash = sha256(file);

    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(file, dest);
      next.files[rel] = { baseline: seedHash };
      summary.copied += 1;
      continue;
    }

    const destHash = sha256(dest);
    const previousBaseline = knownBaseline[rel]?.baseline;

    if (destHash === seedHash) {
      next.files[rel] = { baseline: seedHash };
      summary.unchanged += 1;
      continue;
    }

    if (previousBaseline !== undefined && destHash === previousBaseline) {
      // 没被人改过：安全地升到新基线
      cpSync(file, dest);
      next.files[rel] = { baseline: seedHash };
      summary.updated += 1;
      continue;
    }

    // 被本地改过（或卷上有同名文件但从来没被对账管过）：留本地版，只记冲突
    next.files[rel] = { baseline: seedHash };
    conflicts.push({
      path: rel,
      reason:
        previousBaseline === undefined ? "unmanaged-local" : "local-modified",
    });
    summary.kept += 1;
  }

  writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  writeFileSync(CONFLICTS, `${JSON.stringify(conflicts, null, 2)}\n`, "utf8");

  return { ...summary, conflicts };
}

if (process.argv[1] && process.argv[1].endsWith("reconcile.mjs")) {
  const result = reconcile();
  console.log(`[reconcile] ${JSON.stringify(result)}`);
  if (result.conflicts.length > 0) {
    console.warn(
      `[reconcile] ${result.conflicts.length} 个文件被本地改过，已保留本地版：${result.conflicts
        .map((conflict) => conflict.path)
        .join(", ")}`,
    );
  }
}
