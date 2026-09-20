"use client";

import { memo, type ComponentType, type ReactNode } from "react";
import { Check, Coins, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentToolCallItem } from "@/lib/agent-chat-types";
import { AGENT_TASK_STATUS_TABLE, taskStatusTone } from "@/lib/agent-task-status";
import { AgentParamDisclosure } from "./AgentParamDisclosure";

export interface AgentToolCardProps {
  item: AgentToolCallItem;
}

interface ToolStatusMeta {
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** 行首状态图标色（16px 小图标，无壳无底）。 */
  iconTone: string;
  /** 行尾状态词颜色：运行＝ios-blue、完成＝灰（绿只做 Check 点缀）、失败＝唯一红。 */
  wordTone: string;
}

// 状态语义（标签/是否失败/进行中）查 agent-task-status.ts 单一语义表；图标与
// 状态词着色是本行的展示层，留在这里。running/pending 标签尾缀「…」是展示装饰。
const STATUS_META: Record<AgentToolCallItem["status"], ToolStatusMeta> = {
  running: { label: `${AGENT_TASK_STATUS_TABLE.running.label}…`, Icon: Loader2, iconTone: "text-ios-blue/70", wordTone: "text-ios-blue" },
  // 中继態：任務已提交、成品未到（artifact_pending）。金色胶囊已下线（0920 裁定），
  // pending 与 running 同为「还在跑」：ios-blue 转圈，等 image/video/audio.done
  // 或 image.failed 才转 ok/failed。
  pending: { label: `${AGENT_TASK_STATUS_TABLE.pending.label}…`, Icon: Loader2, iconTone: "text-ios-blue/70", wordTone: "text-ios-blue" },
  ok: { label: AGENT_TASK_STATUS_TABLE.ok.label, Icon: Check, iconTone: "text-ios-green", wordTone: "text-foreground/45" },
  failed: { label: AGENT_TASK_STATUS_TABLE.failed.label, Icon: X, iconTone: "text-ios-red", wordTone: "text-ios-red" },
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
  // 有真实分母时状态词直接报计数「3/8」，比「运行中…」信息量大且不虚报。
  const badgeLabel = progress ? `${progress.done}/${progress.total}` : status.label;
  // F2：默认渲染只有人话——人话标题 + 人话摘要；函数名与完整参数进展开抽屉。
  const displayName = toolDisplayName(item.tool);
  const preview = item.argsSummary !== undefined ? toolArgPreview(item.argsSummary) : undefined;

  // 工具行（2026-09-20 Grok 级无底色细行）：16px 状态图标 + 人话标题 + 摘要暗字
  // 截断吃满剩余宽度 + 右端金币（现场币色）与状态词。无参数可展开时行不当按钮
  // （render div）；有参数时整行是 AgentParamDisclosure 的触发器（点行展开）。
  const renderRow = (api: { open: boolean; toggle?: () => void }): ReactNode => {
    const content = (
      <>
        <status.Icon
          className={cn("h-4 w-4 shrink-0", spinning && "animate-spin", status.iconTone)}
          aria-hidden="true"
        />
        <span className="shrink-0 text-ios-footnote font-medium text-foreground/75">{displayName}</span>
        <span
          className="min-w-0 flex-1 truncate text-ios-footnote text-foreground/45"
          title={preview}
        >
          {preview}
        </span>
        {item.costCoins !== undefined && (
          <span className="flex shrink-0 items-center gap-1 text-ios-footnote tabular-nums text-[rgba(120,90,20,0.85)]">
            <Coins className="h-3 w-3" aria-hidden="true" />
            {formatCoins(item.costCoins)} 金币
          </span>
        )}
        {/* 状态词（无胶囊）：whitespace-nowrap 保证不被长工具名挤出行
            （工具名那一侧自己 truncate 让位）。 */}
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-ios-footnote font-medium tabular-nums",
            status.wordTone,
          )}
        >
          {badgeLabel}
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
          这一行只负责说「这次调了什么工具、花了多少」。整行触发：点行展开参数。
          花费不往下传：行内已经常驻显示，展开后再来一次是噪音。
          （AgentParamCard 保留 costCoins 是给没有行头的挂载点用的。） */}
      {item.argsSummary !== undefined ? (
        <AgentParamDisclosure
          argsSummary={item.argsSummary}
          idPrefix={`agent-args-${item.id}`}
          toolName={item.tool}
          trigger={(api) => renderRow(api)}
        />
      ) : (
        renderRow({ open: false })
      )}

      {/* 逐镜/逐项进度：真实分母才画条（generation-progress-* 全局样式，reduced-motion
          已被 globals.css 兜住）。role=progressbar 带真实 valuenow/valuemax，不虚报。 */}
      {progress && (
        <div className="ml-[22px] flex flex-col gap-1">
          <p className="text-ios-caption1 leading-[1.4] text-muted-foreground">
            {progress.label ?? "处理中"} · 已完成 {progress.done}/{progress.total}
          </p>
          <div
            className="generation-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-label={`${progress.label ?? "处理中"} ${progress.done}/${progress.total}`}
          >
            <div className="generation-progress-fill" style={{ width: pct + "%" }} />
          </div>
        </div>
      )}

      {/* 失败时的人类可读错误（R10-1）：gateway 的 tool.result error.human_message，
          让「红卡刷屏」不再是无声死循环——用户看得到它在修正什么。 */}
      {taskStatusTone(item.status).isFailure && item.error && (
        <p className="ml-[22px] rounded-xl bg-destructive/10 px-2.5 py-1.5 text-ios-caption1 leading-relaxed text-destructive">
          {item.error}
        </p>
      )}
    </div>
  );
}

export const AgentToolCard = memo(AgentToolCardComponent);
