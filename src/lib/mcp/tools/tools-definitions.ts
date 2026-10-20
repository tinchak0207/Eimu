import { AGENT_SKILL_FAMILY_LABELS } from "@/lib/agent-skills";
import { getSkillByIdPublic, listPublicSkills, listSkillFamilies, searchPublicSkills, type AgentSkillView } from "@/lib/agent-skills/registry";
import { EXPERT_IDS } from "@/lib/expert-contract";
import { QUALITY_POLICIES } from "@/lib/media-quality-gate";
import { JSON_RPC_ERROR_CODES, McpRpcError, textResult, truncateToolText } from "../protocol";
import type { McpToolCallResult } from "../protocol";
import { agentSessionPath, runAgent } from "./agent";
import { AGENT_SESSIONS_PATH, AGENT_SETTINGS_PATH, RUN_AGENT_DEFAULT_TIMEOUT_SECONDS, RUN_AGENT_MAX_TIMEOUT_SECONDS } from "./constants";
import { canvasStatePath, runForward, runForwardProjected, snapshotState } from "./forward";
import { asRecord, bilingual, compact, pickString } from "./helpers";
import type { McpToolContext, McpToolDescriptor, ToolDefinition, ToolInputSchema } from "./types";
import { isPlainObject, validateToolArguments } from "./validation";

// 生图/改图的模型 id（`generate_image` 的 `model` 上游是必填，schema 同步宣告为必填）。
const SKILL_FAMILIES = Object.keys(AGENT_SKILL_FAMILY_LABELS) as string[];
const DEFAULT_SKILL_LIMIT = 30;
const MAX_SKILL_LIMIT = 200;

/** 媒体硬检政策的键（单一真源＝`media-quality-gate` 的 `QUALITY_POLICIES`，不另抄一份）。 */
const QUALITY_POLICY_IDS = Object.keys(QUALITY_POLICIES) as string[];

function skillSummary(skill: AgentSkillView) {
  return {
    id: skill.id,
    name: skill.name,
    family: skill.family,
    source: skill.source,
    oneLiner: skill.oneLiner,
    outputKind: skill.outputKind,
    useScenario: skill.useScenario,
    inputType: skill.inputType,
    outputContent: skill.outputContent,
    tags: skill.tags,
    ...(skill.templateId ? { templateId: skill.templateId } : {}),
  };
}

async function runListSkills(args: Record<string, unknown>): Promise<McpToolCallResult> {
  const query = pickString(args, "query");
  const family = pickString(args, "family");
  const limit = typeof args.limit === "number" ? args.limit : DEFAULT_SKILL_LIMIT;

  const all = await listPublicSkills();
  const matched = query ? await searchPublicSkills(query) : all;
  const filtered = family ? matched.filter((skill) => skill.family === family) : matched;
  const page = filtered.slice(0, limit);

  return textResult(
    JSON.stringify(
      {
        total: filtered.length,
        count: page.length,
        families: listSkillFamilies(all),
        skills: page.map(skillSummary),
      },
      null,
      2,
    ),
  );
}

async function runGetSkill(args: Record<string, unknown>): Promise<McpToolCallResult> {
  const id = pickString(args, "id") ?? "";
  const skill = await getSkillByIdPublic(id);
  if (!skill) {
    return textResult(`未找到 id 为 ${id} 的公开技能（私有技能不在此面暴露）。`, true);
  }
  return textResult(
    JSON.stringify(
      {
        ...skillSummary(skill),
        toolIds: skill.toolIds,
        ...(skill.expertId ? { expertId: skill.expertId } : {}),
        ...(skill.aesthetic ? { aesthetic: skill.aesthetic } : {}),
      },
      null,
      2,
    ),
  );
}

