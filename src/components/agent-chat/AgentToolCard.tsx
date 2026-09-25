"use client";

import { memo, type ComponentType, type ReactNode } from "react";
import {
  Bot,
  Check,
  Clapperboard,
  Coins,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Search,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentToolCallItem } from "@/lib/agent-chat-types";
import { taskStatusTone } from "@/lib/agent-task-status";
import { AgentParamDisclosure } from "./AgentParamDisclosure";

export interface AgentToolCardProps {
  item: AgentToolCallItem;
}

type RowIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

/* ─────────────────── 工具类型图标（2026-09-20 對版預覽） ───────────────────
 *
 * 行首那個圖標說「這是哪一類動作」（工具類型），不再兼職說狀態：
 * 狀態只由行尾的 Loader2/Check + 狀態詞承擔（見 STATUS_META）。
 * 兩件事擠進同一個圖標＝使用者分不出「跑完了」和「這是搜尋工具」。
 *
 * 判定順序＝優先序，第一個命中者勝出；全表挑不到就 Wrench（不假造類型）。
 */

/**
 * 內建工具的精確映射：這些 id 太短，片段規則會互相誤吃
 * （todoread 含 read、image_edit 含 edit），所以精確點名。
 */
const TOOL_ROW_EXACT: Record<string, RowIcon> = {
  bash: Wrench, // 终端命令
  read: Search, // 读取文件：检索既有内容
  write: LayoutGrid, // 写入文件：落到画布/文件面
  edit: LayoutGrid,
  glob: Search,
  grep: Search,
  ls: Search,
  webfetch: Search,
  fetch: Search,
  patch: LayoutGrid,
  todowrite: LayoutGrid,
  todoread: LayoutGrid,
  task: Bot, // 派发子任务＝子代理族
};

/** 片段规则（依 TOOL_TITLES 表里的工具族命名）。 */
const TOOL_ROW_RULES: Array<{ match: RegExp; Icon: RowIcon }> = [
  { match: /subagent/, Icon: Bot }, // 子代理派遣/状态
  { match: /quote|price|coin|cost|billing/, Icon: Coins }, // 报价/单价/计费
  // 影片/剪辑/时间线：keyframe_render 这类「渲染」也归影片族判在前面。
  { match: /video|film|trailer|keyframe|last_frame|timeline|editing|movie|clip/, Icon: Clapperboard },
  // 音乐/语音/3D 脚本：也是「生成」，但生成的不是图，先判掉免得被图像族吃掉。
  { match: /music|audio|tts|speak|voice|sound|blender|gltf/, Icon: Wrench },
  // 研究/理解/检索/审查：找既有信息，不产出新资产。
  { match: /search|grep|glob|read|fetch|web|doc|vision|bible|script|story|asset|provenance|evidence|audit|qc|consistency|analyze|inspect|lint|find/, Icon: Search },
  // 画布/工作流/导演台：节点式操作面。判在图像族前面，因为
  // canvas_create_generation_flow、workflow_generate 这类 id 也含「生成」。
  { match: /canvas|workflow|director/, Icon: LayoutGrid },
  // 生图/图片处理。
  { match: /image|img|photo|picture|generat|render|repair|upscale|remove|tryon|garment|product|aspect|reflow|moodboard|emotion|sketch|style|character|cast|canonical|scene|shot|cover/, Icon: ImageIcon },
  // 写回面：写在图像族后面，让 image_edit 先被判成生图。
  { match: /node|layout|draw|write|edit|patch|apply|connect|rerun/, Icon: LayoutGrid },
];

/**
 * 工具 id → 行首类型图标（纯函数，可测）。
 * 认不出来的一律 Wrench：图标准确性比「看起来有个性」重要。
 */
export function toolRowIcon(tool: string): RowIcon {
  const id = tool.trim().toLowerCase();
  const exact = TOOL_ROW_EXACT[id];
  if (exact !== undefined) return exact;
  for (const rule of TOOL_ROW_RULES) {
    if (rule.match.test(id)) return rule.Icon;
  }
  return Wrench;
}

interface ToolRowStatusMeta {
  /** 行尾状态词（對版預覽語彙：运行中… / 完成 / 失败）。 */
  word: string;
  /** 状态词着色：运行＝ios-blue、完成＝灰、失败＝唯一红。 */
  wordTone: string;
  /** 状态图标（缺席＝纯状态词，例如失败）。 */
  Icon?: RowIcon;
  iconTone?: string;
}

