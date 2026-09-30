import { NextRequest, NextResponse } from "next/server";

import { getSiteUrlFromEnv } from "@/lib/site-url";

export const runtime = "nodejs";
export const dynamic = "auto"; // 依賴環境變數，不強制靜態

/**
 * OpenAPI 3.1 spec — 從代碼派生，不手寫漂移。
 *
 * 覆蓋 10 個端點：7 圖像 + 3 影片。
 * 認證一律走 `Authorization: Bearer sk-biz-<key>`，限流 60rpm。
 * 認證通過的所有回應都帶 x-ratelimit-* 頭（輪詢端點 consumeRateLimit:false 不消耗額度）。
 */

// 認證通過的成功回應都帶的頭。
const RATE_LIMIT_HEADERS = {
  "X-Request-Id": {
    description: "請求 trace id；與錯誤體 `error.trace_id` 相同，方便抓包/對帳。",
    schema: { type: "string" },
  },
  "x-ratelimit-limit-requests": {
    description: "每分鐘請求額度上限（rpm）。",
    schema: { type: "integer" },
  },
  "x-ratelimit-remaining-requests": {
    description: "本次請求後剩餘額度。輪詢端點（GET /v1/images/{id}、/result 等）不消耗額度，值等於 limit。",
    schema: { type: "integer" },
  },
  "x-ratelimit-reset-requests": {
    description: "額度重置時間（下一個整分鐘邊界，UTC）。",
    schema: { type: "string", format: "date-time" },
  },
} as const;

const bearerAuth = { bearerAuth: [] } as const;

/** 每個需要認證的端點共同的 401/403/429 錯誤回應。 */
function authErrorResponses() {
  return {
    401: { $ref: "#/components/responses/ErrorResponse" },
    403: { $ref: "#/components/responses/ErrorResponse" },
    429: { $ref: "#/components/responses/ErrorResponse" },
  };
}

