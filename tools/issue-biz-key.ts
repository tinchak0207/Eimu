#!/usr/bin/env -S npx tsx
//
// 从命令行签发 B 端 API 密钥。
//
// 为什么需要它：/admin 的签发界面要管理员密码，而密码只以哈希形式存在，
// 运维脚本、CI、以及「密码不在手边」的场景都用不了。这个脚本只需要
// BLOB_READ_WRITE_TOKEN，直接复用 biz-api-key-store 的同一套读写逻辑 ——
// 不另写一份 Blob 操作，免得两边的记录格式悄悄走偏。
//
// 用法：
//   npx tsx tools/issue-biz-key.ts --label "某聚合平台" --user-id 12
//   npx tsx tools/issue-biz-key.ts --label "客户A" --user-id 12 --rpm 120 --models gpt-image-2,adobe-firefly
//   npx tsx tools/issue-biz-key.ts --list
//
// 明文密钥只在这一次打印。存储里只有 sha256，丢了只能吊销重发。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

/** 从 .env.production 载入脚本需要的变量。真正的密钥不落在仓库里的其他地方。 */
function loadEnv(): void {
  const candidates = [".env.production", ".env.local"];
  for (const file of candidates) {
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const [, key, rawValue] = match;
      const value = rawValue.replace(/^"(.*)"$/, "$1");
      // 已被抹除的占位值不要覆盖真实环境变量
      if (!value || value === "[SENSITIVE]") continue;
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadEnv();

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("缺少 BLOB_READ_WRITE_TOKEN。请确认 .env.production 中该变量为真实值。");
  process.exit(1);
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  // 动态导入：必须等 loadEnv 跑完，@vercel/blob 在模块初始化时就会读 token。
  const { generateBizApiKey, normalizeBizKeyDraft } = await import("../src/lib/biz-api-keys");
  const { issueBizApiKey, listBizApiKeys } = await import("../src/lib/biz-api-key-store");
  const { SUPPORTED_IMAGE_MODEL_IDS } = await import("../src/lib/image-model-ids.js");

  if (hasFlag("list")) {
    const keys = await listBizApiKeys();
    if (!keys.length) {
      console.log("还没有签发任何 B 端密钥。");
      return;
    }
    console.log(`共 ${keys.length} 把密钥：\n`);
    for (const key of keys) {
      console.log(
        `  ${key.keyPreview}  ${key.enabled ? "启用" : "停用"}  ${key.label}\n` +
          `    计费用户 ${key.userId} · ${key.rpm} 次/分 · ` +
          `${key.allowedModels.length ? key.allowedModels.join("、") : "全部模型"}\n` +
          `    ${key.totalRequests} 次请求 · ${key.totalImages} 张 · ` +
          `${key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString("zh-CN") : "从未使用"}\n`,
      );
    }
    return;
  }

  const label = readFlag("label");
  const userId = readFlag("user-id");
  const rpm = readFlag("rpm");
  const models = readFlag("models");

  if (!label || !userId) {
    console.error(
      "用法：npx tsx tools/issue-biz-key.ts --label \"客户名\" --user-id <上游用户id> [--rpm 60] [--models a,b]\n" +
        "     npx tsx tools/issue-biz-key.ts --list",
    );
    process.exit(1);
  }

  const draft = normalizeBizKeyDraft(
    {
      label,
      userId: Number(userId),
      ...(rpm ? { rpm: Number(rpm) } : {}),
      ...(models ? { allowedModels: models.split(",").map((model) => model.trim()) } : {}),
    },
    [...SUPPORTED_IMAGE_MODEL_IDS],
  );

  if (!draft.ok) {
    console.error(`参数有误：${draft.error}`);
    process.exit(1);
  }

  const issued = await issueBizApiKey(draft.draft, generateBizApiKey());

  console.log("\n密钥已签发。明文只出现这一次，请立刻保存。\n");
  console.log("  Base URL   https://eimu.dev/v1");
  console.log(`  API Key    ${issued.key}`);
  console.log(`\n  客户       ${issued.record.label}`);
  console.log(`  计费用户   ${issued.record.userId}（消耗从该账户余额扣除，请先确认已充值）`);
  console.log(`  限流       ${issued.record.rpm} 次/分`);
  console.log(
    `  模型       ${issued.record.allowedModels.length ? issued.record.allowedModels.join("、") : "全部"}\n`,
  );
}

main().catch((error) => {
  console.error("签发失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
