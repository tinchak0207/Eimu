/**
 * 画布工作流模板库——类型定义（2026-09-20 逐模板拆檔）。
 *
 * 型別單一真源；每個模板的節點/連線在同目錄 `<template-id>.ts`，
 * 由 index.ts 匯總成 WORKFLOW_TEMPLATES。改一個模板只動一個檔，
 * 部署與平行修改不再互相衝突。
 *
 * 注意：部署機制為逐檔 SFTP（.gateway-work/sftp-put-443.js），目錄結構
 * 必須手動在 VPS 上建立 remote-dir 並逐檔上傳；舊單檔 workflow-templates.ts
 * 必須刪除或重命名，否則會因 extensionless 解析優先命中舊檔而掩蔽新目錄。
 */

export interface WorkflowNodeSpec {
  role: string // 节点在工作流中的角色（text/config/image/video/audio/film）
  kind: "text" | "config" | "image" | "video" | "audio" | "film"
  title: string
  // 模板预设 metadata；Deepseek 填的内容会 merge 进来。
  defaults?: Record<string, unknown>
  // 提示：引擎生成时提示 Deepseek 应填哪些栏位（放在 SKILL，不进执行）。
  /** 该节点的产出合同（一行配方级描述，铺上画布卡片给用户/agent 看）。 */
  deliverable?: string
  /** 该节点的验收门禁（不达标怎么办；无门禁省略）。 */
  gate?: string
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