const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Eimu API",
    description:
      "OpenAI 相容的圖像 + 影片生成 API，供 AI 聚合平台與 agent 自我發現。\n\n" +
      "認證：`Authorization: Bearer sk-biz-<key>`。限流 60 requests/minute，所有認證通過的回應都帶 `x-ratelimit-*` 頭。\n\n" +
      "生圖/生影片為非同步模式：POST 回 202 task，輪詢 GET /v1/images/{id}（或 /v1/videos/{id}）直到 `status = succeeded | failed`。\n" +
      "錯誤體為 OpenAI 風格 `{ error: { message, type, code, param, trace_id } }`；trace_id 同步落在 `X-Request-Id` 回應頭。",
    version: "1.0.0",
  },
  servers: [
    { url: `${getSiteUrlFromEnv()}/v1`, description: "Production" },
    { url: "https://image.tinchak0207.xyz/v1", description: "Legacy (旧域名，仍可用)" },
  ],
  security: [bearerAuth],
  paths: {
    "/models": {
      get: {
        operationId: "listModels",
        summary: "列出可用模型（圖像 + 視頻，含能力、單價、文檔鏈接）",
        description:
          "只返回當前密鑰真正有權調用的模型，圖像與視頻同列一張表。每項帶非標準擴展 `x_endpoint`（該往哪個端點投递）、`x_capabilities`（逐模型能力契約：比例／解析度／時長／品質檔／生成型別／超分檔位／批次数 `maxBatchCount`／參考上限 `maxReferenceImages`）、`x_docs_url`、`x_openapi_url`；圖像另帶 `x_coins_per_image`（standard/hd），視頻另帶 `x_coins_per_second`（按解析度的每秒單價）。",
        security: [bearerAuth],
        responses: {
          200: {
            description: "模型列表",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ModelList" },
              },
            },
          },
          ...authErrorResponses(),
        },
      },
    },
    "/images/generations": {
      post: {
        operationId: "createImageGeneration",
        summary: "生成圖像（非同步 202 task）",
        description:
          "提交生圖任務，回 202 + `Location: /v1/images/{id}`。輪詢 `GET /v1/images/{id}` 直到 `status = succeeded`；成功後任務回應已內嵌 `data[]` 與 `result_url`，無需再呼叫。\n" +
          "支援 `callback_url` webhook 與 `Idempotency-Key` 請求頭。`response_format` 只接受 url/b64_json，b64 上游缺失時會降級回 URL。",
        security: [bearerAuth],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ImageGenerationRequest" },
            },
          },
        },
        responses: {
          202: {
            description: "任務已接受（非同步）。Location 指向輪詢端點。",
            headers: {
              ...RATE_LIMIT_HEADERS,
              Location: { description: "輪詢任務狀態的 URL：/v1/images/{id}", schema: { type: "string" } },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GenerationTask" },
              },
            },
          },
          200: {
            description:
              "同步回應（僅在 durable control plane 未啟用的 legacy 分支回；production 一律 202）。`{ created, data: [{ url | b64_json }] }`",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SyncImageResponse" },
              },
            },
          },
          400: { $ref: "#/components/responses/ErrorResponse" },
          402: { $ref: "#/components/responses/ErrorResponse" },
          403: { $ref: "#/components/responses/ErrorResponse" },
          409: {
            description: "Idempotency-Key 重複使用",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          429: { $ref: "#/components/responses/ErrorResponse" },
          502: {
            description: "no_endpoints（未配置上游）或 upstream_failed（上游失敗）",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          503: {
            description: "control_plane_unavailable",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/images/{id}": {
      get: {
        operationId: "getImageTask",
        summary: "查詢圖像任務狀態（輪詢不消耗限流）",
        description:
          "輪詢此端點不消耗限流額度。`status = succeeded` 時回應內嵌 `result_url` 與 `data[]`（artifact 列表）；`status = failed` 時帶 `error` 物件。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "任務 id（POST /images/generations 的 202 回應中的 id）",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "任務狀態",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GenerationTask" },
              },
            },
          },
          404: {
            description: "task_not_found",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          ...authErrorResponses(),
        },
      },
    },
    "/images/{id}/result": {
      get: {
        operationId: "getImageResult",
        summary: "獲取圖像結果",
        description:
          "預設回 JSON：`{ object: \"image_generation.result\", task_id, data: [artifact] }`。加 `?format=redirect` 且僅有單一 artifact 時回 302 重定向到圖片 URL。任務未完成時回 409 `result_not_ready`。輪詢不消耗限流。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "任務 id",
            schema: { type: "string" },
          },
          {
            name: "format",
            in: "query",
            required: false,
            description: "`redirect` 時對單一 artifact 回 302 到圖片 URL；其餘回 JSON。",
            schema: { type: "string", enum: ["json", "redirect"] },
          },
        ],
        responses: {
          200: {
            description: "結果 JSON",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ImageResult" },
              },
            },
          },
          302: {
            description: "重定向到圖片 URL（僅 ?format=redirect 且單一 artifact）",
            headers: {
              ...RATE_LIMIT_HEADERS,
              Location: { description: "圖片 URL", schema: { type: "string", format: "uri" } },
            },
          },
          404: {
            description: "task_not_found",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          409: {
            description: "result_not_ready（任務尚未 succeeded）",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          ...authErrorResponses(),
        },
      },
    },
    "/images/edits": {
      post: {
        operationId: "editImage",
        summary: "改圖（同步，~10-30s）",
        description:
          "以 base64 圖 + 提示詞生成改圖結果，同步等待。支援 `Idempotency-Key` 請求頭。定價走 admin 覆寫層（generationCoins pixai-edit）。",
        security: [bearerAuth],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EditsRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "改圖結果（OpenAI 風格 `{ data: [...] }`）",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SyncImageResponse" },
              },
            },
          },
          400: { $ref: "#/components/responses/ErrorResponse" },
          402: { $ref: "#/components/responses/ErrorResponse" },
          403: { $ref: "#/components/responses/ErrorResponse" },
          429: { $ref: "#/components/responses/ErrorResponse" },
          502: {
            description: "upstream_failed",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/uploads": {
      post: {
        operationId: "uploadImage",
        summary: "上傳圖片換 mediaId（供 edits/upscale 用）",
        description:
          "base64 上傳原圖，回 mediaId。上傳本身不計費。最大原圖約 20MB（base64 上限 ~30MB）。",
        security: [bearerAuth],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UploadRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "上傳成功，回 upstream 結果（含 mediaId）",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UploadResponse" },
              },
            },
          },
          400: { $ref: "#/components/responses/ErrorResponse" },
          401: { $ref: "#/components/responses/ErrorResponse" },
          403: { $ref: "#/components/responses/ErrorResponse" },
          413: {
            description: "image_too_large",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          429: { $ref: "#/components/responses/ErrorResponse" },
          502: {
            description: "upstream_failed",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/upscale": {
      post: {
        operationId: "upscaleImage",
        summary: "高清放大（同步，~20s）",
        description:
          "base64 圖放大到檔位 1k／2k／4k。檔位用 `upscale_tier` 顯式指定最清楚；`size`＋`factor` 是舊寫法的檔位配對（`size` 是上游基底檔、只有 `1k`／`2k`，"
          + "`factor=4` 才配到 `4k`）。檔位契約（兩種後端共用）：`1k`=`size\"1k\"×2`、`2k`=`size\"2k\"×2`、`4k`=`size\"2k\"×4`——"
          + "呼叫端給的倍率**不落在檔位上就具名拒** `upscale_factor_conflict`（不再靜默取用任意倍率）。"
          + "什麼都不給＝一鍵預設＝**當下最高可提交檔位**。影片超分在上游無通道 ⇒ 具名拒 `upscale_video_upstream_unsupported`。"
          + "支援 `Idempotency-Key` 請求頭。定價走 generationCoins(pixai-upscale)。\n"
          + "**後端**（2026-09-30）：`UPSCALE_BACKEND=gpt-image-2` 時走 **gpt-image-2 生成式重繪**——把原圖當參考圖提交 durable `image_edit` 任務；"
          + "**檔位以像素 `size` 表達**（實有渠道是 openai_images 型的 `/images/edits`，只收 size／quality，不看 resolution）："
          + "`1k`＝1024x1024／1536x1024／1024x1536、`2k`＝2048x2048、`4k`＝4096x4096；"
          + "原圖比例貼近模型已宣告的可提交比例（實際採用的 `ratio` 與 `ratio_deviation` 如實回報）。"
          + "**這不是保真像素放大，是重新繪製**（內容可能被模型重畫）；回應用 `data[].width/height` 給出真實輸出尺寸供自證。"
          + "該 比例×檔位 折算不出已知可交尺寸（例如 3:2 的 2k⇒3072x2048、16:9 的 1k⇒1792x1024）⇒ 具名拒 `upscale_backend_size_unavailable`（未驗證的尺寸不放行，也不靜默降級成較低檔位）；"
          + "沒有該 比例×檔位 的 image_edit 渠道 ⇒ 具名拒 `upscale_backend_capability_missing`；等待超時 ⇒ `upscale_backend_timeout`（504，任務仍在後台，已提交退款）。"
          + "**4K 默認 fail-closed**：輸出色未經真單校準前對 4K 具名拒 `upscale_4k_upstream_unverified`（不販售未校準檔位；校準後由 `UPSCALE_4K_UPSTREAM=1` 開啟，開啟後一鍵預設自動變 4K）。",
        security: [bearerAuth],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpscaleRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "放大結果（OpenAI 風格 `{ data: [...] }`）",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SyncImageResponse" },
              },
            },
          },
          400: { $ref: "#/components/responses/ErrorResponse" },
          402: { $ref: "#/components/responses/ErrorResponse" },
          403: { $ref: "#/components/responses/ErrorResponse" },
          429: { $ref: "#/components/responses/ErrorResponse" },
          502: {
            description: "upstream_failed",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/videos/generations": {
      post: {
        operationId: "createVideoGeneration",
        summary: "生成影片（非同步 202 task）",
        description:
          "提交影片生成任務，回 202 + `Location: /v1/videos/{id}`。影片只走 durable control plane，無同步回退分支；control plane 未啟用時回 503。\n" +
          "輪詢 `GET /v1/videos/{id}` 直到 `status = succeeded`，再取 `GET /v1/videos/{id}/result` 拿 `video_url`。支援 `callback_url` 與 `Idempotency-Key`。",
        security: [bearerAuth],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/VideoGenerationRequest" },
            },
          },
        },
        responses: {
          202: {
            description: "任務已接受（非同步）。Location 指向輪詢端點。",
            headers: {
              ...RATE_LIMIT_HEADERS,
              Location: { description: "輪詢任務狀態的 URL：/v1/videos/{id}", schema: { type: "string" } },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GenerationTask" },
              },
            },
          },
          400: { $ref: "#/components/responses/ErrorResponse" },
          402: { $ref: "#/components/responses/ErrorResponse" },
          403: { $ref: "#/components/responses/ErrorResponse" },
          409: {
            description: "Idempotency-Key 重複使用",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          429: { $ref: "#/components/responses/ErrorResponse" },
          503: {
            description: "control_plane_unavailable（影片僅支援 durable control plane）",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/videos/{id}": {
      get: {
        operationId: "getVideoTask",
        summary: "查詢影片任務狀態（輪詢不消耗限流）",
        description:
          "與圖像任務同型。`status = succeeded` 時內嵌 `result_url` 與 `data[]`。輪詢不消耗限流額度。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "任務 id（POST /videos/generations 的 202 回應中的 id）",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "任務狀態（與圖像任務同 schema）",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GenerationTask" },
              },
            },
          },
          404: {
            description: "task_not_found",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          ...authErrorResponses(),
        },
      },
    },
    "/videos/{id}/result": {
      get: {
        operationId: "getVideoResult",
        summary: "獲取影片結果",
        description:
          "回 `{ object: \"video_generation.result\", task_id, video_url, data: [artifact] }`。任務未完成時回 409 `result_not_ready`。輪詢不消耗限流。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "任務 id",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "影片結果",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VideoResult" },
              },
            },
          },
          404: {
            description: "task_not_found",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          409: {
            description: "result_not_ready（任務尚未 succeeded）",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          ...authErrorResponses(),
        },
      },
    },
    "/batches": {
      post: {
        operationId: "createBatch",
        summary: "批量生成（圖片/視頻混合，異步 202）",
        description:
          "一次提交最多 100 個生成任務（常量 MAX_BATCH_SIZE，可按需上調）。requests 每項帶 kind（image/video；缺省時由 duration_seconds/generate_audio 判別，再缺省視為 image），欄位與 /images/generations、/videos/generations 一致。\n" +
          "逐項驗證：單項失敗不炸整批，回應逐項標 items[].accepted 與 failed_items[].error。每項走與單任務完全相同的提交/計費/調度路徑。\n" +
          "支援 batch 級 Idempotency-Key 請求頭：重複提交回同一批；崩潰後重放會補齊未提交項（已提交項不重複扣費）。\n" +
          "max_in_flight 為聲明性欄位——實際併發由平台池化治理（全量提交 + scheduler 排隊），可承諾併發請與平台確認。",
        security: [bearerAuth],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BatchRequest" },
            },
          },
        },
        responses: {
          202: {
            description: "批已接受（異步）。Location 指向批聚合視圖。",
            headers: {
              ...RATE_LIMIT_HEADERS,
              Location: { description: "批聚合視圖 URL：/v1/batches/{id}", schema: { type: "string" } },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BatchAccepted" },
              },
            },
          },
          400: {
            description: "invalid_json / missing_requests / empty_requests / batch_too_large / invalid_max_in_flight",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          409: {
            description: "idempotency_key_reused（同鍵不同內容）",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          ...authErrorResponses(),
          503: {
            description: "control_plane_unavailable",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/batches/{id}": {
      get: {
        operationId: "getBatch",
        summary: "查詢批聚合視圖（輪詢不消耗限流）",
        description:
          "counts 按 pending/running/succeeded/failed/cancelled/refunded 分桶（另計 unsubmitted = 驗證被拒項）。\n" +
          "批終結判定：全部已提交項終結即 completed。部分成功語義：任何時刻 succeeded 的項都可經 /v1/images/{id}/result（或 /videos）單獨取件，不必等整批。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "批 id（POST /batches 的 202 回應中的 id）",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "批聚合視圖",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Batch" },
              },
            },
          },
          404: {
            description: "batch_not_found",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          ...authErrorResponses(),
        },
      },
    },
    "/batches/{id}/reconciliation": {
      get: {
        operationId: "getBatchReconciliation",
        summary: "對賬導出（JSON；CSV 後續可加）",
        description:
          "月結對賬面：任務 ID、成功/失敗數、逐項失敗原因 class、計費金額彙總（charged = succeeded 合計；失敗退費=按成功計費；refunded = 非成功終結項退回合計；pending = 在途預留）。輪詢不消耗限流。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "批 id",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "對賬文檔",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BatchReconciliation" },
              },
            },
          },
          404: {
            description: "batch_not_found",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          ...authErrorResponses(),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "sk-biz-<key>",
        description: "聚合平台用的業務密鑰，格式 `sk-biz-...`。限流 60 requests/minute。",
      },
    },
    responses: {
      ErrorResponse: {
        description: "OpenAI 風格錯誤體。trace_id 同步落在 `X-Request-Id` 回應頭。",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
          },
        },
      },
    },
    schemas: {
      ErrorBody: {
        type: "object",
        required: ["message", "type", "code", "param", "trace_id"],
        properties: {
          message: { type: "string", description: "英文 + 中文雙語錯誤描述。" },
          type: {
            type: "string",
            enum: [
              "invalid_request_error",
              "authentication_error",
              "permission_error",
              "rate_limit_error",
              "insufficient_balance",
              "api_error",
            ],
          },
          code: {
            type: "string",
            description:
              "穩定錯誤代碼：invalid_json, missing_prompt, prompt_too_long, missing_model, model_not_found, model_not_permitted, unsupported_size, invalid_n, no_endpoints, insufficient_balance, upstream_failed, control_plane_unavailable, idempotency_key_reused, task_not_found, result_not_ready, missing_image, missing_data, image_too_large, method_not_allowed, invalid_request_body, missing_requests, empty_requests, batch_too_large, invalid_max_in_flight, invalid_item, invalid_kind, invalid_control_nets, submission_failed, batch_not_found",
          },
          param: { type: ["string", "null"] },
          trace_id: { type: "string", description: "與 X-Request-Id 回應頭相同。" },
        },
      },
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: { $ref: "#/components/schemas/ErrorBody" },
        },
      },
      BatchItemRequest: {
        type: "object",
        description:
          "單個生成請求：欄位與 /images/generations（kind=image）或 /videos/generations（kind=video）的請求體一致。kind 缺省時由 duration_seconds/generate_audio 判別，再缺省視為 image。",
        required: ["model", "prompt"],
        properties: {
          kind: { type: "string", enum: ["image", "video", "image_generate", "video_generate"] },
          model: { type: "string" },
          prompt: { type: "string", maxLength: 4000 },
          n: { type: "integer", minimum: 1, maximum: 4 },
          size: { type: "string" },
          quality: { type: "string", enum: ["standard", "hd", "high"], description: "hd/high → quality 檔，其餘 fast。" },
          response_format: { type: "string", enum: ["url", "b64_json"] },
          duration_seconds: { type: "number", description: "視頻項專屬。" },
          generate_audio: { type: "boolean", description: "視頻項專屬。" },
          callback_url: { type: "string", format: "uri" },
          control_nets: {
            type: "array",
            description: "圖片項專屬，最多 4 項，規則同 /images/generations。",
            items: { type: "object" },
          },
        },
      },
      BatchRequest: {
        type: "object",
        required: ["requests"],
        properties: {
          requests: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            description: "上限 100（MAX_BATCH_SIZE 常量）；超限整批 400 batch_too_large。",
            items: { $ref: "#/components/schemas/BatchItemRequest" },
          },
          max_in_flight: {
            type: "integer",
            minimum: 1,
            description: "聲明性欄位：實際併發由平台池化治理（全量提交 + scheduler 排隊）。",
          },
        },
      },
      BatchAcceptedItem: {
        type: "object",
        required: ["index", "task_id", "accepted", "task_url"],
        properties: {
          index: { type: "integer", description: "對應 requests 索引（0 起）。" },
          task_id: { type: "string" },
          accepted: { type: "boolean", enum: [true] },
          task_url: { type: "string", description: "/v1/images/{id} 或 /v1/videos/{id}。" },
        },
      },
      BatchFailedItem: {
        type: "object",
        required: ["index", "error"],
        properties: {
          index: { type: "integer" },
          error: { $ref: "#/components/schemas/ErrorBody" },
        },
      },
      BatchAccepted: {
        type: "object",
        required: ["object", "id", "batch_id", "status", "total_count", "created", "created_at", "idempotent_replay", "items", "failed_items", "counts", "batch_url"],
        properties: {
          object: { type: "string", enum: ["image_generation.batch"] },
          id: { type: "string" },
          batch_id: { type: "string" },
          status: { type: "string", enum: ["open", "completed", "cancelled"] },
          total_count: { type: "integer" },
          max_in_flight: { type: ["integer", "null"] },
          created: { type: "integer", description: "epoch 秒。" },
          created_at: { type: "string", format: "date-time" },
          idempotent_replay: { type: "boolean", description: "true = 同一 Idempotency-Key 的重放，回同一批。" },
          items: { type: "array", items: { $ref: "#/components/schemas/BatchAcceptedItem" } },
          failed_items: { type: "array", items: { $ref: "#/components/schemas/BatchFailedItem" } },
          counts: {
            type: "object",
            properties: { accepted: { type: "integer" }, failed: { type: "integer" } },
          },
          batch_url: { type: "string" },
        },
      },
      BatchStatusCounts: {
        type: "object",
        required: ["total", "submitted", "unsubmitted", "pending", "running", "succeeded", "failed", "cancelled", "refunded", "unknown"],
        properties: {
          total: { type: "integer" },
          submitted: { type: "integer", description: "已成為任務的項數。" },
          unsubmitted: { type: "integer", description: "驗證/提交失敗、永遠不會變成任務的項數。" },
          pending: { type: "integer" },
          running: { type: "integer" },
          succeeded: { type: "integer" },
          failed: { type: "integer" },
          cancelled: { type: "integer" },
          refunded: { type: "integer" },
          unknown: { type: "integer", description: "billing_unknown / submit_unknown。" },
        },
      },
      BatchBillingSummary: {
        type: "object",
        description: "quota 單位。charged = succeeded 合計（失敗退費=按成功計費）；refunded = 非成功終結項退回；pending = 在途預留。",
        required: ["reserved_total", "charged_total", "refunded_total", "pending_total"],
        properties: {
          reserved_total: { type: "integer" },
          charged_total: { type: "integer" },
          refunded_total: { type: "integer" },
          pending_total: { type: "integer" },
        },
      },
      BatchItemView: {
        type: "object",
        required: ["index", "accepted", "task_id", "task_url", "status", "task_state", "model", "kind", "billed", "failure_class", "failure_detail", "error", "created_at", "finished_at"],
        properties: {
          index: { type: "integer" },
          accepted: { type: "boolean" },
          task_id: { type: ["string", "null"] },
          task_url: { type: ["string", "null"] },
          status: { type: ["string", "null"], description: "內部原始狀態。" },
          task_state: { $ref: "#/components/schemas/TaskStatus" },
          model: { type: ["string", "null"] },
          kind: { type: ["string", "null"] },
          billed: { type: "boolean", description: "成功才計費：只有 succeeded 為 true。" },
          failure_class: { type: ["string", "null"] },
          failure_detail: { type: ["string", "null"] },
          error: { type: ["object", "null"], description: "未提交項的拒絕原因（ErrorBody 形狀）。" },
          created_at: { type: ["string", "null"], format: "date-time" },
          finished_at: { type: ["string", "null"], format: "date-time" },
        },
      },
      Batch: {
        type: "object",
        required: ["object", "id", "batch_id", "status", "total_count", "counts", "billing", "items", "created", "created_at", "completed_at", "batch_url", "reconciliation_url"],
        properties: {
          object: { type: "string", enum: ["image_generation.batch"] },
          id: { type: "string" },
          batch_id: { type: "string" },
          status: { type: "string", enum: ["open", "completed", "cancelled"] },
          total_count: { type: "integer" },
          max_in_flight: { type: ["integer", "null"] },
          counts: { $ref: "#/components/schemas/BatchStatusCounts" },
          billing: { $ref: "#/components/schemas/BatchBillingSummary" },
          items: { type: "array", items: { $ref: "#/components/schemas/BatchItemView" } },
          created: { type: "integer" },
          created_at: { type: "string", format: "date-time" },
          completed_at: { type: ["string", "null"], format: "date-time" },
          batch_url: { type: "string" },
          reconciliation_url: { type: "string" },
        },
      },
      BatchReconciliation: {
        type: "object",
        required: ["object", "batch_id", "status", "totals", "billing", "failure_breakdown", "items", "created_at", "completed_at", "generated_at"],
        properties: {
          object: { type: "string", enum: ["image_generation.batch_reconciliation"] },
          batch_id: { type: "string" },
          status: { type: "string", enum: ["open", "completed", "cancelled"] },
          totals: { $ref: "#/components/schemas/BatchStatusCounts" },
          billing: { $ref: "#/components/schemas/BatchBillingSummary" },
          failure_breakdown: {
            type: "array",
            description: "失敗原因分佈：job 的 failure_class + 未提交項的驗證錯誤碼。",
            items: {
              type: "object",
              required: ["failure_class", "count"],
              properties: { failure_class: { type: "string" }, count: { type: "integer" } },
            },
          },
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["index", "task_id", "model", "kind", "status", "task_state", "billed", "billing_amount", "failure_class", "failure_detail", "error_code", "created_at", "finished_at"],
              properties: {
                index: { type: "integer" },
                task_id: { type: ["string", "null"] },
                model: { type: ["string", "null"] },
                kind: { type: ["string", "null"] },
                status: { type: ["string", "null"] },
                task_state: { type: ["string", "null"] },
                billed: { type: "boolean" },
                billing_amount: { type: "integer" },
                failure_class: { type: ["string", "null"] },
                failure_detail: { type: ["string", "null"], description: "截斷至 200 字符。" },
                error_code: { type: ["string", "null"], description: "未提交項的驗證錯誤碼。" },
                created_at: { type: ["string", "null"], format: "date-time" },
                finished_at: { type: ["string", "null"], format: "date-time" },
              },
            },
          },
          created_at: { type: "string", format: "date-time" },
          completed_at: { type: ["string", "null"], format: "date-time" },
          generated_at: { type: "string", format: "date-time" },
        },
      },
      TaskStatus: {
        type: "string",
        enum: ["queued", "running", "succeeded", "failed", "cancelled", "refunded", "unknown"],
      },
      RequestConfig: {
        type: "object",
        required: ["model", "n"],
        properties: {
          model: { type: "string" },
          size: { type: "string" },
          n: { type: "integer" },
          quality: { type: "string" },
          response_format: { type: "string", enum: ["url", "b64_json"] },
          prompt: { type: "string", maxLength: 500, description: "截斷至 500 字符。" },
        },
      },
      TaskArtifact: {
        type: "object",
        required: ["id", "url", "mimeType", "sha256", "width", "height", "outputIndex", "endpointLabel"],
        properties: {
          id: { type: "string" },
          url: { type: ["string", "null"] },
          mimeType: { type: "string" },
          sha256: { type: "string" },
          width: { type: "integer" },
          height: { type: "integer" },
          outputIndex: { type: "integer" },
          endpointLabel: { type: "string" },
        },
      },
      TaskError: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          reason: { type: "string", description: "額外診斷原因（overloaded 類失敗時有）。" },
        },
      },
      GenerationTask: {
        type: "object",
        description: "圖像/影片共用的任務回應（非同步 202 與輪詢共用）。",
        required: [
          "object",
          "id",
          "task_id",
          "status",
          "created",
          "model",
          "requested_count",
          "completed_count",
          "primary_result_id",
          "result_ids",
          "retry_of_task_id",
          "task_url",
          "request_config",
        ],
        properties: {
          object: { type: "string", enum: ["image_generation.task"] },
          id: { type: "string" },
          task_id: { type: "string" },
          status: { $ref: "#/components/schemas/TaskStatus" },
          created: { type: "integer", description: "Unix 時間戳（秒）。" },
          model: { type: "string" },
          requested_count: { type: "integer" },
          completed_count: { type: "integer" },
          primary_result_id: { type: ["string", "null"] },
          result_ids: { type: "array", items: { type: "string" } },
          retry_of_task_id: { type: ["string", "null"] },
          task_url: { type: "string" },
          request_config: { $ref: "#/components/schemas/RequestConfig" },
          result_url: { type: "string", description: "僅 `succeeded` 時存在。" },
          data: {
            type: "array",
            description: "僅 `succeeded` 時存在。",
            items: { $ref: "#/components/schemas/TaskArtifact" },
          },
          error: { $ref: "#/components/schemas/TaskError", description: "僅 `failed` 時存在。" },
        },
      },
      ImageResult: {
        type: "object",
        required: ["object", "task_id", "data"],
        properties: {
          object: { type: "string", enum: ["image_generation.result"] },
          task_id: { type: "string" },
          data: { type: "array", items: { $ref: "#/components/schemas/TaskArtifact" } },
        },
      },
      VideoResult: {
        type: "object",
        required: ["object", "task_id", "video_url", "data"],
        properties: {
          object: { type: "string", enum: ["video_generation.result"] },
          task_id: { type: "string" },
          video_url: { type: ["string", "null"], description: "第一個 artifact 的 url；無則 null。" },
          data: { type: "array", items: { $ref: "#/components/schemas/TaskArtifact" } },
        },
      },
      ModelCapabilities: {
        type: "object",
        description:
          "x_capabilities：逐模型的能力契約（對稱差 D23／P1-7），聚合平台可用它決定是否把模型上架、以及提交前預檢。數量面的值真源＝執行端常數，與真的擋人的閘同源；但**能力宣告 ≠ 一定能提交**（上限是全站共同上限，模型／上游可能更嚴）。",
        properties: {
          modelId: { type: "string" },
          mediaType: { type: "string", enum: ["image", "video"] },
          aspectRatios: { type: "array", items: { type: "string" } },
          resolutions: { type: "array", items: { type: "string" } },
          durations: { type: "array", items: { type: "integer" } },
          referenceImages: { type: "boolean", description: "該模型是否收參考圖（不收則省略 maxReferenceImages）。" },
          maxReferenceImages: {
            type: "integer",
            description:
              "每次請求可帶的參考圖上限（只有 referenceImages=true 的模型有）。值＝/v1/images/generations 的 invalid_reference_images 閘。",
          },
          maxBatchCount: {
            type: "integer",
            description:
              "每次請求可出的張數／段數上限（每個模型都有）。值＝/v1/images|videos/generations 的 `n` 閘，超限回 400 invalid_n。",
          },
          audio: { type: "boolean" },
          lora: { type: "boolean" },
          qualityModes: { type: "array", items: { type: "string", enum: ["fast", "quality"] } },
          defaultAspectRatio: { type: "string" },
          defaultResolution: { type: "string" },
          defaultDuration: { type: "integer" },
          defaultAudio: { type: "boolean" },
          videoGenerationTypes: {
            type: "array",
            items: { type: "string", enum: ["generate", "extend_video", "edit_video"] },
            description: "只有 video 模型有；缺省代表只支援 generate。",
          },
          promptCharLimit: { type: "integer", description: "只有 video 模型有：提交端 prompt 字元硬上限。" },
          upscaleTiers: {
            type: "array",
            items: { type: "string", enum: ["1k", "2k", "4k"] },
            description: "只有宣告超分鏈路的模型有；只列**此刻可提交**的檔位。",
          },
        },
      },
      ModelObject: {
        type: "object",
        required: ["id", "object", "created", "owned_by", "x_display_name", "x_endpoint", "x_docs_url", "x_openapi_url"],
        description:
          "圖像與視頻模型同在一張表。用 `x_capabilities.mediaType` 或 `x_endpoint` 區分：圖像模型帶 `x_coins_per_image`（按張），視頻模型帶 `x_coins_per_second`（按秒，隨解析度浮動）。",
        properties: {
          id: { type: "string" },
          object: { type: "string", enum: ["model"] },
          created: { type: "integer" },
          owned_by: { type: "string" },
          x_display_name: { type: "string" },
          x_endpoint: {
            type: "string",
            enum: ["/v1/images/generations", "/v1/videos/generations"],
            description: "該模型該往哪個端點投递。投錯端點會收到 400 unsupported_model。",
          },
          x_coins_per_image: {
            type: "object",
            description: "只有圖像模型有。",
            properties: {
              standard: { type: "number", description: "standard/fast 模式的單價（coins）。" },
              hd: { type: "number", description: "hd/quality 模式的單價；與 standard 同價時省略。" },
            },
          },
          x_coins_per_second: {
            type: "object",
            description:
              "只有視頻模型有。key 是解析度（見 `x_capabilities.resolutions`），value 是每秒單價（coins）。總價 = 單價 × durationSeconds。",
            additionalProperties: { type: "number" },
          },
          x_coins_per_second_with_audio: {
            type: "object",
            description: "只有視頻模型且開音軌要加價時才有；與無音同價時省略。",
            additionalProperties: { type: "number" },
          },
          x_capabilities: { $ref: "#/components/schemas/ModelCapabilities" },
          x_docs_url: { type: "string", format: "uri" },
          x_openapi_url: { type: "string", format: "uri" },
        },
      },
      ModelList: {
        type: "object",
        required: ["object", "data"],
        properties: {
          object: { type: "string", enum: ["list"] },
          data: { type: "array", items: { $ref: "#/components/schemas/ModelObject" } },
        },
      },
      ImageGenerationRequest: {
        type: "object",
        required: ["model", "prompt"],
        properties: {
          model: { type: "string", description: "支援的圖像模型 id，見 GET /v1/models。" },
          prompt: { type: "string", maxLength: 4000, minLength: 1 },
          n: { type: "integer", minimum: 1, maximum: 4, default: 1, description: "一次出幾張。" },
          size: {
            type: "string",
            enum: ["1024x1024", "1536x1024", "1024x1536", "2048x2048"],
            default: "1024x1024",
            description: "只接受這四種尺寸（2048x2048 由 seedream 系支援）。" },
          quality: {
            type: "string",
            enum: ["standard", "hd", "high"],
            default: "standard",
            description: "hd/high 對映內部 quality 模式；standard 對映 fast。" },
          response_format: {
            type: "string",
            enum: ["url", "b64_json"],
            default: "b64_json",
            description: "未傳或非 url 一律按 b64_json 處理；legacy 同步分支上游缺 b64 時該項降級回 URL。" },
          async: { type: "boolean", default: true, description: "production 一律非同步 202；此欄位僅向後相容。" },
          callback_url: { type: "string", format: "uri", description: "任務完成時的 webhook 回調。" },
        },
      },
      ImageObject: {
        type: "object",
        description: "OpenAI 風格圖片物件（legacy 同步回應用）。",
        properties: {
          url: { type: "string", format: "uri" },
          b64_json: { type: "string" },
          revised_prompt: { type: "string" },
          width: { type: "integer", nullable: true, description: "實測輸出寬（拿不到回 null，不以 0 冒充）。" },
          height: { type: "integer", nullable: true, description: "實測輸出高（拿不到回 null，不以 0 冒充）。" },
        },
      },
      SyncImageResponse: {
        type: "object",
        required: ["created", "data"],
        properties: {
          created: { type: "integer" },
          data: { type: "array", items: { $ref: "#/components/schemas/ImageObject" } },
        },
      },
      EditsRequest: {
        type: "object",
        required: ["image", "prompt"],
        properties: {
          image: { type: "string", description: "base64 原圖。" },
          prompt: { type: "string", maxLength: 2000, minLength: 1 },
          model: { type: "string", description: "可選；走 resolveBridgeModel 歸一，可為 null 用預設。" },
          size: { type: "string", enum: ["1k", "2k"], default: "1k" },
          n: { type: "integer", minimum: 1, maximum: 4, default: 1 },
          ratio: { type: "string", description: "寬高比，可選。" },
        },
      },
      UploadRequest: {
        type: "object",
        required: ["data"],
        properties: {
          data: { type: "string", description: "base64 圖片（原圖約 20MB，base64 上限 ~30MB）。" },
          mimeType: { type: "string", default: "image/png" },
        },
      },
      UploadResponse: {
        type: "object",
        required: ["mediaId"],
        properties: {
          mediaId: { type: "string", description: "上傳後拿到的 media id，供 edits/upscale 引用。" },
        },
      },
      UpscaleRequest: {
        type: "object",
        required: ["image"],
        properties: {
          image: { type: "string", description: "base64 原圖。" },
          upscale_tier: {
            type: "string",
            enum: ["1k", "2k", "4k"],
            description:
              "目標檔位（顯式鍵，與 `size`／`factor` 同時給且矛盾時具名拒 `upscale_factor_conflict`）。別名：`tier`、`output_resolution`。未給＝當下最高可提交檔位。",
          },
          factor: {
            type: "number",
            description:
              "檔位倍率寫法：`2`⇒2k、`4`⇒4k。**不是任意倍率**——不落在任何檔位上的值具名拒 `upscale_factor_conflict`。別名：`upscale`、`scale`。",
          },
          ratio: { type: "string", description: "寬高比，可選。gpt-image-2 後端會把它貼近模型已宣告的可提交比例，實際採用值回報在 `upscale.ratio`。" },
          size: {
            type: "string",
            enum: ["1k", "2k"],
            description:
              "舊寫法：上游 bridge 的基底檔（白名單只有 `1k`／`2k`，4K 靠 `factor=4` 推上去）。單給 `size` 即該檔位；與 `factor` 同給則按檔位組合配對（`(\"2k\",4)`⇒4k）。像素尺寸寫法（`\"1024x1024\"`）只作計費提示。",
          },
        },
      },
      VideoGenerationRequest: {
        type: "object",
        required: ["model", "prompt"],
        properties: {
          model: { type: "string", description: "支援的影片模型 id，見 GET /v1/models。" },
          prompt: { type: "string", maxLength: 4000, minLength: 1 },
          n: { type: "integer", minimum: 1, maximum: 4, default: 1 },
          size: { type: "string", description: "接受 \"16:9\" 與 \"1920x1080\" 兩種寫法，歸一成 catalog 的 aspectRatio。" },
          duration_seconds: { type: "integer", description: "影片時長（秒）；由 catalog 歸一，非法值回預設。" },
          generate_audio: { type: "boolean", description: "是否生成音訊；由 catalog 歸一。" },
          response_format: { type: "string", enum: ["url"], default: "url", description: "影片只支援 url（無 b64 通道）。" },
          callback_url: { type: "string", format: "uri", description: "任務完成時的 webhook 回調。" },
        },
      },
    },
  },
} as const;

/** 允許跨域讀取的自家域名（docs 頁同源讀取不受影響；擋瀏覽器側跨站抓 spec）。 */
const ALLOWED_ORIGINS = [
  "https://eimu.dev",
  "https://www.eimu.dev",
  "https://image.tinchak0207.xyz",
  "https://www.image.tinchak0207.xyz",
];

export function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "";
  return NextResponse.json(SPEC, {
    headers: {
      ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    },
  });
}
