#!/usr/bin/env -S npx tsx
//
// 在上游 New API 里开一个专用 B 端计费账户，并给它初始额度。
//
// 为什么要专用账户：B 端客户跑量与自用额度隔离，对账清楚，
// 客户把量跑上来也不会吃掉自己做图的余额。
//
// 用法：
//   npx tsx tools/provision-biz-account.ts --username biz-aggregator --images 10000
//   npx tsx tools/provision-biz-account.ts --find biz-aggregator     # 只查，不建
//
// 需要 .env.production.local 里的 GATEWAY_BASE_URL / GATEWAY_ADMIN_ACCESS_TOKEN /
// GATEWAY_ADMIN_USER_ID（用 `npx vercel env pull .env.production.local
// --environment=production` 拉取）。
//
// 调用格式与 image-billing.ts 的 adjustImageQuota / fetchManagedImageUser 完全一致，
// 不另发明一套，避免和生产扣费路径产生差异。

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const root = process.cwd();

/** 1 张图 = 500000 配额单位，与 quota-constants.ts 及上游 quota_per_unit 一致。 */
const QUOTA_PER_COIN = 500_000;

function loadEnv(): void {
  // production.local 优先：它才有真值，仓库里的 .env.production 已被抹除。
  for (const file of [".env.production.local", ".env.production"]) {
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
      const value = rawValue.replace(/^"(.*)"$/, "$1").trim();
      if (!value || value === "[SENSITIVE]") continue;
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadEnv();

function required(name: string): string {
  const value = process.env[name]?.replace(/^﻿+/, "").trim();
  if (!value) {
    console.error(`缺少 ${name}。请先运行：npx vercel env pull .env.production.local --environment=production`);
    process.exit(1);
  }
  return value;
}

const GATEWAY = required("GATEWAY_BASE_URL").replace(/\/+$/, "");
const ADMIN_TOKEN = required("GATEWAY_ADMIN_ACCESS_TOKEN");
const ADMIN_USER_ID = required("GATEWAY_ADMIN_USER_ID");

/** 与 image-billing.ts 相同：token 需要 Bearer 前缀，缺了就补上。 */
function bearer(token: string): string {
  return /^bearer /i.test(token) ? token : `Bearer ${token}`;
}

const adminHeaders = {
  Authorization: bearer(ADMIN_TOKEN),
  "New-Api-User": ADMIN_USER_ID,
  "Content-Type": "application/json",
};

interface GatewayResult<T> {
  success: boolean;
  message?: string;
  data?: T;
}

async function callGateway<T>(path: string, init?: RequestInit): Promise<GatewayResult<T>> {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { ...adminHeaders, ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const text = await response.text();
  let parsed: GatewayResult<T>;
  try {
    parsed = JSON.parse(text) as GatewayResult<T>;
  } catch {
    throw new Error(`网关返回了非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok && !parsed.message) {
    throw new Error(`网关返回 HTTP ${response.status}`);
  }
  return parsed;
}

interface GatewayUser {
  id: number;
  username: string;
  display_name?: string;
  quota: number;
  used_quota?: number;
  status?: number;
  group?: string;
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 按用户名在全部分页里找。New API 的 /api/user/search 只认关键词，这里精确比对。 */
async function findUser(username: string): Promise<GatewayUser | null> {
  const result = await callGateway<GatewayUser[] | { items?: GatewayUser[] }>(
    `/api/user/search?keyword=${encodeURIComponent(username)}&p=1&page_size=100`,
  );
  if (!result.success) return null;
  const items = Array.isArray(result.data) ? result.data : (result.data?.items ?? []);
  return items.find((user) => user.username === username) ?? null;
}

async function main(): Promise<void> {
  const findOnly = readFlag("find");
  if (findOnly) {
    const user = await findUser(findOnly);
    console.log(user ? JSON.stringify(user, null, 2) : `没有找到用户 ${findOnly}。`);
    return;
  }

  const username = readFlag("username");
  const images = Number(readFlag("images") ?? 0);

  if (!username || !Number.isFinite(images) || images <= 0) {
    console.error(
      "用法：npx tsx tools/provision-biz-account.ts --username biz-aggregator --images 10000\n" +
        "     npx tsx tools/provision-biz-account.ts --find biz-aggregator",
    );
    process.exit(1);
  }

  console.log(`网关 ${GATEWAY}`);

  // 幂等：已经建过就直接复用，不重复创建也不重复加额度。
  let user = await findUser(username);

  if (user) {
    console.log(`用户 ${username} 已存在，id=${user.id}，当前额度 ${user.quota}（${user.quota / QUOTA_PER_COIN} 张）。`);
  } else {
    // 随机密码：这个账户只通过 B 端密钥被程序调用，没人需要登录它。
    const password = randomBytes(16).toString("base64url");
    const created = await callGateway(`/api/user/`, {
      method: "POST",
      body: JSON.stringify({
        username,
        password,
        display_name: "B 端 API 计费账户",
      }),
    });

    if (!created.success) {
      console.error(`创建用户失败：${created.message ?? "未知错误"}`);
      process.exit(1);
    }

    user = await findUser(username);
    if (!user) {
      console.error("创建似乎成功了，但随后查不到该用户。请手动检查上游。");
      process.exit(1);
    }
    console.log(`已创建用户 ${username}，id=${user.id}。`);
    console.log(`（登录密码为随机生成且未保存 —— 该账户只由程序通过 B 端密钥调用，不需要人工登录。`);
    console.log(`  日后若需要登录，请在上游后台重置密码。）`);
  }

  const targetQuota = images * QUOTA_PER_COIN;
  const delta = targetQuota - user.quota;

  if (delta === 0) {
    console.log(`额度已经是 ${images} 张，无需调整。`);
  } else {
    // 与生产扣费路径同一个端点与同一套参数。
    const adjusted = await callGateway(`/api/user/manage`, {
      method: "POST",
      body: JSON.stringify({
        id: user.id,
        action: "add_quota",
        mode: delta > 0 ? "add" : "subtract",
        value: Math.abs(delta),
      }),
    });
    if (!adjusted.success) {
      console.error(`调整额度失败：${adjusted.message ?? "未知错误"}`);
      process.exit(1);
    }
    console.log(`额度已调整 ${delta > 0 ? "+" : "-"}${Math.abs(delta) / QUOTA_PER_COIN} 张。`);
  }

  const confirmed = await callGateway<GatewayUser>(`/api/user/${user.id}`);
  if (!confirmed.success || !confirmed.data) {
    console.error("无法复核最终额度，请手动检查上游。");
    process.exit(1);
  }

  console.log(`\n最终状态：`);
  console.log(`  用户 id    ${confirmed.data.id}`);
  console.log(`  用户名     ${confirmed.data.username}`);
  console.log(`  可用额度   ${confirmed.data.quota} 配额单位 = ${confirmed.data.quota / QUOTA_PER_COIN} 张`);
  console.log(`  已用额度   ${confirmed.data.used_quota ?? 0}`);
  console.log(`\n下一步：npm run bizkey:issue -- --label "<客户名>" --user-id ${confirmed.data.id}`);
}

main().catch((error) => {
  console.error("失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
