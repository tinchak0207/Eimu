import Taro from '@tarojs/taro'
import { request } from './request'
import { getUserId } from './storage'

// 手机端作品审阅：对应服务端 /api/canvas/projects/review（见 src/lib/canvas/shot-review.ts）。

export type ShotState = 'ready' | 'stale' | 'pending' | 'failed' | 'empty'
export interface ShotVersion { version: string; kind: 'image' | 'video'; url?: string; status?: string; adopted: boolean; stale: boolean }
export interface ShotCandidate { id: string; url?: string; status?: string; adopted: boolean }
export interface ReviewShot {
  nodeId: string; shotNumber: string; episodeId?: string; episodeNo?: number; title: string; summary: string
  state: ShotState; adoptedUrl?: string; adoptedKind?: 'image' | 'video'; hasAudio: boolean
  versions: ShotVersion[]; candidates: ShotCandidate[]
}
export interface ProjectReview {
  projectId: string; title: string
  episodes: { id: string; episodeNo: number; title: string; shots: number; ready: number }[]
  shots: ReviewShot[]
  summary: { total: number; ready: number; stale: number; pending: number; failed: number; empty: number; headline: string; nextAction: null | { kind: string; nodeIds: string[]; label: string } }
  continuity: { cardCount: number; narrationVoice?: string; styleId?: string }
}
export interface ProjectSummary { id: string; title: string; updatedAt: string; nodeCount: number }

export const STATE_LABEL: Record<ShotState, string> = {
  ready: '可直接用', stale: '改过，旧稿待重做', pending: '生成中', failed: '失败，可单独补跑', empty: '还没出',
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const body = await request<{ summaries?: ProjectSummary[] }>({ path: '/api/canvas/projects?view=summary' })
  const list = body.summaries ?? []
  return list.filter(p => p && typeof p.id === 'string')
}
export async function fetchReview(projectId: string): Promise<ProjectReview> {
  const body = await request<{ review: ProjectReview }>({ path: `/api/canvas/projects/review?projectId=${encodeURIComponent(projectId)}` })
  return body.review
}
/** 用这条／回旧版：只改这一镜；回执里的 touchedNodes 恒 ≤1。 */
export async function adoptVersion(projectId: string, nodeId: string, pick: { version?: string; candidateId?: string }): Promise<ProjectReview> {
  const body = await request<{ review: ProjectReview }>({ path: '/api/canvas/projects/review', method: 'POST', data: { projectId, nodeId, ...pick } })
  return body.review
}

/** 把成品存到手机相册（视频/图片）；只有平台完成才回 true。 */
export async function saveToAlbum(url: string, kind: 'image' | 'video'): Promise<boolean> {
  try {
    const file = await Taro.downloadFile({ url })
    if (file.statusCode !== 200) return false
    if (kind === 'video') await Taro.saveVideoToPhotosAlbum({ filePath: file.tempFilePath })
    else await Taro.saveImageToPhotosAlbum({ filePath: file.tempFilePath })
    return true
  } catch { return false }
}

// ── 点选 → 对话的交接：精确的决定能点，模糊的意图带着「是哪一镜」去说 ──
const DRAFT_KEY = 'eimu_pending_agent_draft'
export function stashAgentDraft(text: string): void {
  const owner = getUserId()
  if (owner) Taro.setStorageSync(DRAFT_KEY, { owner, text })
}
/** 一次消费；账号不符立即销毁。 */
export function consumeAgentDraft(): string | null {
  const value = Taro.getStorageSync(DRAFT_KEY) as { owner?: number; text?: string } | undefined
  Taro.removeStorageSync(DRAFT_KEY)
  if (!value || value.owner !== getUserId() || typeof value.text !== 'string' || !value.text.trim()) return null
  return value.text
}