// 状态语义（进行中/失败/是否终态）仍查 agent-task-status.ts 单一语义表；
// 这里的字面词与着色是行尾的展示层。
// 「已完成」不再上车：工具行说的是这一刻在不在跑/跑完没有，不是工单状态。
const STATUS_META: Record<AgentToolCallItem["status"], ToolRowStatusMeta> = {
  running: { word: "运行中…", wordTone: "text-ios-blue", Icon: Loader2, iconTone: "text-ios-blue/70" },
  // 中继態：任務已提交、成品未到（artifact_pending）。金色胶囊已下线（0920 裁定），
  // pending 与 running 同为「还在跑」：ios-blue 转圈，等 image/video/audio.done
  // 或 image.failed 才转 ok/failed。
  pending: { word: "运行中…", wordTone: "text-ios-blue", Icon: Loader2, iconTone: "text-ios-blue/70" },
  ok: { word: "完成", wordTone: "text-foreground/45", Icon: Check, iconTone: "text-ios-green" },
  // 失败没有状态图标：红色状态词 + 行下的错误原文（error）已经说清楚，
  // 再来一个红叉是同一句话说三遍。
  failed: { word: "失败", wordTone: "text-ios-red" },
};

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * 工具名 → 人话标题（F2）。画面上不许出现 `subagent_dispatch` 这种函数名：
 * 那是 debug 视图的语言，不是给用户的。未知工具原样回落工具名 —— 不假造名字。
 * 原始函数名不消失，只是收进展开抽屉（AgentParamDisclosure 的 toolName）。
 */
const TOOL_TITLES: Record<string, string> = {
  // ── 內建 ──
  bash: "终端命令",
  read: "读取文件",
  write: "写入文件",
  edit: "修改文件",
  glob: "查找文件",
  grep: "搜索内容",
  ls: "列出目录",
  webfetch: "抓取网页",
  fetch: "抓取网页",
  todowrite: "更新任务清单",
  todoread: "查看任务清单",
  question: "向你提问",
  skill: "载入技能",
  task: "派发子任务",
  patch: "应用补丁",
  invalid: "invalid",
  // ── 子代理 ──
  subagent_dispatch: "派遣子代理",
  subagent_status: "查看子代理状态",
  // ── 研究與理解 ──
  search_web: "搜索网络",
  vision_analyze: "分析图片",
  doc_struct: "解析文档结构",
  world_bible_extract: "提取世界观设定",
  script_scene_parse: "解析剧本分场",
  storyboard_qc_17: "分镜 17 项体检",
  story_sequence_consistency: "故事连贯性检查",
  // ── 生圖與圖片處理 ──
  image_generate: "生成图片",
  image_edit: "编辑图片",
  image_upscale: "放大图片",
  image_upload: "上传图片",
  image_get_result: "取回图片结果",
  image_quote: "查询图片单价",
  quote_bundle: "整包报价",
  background_remove: "抠图去背",
  upscale_audit: "放大质量审查",
  canvas_generate_image: "画布生图",
  canvas_get_state: "读取画布",
  canvas_apply_ops: "套用画布操作",
  canvas_create_generation_flow: "建立生成流程",
  product_conditioned_generation: "商品条件生图",
  product_lock: "锁定商品",
  virtual_tryon: "虚拟试穿",
  garment_extract: "提取服装",
  garment_dna_lock: "锁定服装特征",
  model_identity_lock: "锁定模特形象",
  hand_contact_repair: "手部接触修复",
  scene_pack_batch: "场景批量生成",
  shot_grid_batch: "分镜格批量生成",
  style_aligned_batch: "风格对齐批量生成",
  style_dna_extract: "提取风格特征",
  style_anchor_sref: "风格锚定（sref）",
  sketch_lock: "锁定线稿",
  cast_asset_lock: "锁定角色资产",
  canonical_key_art_lock: "锁定主视觉",
  character_dna_turnaround: "角色四视图",
  moodboard_diverge_converge: "情绪板发散收敛",
  emotion_board_matrix: "情绪板矩阵",
  outlier_audit_regenerate: "离群图筛查与重生",
  aspect_reflow: "多画幅矩阵重排",
  multi_aspect_reflow: "多画幅重排",
  platform_reflow: "平台规格适配",
  // ── 影片 ──
  video_quote: "查询视频单价",
  video_upload: "上传视频",
  last_frame_video_chain: "首尾帧续接视频",
  keyframe_render: "生成关键帧",
  // ── 音樂與語音 ──
  music_gen: "生成音乐",
  tts_speak: "语音合成",
  audio_first_timeline: "音频优先时间线",
  // ── 剪輯與時間線 ──
  timeline_query: "读取时间线",
  timeline_ops: "时间线操作",
  timeline_rhythm: "时间线节奏分析",
  timeline_style: "时间线风格与字幕",
  timeline_mix: "时间线混音",
  timeline_master: "导出时间线母版",
  timeline_lint: "时间线体检",
  timeline_restore: "还原时间线版本",
  editing_manifest: "生成剪辑清单",
  // ── 工作流 ──
  workflow_start: "启动工作流",
  workflow_add_node: "新增节点",
  workflow_connect: "连接节点",
  workflow_disconnect: "断开连接",
  workflow_update_node: "更新节点",
  workflow_rerun_node: "重跑节点",
  workflow_generate: "执行节点生成",
  workflow_status: "查看工作流状态",
  // ── 3D／Blender／導演台 ──
  blender_exec: "执行 Blender 脚本",
  blender_render: "Blender 渲染",
  blender_export_gltf: "导出 glTF 模型",
  director_get_state: "读取导演台",
  director_propose_plans: "提出布景方案",
  director_apply_proposal: "套用方案",
  director_manage_plan: "管理方案",
  director_manage_shot: "管理镜头",
  director_manage_group: "管理群组",
  director_create_element: "新增元素",
  director_update_element: "更新元素",
  director_delete: "删除元素",
  director_select: "选中元素",
  director_transport: "播放控制",
  director_set_lock: "锁定设置",
  director_set_camera_keyframe: "设镜头关键帧",
  director_set_motion_keyframe: "设动态关键帧",
  director_upsert_action: "更新分镜动作",
  director_project_control: "项目控制",
  director_prepare_export: "准备导出",
  // ── 資產與交付 ──
  asset_search: "搜索资产",
  asset_get: "读取资产",
  asset_activate: "启用资产",
  asset_provenance_archive: "资产溯源归档",
  delivery_assets: "聚合成交付包",
  detail_page_manifest: "生成详情页排版",
  detail_page_evidence_map: "卖点找图内证据",
  exhibition_delivery_manifest: "展陈交付清单",
  run_py: "运行 Python 脚本",
};

