/**
 * 模型选择面板。结构／Tailwind class 逐行复制网页版手机端分支：
 *   src/components/ModelPicker.tsx:462-531（renderMobileVendor：厂商行可展开、模型行带单价与勾选）
 *   src/components/ModelPicker.tsx:552-563（面板容器 lg-sheet / rounded-ios-2xl / p-2）
 *
 * 平台差异（白名单内）：
 *   - Radix DropdownMenu → 小程序底部浮层（同一 lg-sheet 材质，overlay 关闭）。
 *   - VendorIcon 品牌 SVG → 小程序无对应资产，厂商行只留文字与数量（不伪造品牌图）。
 *   - 悬停展开 / 键盘 → 点击展开。
 */
import { useState } from 'react'
import { ScrollView, Text, View } from '@tarojs/components'
import { Icon } from '../agent-chat/icons'
import { modelPriceLabel } from './playground-data'
import type { ImageModelOption } from '../../lib/models'

export interface ModelSheetProps {
  open: boolean
  models: ImageModelOption[]
  value: string
  resolution: string
  vendors: Record<string, string>
  onSelect: (modelId: string) => void
  onClose: () => void
}

interface VendorGroup {
  vendor: string
  models: ImageModelOption[]
}

export function ModelSheet({ open, models, value, resolution, vendors, onSelect, onClose }: ModelSheetProps) {
  const groups: VendorGroup[] = []
  for (const model of models) {
    const vendor = vendors[model.id] ?? '其他'
    const group = groups.find((entry) => entry.vendor === vendor)
    if (group) group.models.push(model)
    else groups.push({ vendor, models: [model] })
  }

  const currentVendor = vendors[value] ?? null
  // 网版默认展开「当前选中模型所在厂商」（ModelPicker.tsx:172-175）。
  const [expandedVendor, setExpandedVendor] = useState<string | null>(currentVendor)

  if (!open) return null

  return (
    <View className='fixed inset-0 z-[60] flex flex-col justify-end bg-[rgba(0,0,0,0.28)]' onClick={onClose}>
      <View
        className='lg-sheet rounded-t-[2rem] p-2'
        style={{ paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))' }}
        onClick={(event) => event.stopPropagation()}
      >
        <View className='pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-90' />
        <View className='mx-auto mb-1 h-1 w-9 rounded-full bg-[rgba(0,0,0,0.12)]' />
        <ScrollView scrollY className='max-h-[60vh]'>
          {groups.map((group) => {
            const expanded = expandedVendor === group.vendor
            const hasSelected = group.models.some((model) => model.id === value)
            return (
              <View key={group.vendor} className='min-w-0 max-w-full py-0.5 first:pt-0 last:pb-0'>
                <View
                  className={`flex min-w-0 w-full items-center gap-2.5 rounded-[1.05rem] px-3 py-2.5 text-ios-subhead font-semibold ${
                    expanded
                      ? 'bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.85)]'
                      : hasSelected
                        ? 'bg-[rgba(0,122,255,0.06)] text-[rgba(0,122,255,0.95)]'
                        : 'text-[rgba(0,0,0,0.88)]'
                  }`}
                  onClick={() => setExpandedVendor(expanded ? null : group.vendor)}
                >
                  <Text className='min-w-0 flex-1 truncate text-left'>{group.vendor}</Text>
                  <View className='shrink-0 rounded-full bg-[rgba(0,0,0,0.05)] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[rgba(0,0,0,0.48)]'>
                    <Text>{group.models.length}</Text>
                  </View>
                  <Icon
                    name='chevron-down-a35'
                    className={`h-4 w-4 shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
                  />
                </View>
                {expanded ? (
                  <View className='mt-1 space-y-0.5 pl-1 pr-0.5'>
                    {group.models.map((model) => {
                      const selected = model.id === value
                      return (
                        <View
                          key={model.id}
                          className={`relative flex min-w-0 max-w-full items-center gap-1.5 rounded-[0.95rem] py-2.5 pl-3 pr-8 text-ios-footnote ${
                            selected
                              ? 'bg-[rgba(0,122,255,0.10)] font-medium text-[rgba(0,122,255,0.95)]'
                              : 'text-[rgba(0,0,0,0.88)]'
                          }`}
                          onClick={() => {
                            onSelect(model.id)
                            onClose()
                          }}
                        >
                          <Text className='min-w-0 flex-1 truncate font-medium'>{model.name}</Text>
                          <Text className='shrink-0 pl-1 text-ios-caption1 tabular-nums text-[rgba(0,0,0,0.52)]'>
                            {modelPriceLabel(model.id, resolution)}
                          </Text>
                          {selected ? (
                            <Icon name='check-blue' className='absolute right-2.5 h-3.5 w-3.5' />
                          ) : null}
                        </View>
                      )
                    })}
                  </View>
                ) : null}
              </View>
            )
          })}
        </ScrollView>
      </View>
    </View>
  )
}
