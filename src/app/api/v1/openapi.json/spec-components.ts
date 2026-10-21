import { DURABLE_IMAGE_SIZES } from "@/lib/generation-core/durable-image-sizes";

export const COMPONENTS = {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "sk-biz-<key>",
        description: "聚合平台用的业务密钥，格式 `sk-biz-...`。限流 60 requests/minute。",
      },
    },
    responses: {
      ErrorResponse: {
        description: "OpenAI 风格错误体。trace_id 同步落在 `X-Request-Id` 回应头。",
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
          message: { type: "string", description: "英文 + 中文双语错误描述。" },
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
              "稳定错误代码：invalid_json, missing_prompt, prompt_too_long, missing_model, model_not_found, model_not_permitted, unsupported_size, invalid_n, no_endpoints, insufficient_balance, upstream_failed, control_plane_unavailable, idempotency_key_reused, task_not_found, result_not_ready, missing_image, missing_data, image_too_large, method_not_allowed, invalid_request_body, missing_requests, empty_requests, batch_too_large, invalid_max_in_flight, invalid_item, invalid_kind, invalid_control_nets, submission_failed, batch_not_found",
          },
          param: { type: ["string", "null"] },
          trace_id: { type: "string", description: "与 X-Request-Id 回应头相同。" },
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
          "单个生成请求：栏位与 /images/generations（kind=image）或 /videos/generations（kind=video）的请求体一致。kind 缺省时由 duration_seconds/generate_audio 判别，再缺省视为 image。",
        required: ["model", "prompt"],
        properties: {
          kind: { type: "string", enum: ["image", "video", "image_generate", "video_generate"] },
          model: { type: "string" },
          prompt: { type: "string", maxLength: 4000 },
          n: { type: "integer", minimum: 1, maximum: 4 },
          size: { type: "string" },
          quality: { type: "string", enum: ["standard", "hd", "high"], description: "hd/high → quality 档，其余 fast。" },
          response_format: { type: "string", enum: ["url", "b64_json"] },
          duration_seconds: { type: "number", description: "视频项专属。" },
          generate_audio: { type: "boolean", description: "视频项专属。" },
          callback_url: { type: "string", format: "uri" },
          control_nets: {
            type: "array",
            description: "图片项专属，最多 4 项，规则同 /images/generations。",
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
            description: "声明性栏位：实际并发由平台池化治理（全量提交 + scheduler 排队）。",
          },
        },
      },
      BatchAcceptedItem: {
        type: "object",
        required: ["index", "task_id", "accepted", "task_url"],
        properties: {
          index: { type: "integer", description: "对应 requests 索引（0 起）。" },
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
          submitted: { type: "integer", description: "已成为任务的项数。" },
          unsubmitted: { type: "integer", description: "验证/提交失败、永远不会变成任务的项数。" },
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
        description: "quota 单位。charged = succeeded 合计（失败退费=按成功计费）；refunded = 非成功终结项退回；pending = 在途预留。",
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
          status: { type: ["string", "null"], description: "内部原始状态。" },
          task_state: { $ref: "#/components/schemas/TaskStatus" },
          model: { type: ["string", "null"] },
          kind: { type: ["string", "null"] },
          billed: { type: "boolean", description: "成功才计费：只有 succeeded 为 true。" },
          failure_class: { type: ["string", "null"] },
          failure_detail: { type: ["string", "null"] },
          error: { type: ["object", "null"], description: "未提交项的拒绝原因（ErrorBody 形状）。" },
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
            description: "失败原因分布：job 的 failure_class + 未提交项的验证错误码。",
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
                failure_detail: { type: ["string", "null"], description: "截断至 200 字符。" },
                error_code: { type: ["string", "null"], description: "未提交项的验证错误码。" },
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
          prompt: { type: "string", maxLength: 500, description: "截断至 500 字符。" },
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
          reason: { type: "string", description: "额外诊断原因（overloaded 类失败时有）。" },
        },
      },
      GenerationTask: {
        type: "object",
        description: "图像/影片共用的任务回应（非同步 202 与轮询共用）。",
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
          "metadata",
          "cancellation_requested",
          "task_url",
          "request_config",
        ],
        properties: {
          object: { type: "string", enum: ["image_generation.task"] },
          id: { type: "string" },
          task_id: { type: "string" },
          status: { $ref: "#/components/schemas/TaskStatus" },
          created: { type: "integer", description: "Unix 时间戳（秒）。" },
          model: { type: "string" },
          requested_count: { type: "integer" },
          completed_count: { type: "integer" },
          primary_result_id: { type: ["string", "null"] },
          result_ids: { type: "array", items: { type: "string" } },
          retry_of_task_id: { type: ["string", "null"] },
          metadata: {
            type: "object",
            additionalProperties: true,
            description: "任务提交时携带的工作流元数据（`workflow.metadata`）；无元数据时为空对象，恒存在。",
          },
          cancellation_requested: {
            type: "boolean",
            description: "是否已请求取消该任务（收到取消请求后为 true），恒存在。",
          },
          task_url: { type: "string" },
          request_config: { $ref: "#/components/schemas/RequestConfig" },
          result_url: { type: "string", description: "仅 `succeeded` 时存在。" },
          data: {
            type: "array",
            description: "仅 `succeeded` 时存在。",
            items: { $ref: "#/components/schemas/TaskArtifact" },
          },
          error: { $ref: "#/components/schemas/TaskError", description: "仅 `failed` 时存在。" },
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
          video_url: { type: ["string", "null"], description: "第一个 artifact 的 url；无则 null。" },
          data: { type: "array", items: { $ref: "#/components/schemas/TaskArtifact" } },
        },
      },
      ModelCapabilities: {
        type: "object",
        description:
          "x_capabilities：逐模型的能力契约（对称差 D23／P1-7），聚合平台可用它决定是否把模型上架、以及提交前预检。数量面的值真源＝执行端常数，与真的挡人的闸同源；但**能力宣告 ≠ 一定能提交**（上限是全站共同上限，模型／上游可能更严）。",
        properties: {
          modelId: { type: "string" },
          mediaType: { type: "string", enum: ["image", "video"] },
          aspectRatios: { type: "array", items: { type: "string" } },
          resolutions: { type: "array", items: { type: "string" } },
          durations: { type: "array", items: { type: "integer" } },
          referenceImages: { type: "boolean", description: "该模型是否收参考图（不收则省略 maxReferenceImages）。" },
          maxReferenceImages: {
            type: "integer",
            description:
              "每次请求可带的参考图上限（只有 referenceImages=true 的模型有）。值＝/v1/images/generations 的 invalid_reference_images 闸。",
          },
          maxBatchCount: {
            type: "integer",
            description:
              "每次请求可出的张数／段数上限（每个模型都有）。值＝/v1/images|videos/generations 的 `n` 闸，超限回 400 invalid_n。",
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
            description: "只有宣告超分链路的模型有；只列**此刻可提交**的档位。",
          },
        },
      },
      ModelObject: {
        type: "object",
        required: ["id", "object", "created", "owned_by", "x_display_name", "x_endpoint", "x_docs_url", "x_openapi_url"],
        description:
          "图像与视频模型同在一张表。用 `x_capabilities.mediaType` 或 `x_endpoint` 区分：图像模型带 `x_coins_per_image`（按张），视频模型带 `x_coins_per_second`（按秒，随解析度浮动）。",
        properties: {
          id: { type: "string" },
          object: { type: "string", enum: ["model"] },
          created: { type: "integer" },
          owned_by: { type: "string" },
          x_display_name: { type: "string" },
          x_endpoint: {
            type: "string",
            enum: ["/v1/images/generations", "/v1/videos/generations"],
            description: "该模型该往哪个端点投递。投错端点会收到 400 unsupported_model。",
          },
          x_coins_per_image: {
            type: "object",
            description: "只有图像模型有。",
            properties: {
              standard: { type: "number", description: "standard/fast 模式的单价（coins）。" },
              hd: { type: "number", description: "hd/quality 模式的单价；与 standard 同价时省略。" },
            },
          },
          x_coins_per_second: {
            type: "object",
            description:
              "只有视频模型有。key 是解析度（见 `x_capabilities.resolutions`），value 是每秒单价（coins）。总价 = 单价 × durationSeconds。",
            additionalProperties: { type: "number" },
          },
          x_coins_per_second_with_audio: {
            type: "object",
            description: "只有视频模型且开音轨要加价时才有；与无音同价时省略。",
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
          model: { type: "string", description: "支援的图像模型 id，见 GET /v1/models。" },
          prompt: { type: "string", maxLength: 4000, minLength: 1 },
          n: { type: "integer", minimum: 1, maximum: 4, default: 1, description: "一次出几张。" },
          size: {
            type: "string",
            enum: [...DURABLE_IMAGE_SIZES],
            default: "1024x1024",
            description: "已知可交的上游尺寸白名单（唯一真源＝执行端常数）；白名单外具名拒 unsupported_size。" },
          resolution: {
            type: "string",
            enum: ["1k", "2k", "4k"],
            description:
              "目标档位（显式键；别名 `output_resolution`）。优先序：显式档位 > `size` 档位字串 > `size` 像素长边 > `quality`（hd⇒2k、其余⇒1k）> 1k；"
              + "模型未宣告该档位 ⇒ 具名拒 `resolution_not_declared_by_model`（不静默降级）。4K 只能由这里或 `size` 带到此值。",
          },
          output_resolution: { type: "string", enum: ["1k", "2k", "4k"], description: "`resolution` 的别名。" },
          quality: {
            type: "string",
            enum: ["standard", "hd", "high"],
            default: "standard",
            description: "hd/high 对映内部 quality 模式；standard 对映 fast。" },
          response_format: {
            type: "string",
            enum: ["url", "b64_json"],
            default: "b64_json",
            description: "未传或非 url 一律按 b64_json 处理；legacy 同步分支上游缺 b64 时该项降级回 URL。" },
          async: { type: "boolean", default: true, description: "production 一律非同步 202；此栏位仅向后相容。" },
          callback_url: { type: "string", format: "uri", description: "任务完成时的 webhook 回调。" },
        },
      },
      ImageObject: {
        type: "object",
        description: "OpenAI 风格图片物件（legacy 同步回应用）。",
        properties: {
          url: { type: "string", format: "uri" },
          b64_json: { type: "string" },
          revised_prompt: { type: "string" },
          width: { type: "integer", nullable: true, description: "实测输出宽（拿不到回 null，不以 0 冒充）。" },
          height: { type: "integer", nullable: true, description: "实测输出高（拿不到回 null，不以 0 冒充）。" },
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
          image: { type: "string", description: "base64 原图。" },
          prompt: { type: "string", maxLength: 2000, minLength: 1 },
          model: { type: "string", description: "可选；走 resolveBridgeModel 归一，可为 null 用预设。" },
          size: { type: "string", enum: ["1k", "2k"], default: "1k" },
          n: { type: "integer", minimum: 1, maximum: 4, default: 1 },
          ratio: { type: "string", description: "宽高比，可选。" },
        },
      },
      UploadRequest: {
        type: "object",
        required: ["data"],
        properties: {
          data: { type: "string", description: "base64 图片（原图约 20MB，base64 上限 ~30MB）。" },
          mimeType: { type: "string", default: "image/png" },
        },
      },
      UploadResponse: {
        type: "object",
        required: ["mediaId"],
        properties: {
          mediaId: { type: "string", description: "上传后拿到的 media id，供 edits/upscale 引用。" },
        },
      },
      UpscaleRequest: {
        type: "object",
        required: ["image"],
        properties: {
          image: { type: "string", description: "base64 原图。" },
          upscale_tier: {
            type: "string",
            enum: ["1k", "2k", "4k"],
            description:
              "目标档位（显式键，与 `size`／`factor` 同时给且矛盾时具名拒 `upscale_factor_conflict`）。别名：`tier`、`output_resolution`。未给＝当下最高可提交档位。",
          },
          factor: {
            type: "number",
            description:
              "档位倍率写法：`2`⇒2k、`4`⇒4k。**不是任意倍率**——不落在任何档位上的值具名拒 `upscale_factor_conflict`。别名：`upscale`、`scale`。",
          },
          ratio: { type: "string", description: "宽高比，可选。gpt-image-2 后端会把它贴近模型已宣告的可提交比例，实际采用值回报在 `upscale.ratio`。" },
          size: {
            type: "string",
            enum: ["1k", "2k"],
            description:
              "旧写法：上游 bridge 的基底档（白名单只有 `1k`／`2k`，4K 靠 `factor=4` 推上去）。单给 `size` 即该档位；与 `factor` 同给则按档位组合配对（`(\"2k\",4)`⇒4k）。像素尺寸写法（`\"1024x1024\"`）只作计费提示。",
          },
        },
      },
      VideoGenerationRequest: {
        type: "object",
        required: ["model", "prompt"],
        properties: {
          model: { type: "string", description: "支援的影片模型 id，见 GET /v1/models。" },
          prompt: { type: "string", maxLength: 4000, minLength: 1 },
          n: { type: "integer", minimum: 1, maximum: 4, default: 1 },
          size: { type: "string", description: "接受 \"16:9\" 与 \"1920x1080\" 两种写法，归一成 catalog 的 aspectRatio。" },
          duration_seconds: { type: "integer", description: "影片时长（秒）；由 catalog 归一，非法值回预设。" },
          generate_audio: { type: "boolean", description: "是否生成音讯；由 catalog 归一。" },
          response_format: { type: "string", enum: ["url"], default: "url", description: "影片只支援 url（无 b64 通道）。" },
          callback_url: { type: "string", format: "uri", description: "任务完成时的 webhook 回调。" },
        },
      },
    },
} as const;
