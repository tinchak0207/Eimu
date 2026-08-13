// 跨层诊断的采集逻辑。
//
// 排障链路是 Vercel（env/rewrite）→ nginx → image-control-api 容器（env）→ Postgres。
// 之前查一次 overloaded 要分别 SSH 看容器 env、psql 查 supplier、curl 试 bridge，
// 四层各查一遍才拼出结论。这里把每层的判定收成一个函数，两侧各跑一次再合并。
//
// 只报「配置存在/不存在」与「连通/不连通」，绝不回显任何密钥值 ——
// 诊断端点是最容易被顺手加日志泄露凭据的地方。

import { generationControlPlaneEnabled, getGenerationSql } from "./generation-core/database";
import { PIXAI_ALL_MODEL_IDS, PIXAI_GENERATE_MODEL_IDS } from "./pixai-model-map";

export type EnvLayer = {
  runningOn: "control-plane" | "vercel-edge";
  controlPlaneOriginConfigured: boolean;
  generationDatabase: boolean;
  blobStore: boolean;
  envKeyFallback: boolean;
  billingRelayUrl: boolean;
  billingRelaySecret: boolean;
  gatewayAdminToken: boolean;
  pixaiBridge: boolean;
  adminSessionSecret: boolean;
};

export type DatabaseLayer = {
  connected: boolean;
  detail: string;
  suppliers?: {
    label: string;
    tier: string;
    enabled: boolean;
    healthStatus: string;
    coolingDown: boolean;
    healthyAccounts: number;
  }[];
  pixaiModelCoverage?: { modelId: string; kind: string; suppliers: string[] }[];
  unprovisionedPixaiModels?: string[];
  bizKeyCount?: number | null;
};

export type LocalDiagnostics = {
  env: EnvLayer;
  database: DatabaseLayer;
};

