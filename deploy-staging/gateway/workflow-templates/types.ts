/**
 * 画布工作流模板库——类型定义（2026-09-20 逐模板拆档）。
 *
 * 型别单一真源；每个模板的节点/连线在同目录 `<template-id>.ts`，
 * 由 index.ts 汇总成 WORKFLOW_TEMPLATES。改一个模板只动一个档，
 * 部署与平行修改不再互相冲突。
 *
 * 注意：部署机制为逐档 SFTP（.gateway-work/sftp-put-443.js），目录结构
 * 必须手动在 VPS 上建立 remote-dir 并逐档上传；旧单档 workflow-templates.ts
 * 必须删除或重命名，否则会因 extensionless 解析优先命中旧档而掩蔽新目录。
 */

export interface WorkflowNodeSpec {
  role: string // 节点在工作流中的角色（text/config/image/video/audio/film）
  kind: "text" | "config" | "image" | "video" | "audio" | "film"
  title: string
  /**
   * 模板预设 metadata；Deepseek 填的内容会 merge 进来。
   *
   * 保留键 `emitsEntity`（2026-09-24）：宣告这个节点的交付物是一个**可被 @ 引用的实体**
   * （角色/场景/道具/音频），画布侧据此自动落卡并回填分镜引用。形状（**四个键，逐字**）：
   *   - `kind`：`"character" | "scene" | "style" | "prop" | "audio"`（必填；五值域外＝整号宣告作废）
   *   - `nameFrom?`：`"nodeTitle" | "input"`（卡名来源，预设 `"nodeTitle"`）
   *   - `referenceRoles?`：`string[]`——**由模板作者宣告**：同模板实例上哪些 role 的交付物
   *     是本实体的「参考图」（如四视图的 `["view2", "view3", "view4"]`）。只有一个交付物
   *     的实体（场景图等）**不要写**。
   *   - `referenceNodeIds?`：`string[]`——**由引擎解析后填入**（`expandTemplate` 的参考图
   *     post-pass 按本次展开的 role→nodeId 对应解出，顺序＝`referenceRoles` 顺序）。
   *     站点据此收参考图。**作者不要手写这一键**：写了也会被引擎的重算结果覆写。
   * 放在 defaults 而非 spec 顶层：expandTemplate 已 spread defaults 进 metadata，
   * 顶层栏位需要改引擎才会被复制。
   */
  defaults?: Record<string, unknown>
  // 提示：引擎生成时提示 Deepseek 应填哪些栏位（放在 SKILL，不进执行）。
  /** 该节点的产出合同（一行配方级描述，铺上画布卡片给用户/agent 看）。 */
  deliverable?: string
  /** 该节点的验收门禁（不达标怎么办；无门禁省略）。 */
  gate?: string
  /** 工具链卡：该节点要调的 harness 工具（expandTemplate 衍生工具卡用）。 */
  tools?: { id: string; input?: string; output?: string; unsupported?: boolean; requiredCapability?: string }[]
  /** 配方笔记：每条衍生一张配方卡（expandTemplate 用）。 */
  notes?: string[]
}

export interface WorkflowConnectionSpec {
  fromRole: string
  toRole: string
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string // 给 Deepseek 看的一句心智
  // 节点是否可复制（大片：多镜头 = 同角色节点复制多份，id 加后缀）。
  multiShot?: boolean
  nodes: WorkflowNodeSpec[]
  connections: WorkflowConnectionSpec[]
}