#!/usr/bin/env -S npx tsx
//
// 從命令列簽發「宣傳用」兌換碼（一次性、非現金）。
//
// 為什麼需要它：站上產碼的兩條路徑（mPay 履約 `mapay-redemption.ts`、訂閱履約
// `subscription-redemption.ts`）都綁死業務訂單與自己的命名約定，且都是**冪等**的
// （同名同額只會有一張）。發宣傳碼要的剛好相反——每次都生一張全新的碼——所以這裡
// 走同一個上游端點（`POST <gateway>/api/redemption/`），只把 name 換成人類可讀的
// 宣傳前綴。**不另寫一套閘道邏輯**：env 載入逐字沿用 `tools/issue-biz-key.ts`，
// 額度換算沿用 `src/lib/quota-constants.ts` 的 QUOTA_PER_COIN（1 幣 = 500,000）。
//
// 命名即帳務語義（見 account-ledger.isCashBackedRedemptionName）：
//   ・只有 `MP<orderId>` 開頭才是「真金白銀買來的」→ 記成營收；
//   ・`PROMO-*` 這種人工碼一律非現金（source = gift-manual-code），不會謊報營收。
//   所以本檔的預設前綴刻意**不能**是 `MP`。
//
// 用法：
//   npx tsx tools/issue-promo-code.ts                          # 30 幣一張
//   npx tsx tools/issue-promo-code.ts --coins 100 --count 5    # 100 幣五張
//   npx tsx tools/issue-promo-code.ts --coins 30 --expires 30  # 30 天後過期
//   npx tsx tools/issue-promo-code.ts --prefix BILIBILI-1010    # 自訂前綴（方便對帳）
//   npx tsx tools/issue-promo-code.ts --dry-run                 # 只印請求，不發碼
//
// 憑證從哪來：`--env-file <路徑>` 指定，或依序找 `.env.production` /
// `.env.production.local` / `.env.local` / `.env.pulled`。缺憑證時自行
// `vercel env pull .env.production.local`（或從部署環境取）即可，本檔不猜。

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QUOTA_PER_COIN } from "../src/lib/quota-constants";

const root = process.cwd();