export function toolDisplayName(tool: string): string {
  return TOOL_TITLES[tool] ?? tool;
}

/**
 * 参数摘要的人话预览（F2）：只挑「人能读懂」的白名单栏位（子任务标签、
 * 命令、路径、关键词…），挑不到就回 undefined —— 默认渲染绝不把 raw JSON
 * 或半截 `{"async":false…` 端到用户面前。完整 JSON 收进展开抽屉。
 */
export function toolArgPreview(args: string): string | undefined {
  const t = args.trim();
  if (t.length === 0) return undefined;
  const humanize = (v: string): string | undefined => {
    const s = v.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\s+/g, " ").trim();
    return s.length > 0 ? s : undefined;
  };
  let obj: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    // 被网关截断的半截 JSON（补了省略号）：下面用白名单栏位做宽松提取。
  }
  if (obj) {
    for (const key of ["label", "command", "filePath", "file_path", "pattern", "query", "url", "prompt", "description"]) {
      const v = obj[key];
      if (typeof v === "string") {
        const s = humanize(v);
        if (s !== undefined) return s;
      }
    }
    return undefined; // 只有布林/数字/巢状等没人话的栏位：不显示 raw JSON。
  }
  if (t.startsWith("{")) {
    // 半截 JSON：只从白名单栏位里摘一段人能读的值，绝不显示 JSON 片段本身。
    // 收尾引号可缺（网关截断可能正好切在字符串中间）。
    const m = /"(label|command|filePath|file_path|pattern|query|url|prompt|description)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t);
    if (m) return humanize(m[2]);
    return undefined;
  }
  return humanize(t.split("\n")[0]);
}

