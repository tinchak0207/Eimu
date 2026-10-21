// 认证通过的成功回应都带的头。
const RATE_LIMIT_HEADERS = {
  "X-Request-Id": {
    description: "请求 trace id；与错误体 `error.trace_id` 相同，方便抓包/对帐。",
    schema: { type: "string" },
  },
  "x-ratelimit-limit-requests": {
    description: "每分钟请求额度上限（rpm）。",
    schema: { type: "integer" },
  },
  "x-ratelimit-remaining-requests": {
    description: "本次请求后剩余额度。轮询端点（GET /v1/images/{id}、/result 等）不消耗额度，值等于 limit。",
    schema: { type: "integer" },
  },
  "x-ratelimit-reset-requests": {
    description: "额度重置时间（下一个整分钟边界，UTC）。",
    schema: { type: "string", format: "date-time" },
  },
} as const;

export const bearerAuth = { bearerAuth: [] } as const;

/** 每个需要认证的端点共同的 401/403/429 错误回应。 */
function authErrorResponses() {
  return {
    401: { $ref: "#/components/responses/ErrorResponse" },
    403: { $ref: "#/components/responses/ErrorResponse" },
    429: { $ref: "#/components/responses/ErrorResponse" },
  };
}

export const PATHS = {
    "/models": {
      get: {
        operationId: "listModels",
        summary: "列出可用模型（图像 + 视频，含能力、单价、文档链接）",
        description:
          "只返回当前密钥真正有权调用的模型，图像与视频同列一张表。每项带非标准扩展 `x_endpoint`（该往哪个端点投递）、`x_capabilities`（逐模型能力契约：比例／解析度／时长／品质档／生成型别／超分档位／批次数 `maxBatchCount`／参考上限 `maxReferenceImages`）、`x_docs_url`、`x_openapi_url`；图像另带 `x_coins_per_image`（standard/hd），视频另带 `x_coins_per_second`（按解析度的每秒单价）。",
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
        summary: "生成图像（非同步 202 task）",
        description:
          "提交生图任务，回 202 + `Location: /v1/images/{id}`。轮询 `GET /v1/images/{id}` 直到 `status = succeeded`；成功后任务回应已内嵌 `data[]` 与 `result_url`，无需再呼叫。\n" +
          "支援 `callback_url` webhook 与 `Idempotency-Key` 请求头。`response_format` 只接受 url/b64_json，b64 上游缺失时会降级回 URL。",
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
            description: "任务已接受（非同步）。Location 指向轮询端点。",
            headers: {
              ...RATE_LIMIT_HEADERS,
              Location: { description: "轮询任务状态的 URL：/v1/images/{id}", schema: { type: "string" } },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GenerationTask" },
              },
            },
          },
          200: {
            description:
              "同步回应（仅在 durable control plane 未启用的 legacy 分支回；production 一律 202）。`{ created, data: [{ url | b64_json }] }`",
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
            description: "Idempotency-Key 重复使用",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          429: { $ref: "#/components/responses/ErrorResponse" },
          502: {
            description: "no_endpoints（未配置上游）或 upstream_failed（上游失败）",
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
        summary: "查询图像任务状态（轮询不消耗限流）",
        description:
          "轮询此端点不消耗限流额度。`status = succeeded` 时回应内嵌 `result_url` 与 `data[]`（artifact 列表）；`status = failed` 时带 `error` 物件。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "任务 id（POST /images/generations 的 202 回应中的 id）",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "任务状态",
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
        summary: "获取图像结果",
        description:
          "预设回 JSON：`{ object: \"image_generation.result\", task_id, data: [artifact] }`。加 `?format=redirect` 且仅有单一 artifact 时回 302 重定向到图片 URL。任务未完成时回 409 `result_not_ready`。轮询不消耗限流。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "任务 id",
            schema: { type: "string" },
          },
          {
            name: "format",
            in: "query",
            required: false,
            description: "`redirect` 时对单一 artifact 回 302 到图片 URL；其余回 JSON。",
            schema: { type: "string", enum: ["json", "redirect"] },
          },
        ],
        responses: {
          200: {
            description: "结果 JSON",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ImageResult" },
              },
            },
          },
          302: {
            description: "重定向到图片 URL（仅 ?format=redirect 且单一 artifact）",
            headers: {
              ...RATE_LIMIT_HEADERS,
              Location: { description: "图片 URL", schema: { type: "string", format: "uri" } },
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
            description: "result_not_ready（任务尚未 succeeded）",
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
        summary: "改图（同步，~10-30s）",
        description:
          "以 base64 图 + 提示词生成改图结果，同步等待。支援 `Idempotency-Key` 请求头。定价走 admin 覆写层（generationCoins pixai-edit）。",
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
            description: "改图结果（OpenAI 风格 `{ data: [...] }`）",
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
        summary: "上传图片换 mediaId（供 edits/upscale 用）",
        description:
          "base64 上传原图，回 mediaId。上传本身不计费。最大原图约 20MB（base64 上限 ~30MB）。",
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
            description: "上传成功，回 upstream 结果（含 mediaId）",
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
          "base64 图放大到档位 1k／2k／4k。档位用 `upscale_tier` 显式指定最清楚；`size`＋`factor` 是旧写法的档位配对（`size` 是上游基底档、只有 `1k`／`2k`，"
          + "`factor=4` 才配到 `4k`）。档位契约（两种后端共用）：`1k`=`size\"1k\"×2`、`2k`=`size\"2k\"×2`、`4k`=`size\"2k\"×4`——"
          + "呼叫端给的倍率**不落在档位上就具名拒** `upscale_factor_conflict`（不再静默取用任意倍率）。"
          + "什么都不给＝一键预设＝**当下最高可提交档位**。影片超分在上游无通道 ⇒ 具名拒 `upscale_video_upstream_unsupported`。"
          + "支援 `Idempotency-Key` 请求头。定价走 generationCoins(pixai-upscale)。\n"
          + "**后端**（2026-09-30）：`UPSCALE_BACKEND=gpt-image-2` 时走 **gpt-image-2 生成式重绘**——把原图当参考图提交 durable `image_edit` 任务；"
          + "**档位以像素 `size` 表达**（实有渠道是 openai_images 型的 `/images/edits`，只收 size／quality，不看 resolution）："
          + "`1k`＝1024x1024／1536x1024／1024x1536、`2k`＝2048x2048、`4k`＝4096x4096；"
          + "原图比例贴近模型已宣告的可提交比例（实际采用的 `ratio` 与 `ratio_deviation` 如实回报）。"
          + "**这不是保真像素放大，是重新绘制**（内容可能被模型重画）；回应用 `data[].width/height` 给出真实输出尺寸供自证。"
          + "该 比例×档位 折算不出已知可交尺寸（例如 3:2 的 2k⇒3072x2048、16:9 的 1k⇒1792x1024）⇒ 具名拒 `upscale_backend_size_unavailable`（未验证的尺寸不放行，也不静默降级成较低档位）；"
          + "没有该 比例×档位 的 image_edit 渠道 ⇒ 具名拒 `upscale_backend_capability_missing`；等待超时 ⇒ `upscale_backend_timeout`（504，任务仍在后台，已提交退款）。"
          + "**4K 默认 fail-closed**：输出色未经真单校准前对 4K 具名拒 `upscale_4k_upstream_unverified`（不贩售未校准档位）。"
          + "服务端 env `UPSCALE_4K_UPSTREAM`（`1`／`true`，大小写不敏感；未设＝关闭）在校准后开启：开启后提交闸放行 4K、`/v1/models` 的 `x_capabilities.upscaleTiers` 同步外露 4K，且一键预设自动变 4K；关闭时上述两处均不出现 4K。",
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
            description: "放大结果（OpenAI 风格 `{ data: [...] }`）",
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
          "提交影片生成任务，回 202 + `Location: /v1/videos/{id}`。影片只走 durable control plane，无同步回退分支；control plane 未启用时回 503。\n" +
          "轮询 `GET /v1/videos/{id}` 直到 `status = succeeded`，再取 `GET /v1/videos/{id}/result` 拿 `video_url`。支援 `callback_url` 与 `Idempotency-Key`。",
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
            description: "任务已接受（非同步）。Location 指向轮询端点。",
            headers: {
              ...RATE_LIMIT_HEADERS,
              Location: { description: "轮询任务状态的 URL：/v1/videos/{id}", schema: { type: "string" } },
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
            description: "Idempotency-Key 重复使用",
            headers: RATE_LIMIT_HEADERS,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          429: { $ref: "#/components/responses/ErrorResponse" },
          503: {
            description: "control_plane_unavailable（影片仅支援 durable control plane）",
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
        summary: "查询影片任务状态（轮询不消耗限流）",
        description:
          "与图像任务同型。`status = succeeded` 时内嵌 `result_url` 与 `data[]`。轮询不消耗限流额度。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "任务 id（POST /videos/generations 的 202 回应中的 id）",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "任务状态（与图像任务同 schema）",
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
        summary: "获取影片结果",
        description:
          "回 `{ object: \"video_generation.result\", task_id, video_url, data: [artifact] }`。任务未完成时回 409 `result_not_ready`。轮询不消耗限流。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "任务 id",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "影片结果",
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
            description: "result_not_ready（任务尚未 succeeded）",
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
        summary: "批量生成（图片/视频混合，异步 202）",
        description:
          "一次提交最多 100 个生成任务（常量 MAX_BATCH_SIZE，可按需上调）。requests 每项带 kind（image/video；缺省时由 duration_seconds/generate_audio 判别，再缺省视为 image），栏位与 /images/generations、/videos/generations 一致。\n" +
          "逐项验证：单项失败不炸整批，回应逐项标 items[].accepted 与 failed_items[].error。每项走与单任务完全相同的提交/计费/调度路径。\n" +
          "支援 batch 级 Idempotency-Key 请求头：重复提交回同一批；崩溃后重放会补齐未提交项（已提交项不重复扣费）。\n" +
          "max_in_flight 为声明性栏位——实际并发由平台池化治理（全量提交 + scheduler 排队），可承诺并发请与平台确认。",
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
            description: "批已接受（异步）。Location 指向批聚合视图。",
            headers: {
              ...RATE_LIMIT_HEADERS,
              Location: { description: "批聚合视图 URL：/v1/batches/{id}", schema: { type: "string" } },
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
            description: "idempotency_key_reused（同键不同内容）",
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
        summary: "查询批聚合视图（轮询不消耗限流）",
        description:
          "counts 按 pending/running/succeeded/failed/cancelled/refunded 分桶（另计 unsubmitted = 验证被拒项）。\n" +
          "批终结判定：全部已提交项终结即 completed。部分成功语义：任何时刻 succeeded 的项都可经 /v1/images/{id}/result（或 /videos）单独取件，不必等整批。",
        security: [bearerAuth],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "批 id（POST /batches 的 202 回应中的 id）",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "批聚合视图",
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
        summary: "对账导出（JSON；CSV 后续可加）",
        description:
          "月结对账面：任务 ID、成功/失败数、逐项失败原因 class、计费金额汇总（charged = succeeded 合计；失败退费=按成功计费；refunded = 非成功终结项退回合计；pending = 在途预留）。轮询不消耗限流。",
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
            description: "对账文档",
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
} as const;
