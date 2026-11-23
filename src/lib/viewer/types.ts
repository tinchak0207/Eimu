// 赏阅（Viewer）契约：所有「成品」在站内被查看、评判、标记、回流给助理的唯一数据形状。
//
// 为什么存在：生成只是半个闭环，另一半是「验收→指出哪里不对→回到生成」。此前每个入口各写一套
// 查看器（ImageLightbox / HistoryLightbox / AgentVideoCard 内的全屏 / 音频卡跳外部静态播放器 /
// 分镜与资产审查面板 / OpenUI 成品组件），能力各不相同、互不相通、也都没有「标记→助理」这一环。
// 本档定义一次，之后新增一种可查看的成品＝实现一个 ViewerAdapter，而不是再写一个查看器。
//
// 零 React 依赖（types only + 纯函式在 review.ts），任何层可 import。

import type { DeliverableKind } from "@/lib/deliverable-kind";

/**
 * 可查看的种类。交付物种类（image/video/audio）以 deliverable-kind 注册表为真源；
 * 其余是「只读可看、尚未成为历史/资产种类」的扩展种类。某扩展种类一旦进入历史或资产库，
 * 就应升格进 DELIVERABLE_KINDS（那时本处自动由注册表推导，adapter 表的穷尽检查会提醒补齐）。
 */
export const EXTRA_VIEW_KINDS = ["text", "scene3d", "document", "storyboard", "collection"] as const;
export type ExtraViewKind = (typeof EXTRA_VIEW_KINDS)[number];
export type ViewKind = DeliverableKind | ExtraViewKind;

/** 歌词（音频/视频可带）。status 与 audio.done.lyric_status 同口径。 */
export interface ViewLyrics {
  /** 带时间轴的 LRC（含增强版逐字 <mm:ss.xx>）。 */
  lrc?: string;
  /** 无时间轴的纯歌词；仅在没有 lrc 时按比例估算滚动，并必须向用户标明「估算」。 */
  plain?: string;
  status?: string;
}

/** 一件可被查看的成品。children 用于合集（专辑/MV 套件/分镜表/资产包）。 */
export interface ViewAsset {
  /** 稳定 id（优先 taskId，其次 URL 的稳定摘要）；标记与续播按它存取。 */
  id: string;
  kind: ViewKind;
  title?: string;
  /** 主资源 URL。collection 可为空（内容在 children）。 */
  url?: string;
  /** MIME 类型（有就填；文档种类据此/据扩展名分流）。 */
  mime?: string;
  /** 封面/缩略图；没有就不显示，绝不拿别的成品的图占位。 */
  cover?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  /** text 种类的正文（markdown/纯文本）；document 用 url。 */
  text?: string;
  lyrics?: ViewLyrics;
  /** 字幕轨 URL（vtt）。 */
  captionsUrl?: string;
  /** 来历。只展示真实有的字段，没有就不显示、不编造。 */
  provenance?: {
    taskId?: string;
    prompt?: string;
    model?: string;
    costCoins?: number;
    createdAt?: number;
    /** 同一需求下第几个候选（best-of-N / 再来一组）。 */
    take?: number;
  };
  /** 合集成员；也用于 MV 套件（video + audio + lyrics 各一件）。 */
  children?: ViewAsset[];
}

/**
 * 定位器：「指在成品的哪里」。按种类取不同形状，但对用户是同一个动作：标记。
 * time 区间用于音频/视频；region 用于图/视频帧（坐标归一化 0–1，相对于原图/视频画面）；
 * page 用于文档；pose 用于 3D 视角；span 用于文本（字符区间）；whole 表示整件。
 */
export type Locator =
  | { t: "time"; a: number; b?: number }
  | { t: "region"; x: number; y: number; w: number; h: number; frameT?: number }
  | { t: "page"; n: number }
  | { t: "pose"; pos: [number, number, number]; target: [number, number, number]; fov?: number }
  | { t: "span"; from: number; to: number }
  | { t: "whole" };

/** 一条标记。excerpt 是定位处的内容摘录（歌词句/文本片段/OCR 等），由 adapter 在标记时取。 */
export interface Annotation {
  id: string;
  assetId: string;
  locator: Locator;
  /** 来自 TagDef.id */
  tags: string[];
  note?: string;
  excerpt?: string;
  at: number;
}

export interface TagDef {
  id: string;
  /** 按钮上的短标签。 */
  label: string;
  /** 写进给助理的话。 */
  say: string;
  /** 正向标记（「这段最好」）：用绿色、并告诉助理「保留不要动」。 */
  good?: boolean;
}

/** adapter 在 Surface 内发布给壳的控制柄（壳据此取当前位置、跳到标记、循环试听）。 */
export interface ViewerController {
  /** 抓取「此刻」的定位（音视频＝当前时间；图＝当前选区或整张；文档＝当前页；3D＝当前相机）。 */
  capture(): { locator: Locator; excerpt?: string };
  /** 跳到某个定位（点标记列表时调用）。 */
  reveal(locator: Locator): void;
  /** 仅时间轴种类：把区间设为循环试听；null 取消。 */
  loop?(range: { a: number; b: number } | null): void;
  play?(): void;
  pause?(): void;
}

export interface ViewerSurfaceProps {
  asset: ViewAsset;
  /** inline＝聊天/卡片内嵌，最小 chrome；full＝沉浸全屏/独立页。 */
  density: "inline" | "full";
  /** 本件已有的标记（adapter 用来在时间轴/画面上画点）。 */
  annotations: readonly Annotation[];
  /** adapter 挂载后写入；卸载时置 null。 */
  controllerRef: { current: ViewerController | null };
  /** adapter 内按下「标记」（按钮或 F 键）时调用，壳负责打开标记面板。 */
  onRequestMark(): void;
  /** 壳不再显示本件（切到别的件/关闭）时为 false：adapter 必须暂停并释放大资源。 */
  active: boolean;
  /** 仅合集/分镜类 adapter 使用：用户点开某个成员时调用，壳负责在同一视图里切到该成员。 */
  onOpenChild?(child: ViewAsset): void;
}

/** 壳向外暴露的动作；没传的动作＝对应按钮不出现或 disabled（沿用既有媒体卡惯例）。 */
export interface ViewerActions {
  onDownload?(asset: ViewAsset): Promise<boolean>;
  onSaveToLibrary?(asset: ViewAsset): Promise<boolean>;
  /** 「再来 N 组」：会话级，翻成一句话丢回对话。 */
  onRerun?(asset: ViewAsset, count: number): void;
  /** 「微调」：只预填输入框，不自动送出（不替用户开一轮扣费）。 */
  onVariant?(asset: ViewAsset): void;
  /**
   * 「发给助理」：把标记整理成的一段话预填进输入框（同样不自动送出）。
   * 无此回调（独立页/外部嵌入）时壳退化为「复制给助理」+ postMessage。
   */
  onSendFeedback?(text: string, annotations: readonly Annotation[], asset: ViewAsset): void;
}
