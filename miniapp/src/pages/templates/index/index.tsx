import { useMemo, useState } from 'react'
import { ScrollView, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import {
  TEMPLATE_CATEGORIES,
  filterTemplatesByCategory,
  type InspirationTemplate,
  type TemplateCategory,
} from '../../../lib/templates'
import './index.scss'

const ALL = '全部'
type CategoryFilter = typeof ALL | TemplateCategory

/** 卡片摘要：取 prompt 前 60 字，超出加省略号。 */
function summarize(prompt: string): string {
  const text = prompt.trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export default function TemplatesPage() {
  const [active, setActive] = useState<CategoryFilter>(ALL)

  const templates = useMemo(
    () => filterTemplatesByCategory(active === ALL ? undefined : active),
    [active],
  )

  // 两列瀑布：按奇偶下标分流，列内自然堆叠。
  const columns = useMemo(() => {
    const left: InspirationTemplate[] = []
    const right: InspirationTemplate[] = []
    templates.forEach((item, index) => {
      if (index % 2 === 0) left.push(item)
      else right.push(item)
    })
    return [left, right]
  }, [templates])

  function handlePick(item: InspirationTemplate) {
    try {
      Taro.setStorageSync('pending_template', item)
    } catch {
      Taro.showToast({ title: '模板暂存失败，请重试', icon: 'none' })
      return
    }

    const pages = Taro.getCurrentPages()
    const previous = pages[pages.length - 2]
    const previousRoute = (previous?.route ?? '').replace(/^\//, '')
    if (previousRoute === 'pages/index/index') {
      Taro.navigateBack({
        fail: () => {
          void Taro.redirectTo({ url: '/pages/index/index' }).catch(() => {
            void Taro.showToast({ title: '返回创作页失败，请重试', icon: 'none' })
          })
        },
      })
      return
    }
    void Taro.redirectTo({ url: '/pages/index/index' }).catch(() => {
      void Taro.showToast({ title: '打开创作页失败，请重试', icon: 'none' })
    })
  }

  return (
    <View className='page tpl-page'>
      <View className='tpl-head'>
        <Text className='tpl-head__title'>灵感模板</Text>
        <Text className='tpl-head__subtitle'>选一个场景，提示词直接填进创作页。</Text>
      </View>

      <ScrollView className='tpl-cats' scrollX enableFlex>
        <View className='tpl-cats__inner'>
          {([ALL, ...TEMPLATE_CATEGORIES] as CategoryFilter[]).map((category) => (
            <View
              key={category}
              className={`tpl-chip ${active === category ? 'tpl-chip--active' : ''}`}
              onClick={() => setActive(category)}
            >
              <Text>{category}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      {templates.length === 0 ? (
        <View className='tpl-empty'>
          <Text className='tpl-empty__title'>这个分类还没有模板</Text>
          <Text className='tpl-empty__hint'>换一个分类看看，或回到创作页自己写。</Text>
        </View>
      ) : (
        <View className='tpl-columns'>
          {columns.map((column, columnIndex) => (
            <View className='tpl-column' key={`column-${columnIndex}`}>
              {column.map((item) => (
                <View
                  className='tpl-card'
                  key={item.id}
                  onClick={() => handlePick(item)}
                >
                  <View className='tpl-card__head'>
                    <Text className='tpl-card__title'>{item.title}</Text>
                    <Text className='tpl-card__category'>{item.category}</Text>
                  </View>
                  <Text className='tpl-card__summary'>{summarize(item.prompt)}</Text>
                  <Text className='tpl-card__action'>套用这个模板</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