function defineTools(): ToolDefinition[] {
  return [
    {
      name: "list_skills",
      title: "列出公开技能",
      description: bilingual(
        "列出公开技能库（builtin / recipe / template 三个来源），可按关键词与题材家族筛选。返回家族 facet 与条目摘要；只返回公开技能，用户私有技能永不出现。",
        "List public skills (builtin / recipe / template) with optional keyword and family filters.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词（风格名/流派/题材/拍摄手法），匹配名称、一句话说明与标签。" },
          family: { type: "string", enum: SKILL_FAMILIES, description: "题材家族 id，见返回的 families 字段。" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SKILL_LIMIT,
            description: `返回条数上限，默认 ${DEFAULT_SKILL_LIMIT}。`,
          },
        },
        additionalProperties: false,
      },
      run: (args) => runListSkills(args),
    },
    {
      name: "get_skill",
      title: "读取单个技能",
      description: bilingual(
        "按 id 读取一条公开技能的完整条目（适用场景、输入面、交付物、可调用工具、主责 Expert、美学锚）。私有技能与此面无关，查不到即不存在。",
        "Read one public skill entry by id.",
      ),
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "技能 id（来自 list_skills）。" } },
        required: ["id"],
        additionalProperties: false,
      },
      run: (args) => runGetSkill(args),
    },
    {
      name: "list_models",
      title: "列出可用模型",
      description: bilingual(
        "列出当前 API key 可用的图像/视频模型，含端点归属（x_endpoint）、能力面与计价（x_coins_per_image / x_coins_per_second）。生成类工具调用前先用它取 model id。",
        "List models available to the current API key, including endpoint routing and pricing metadata. Call this before generate_image / generate_video to obtain a model id.",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) =>
        runForward({ method: "GET", path: "/api/v1/models" }, "list_models", args, ctx),
    },
    {
      name: "generate_image",
      title: "生成图像",
      description: bilingual(
        "按提示词生成图像（同步返回）。计费与配额走既有账本，与 /v1/images/generations 完全同一条扣费路径。因 MCP 结果是文本，默认以 response_format=url 返回链接（除非显式传 b64_json）。",
        "Generate images from a prompt, billed through the same ledger path as /v1/images/generations. Defaults to response_format=url so the text result stays usable.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "提示词，必填，最长 4000 字符。" },
          model: { type: "string", description: "模型 id（必填，先用 list_models 取）。" },
          size: {
            type: "string",
            enum: ["1024x1024", "1536x1024", "1024x1536", "2048x2048"],
            description: "输出尺寸，默认 1024x1024。",
          },
          n: { type: "integer", minimum: 1, maximum: 4, description: "出图张数，1-4，默认 1。" },
          reference_images: {
            type: "array",
            maxItems: 5,
            items: { type: "string", description: "http(s) 或 data:image URL。" },
            description: "参考图 URL 列表，最多 5 张。",
          },
          response_format: { type: "string", enum: ["url", "b64_json"], description: "返回形态，默认 url。" },
        },
        required: ["prompt", "model"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: "/api/v1/images/generations",
            body: (a) => compact({ ...a, response_format: a.response_format ?? "url" }),
          },
          "generate_image",
          args,
          ctx,
        ),
    },
    {
      name: "edit_image",
      title: "编辑图像",
      description: bilingual(
        "对一张输入图按提示词做编辑（同步返回）。image 为图片 URL。计费与配额走既有账本，与 /v1/images/edits 同一条路径。",
        "Edit an input image with a prompt, billed through the same ledger path as /v1/images/edits.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "输入图 URL（http(s) 或 data:image）。" },
          prompt: { type: "string", description: "编辑指令，必填，最长 2000 字符。" },
          model: { type: "string", description: "模型 id，可选；缺省走默认编辑模型。" },
          size: { type: "string", enum: ["1k", "2k"], description: "输出尺寸档，默认 1k。" },
          n: { type: "integer", minimum: 1, maximum: 4, description: "出图张数，1-4，默认 1。" },
          response_format: { type: "string", enum: ["url", "b64_json"], description: "返回形态，默认 url。" },
        },
        required: ["image", "prompt"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: "/api/v1/images/edits",
            body: (a) => compact({ ...a, response_format: a.response_format ?? "url" }),
          },
          "edit_image",
          args,
          ctx,
        ),
    },
    {
      name: "generate_video",
      title: "生成视频",
      description: bilingual(
        "提交视频生成任务（异步，返回 task 与 id，用 get_result 轮询）。计费与配额走既有账本，与 /v1/videos/generations 同一条路径。",
        "Submit an asynchronous video generation task (poll with get_result), billed through the same ledger path as /v1/videos/generations.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "提示词，必填，最长 4000 字符。" },
          model: { type: "string", description: "视频模型 id（必填，先用 list_models 取）。" },
          n: { type: "integer", minimum: 1, maximum: 4, description: "任务数，1-4，默认 1。" },
          size: { type: "string", description: "分辨率或画幅，如 1920x1080 / 16:9。" },
          duration_seconds: { type: "number", description: "时长（秒），可选，取值见模型能力面。" },
          generate_audio: { type: "boolean", description: "是否带音轨（模型支持时）。" },
          callback_url: { type: "string", description: "完成回调地址，可选。" },
        },
        required: ["prompt", "model"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          { method: "POST", path: "/api/v1/videos/generations", body: (a) => compact(a) },
          "generate_video",
          args,
          ctx,
        ),
    },
    {
      name: "tts",
      title: "文本转语音",
      description: bilingual(
        "提交文本转语音任务（异步，返回 task 与 id，用 get_result 轮询）。计费与配额走既有账本，与 /v1/tts/generations 同一条路径。",
        "Submit an asynchronous text-to-speech task (poll with get_result), billed through the same ledger path as /v1/tts/generations.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "要朗读的文本，必填，最长 5000 字符。" },
          voice: { type: "string", description: "音色 id，默认 default。" },
          model: { type: "string", description: "TTS 模型 id，默认 tts-1。" },
          callback_url: { type: "string", description: "完成回调地址，可选。" },
        },
        required: ["input"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward({ method: "POST", path: "/api/v1/tts/generations", body: (a) => compact(a) }, "tts", args, ctx),
    },
    {
      name: "upscale",
      title: "图像放大",
      description: bilingual(
        "放大一张图像。计费与配额走既有账本（含幂等预留与失败退款），与 /v1/upscale 同一条路径。",
        "Upscale an image, billed through the same ledger path as /v1/upscale (including idempotent reserve and refund on failure).",
      ),
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "输入图 URL，必填。" },
          factor: { type: "number", minimum: 1, maximum: 4, description: "放大倍数，默认 2。" },
          ratio: { type: "string", description: "目标画幅比，可选。" },
          size: { type: "string", enum: ["1k", "2k"], description: "输出尺寸档，默认 1k。" },
        },
        required: ["image"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward({ method: "POST", path: "/api/v1/upscale", body: (a) => compact(a) }, "upscale", args, ctx),
    },
    {
      name: "get_quota",
      title: "查询余额",
      description: bilingual(
        "查询当前 API key 绑定账户的余额与币种（与 /v1/quota 同源账本）。",
        "Read the balance and currency of the account bound to the current API key (same ledger as /v1/quota).",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) => runForward({ method: "GET", path: "/api/v1/quota" }, "get_quota", args, ctx),
    },
    {
      name: "get_result",
      title: "轮询任务结果",
      description: bilingual(
        "按任务 id 取异步结果：kind=image（/v1/images/{id}/result）、kind=video（/v1/videos/{id}/result）、kind=tts（/v1/tts/{id}）。生成类工具返回的 id 用它查。",
        "Fetch an asynchronous task result by id: kind=image, kind=video or kind=tts.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["image", "video", "tts"], description: "任务类型。" },
          id: { type: "string", description: "任务 id（generate_* / tts 返回）。" },
        },
        required: ["kind", "id"],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const kind = pickString(args, "kind") ?? "";
        const id = encodeURIComponent(pickString(args, "id") ?? "");
        const path = kind === "image" ? `/api/v1/images/${id}/result` : kind === "tts" ? `/api/v1/tts/${id}` : `/api/v1/videos/${id}/result`;
        return runForward({ method: "GET", path }, "get_result", args, ctx);
      },
    },
    {
      name: "list_canvas_projects",
      title: "列出画布项目",
      description: bilingual(
        "列出本 API key 所属账号的画布项目摘要（id／名称／创建与更新时间／节点数），按更新时间由新到旧。只回本密钥账号自己的项目，不回他人项目。拿到 project_id 后才能用 workflow_write 落图、用 workflow_rollback 回退——改画布产线前先调它找到目标项目。",
        "List canvas projects owned by the current API key's account (id, title, timestamps, node count). Use the returned id as project_id for workflow_write / workflow_rollback.",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) =>
        runForward({ method: "GET", path: "/api/v1/canvas/projects" }, "list_canvas_projects", args, ctx),
    },
    {
      name: "canvas_get_state",
      title: "读取画布快照",
      description: bilingual(
        "读取某个 agent 会话当前画布快照（节点/连线/选中/视口，以及画布产线的可逆声明 dsl 与节点版本索引 node_versions）。dsl 就是画布产线的权威骨架，已自动覆盖存量画布上的产线节点（含没有产线身份键的「提示词节点＋生成配置节点」）——读到 dsl 就直接改，不要自己发明骨架；每步 meta._origin_node_id 由读面自动填好（＝原画布节点 id），原样带回。dsl 为空有两种原因：①画布上确实没有任何产线节点；②画布太大，骨架超出快照预算——此时摘要里带 dsl_omitted: \"budget\"（不代表没有产线），先看节点清单、用 canvas_apply_ops 逐节点改或按画布现状写 DSL 收编（别另建平行节点）。改动画布产线前先读它拿 session_id 对应的现状。会话无快照时上游回 has_state=false。",
        "Read the current canvas snapshot (nodes/connections/dsl/node_versions) of an agent session. The dsl is the authoritative skeleton of the canvas production line and already covers production-line nodes on legacy canvases (including prompt nodes + generation-config nodes that carry no production-line identity key) — edit it directly, never invent a skeleton; each step's meta._origin_node_id is auto-filled by the read surface (= the original canvas node id), carry it back verbatim. An empty dsl has two causes: (1) the canvas has no production-line node; (2) the canvas is too large and the skeleton exceeded the snapshot budget — in that case the summary carries dsl_omitted: \"budget\" (it does NOT mean there is no production line): inspect the node list, edit node-by-node via canvas_apply_ops, or write a DSL from the current canvas (never create parallel nodes).",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "agent 会话 id（画布由该会话持有）。" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) => runForward({ method: "GET", path: (a) => canvasStatePath(a) }, "canvas_get_state", args, ctx),
    },
    {
      name: "workflow_read",
      title: "读取工作流声明",
      description: bilingual(
        "读取画布产线的可逆声明（dsl = 工作流 DSL 源码数组）与当前节点版本索引，供「像改代码一样改工作流」：读 dsl → 改 steps → 用 workflow_write 整份交回。dsl 已覆盖存量画布产线节点（含未带产线身份键的「提示词节点＋生成配置节点」），并含每步 meta._origin_node_id（＝原画布节点 id，由读面自动填好，原样带回）。只投影 dsl 与版本索引，不含节点坐标。要完整画布用 canvas_get_state。",
        "Read the reversible workflow declarations (dsl) and node version index of an agent session's canvas. The dsl already covers production-line nodes on legacy canvases (including prompt nodes + generation-config nodes that carry no production-line identity key), with meta._origin_node_id auto-filled on each step (= the original canvas node id, carry it back verbatim).",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "agent 会话 id（画布由该会话持有）。" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForwardProjected(
          { method: "GET", path: (a) => canvasStatePath(a) },
          "workflow_read",
          args,
          ctx,
          (payload) => {
            const state = snapshotState(payload);
            const p = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
            return {
              has_state: p.has_state === true,
              updated_at: p.updated_at ?? null,
              dsl: Array.isArray(state.dsl) ? state.dsl : [],
              workflow_versions: Array.isArray(state.node_versions) ? state.node_versions : [],
            };
          },
        ),
    },
    {
      name: "workflow_history",
      title: "读取工作流版本史",
      description: bilingual(
        "读取画布节点的版本史（node_versions：每节点的 version/created_at/reason/title）。给 node_id 只回该节点；拿 version 号去 workflow_rollback 回退。只回内容史（title+metadata），不含坐标。",
        "Read per-node version history from an agent session's canvas; pass node_id to filter one node.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "agent 会话 id（画布由该会话持有）。" },
          node_id: { type: "string", description: "只回该节点的版本史；省略回全部节点。" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForwardProjected(
          { method: "GET", path: (a) => canvasStatePath(a) },
          "workflow_history",
          args,
          ctx,
          (payload) => {
            const state = snapshotState(payload);
            const p = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
            const all = Array.isArray(state.node_versions) ? state.node_versions : [];
            const nodeId = pickString(args, "node_id");
            const versions = nodeId
              ? all.filter((entry) => isPlainObject(entry) && (entry as { node_id?: unknown }).node_id === nodeId)
              : all;
            return {
              has_state: p.has_state === true,
              node_id: nodeId ?? null,
              workflow_versions: versions,
            };
          },
        ),
    },
    {
      name: "workflow_write",
      title: "写入工作流声明",
      description: bilingual(
        "把整份工作流声明（DSL）编译成画布操作，落图与否看是否给了 project_id。用法：先 canvas_get_state / workflow_read 读 dsl 作为骨架。\n· dsl 非空 ⇒ 骨架已被读面自动收编（含存量画布上的产线节点），直接在读到的 dsl 上按需增删改 steps、整份 source 交回本工具；每步 meta._origin_node_id 原样带回（＝原画布节点 id），不要自己发明——只有画布上还不存在的新步骤才不带该键（编译器会新增节点）。\n· 改提示词要改「生成步」（kind=image/video 的那一步）的 prompt——生成面板与重跑读的是生成节点自身的 metadata.prompt；若上游另有「提示词节点步」持有同一段提示词（画布把提示词存了两份），把两处改成同一段：只改提示词步不会改变生成输入。\n· 节点上不合 DSL 格式的值（例：size 不是「宽x高」）读面会原样放进该步的 meta（同键，如 meta.size），不会丢；要改它就改 meta 里的同名键。\n· dsl 为空有两种原因：①画布上确实没有任何产线节点；②画布太大，骨架超出快照预算——此时摘要里带 dsl_omitted: \"budget\"（不代表没有产线），先看节点清单、用 canvas_apply_ops 逐节点改或按画布现状写 DSL 收编（别另建平行节点）；只有原因①时才需要你按画布现状写一份完整 DSL。\n· 给了 project_id：编译后原子套用到该画布项目（B 端密钥所属账号的画布；跨账号的 project_id 找不到，画布不动）——这是外部 coding agent 端到端写产线的通道。\n· 没给 project_id：只编译，回 ops 与 summary（纯函数端点 /v1/workflow/compile）。\n校验失败一律回 workflow_dsl_invalid 与逐条 errors；同 id 同节点＝幂等更新（重放不重复建节点）。\n· **铺新产线＝有意动作**：交回会新建节点的 source 时，若 `source.workflow` 不在当前画布 `dsl` 的 ns 里（画布快照没有产线信息、或它来自别的画布／会话记忆，都算不在），工具先回 `confirm_new_line` 要你确认——确认前画布不动。确为有意（用户要铺这条线／你在规划另一张画布）就带 `confirm_new_line: true` 重交同一份 source；若它只是记忆或别的画布的 source 就不要交回。**回执里的新建/更新颗数（`created_node_ids`）必须如实转述，不得声称「无新建」。**",
        "Compile a full workflow declaration (DSL) into canvas ops, and apply it when project_id is given. Usage: read dsl first via canvas_get_state / workflow_read. A non-empty dsl is already auto-adopted as the skeleton (covering production-line nodes on legacy canvases) — edit its steps and send the whole source back, keeping each step's meta._origin_node_id verbatim (= the original canvas node id; only brand-new steps omit it, the compiler adds those nodes). · To change a prompt, edit the prompt on the generation step (the kind=image/video step): the generation panel and re-run read that node's own metadata.prompt. If an upstream \"prompt node\" step holds the same text (the canvas stores the prompt twice), update both to the same text — editing only the prompt step does not change the generation input. Values on a node that do not fit the DSL format (e.g. size that is not \"WxH\") are carried over verbatim by the read surface into that step's meta under the same key (e.g. meta.size) and are not lost; to change such a value, edit the same-named key in meta. An empty dsl has two causes: (1) the canvas has no production-line node; (2) the canvas is too large and the skeleton exceeded the snapshot budget — then the summary carries dsl_omitted: \"budget\" (it does NOT mean there is no production line): inspect the node list, edit node-by-node via canvas_apply_ops, or write a DSL from the current canvas (never create parallel nodes). Only cause (1) requires you to write a full DSL from the current canvas. With project_id it applies the ops atomically to that canvas project (owned by the key's account); without it, compile-only. · New production line = a deliberate action: when you submit a source that would create nodes and `source.workflow` is not in the current canvas `dsl`'s ns (a snapshot with no production-line info, or a source from another canvas / session memory, both count as not-in), the tool first returns `confirm_new_line` for your confirmation — the canvas is untouched until confirmed. If it is genuinely intended (the user asked for this line, or you are planning another canvas) re-submit the same source with `confirm_new_line: true`; if it is merely the source from memory or another canvas, do not submit it back. **Report the created/updated node counts in the receipt (`created_node_ids`) faithfully; never claim \"no new nodes\".**",
      ),
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "object",
            description:
              "整份工作流声明：{ workflow, title?, steps: [{ id, title, kind?, prompt?, needs?, model?, size?, count?, gate?, tool?, meta? }] }（steps 1..256；先 canvas_get_state / workflow_read 读出 dsl 再改其 steps，逐步 meta._origin_node_id 原样带回＝更新原画布节点、省略＝编译器新增节点）。",
          },
          current: {
            type: "object",
            description: "画布当前真相 { nodes, connections }；省略＝用 project_id 项目的现况（推荐）或按空图编译。",
          },
          project_id: {
            type: "string",
            description: "画布项目 id（给了才真的套用到画布；项目必须属于本密钥账号）。",
          },
          dry_run: { type: "boolean", description: "true＝只编译回 ops 与 summary，不落图（给了 project_id 时可用）。" },
          label: { type: "string", description: "给用户看的一句话操作意图，如「把分镜从 3 步扩到 5 步」。" },
        },
        required: ["source"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            // 带 project_id → 落图端点（编译＋套用到 owner 画布）；不带 → 既有纯编译端点。
            path: (a) => (pickString(a, "project_id") ? "/api/v1/canvas/workflow" : "/api/v1/workflow/compile"),
            body: (a) => {
              const projectId = pickString(a, "project_id");
              return projectId
                ? compact({ projectId, source: a.source, current: a.current, label: a.label, dry_run: a.dry_run })
                : compact({ source: a.source, current: a.current, label: a.label });
            },
          },
          "workflow_write",
          args,
          ctx,
        ),
    },
    {
      name: "workflow_rollback",
      title: "回滚工作流节点",
      description: bilingual(
        "把画布某个节点的内容回滚到指定版本（先 workflow_history 查 version）。version 省略＝回上一版；只还原内容（title+metadata），不动坐标/尺寸；回滚本身也落一版（reason=revert），可再回滚回去。要改出新内容用 workflow_write。走 B 端密钥鉴权的画布回退端点：project_id 所属项目必须在本密钥账号名下（跨账号的 project_id 一律拒绝，画布不动）。",
        "Roll a canvas node's content back to a version (or the previous one) via the B-key canvas revert endpoint; the project must belong to the key's account.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "要回滚的节点 id（画布节点 id，如 wf-…）。" },
          project_id: { type: "string", description: "画布项目 id（node 所属 project）。" },
          version: { type: "integer", minimum: 1, description: "目标版本号；省略＝上一版。" },
        },
        required: ["node_id", "project_id"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: (a) => `/api/v1/canvas/nodes/${encodeURIComponent(pickString(a, "node_id") ?? "")}/revert`,
            body: (a) => compact({ projectId: a.project_id, version: a.version }),
          },
          "workflow_rollback",
          args,
          ctx,
        ),
    },
    {
      name: "list_agent_sessions",
      title: "列出 agent 会话",
      description: bilingual(
        "列出本 API key 所属账号的 Eimu agent 会话（session_id / status / title / updated_at），按最近活动由新到旧。这些会话与网页版 AI 助理是同一个账户空间（同一 settings）。拿到 session_id 后可用 get_agent_session 读对话与产物、用 run_agent 继续下任务。",
        "List Eimu agent sessions owned by the current API key's account (id / status / title / updated_at), newest first. Same account space as the web AI assistant.",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) =>
        runForwardProjected({ method: "GET", path: AGENT_SESSIONS_PATH }, "list_agent_sessions", args, ctx, (payload) => {
          const sessions = isPlainObject(payload) && Array.isArray(payload.sessions) ? payload.sessions : [];
          return {
            object: "agent.session.list",
            count: sessions.length,
            sessions: sessions.filter(isPlainObject).map((session) => ({
              session_id: session.session_id ?? null,
              status: session.status ?? null,
              title: session.title ?? null,
              updated_at: session.updated_at ?? null,
            })),
          };
        }),
    },
    {
      name: "get_agent_session",
      title: "读取 agent 会话",
      description: bilingual(
        "读取一个 Eimu agent 会话的内容：view=summary（默认，会话摘要与消息计数）、view=transcript（角色/部件级对话）、view=raw（网关原始消息，体积大）。assistant 的最终文字里含成品图片/影片 URL（用 run_agent 也可直接拿到结构化 artifacts）。会话属于本密钥账号，跨账号一律找不到。",
        "Read one Eimu agent session: view=summary (default) | transcript | raw. The assistant's final text carries finished image/video URLs.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "agent 会话 id（来自 list_agent_sessions）。" },
          view: {
            type: "string",
            enum: ["summary", "transcript", "raw"],
            description: "视图：summary（默认）| transcript | raw。",
          },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const view = pickString(args, "view") ?? "summary";
        const path = (a: Record<string, unknown>) => {
          const id = encodeURIComponent(pickString(a, "session_id") ?? "");
          if (view === "transcript") return `${AGENT_SESSIONS_PATH}/${id}/transcript`;
          if (view === "raw") return `${AGENT_SESSIONS_PATH}/${id}/messages`;
          return `${AGENT_SESSIONS_PATH}/${id}`;
        };
        return runForward({ method: "GET", path }, "get_agent_session", args, ctx);
      },
    },
    {
      name: "get_agent_settings",
      title: "读取 agent 设置",
      description: bilingual(
        "读取本 API key 所属账号的 Eimu agent 设置（interrupt_mode / persona / cost_mode / interaction_mode / beast_mode）。beast_mode（野兽模式）是账号级开关，由 agent orchestrator 即时读取；本工具纯读，不产生费用。",
        "Read the account-level Eimu agent settings (including beast_mode). Read-only, no charge.",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) =>
        runForward({ method: "GET", path: AGENT_SETTINGS_PATH }, "get_agent_settings", args, ctx),
    },
    {
      name: "run_agent",
      title: "运行 agent 任务",
      description: bilingual(
        "把一个任务交给 Eimu 的 agent orchestrator 执行，返回最终回复与成品 URL（artifacts）。注意：这会真实消耗账号额度——orchestrator 会依任务自行使用生成类工具（可能扣费）；纯文本问答不要用它。它会自动建会话（或续用你给的 session_id）、快回 accepted 后由本工具反复轮询取结果；超时返回 status=running，可用 get_agent_session 续查。",
        "Hand a task to Eimu's agent orchestrator and return its final reply plus artifact URLs. This really consumes account credits because the orchestrator may call billed generation tools itself; do not use it for plain text Q&A.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "任务指令，必填，最长 8000 字符。" },
          session_id: { type: "string", description: "续用既有会话；省略则新建一个会话。" },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: RUN_AGENT_MAX_TIMEOUT_SECONDS,
            description: `等待上限（秒），默认 ${RUN_AGENT_DEFAULT_TIMEOUT_SECONDS}，上限 ${RUN_AGENT_MAX_TIMEOUT_SECONDS}。`,
          },
          session_directive: { type: "string", description: "本次会话的额外指令（可选，最长 4000 字符）。" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      run: (args, ctx) => runAgent(args, ctx),
    },
    {
      name: "abort_agent_session",
      title: "中止 agent 会话",
      description: bilingual(
        "中止一个正在运行的 Eimu agent 会话（中断当前回合）。会话必须属于本密钥账号；上游回包原样返回。",
        "Abort a running Eimu agent session (interrupt the current turn); returns the upstream response verbatim.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "要中止的 agent 会话 id。" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          { method: "POST", path: (a) => agentSessionPath(pickString(a, "session_id") ?? "", "/abort"), body: () => ({}) },
          "abort_agent_session",
          args,
          ctx,
        ),
    },
    // ─────────────────────────────────────────── 闸门工具（2026-10-03 MCP 暴露）
    //
    // 这两支是给外部 agent 对**自己的产物**做确定性自检的闸门：不重写任何业务，
    // 只把参数原样交给站内 `/api/harness/**` 端点（契约校验真源＝expert-contract.ts，
    // 媒体硬检真源＝media-quality-gate.ts），回包原样透传。
    // 刻意**不**放在 `/api/v1/**`：该前缀被 next.config.mjs 的 beforeFiles 整包代理给控面，
    // 控面没有这两条 route ⇒ 直打会 404（2026-10-03 线上缺陷）。`/api/harness/**` 未被代理，
    // 由本 Vercel 部署直接服务。漂移探针见 tools.test.ts 的「MCP 工具目标路由漂移」。
    {
      name: "check_delivery_contract",
      title: "校验交付契约",
      description: bilingual(
        "对 Expert 交付物做**契约栏位层**的确定性校验，逐条检查：① expert_id 是合法 Expert；② kind 非空、payload 是非空物件；③ evidence 至少一项可核验指针（url／artifact_path／bytes／duration_sec 任一非空）；④ qc_signature 与内容相符（computeQcSignature 重算比对）；⑤ **该域契约的必填栏位每一栏在 payload 中必须存在且值非空**（undefined／null／空字符串／空白字符串／空数组／空对象一律算缺，缺栏按契约顺序点名）。**这不是品质评分**——它不判断作品好不好，只判断交付物合不合契约；ok:true 只代表「栏位层合格」，不代表成品可用（成品品质请用 evaluate_media_quality）。注意：站内还有一个同名交付闸门，但判据不同——它是在**自由文本**里做栏位名子字符串命中（栏名出现即算过，空值也命中），本工具是**结构化物件**检查（栏位必须在 payload 里且值非空），两者读同一份契约档但**判据不等价**。返回 { ok, errors[], qc_signature }：qc_signature 恒回对本次输入重算出的**期望值**（sha256 校验和，无密钥、无秘密），便于修正或比对。",
        "Deterministic contract-field validation of an Expert deliverable. It checks: (1) expert_id is a known Expert; (2) kind non-empty and payload is a non-empty object; (3) evidence has at least one verifiable pointer (url/artifact_path/bytes/duration_sec); (4) qc_signature matches the content (recomputed via computeQcSignature); (5) **every required field of that domain's contract exists in payload with a non-empty value** (undefined/null/empty or whitespace string/empty array/empty object all count as missing, and missing ones are named in contract order). This is NOT a quality score: ok:true means the contract shape is valid, not that the artifact is good — use evaluate_media_quality for the artifact. Note the in-house gate of the same name has DIFFERENT criteria: it does substring matching of field NAMES in free text (a name's presence passes even with an empty value), whereas this tool inspects a structured object (the field must exist in payload with a non-empty value); both read the same contract file but the criteria are NOT equivalent. Returns { ok, errors[], qc_signature } where qc_signature is always the expected checksum recomputed over the submitted input (sha256, no key, no secret).",
      ),
      inputSchema: {
        type: "object",
        properties: {
          expert_id: {
            type: "string",
            enum: EXPERT_IDS,
            description: "Expert 身份 id（决定允许的交付域与该域的必填契约栏位）。",
          },
          kind: {
            type: "string",
            description: "交付物种类（如 scene_3d / music_track）。",
          },
          payload: {
            type: "object",
            description: "交付物本体（按域 schema；必须含该域契约 requiredFields 的每一栏且值非空）。",
          },
          evidence: {
            type: "object",
            description: bilingual(
              "可核验指针，至少一项非空。**键名两种拼法都接受**：snake_case（`artifact_path`／`duration_sec`）与 camelCase（`artifactPath`／`durationSec`）皆可，**两者同时给时以 camelCase 为准**；`url`／`bytes` 本就同名。",
              "Verifiable pointer, at least one non-empty. BOTH key spellings are accepted: snake_case (`artifact_path`/`duration_sec`) and camelCase (`artifactPath`/`durationSec`); when both are given, camelCase takes precedence. `url`/`bytes` are identical in both spellings.",
            ),
          },
          qc_signature: {
            type: "string",
            description: "QC 签名（computeQcSignature 产出的 sha256 hex）；缺或不符会随 errors 一并回报期望值。",
          },
        },
        required: ["expert_id", "kind", "payload"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: "/api/harness/expert/deliverable/validate",
            body: (a) =>
              compact({
                expert_id: a.expert_id,
                kind: a.kind,
                payload: a.payload,
                evidence: a.evidence,
                qc_signature: a.qc_signature,
              }),
          },
          "check_delivery_contract",
          args,
          ctx,
        ),
    },
    {
      name: "evaluate_media_quality",
      title: "媒体硬检",
      description: bilingual(
        "对已生成完成的影片/图片/音频做确定性硬检（分辨率/时长/文件大小/音轨/非静音等），套用我方政策阈值。三条诚实契约：① 量测在**我们的服务器**上执行（本机 ffprobe/ffmpeg）；本部署环境（Vercel serverless）**不保证有 ffprobe/ffmpeg**，量测失败会**原样回** { ok:false, failures:[{ code:\"probe_unavailable\" }] }——**probe_unavailable ≠ 通过**，它代表「量测没有发生」，不是「检查通过」；② 呼叫方也可以自己 ffprobe 后把 probe 传进来，我们只负责套用**我们的政策与阈值**；③ 给了 probe 就不再执行服务器量测。返回 { ok, failures[], measured, policyId }。",
        "Deterministic hard check of a finished video/image/audio against our policy thresholds. Honesty contract: measurement runs on OUR server and this deployment (Vercel serverless) may lack ffprobe/ffmpeg, in which case it returns ok:false with a probe_unavailable failure — probe_unavailable is NOT a pass, it means nothing was measured. Alternatively pass your own ffprobe `probe` and we only apply our policy/thresholds. Returns { ok, failures[], measured, policyId }.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          media_url: {
            type: "string",
            description: "要量测的媒体地址（http(s) URL）或服务器可读路径；省略时必须给 probe。",
          },
          probe: {
            type: "object",
            description:
              "呼叫方自行 ffprobe 的结果（MediaProbe 形状：status / container / durationSec / sizeBytes / video / audio）；给了它我们只套政策，不做服务器量测。",
          },
          policy: {
            type: "string",
            enum: QUALITY_POLICY_IDS,
            description: `政策 id，默认 video_default（可选：${QUALITY_POLICY_IDS.join(" / ")}）。`,
          },
        },
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: "/api/harness/media/quality",
            body: (a) => compact({ media_url: a.media_url, probe: a.probe, policy: a.policy }),
          },
          "evaluate_media_quality",
          args,
          ctx,
        ),
    },
  ];
}