function AgentToolCardComponent({ item }: AgentToolCardProps) {
  const status = STATUS_META[item.status];
  const running = item.status === "running";
  // 图标转圈：running（工具自身在执行）与 pending（任务已提交、成品在路上）
  // 都是「还在跑」，都转 —— 停在静止图标上等于谎报已结束。转不转由语义表的
  // pending 色调（进行中）裁决，不再各自字面比较。
  const spinning = taskStatusTone(item.status).tone === "pending";
  // 执行中进度：只有 running 且网关回了 tool.progress 才有。终态后忽略（不冒充还在跑）。
  // pending 没有进度帧（进度是工具内部的计数，提交出去后由成品事件定案），不得假造。
  const progress = running ? item.progress : undefined;
  const pct = progress ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  // F2：默认渲染只有人话——人话标题；函数名与完整参数进展开抽屉。
  // 参数摘要与币数都不在行内：行只说「哪个动作、什么状态」，细节点行进抽屉
  // （2026-09-20 對版預覽，币数与 key-value 细目同住展开面板）。
  const displayName = toolDisplayName(item.tool);
  const ToolIcon = toolRowIcon(item.tool);
  const StatusIcon = status.Icon;
  // 没有参数 = 没有抽屉。这时候已结算的币数仍然要看得见：网关可能把
  // tool.invoke 弄丢（只补发 tool.result），花出去的钱不许凭空消失。
  const panelMounted = item.argsSummary !== undefined;
  const nakedCost = !panelMounted && item.costCoins !== undefined ? item.costCoins : undefined;

  // 工具行（2026-09-20 Grok 级无底色细行）：类型图标 + 人话标题（截断吃满剩余
  // 宽度）+ 右端状态（Loader2/Check + 状态词）。无参数可展开时行不当按钮
  // （render div）；有参数时整行是 AgentParamDisclosure 的触发器（点行展开）。
  const renderRow = (api: { open: boolean; toggle?: () => void }): ReactNode => {
    const content = (
      <>
        <ToolIcon className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-ios-footnote text-foreground/60">
          {displayName}
        </span>
        {nakedCost !== undefined && (
          <span className="flex shrink-0 items-center gap-1 text-ios-footnote tabular-nums text-muted-foreground">
            <Coins className="h-3 w-3" aria-hidden="true" />
            {formatCoins(nakedCost)} 币
          </span>
        )}
        {StatusIcon !== undefined && (
          <StatusIcon
            className={cn("h-3.5 w-3.5 shrink-0", spinning && "animate-spin", status.iconTone)}
            aria-hidden="true"
          />
        )}
        {/* 状态词（无胶囊）：whitespace-nowrap 保证不被长工具名挤出行
            （工具名那一侧自己 truncate 让位）。 */}
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-ios-footnote tabular-nums",
            status.wordTone,
          )}
        >
          {status.word}
        </span>
      </>
    );
    if (api.toggle === undefined) {
      return (
        <div className="flex min-h-11 w-full items-center gap-2 rounded-[12px] px-2 -mx-2">
          {content}
        </div>
      );
    }
    return (
      <button
        type="button"
        onClick={api.toggle}
        aria-expanded={api.open}
        aria-controls={`agent-args-${item.id}-params`}
        className="flex min-h-11 w-full cursor-pointer touch-manipulation items-center gap-2 rounded-[12px] px-2 -mx-2 text-left transition-colors hover:bg-white/55 select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 [-webkit-tap-highlight-color:transparent]"
      >
        {content}
      </button>
    );
  };

  return (
    <div className="agent-rise flex flex-col gap-1">
      {/* D-19 分层参数 + D-23 窄屏底部抽屉。展开与布局切换都归 AgentParamDisclosure，
          这一行只负责说「这次调了什么工具、跑到哪一步」；参数与花费都在抽屉里，
          整行触发：点行展开。 */}
      {item.argsSummary !== undefined ? (
        <AgentParamDisclosure
          argsSummary={item.argsSummary}
          idPrefix={`agent-args-${item.id}`}
          toolName={item.tool}
          costCoins={item.costCoins}
          trigger={(api) => renderRow(api)}
        />
      ) : (
        renderRow({ open: false })
      )}

      {/* 逐镜/逐项进度：真实分母才画条，细 3px 灰轨 + 蓝色填充（與預覽同款，
          reduced-motion 由 globals.css 兜住）。role=progressbar 带真实
          valuenow/valuemax，不虚报。计数只在这里说，行尾状态词只说「运行中…」。 */}
      {progress && (
        <div className="ml-[22px] flex flex-col gap-1">
          {/* 進度標籤是閘道文字（可能是模型名／長英文串）：無換行策略時
              一個長 token 就把這一區撐出面板寬度（2026-09-20 根因清剿）。 */}
          <p className="break-words text-ios-caption1 leading-[1.4] text-muted-foreground [overflow-wrap:anywhere]">
            {progress.label ?? "处理中"} · 已完成 {progress.done}/{progress.total}
          </p>
          <div
            className="h-[3px] w-full overflow-hidden rounded-full bg-black/[0.06]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-label={`${progress.label ?? "处理中"} ${progress.done}/${progress.total}`}
          >
            <div
              className="lg-transition h-full rounded-full bg-ios-blue"
              style={{ width: pct + "%" }}
            />
          </div>
        </div>
      )}

      {/* 失败时的人类可读错误（R10-1）：gateway 的 tool.result error.human_message，
          让「红卡刷屏」不再是无声死循环——用户看得到它在修正什么。 */}
      {/* 失败时的人类可读错误（R10-1）：gateway 的 tool.result error.human_message，
          让「红卡刷屏」不再是无声死循环——用户看得到它在修正什么。
          錯誤原文是上游字串（常含 URL／JSON 鍵值）：必須能任意換行，
          否則一個長 token 直接撐破行寬（2026-09-20 根因清剿）。 */}
      {taskStatusTone(item.status).isFailure && item.error && (
        <p className="ml-[22px] break-words rounded-xl bg-destructive/10 px-2.5 py-1.5 text-ios-caption1 leading-relaxed text-destructive [overflow-wrap:anywhere]">
          {item.error}
        </p>
      )}
    </div>
  );
}

export const AgentToolCard = memo(AgentToolCardComponent);
