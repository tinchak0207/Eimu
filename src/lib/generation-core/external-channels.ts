// B 端自定义上游（外部 OpenAI 相容渠道）的核心纯逻辑。
//
// 商业场景：B 端客户自带 OpenAI 相容 v1 端点，平台帮他做计费、追踪、失败诊断的
// 转售。目前 channel-registry 只有内部渠道；本模组补上「外部注入」：管理员注册
// 一个外部 channel（baseUrl + 模型映射 + 可用金钥白名单），该金钥的生图流量改走
// 客户自己的上游，计费仍然挂在平台。
//
// 安全约定：raw API key 永不落 Blob/DB——channel 只存 `credentialRef`（环境变数名），
// 值在生成时从 `process.env[credentialRef]` 读取。永远不把 key 写进任何储存或回传。
//
// 本模组是纯函式层：不碰 Blob、不碰 process.env、不碰 network，可直接在 node --test
// 下测。持久化在 external-channels-store.ts，路由注入在 external-channel-adapter.ts。

export interface ExternalChannel {
  id: string;
  name: string;
  /** 上游 base URL，不含尾斜线。 */
  baseUrl: string;
  /** 存放上游 API key 的环境变数名。原始 key 永不落储存。 */
  credentialRef: string;
  /** 平台 model id → 上游 model id；未映射的原样透传。 */
  modelMapping: Record<string, string>;
  /** 允许使用本渠道的 B 端金钥 id；空阵列 = 允许所有金钥。 */
  apiKeyWhitelist: string[];
  enabled: boolean;
  createdBy?: string;
  createdAt?: string;
}

export interface ExternalChannelDocument {
  channels: ExternalChannel[];
}

export function emptyExternalChannelDocument(): ExternalChannelDocument {
  return { channels: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const URL_PATTERN = /^https?:\/\/[^\s]{3,2048}$/;
const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9_\-]{4,128}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._\-]{1,128}$/;

/** 清洗单笔 channel。非法 baseUrl / credentialRef / id 整笔拒绝；栏位级清洗可容忍的脏输入。 */
export function normalizeExternalChannel(raw: unknown): ExternalChannel | null {
  if (!isPlainObject(raw)) return null;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : "";
  const credentialRef = typeof raw.credentialRef === "string" ? raw.credentialRef.trim() : "";

  if (!id || !KEY_ID_PATTERN.test(id)) return null;
  if (!URL_PATTERN.test(baseUrl)) return null;
  if (!CREDENTIAL_REF_PATTERN.test(credentialRef)) return null;

  const modelMapping: Record<string, string> = {};
  if (isPlainObject(raw.modelMapping)) {
    for (const [modelId, upstream] of Object.entries(raw.modelMapping)) {
      if (!MODEL_ID_PATTERN.test(modelId)) continue;
      if (typeof upstream !== "string" || !upstream.trim()) continue;
      const cleaned = upstream.trim();
      if (!MODEL_ID_PATTERN.test(cleaned)) continue;
      Object.defineProperty(modelMapping, modelId, { value: cleaned, enumerable: true, writable: true, configurable: true });
    }
  }

  const apiKeyWhitelist: string[] = [];
  if (Array.isArray(raw.apiKeyWhitelist)) {
    for (const entry of raw.apiKeyWhitelist) {
      if (typeof entry !== "string") continue;
      const cleaned = entry.trim();
      if (cleaned && KEY_ID_PATTERN.test(cleaned)) apiKeyWhitelist.push(cleaned);
    }
  }

  return {
    id,
    name: name || id,
    baseUrl,
    credentialRef,
    modelMapping,
    apiKeyWhitelist,
    enabled: raw.enabled !== false,
    ...(typeof raw.createdBy === "string" && raw.createdBy ? { createdBy: raw.createdBy } : {}),
    ...(typeof raw.createdAt === "string" && raw.createdAt ? { createdAt: raw.createdAt } : {}),
  };
}

/** 清洗整份文件。未知/非法 channel 静默丢弃。 */
export function normalizeExternalChannelDocument(raw: unknown): ExternalChannelDocument {
  if (!isPlainObject(raw) || !Array.isArray(raw.channels)) return { channels: [] };
  const seen = new Set<string>();
  const channels: ExternalChannel[] = [];
  for (const entry of raw.channels) {
    const channel = normalizeExternalChannel(entry);
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    channels.push(channel);
  }
  return { channels };
}

/** 回传不含任何凭证的公开视图（admin 用）。 */
export function toPublicExternalChannel(channel: ExternalChannel, credentialConfigured: boolean): unknown {
  return {
    id: channel.id,
    name: channel.name,
    baseUrl: channel.baseUrl,
    credentialRef: channel.credentialRef,
    credentialConfigured,
    modelMapping: { ...channel.modelMapping },
    apiKeyWhitelist: [...channel.apiKeyWhitelist],
    enabled: channel.enabled,
    ...(channel.createdBy ? { createdBy: channel.createdBy } : {}),
    ...(channel.createdAt ? { createdAt: channel.createdAt } : {}),
  };
}

/**
 * 依金钥 id 解析命中的外部 channel：必须 enabled，且金钥在该 channel 的
 * 白名单内（空白名单 = 允许所有）。多个命中取文件顺序第一个。
 * 回 null = 该金钥没有外部上游，走既有内部渠道。
 */
export function resolveExternalChannelForKey(
  doc: ExternalChannelDocument,
  keyId: string,
): ExternalChannel | null {
  for (const channel of doc.channels) {
    if (!channel.enabled) continue;
    if (channel.apiKeyWhitelist.length === 0 || channel.apiKeyWhitelist.includes(keyId)) {
      return channel;
    }
  }
  return null;
}

/** 平台 model id → 上游 model id（无映射原样透传）。 */
export function mapExternalModel(channel: ExternalChannel, modelId: string): string {
  return channel.modelMapping[modelId] ?? modelId;
}

/** 该外部 channel 的 API key 是否已设定（env 存在且非空）。 */
export function externalChannelKeyConfigured(channel: ExternalChannel, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[channel.credentialRef];
  return typeof value === "string" && value.trim().length > 0;
}
