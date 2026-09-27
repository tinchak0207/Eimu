import { NextRequest, NextResponse } from "next/server";
import { isModelAllowedForKey, readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { SUPPORTED_GENERATION_MODEL_IDS } from "@/lib/image-model-ids";
import { imageGenerationCoins, modelDisplayName } from "@/lib/provider-config";
import { generationCapabilities, generationCoins } from "@/lib/generation-model-catalog";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { readUnavailableModels } from "@/lib/generation-core/model-availability-gate";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

/**
 * GET /v1/models — OpenAI 兼容的模型列表。
 *
 * 聚合平台通常用它做模型发现与可用性探测，所以只返回当前密钥真正有权调用的模型。
 * 图像与视频模型同列一张表，用 `x_capabilities.mediaType` 与 `x_endpoint` 指出该往哪个
 * 端点投递；单价按介质给不同的扩展字段（图像按张、视频按秒）。
 * 标准字段一个不少，不认识这些扩展的客户端会自动忽略。
 *
 * 价格必须先 `syncModelPricing()` 再算：扣费路由都同步过 admin 覆写层，列表若不同步，
 * 就会出现「报价用旧表、扣费用新表」的不诚实差异。
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    return NextResponse.json(
      {
        error: {
          message: auth.message,
          type: auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error",
          code: auth.code,
          param: null,
        },
      },
      {
        status: auth.status,
        ...(auth.retryAfterSeconds ? { headers: { "Retry-After": String(auth.retryAfterSeconds) } } : {}),
      },
    );
  }

  await syncModelPricing();
  // 真實結果閘（2026-09-27）：近期真實生成全失敗的模型提交會被拒，列表不再宣稱它可用
  // （agent / MCP list_models 讀的就是這張表）。讀取失敗 → 空 map，全量照列。
  const breakerUnavailable = await readUnavailableModels().catch(() => new Map<string, string>());

  const siteUrl = getSiteUrlFromRequest(req);
  const created = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);

  const data = SUPPORTED_GENERATION_MODEL_IDS.filter(
    (modelId) => isModelAllowedForKey(auth.key, modelId) && !breakerUnavailable.has(modelId),
  ).map(
    (modelId) => {
      const capabilities = generationCapabilities(modelId);
      const isVideo = capabilities?.mediaType === "video";
      const base = {
        id: modelId,
        object: "model" as const,
        created,
        owned_by: "image-studio",
        x_display_name: modelDisplayName(modelId),
        // 同一张表混了两种介质，必须明确投递端点，否则聚合平台会把视频模型 POST 到
        // /v1/images/generations，然后收到 400 unsupported_model。
        x_endpoint: isVideo ? "/v1/videos/generations" : "/v1/images/generations",
        // 能力面投影：聚合平台可用它決定是否把模型上架；目錄查不到的模型省略。
        ...(capabilities ? { x_capabilities: capabilities } : {}),
        x_docs_url: `${siteUrl}/docs`,
        x_openapi_url: `${siteUrl}/v1/openapi.json`,
      };

      if (!isVideo) {
        const fastCoins = imageGenerationCoins(modelId, "fast");
        const qualityCoins = imageGenerationCoins(modelId, "quality");
        return {
          ...base,
          // 非标准扩展：便于聚合平台直接算单价。fast 与 quality 的消耗可能不同。
          // 若 fast 與 quality 同價（hd 沒比較貴），就不輸出 hd，避免誤導成「更貴」。
          x_coins_per_image: {
            standard: fastCoins,
            ...(qualityCoins === fastCoins ? {} : { hd: qualityCoins }),
          },
        };
      }

      // 视频按秒计价、费率随解析度浮动，所以给一张 resolution → coins/秒 的表。
      // 用的是扣费同一个 generationCoins()，报价与实际扣费同源。
      // 总价 = 表里的费率 × durationSeconds（可选时长见 x_capabilities.durations）。
      const perSecond: Record<string, number> = {};
      const perSecondWithAudio: Record<string, number> = {};
      for (const resolution of capabilities?.resolutions ?? []) {
        perSecond[resolution] = generationCoins(modelId, { resolution, durationSeconds: 1 });
        if (capabilities?.audio) {
          perSecondWithAudio[resolution] = generationCoins(modelId, {
            resolution,
            durationSeconds: 1,
            generateAudio: true,
          });
        }
      }
      // 开音轨不加价的模型就不输出这张表，避免误导成「带音更贵」。
      const audioDiffers = Object.keys(perSecondWithAudio).some(
        (resolution) => perSecondWithAudio[resolution] !== perSecond[resolution],
      );

      return {
        ...base,
        x_coins_per_second: perSecond,
        ...(audioDiffers ? { x_coins_per_second_with_audio: perSecondWithAudio } : {}),
      };
    },
  );

  return addRateLimitHeaders(NextResponse.json({ object: "list", data }), auth.key);
}