/** 只回布尔，不回值。 */
function configured(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function envLayer(): EnvLayer {
  return {
    runningOn: generationControlPlaneEnabled() ? "control-plane" : "vercel-edge",
    controlPlaneOriginConfigured: configured("GENERATION_CONTROL_PLANE_PROXY_ORIGIN"),
    generationDatabase: configured("GENERATION_DATABASE_URL"),
    blobStore: configured("BLOB_READ_WRITE_TOKEN"),
    envKeyFallback: configured("BIZ_API_KEY_HASHES"),
    billingRelayUrl: configured("GENERATION_BILLING_RELAY_URL"),
    billingRelaySecret: configured("GENERATION_BILLING_RELAY_SECRET"),
    gatewayAdminToken: configured("GATEWAY_ADMIN_ACCESS_TOKEN"),
    pixaiBridge: configured("PIXAI_BASE_URL") && configured("PIXAI_API_KEY"),
    adminSessionSecret: configured("ADMIN_SESSION_SECRET"),
  };
}

async function databaseLayer(): Promise<DatabaseLayer> {
  if (!generationControlPlaneEnabled()) {
    return { connected: false, detail: "本实例未配置 GENERATION_DATABASE_URL（Vercel 侧属正常）。" };
  }

  try {
    const sql = getGenerationSql();

    const suppliers = await sql<{
      label: string;
      supply_tier: string;
      enabled: boolean;
      health_status: string;
      cooling_down: boolean;
      healthy_accounts: number;
    }[]>`
      SELECT s.label, s.supply_tier, s.enabled, s.health_status,
        (s.cooldown_until IS NOT NULL AND s.cooldown_until > now()) AS cooling_down,
        (SELECT count(*) FROM supplier_account a
           WHERE a.supplier_id = s.id AND a.enabled AND a.health_status = 'healthy'
             AND (a.cooldown_until IS NULL OR a.cooldown_until <= now())) AS healthy_accounts
      FROM supplier s
      ORDER BY s.label
    `;

    // 逐模型列出「当前生效」的供应商。空数组 = 这个模型永远回 overloaded。
    const coverage = await sql<{ public_model_id: string; kind: string; labels: string[] }[]>`
      SELECT c.public_model_id, c.kind, array_agg(DISTINCT s.label) AS labels
      FROM supplier_capability c
      JOIN supplier s ON s.id = c.supplier_id
      WHERE c.is_current AND c.enabled AND s.enabled
        AND c.public_model_id = ANY(${[...PIXAI_ALL_MODEL_IDS]}::text[])
      GROUP BY c.public_model_id, c.kind
      ORDER BY c.public_model_id, c.kind
    `;

    const covered = new Set(coverage.map((row) => row.public_model_id));
    const bizKeys = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM biz_api_key WHERE enabled
    `.catch(() => null);

    return {
      connected: true,
      detail: "已连接。",
      suppliers: suppliers.map((row) => ({
        label: row.label,
        tier: row.supply_tier,
        enabled: row.enabled,
        healthStatus: row.health_status,
        coolingDown: row.cooling_down === true,
        healthyAccounts: Number(row.healthy_accounts ?? 0),
      })),
      pixaiModelCoverage: coverage.map((row) => ({
        modelId: row.public_model_id,
        kind: row.kind,
        suppliers: row.labels,
      })),
      // 只对生图模型报警：edit/upscale/template 走同步直连，不经调度器。
      unprovisionedPixaiModels: PIXAI_GENERATE_MODEL_IDS.filter((id) => !covered.has(id)),
      bizKeyCount: bizKeys ? Number(bizKeys[0]?.count ?? 0) : null,
    };
  } catch (error) {
    return { connected: false, detail: error instanceof Error ? error.message : "连接失败" };
  }
}

export async function gatherLocalDiagnostics(): Promise<LocalDiagnostics> {
  return { env: envLayer(), database: await databaseLayer() };
}

/** 由两侧的采集结果推出可执行结论。 */
export function summarizeProblems(input: {
  local: LocalDiagnostics;
  controlPlane: LocalDiagnostics | null;
  controlPlaneReachable: { ok: boolean; detail: string } | null;
}): string[] {
  const problems: string[] = [];

  if (input.controlPlaneReachable && !input.controlPlaneReachable.ok) {
    problems.push(`控制面不可达（${input.controlPlaneReachable.detail}），检查 nginx 与容器状态。`);
  }

  // 有数据库的那一侧才有供给面结论：Vercel 侧永远看不到。
  const authoritative = input.controlPlane?.database.connected
    ? input.controlPlane
    : input.local.database.connected ? input.local : null;

  if (authoritative) {
    const unprovisioned = authoritative.database.unprovisionedPixaiModels ?? [];
    if (unprovisioned.length) {
      problems.push(
        `以下生图模型没有任何可用供应商，调用必回 overloaded：${unprovisioned.join(", ")}。`
          + "在控制面执行 npm run generation:seed，或重启 worker 容器自动播种。",
      );
    }
    if (authoritative.database.bizKeyCount === 0) {
      problems.push("控制面密钥表为空：新签发的 key 会 401。检查 admin 签发是否走到了签名通道。");
    }
    if (!authoritative.env.billingRelaySecret) {
      problems.push("控制面缺 GENERATION_BILLING_RELAY_SECRET，B 端同步路由无法扣费。");
    }
    if (!authoritative.env.pixaiBridge) {
      problems.push("控制面缺 PIXAI_BASE_URL / PIXAI_API_KEY，改图/放大/模板会回 503。");
    }
  } else if (!input.controlPlane) {
    problems.push("拿不到控制面诊断：签名通道不可用，供给面与密钥表状态未知。");
  }

  if (input.local.env.runningOn === "vercel-edge" && !input.local.env.controlPlaneOriginConfigured) {
    problems.push("Vercel 侧缺 GENERATION_CONTROL_PLANE_PROXY_ORIGIN，/v1 不会转发到控制面。");
  }

  return problems;
}