/** 從 .env* 載入腳本需要的變數；真實憑證不落在倉庫裡的其他地方。 */
function loadEnvFile(file: string): void {
  let content: string;
  try {
    content = readFileSync(file.startsWith("/") ? file : join(root, file), "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^"(.*)"$/, "$1");
    // 已被抹除的占位值不要覆蓋真實環境變數
    if (!value || value === "[SENSITIVE]") continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

type Options = {
  coins: number;
  count: number;
  expiresDays: number;
  prefix: string;
  name?: string;
  envFile?: string;
  baseUrl?: string;
  dryRun: boolean;
  json: boolean;
};

const USAGE = `用法：npx tsx tools/issue-promo-code.ts [選項]

  --coins <n>        每張碼的面額（站上單位＝幣），預設 30
  --count <n>        一次發幾張（1-100），預設 1
  --expires <days>   有效天數，預設 0＝永不過期
  --prefix <str>     碼名前綴，預設 PROMO（僅供閘道後台辨識，用戶看不到）
  --name <str>       指定完整碼名（僅 --count 1 可用；重名會被上游拒絕）
  --env-file <path>  指定憑證檔
  --base-url <url>   覆寫閘道位址（預設 GATEWAY_BASE_URL 或生產位址）
  --dry-run          只印出將送出的請求，不真的發碼
  --json             以 JSON 輸出（方便腳本再加工）
  -h, --help         顯示本說明`;

function fail(message: string): never {
  console.error(`錯誤：${message}`);
  console.error("");
  console.error(USAGE);
  process.exit(1);
}

function parseNumber(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`${flag} 必須是正數，收到「${raw}」`);
  return value;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    coins: 30,
    count: 1,
    expiresDays: 0,
    prefix: "PROMO",
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} 缺少值`);
      i += 1;
      return value;
    };

    switch (arg) {
      case "--coins":
        options.coins = parseNumber(next(), "--coins", 30);
        break;
      case "--count":
        options.count = Math.floor(parseNumber(next(), "--count", 1));
        break;
      case "--expires":
        options.expiresDays = Number(next());
        if (!Number.isFinite(options.expiresDays) || options.expiresDays < 0) {
          fail(`--expires 必須是 >= 0 的天數，收到「${argv[i]}」`);
        }
        break;
      case "--prefix":
        options.prefix = next();
        break;
      case "--name":
        options.name = next();
        break;
      case "--env-file":
        options.envFile = next();
        break;
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`未知參數「${arg}」`);
    }
  }

  if (options.count > 100) fail("--count 最多 100（要更多就多跑幾次）");
  if (options.name && options.count !== 1) fail("--name 只能搭配 --count 1");
  if (!options.name && !/^[A-Za-z0-9_-]+$/.test(options.prefix)) {
    fail("--prefix 只允許英數、底線與連字號（上游後台搜尋用）");
  }
  // 只擋「會被帳本誤判成營收」的那一種前綴，不是擋關鍵字。
  if (/^MP[A-Z0-9]{6,}$/i.test(options.name ?? options.prefix)) {
    fail("碼名不可長成 mPay 訂單格式（MP…），否則帳本會把它記成營收");
  }
  return options;
}

function gatewayBaseUrl(options: Options): string {
  return (
    options.baseUrl ??
    process.env.GATEWAY_BASE_URL ??
    "https://store.tinchak0207.xyz/newapi"
  );
}

function adminHeaders(): Record<string, string> {
  const token =
    process.env.GATEWAY_ADMIN_ACCESS_TOKEN ??
    process.env.GATEWAY_ADMIN_TOKEN ??
    process.env.NEW_API_ADMIN_ACCESS_TOKEN ??
    "";
  const userId = process.env.GATEWAY_ADMIN_USER_ID ?? process.env.NEW_API_ADMIN_USER_ID ?? "";

  if (!token.trim() || !userId.trim()) {
    console.error("缺少閘道管理憑證 GATEWAY_ADMIN_ACCESS_TOKEN / GATEWAY_ADMIN_USER_ID。");
    console.error("先 `vercel env pull .env.production.local`，或用 --env-file 指定憑證檔。");
    process.exit(1);
  }

  return {
    Authorization: `Bearer ${token.replace(/^Bearer\s+/i, "").trim()}`,
    "Content-Type": "application/json",
    "New-Api-User": userId.trim(),
  };
}

function buildName(options: Options): string {
  if (options.name) return withLengthGuard(options.name);
  // 上游對 `name` 有 20 字上限（現場實錘：22 字回「兑换码名称长度必须在1-20之间」）。
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  return withLengthGuard(`${options.prefix}-${options.coins}-${suffix}`);
}

/** 碼名長度上限由上游決定（1-20）；在地先擋，免得送出去才被拒。 */
function withLengthGuard(name: string): string {
  if (name.length < 1 || name.length > 20) {
    fail(`碼名「${name}」長度 ${name.length} 超出自 1-20（上游限制）：縮短 --prefix 或 --name`);
  }
  return name;
}

type GatewayResult<T> = { success: boolean; message?: string; data?: T };

async function readGatewayResult<T>(response: Response): Promise<GatewayResult<T>> {
  const text = await response.text();
  if (!text) return { success: false, message: `閘道回 ${response.status}` };
  try {
    return JSON.parse(text) as GatewayResult<T>;
  } catch {
    return { success: false, message: text.slice(0, 300) };
  }
}

/** 發碼核心：一張碼一次 POST（與生產履約同一端點、同一請求形狀）。 */
async function createCode(
  input: { name: string; quota: number; expiresDays: number },
  baseUrl: string,
  headers: Record<string, string>,
): Promise<string> {
  const expiredTime = input.expiresDays > 0 ? Math.floor(Date.now() / 1000) + input.expiresDays * 86_400 : 0;
  const response = await fetch(`${baseUrl}/api/redemption/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: input.name,
      count: 1,
      quota: input.quota,
      expired_time: expiredTime,
    }),
    cache: "no-store",
  });
  const result = await readGatewayResult<string[]>(response);
  const key = result.data?.[0];
  if (!response.ok || !result.success || !key) {
    throw new Error(`${input.name}：${result.message ?? `閘道回 ${response.status}`}`);
  }
  return key;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.envFile) loadEnvFile(options.envFile);
  for (const file of [".env.production", ".env.production.local", ".env.local", ".env.pulled"]) {
    loadEnvFile(file);
  }

  const quota = Math.round(options.coins * QUOTA_PER_COIN);
  const baseUrl = gatewayBaseUrl(options);

  if (options.dryRun) {
    const request = {
      url: `${baseUrl}/api/redemption/`,
      method: "POST",
      body: {
        name: `${options.name ?? `${options.prefix}-${options.coins}-XXXXXX`}（--count ${options.count}）`,
        count: 1,
        quota,
        expired_time:
          options.expiresDays > 0
            ? Math.floor(Date.now() / 1000) + options.expiresDays * 86_400
            : 0,
      },
      note: `${options.coins} 幣 = ${quota} quota = ${Math.round(options.coins * 0.045 * 100) / 100} 元等值`,
    };
    console.log(options.json ? JSON.stringify(request, null, 2) : JSON.stringify(request));
    return;
  }

  const headers = adminHeaders();
  const codes: { key: string; name: string }[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const name = buildName(options);
    try {
      codes.push({ key: await createCode({ name, quota, expiresDays: options.expiresDays }, baseUrl, headers), name });
    } catch (error) {
      // 已發出的碼不再收回（上游沒有撤銷慣例）：如實印出，讓操作者自己處置。
      if (codes.length) {
        console.error(`已發出 ${codes.length} 張，第 ${i + 1} 張失敗。`);
        for (const code of codes) console.error(`  ${code.key}  (${code.name})`);
      }
      throw error;
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          coins: options.coins,
          quota,
          expiresDays: options.expiresDays,
          gateway: baseUrl,
          codes: codes.map((code) => ({ code: code.key, name: code.name })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // 兌換碼本身就是 stdout 的主菜（給人複製去發），其餘資訊走 stderr。
  for (const code of codes) console.log(code.key);
  console.error(
    `已發出 ${codes.length} 張：${options.coins} 幣/張（= ${quota.toLocaleString("en-US")} quota` +
      `${options.expiresDays > 0 ? `，${options.expiresDays} 天後過期` : "，永不過期"}）`,
  );
  console.error(`兌換入口：${(process.env.NEXT_PUBLIC_SITE_URL ?? "https://eimu.dev").replace(/\/$/, "")}/pricing#redeem`);
}

// 不用 top-level await：本 repo 的 package.json 不是 ESM（tsx 會走 cjs 轉譯）。
main().catch((error: unknown) => {
  console.error(`發碼失敗：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
