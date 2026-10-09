/**
 * 创作项目（P0 新层）与聊天条目。
 *
 * 归属真源只有一处＝本档：聊天挂哪个项目、一个聊天有哪几张画布，全记在
 * CreativeProject.chats 里；画布文档（CanvasProject）**不加**反向栏位，
 * 避免两处真源漂移。
 */
export type ProjectTitleSource = "default" | "first_input" | "generated" | "custom";

export interface ProjectChat {
  /** 网关会话 id。**空字符串＝尚未绑定会话**（存量迁移期的「默认画布」条目唯一特例）。 */
  sessionId: string;
  /** 显示标题。仅 titleSource==="custom" 时权威；其余情形显示端优先用网关标题。 */
  title: string;
  titleSource: ProjectTitleSource;
  /** 本聊天拥有的画布 id 清单（一个聊天可有多张画布）。 */
  canvasIds: string[];
  /** 主画布 id；必须在 canvasIds 内，否则读取端省略。 */
  primaryCanvasId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CreativeProject {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  chats: ProjectChat[];
}
