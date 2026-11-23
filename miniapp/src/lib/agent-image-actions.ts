import Taro from '@tarojs/taro'
import { getUserId } from './storage'
import { IMAGE_MODELS } from './models'
import type { AgentItem } from '../components/agent-chat/types'
type ImageItem = Extract<AgentItem, { kind: 'image' }>
const KEY = 'eimu_pending_agent_image_recipe'
export interface AgentImagePrefill { owner: number; prompt: string; modelId: string; size?: string; referenceImage?: string; retryOfTaskId?: string; mode: 'rerun' | 'variant' | 'edit' }
/** 同网页版 canHistoryEntryRerun：真prompt + 已知图片模型；不替上传图片伪造配方。 */
export function canRerunAgentImage(item: ImageItem): boolean {
  const recipe = item.recipe as unknown as Record<string, unknown> | undefined
  if (recipe?.lora || recipe?.loraModelVersionIds) return false
  return Boolean(item.recipe?.prompt?.trim() && IMAGE_MODELS.some(model => model.id === item.recipe?.model && model.kind === 'image'))
}
export async function openAgentImageRecipe(item: ImageItem, mode: AgentImagePrefill['mode'] = 'rerun'): Promise<boolean> {
  const owner = getUserId()
  if (!owner || (mode !== 'edit' && !canRerunAgentImage(item))) return false
  Taro.setStorageSync(KEY, { owner, prompt: item.recipe?.prompt ?? '', modelId: item.recipe?.model ?? '', size: item.recipe?.size, retryOfTaskId: mode === 'edit' ? undefined : item.taskId, referenceImage: mode === 'edit' ? item.url : undefined, mode })
  try { await Taro.navigateTo({ url: '/pages/index/index' }); return true } catch { Taro.removeStorageSync(KEY); return false }
}
/** 一次消费；所有者不符也立即销毁，不把前人配方交给下个账号。 */
export function consumeAgentImageRecipe(): AgentImagePrefill | null {
  const value = Taro.getStorageSync(KEY) as AgentImagePrefill | undefined
  Taro.removeStorageSync(KEY)
  if (!value || value.owner !== getUserId() || typeof value.prompt !== 'string') return null
  if (value.mode !== 'edit' && !IMAGE_MODELS.some(model => model.id === value.modelId && model.kind === 'image') || (value.mode !== 'edit' && !value.prompt.trim())) return null
  return value
}