const TOOL_DEFINITIONS: ToolDefinition[] = defineTools();

const TOOL_INDEX: Map<string, ToolDefinition> = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

/** `tools/list` 的回应内容（只暴露 descriptor，不外泄 run/schema 内部物件）。 */
export const MCP_TOOLS: readonly McpToolDescriptor[] = TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
}));

export function listToolNames(): string[] {
  return TOOL_DEFINITIONS.map((tool) => tool.name);
}

/**
 * 执行一次 `tools/call`。
 * - 未知工具 → `isError: true` 的工具结果（**不是** -32600/-32601，模型看得懂并能自救）。
 * - 参数不合 schema → 抛 `McpRpcError(-32602)`，由 route 转成 JSON-RPC 错误。
 * - 上游/网路失败 → `isError: true` 的工具结果，附上游原文（已消毒、已截断）。
 */
export async function callTool(
  name: string,
  rawArguments: unknown,
  ctx: McpToolContext,
): Promise<McpToolCallResult> {
  const tool = TOOL_INDEX.get(name);
  if (!tool) {
    return textResult(`未知工具：${name}。可用工具请调用 tools/list。`, true);
  }

  // MCP 允许省略 arguments；null 也当空物件（比照官方 SDK 的宽容度）。
  const args = rawArguments === undefined || rawArguments === null ? {} : rawArguments;
  const problem = validateToolArguments(tool.inputSchema, args);
  if (problem) {
    throw new McpRpcError(JSON_RPC_ERROR_CODES.invalidParams, `工具 ${name} 参数不合法：${problem}`);
  }

  try {
    return await tool.run(asRecord(args), ctx);
  } catch (error) {
    if (error instanceof McpRpcError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // 只回讯息、不回 stack；dispatch 失败的原文经消毒后可见。
    return textResult(`工具 ${name} 执行失败：${truncateToolText(message, 2_000)}`, true);
  }
}

/** 供测试检查 schema 与描述（不要拿它做生产逻辑）。 */
export function __getToolSchemaForTests(name: string): ToolInputSchema | undefined {
  return TOOL_INDEX.get(name)?.inputSchema;
}
