import { useCallback, useState } from 'react'
import { Image, ScrollView, Text, Video, View } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { ensureLogin } from '../../lib/session'
import { PageShell } from '../../components/pages/PageShell'
import {
  adoptVersion, fetchProjects, fetchReview, saveToAlbum, stashAgentDraft, STATE_LABEL,
  type ProjectReview, type ProjectSummary, type ReviewShot,
} from '../../lib/project-review'

const STATE_TONE: Record<ReviewShot['state'], string> = {
  ready: 'text-ios-green', stale: 'text-ios-orange', pending: 'text-ios-blue', failed: 'text-destructive', empty: 'text-foreground/45',
}

function Thumb({ url, kind }: { url?: string; kind?: 'image' | 'video' }) {
  if (!url) return <View className='flex h-24 w-full items-center justify-center rounded-ios-xl bg-black/[0.04]'><Text className='text-ios-caption2 text-foreground/40'>暂无</Text></View>
  if (kind === 'video') return <Video src={url} controls={false} showCenterPlayBtn objectFit='cover' className='h-24 w-full rounded-ios-xl bg-black' />
  return <Image src={url} mode='aspectFill' className='h-24 w-full rounded-ios-xl bg-black/[0.04]' />
}

export default function ProjectPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [review, setReview] = useState<ProjectReview | null>(null)
  const [episode, setEpisode] = useState<number | null>(null)
  const [openShot, setOpenShot] = useState<string | null>(null)
  const [compare, setCompare] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  const flash = useCallback((text: string) => { setToast(text); setTimeout(() => setToast(''), 2200) }, [])

  const load = useCallback(async (projectId?: string) => {
    setError('')
    try {
      await ensureLogin()
      if (projectId) { setReview(await fetchReview(projectId)); return }
      const list = await fetchProjects()
      setProjects(list)
      // 只有一个项目＝直接进去，不让人多点一下。
      if (list.length === 1) setReview(await fetchReview(list[0].id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取作品失败')
    } finally { Taro.stopPullDownRefresh() }
  }, [])

  useDidShow(() => { void load(review?.projectId) })
  usePullDownRefresh(() => { void load(review?.projectId) })

  const shots = (review?.shots ?? []).filter(s => episode === null || s.episodeNo === episode)
  const current = review?.shots.find(s => s.nodeId === openShot) ?? null

  async function adopt(shot: ReviewShot, pick: { version?: string; candidateId?: string }, label: string) {
    if (!review || busy) return
    setBusy(true)
    try {
      setReview(await adoptVersion(review.projectId, shot.nodeId, pick))
      flash(`${label}，其余镜头、台词、配乐没有动`)
      setCompare(null)
    } catch (err) { flash(err instanceof Error ? err.message : '没有改成，原样保留') } finally { setBusy(false) }
  }

  function sayAboutShot(shot: ReviewShot) {
    stashAgentDraft(`第 ${shot.shotNumber} 镜（${shot.summary}）：`)
    void Taro.navigateTo({ url: '/pages/agent/index' }).catch(() => Taro.reLaunch({ url: '/pages/agent/index' }))
  }

  async function save(shot: ReviewShot) {
    if (!shot.adoptedUrl || !shot.adoptedKind) return
    flash((await saveToAlbum(shot.adoptedUrl, shot.adoptedKind)) ? '已存到相册' : '没存成，请在授权后重试')
  }

  return (
    <PageShell>
      <View className='min-h-[100dvh] bg-background px-4 pb-24 pt-3'>
        {error ? <Text className='text-ios-footnote text-destructive'>{error}</Text> : null}

        {!review ? (
          <View className='space-y-2'>
            <Text className='text-ios-title3 font-semibold text-foreground'>我的作品</Text>
            {projects.length === 0 && !error ? <Text className='block text-ios-subhead text-foreground/50'>还没有作品。回到对话说出想拍的片子，做出来后会出现在这里。</Text> : null}
            {projects.map(p => (
              <View key={p.id} className='lg-sheet rounded-ios-2xl px-4 py-3' onClick={() => void load(p.id)}>
                <Text className='block text-ios-subhead font-medium text-foreground'>{p.title || '未命名作品'}</Text>
                <Text className='block text-ios-caption2 text-foreground/45'>{p.nodeCount} 个节点</Text>
              </View>
            ))}
          </View>
        ) : (
          <View className='space-y-3'>
            <Text className='block text-ios-title3 font-semibold text-foreground'>{review.title || '未命名作品'}</Text>
            {/* 做完了没有：一句话说清手里有什么、缺什么 */}
            <View className='lg-sheet rounded-ios-2xl px-4 py-3'>
              <Text className='block text-ios-subhead text-foreground'>{review.summary.headline}</Text>
              {review.summary.nextAction ? <Text className='mt-1 block text-ios-footnote text-ios-blue'>下一步：{review.summary.nextAction.label}（对我说「{review.summary.nextAction.label}」即可）</Text> : <Text className='mt-1 block text-ios-footnote text-ios-green'>全部镜头都可直接用</Text>}
              {review.continuity.cardCount > 0 || review.continuity.narrationVoice ? (
                <Text className='mt-1 block text-ios-caption2 text-foreground/45'>
                  已留存：{review.continuity.cardCount} 张角色/场景卡{review.continuity.narrationVoice ? ` · 旁白音色 ${review.continuity.narrationVoice}` : ''}，接着做下一集会沿用
                </Text>
              ) : null}
            </View>
            {review.episodes.length > 1 ? (
              <ScrollView scrollX className='whitespace-nowrap'>
                {[{ id: 'all', episodeNo: null as number | null, title: '全部' }, ...review.episodes.map(e => ({ id: e.id, episodeNo: e.episodeNo as number | null, title: `第 ${e.episodeNo} 集 ${e.ready}/${e.shots}` }))].map(e => (
                  <View key={e.id} className={`mr-2 inline-flex min-h-9 items-center rounded-full px-3 ${episode === e.episodeNo ? 'bg-ios-blue text-white' : 'bg-black/[0.05] text-foreground'}`} onClick={() => setEpisode(e.episodeNo)}>
                    <Text className='text-ios-footnote'>{e.title}</Text>
                  </View>
                ))}
              </ScrollView>
            ) : null}
            <View className='grid grid-cols-2 gap-2'>
              {shots.map(shot => (
                <View key={shot.nodeId} className='lg-sheet rounded-ios-2xl p-2' onClick={() => { setOpenShot(shot.nodeId); setCompare(null) }}>
                  <Thumb url={shot.adoptedUrl} kind={shot.adoptedKind} />
                  <Text className='mt-1.5 block text-ios-footnote font-medium text-foreground'>{`${shot.episodeNo ? `第${shot.episodeNo}集 ` : ''}第 ${shot.shotNumber} 镜`}</Text>
                  <Text className={`block text-ios-caption2 ${STATE_TONE[shot.state]}`}>{STATE_LABEL[shot.state]}{shot.versions.length > 1 ? ` · ${shot.versions.length} 版` : ''}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* 单镜：看当前采用、对照另一版、点「用这条」；模糊的意图带着镜号去说 */}
        {current ? (
          <View className='agent-chat-surface fixed inset-0 z-[90] flex flex-col justify-end bg-black/40' onClick={() => setOpenShot(null)}>
            <View className='max-h-[85dvh] overflow-y-auto rounded-t-ios-3xl bg-background px-4 pb-8 pt-4' onClick={e => e.stopPropagation()}>
              <Text className='block text-ios-title3 font-semibold text-foreground'>{`第 ${current.shotNumber} 镜`}<Text className={`ml-2 text-ios-footnote ${STATE_TONE[current.state]}`}>{STATE_LABEL[current.state]}</Text></Text>
              <Text className='mt-1 block text-ios-footnote text-foreground/55'>{current.summary}</Text>
              <View className='mt-3 flex gap-2'>
                <View className='flex-1'><Text className='block pb-1 text-ios-caption2 text-foreground/45'>当前采用</Text><Thumb url={current.adoptedUrl} kind={current.adoptedKind} /></View>
                {compare ? (() => { const v = current.versions.find(x => x.version === compare); return <View className='flex-1'><Text className='block pb-1 text-ios-caption2 text-foreground/45'>对照这一版</Text><Thumb url={v?.url} kind={v?.kind} /></View> })() : null}
              </View>
              <Text className='mt-4 block text-ios-footnote text-foreground/55'>所有版本（点一版对照，再决定用不用）</Text>
              <ScrollView scrollX className='mt-1 whitespace-nowrap'>
                {current.versions.map((v, i) => (
                  <View key={v.version} className={`mr-2 inline-block w-24 align-top ${compare === v.version ? 'opacity-100' : 'opacity-80'}`} onClick={() => setCompare(v.adopted ? null : v.version)}>
                    <Thumb url={v.url} kind={v.kind} />
                    <Text className='block text-ios-caption2 text-foreground/55'>{`第 ${i + 1} 版${v.adopted ? ' · 当前' : ''}${v.stale ? ' · 旧稿' : ''}`}</Text>
                  </View>
                ))}
                {current.candidates.map((c, i) => (
                  <View key={c.id} className='mr-2 inline-block w-24 align-top' onClick={() => { if (!c.adopted) void adopt(current, { candidateId: c.id }, `已改用候选 ${i + 1}`) }}>
                    <Thumb url={c.url} kind='video' />
                    <Text className='block text-ios-caption2 text-foreground/55'>{`候选 ${i + 1}${c.adopted ? ' · 当前' : '（点一下用这条）'}`}</Text>
                  </View>
                ))}
              </ScrollView>
              <View className='mt-4 flex flex-wrap gap-2'>
                {compare ? <View className='flex min-h-11 items-center rounded-full bg-ios-blue px-5 text-white' onClick={() => { const v = current.versions.find(x => x.version === compare); if (v) void adopt(current, { version: v.version }, v.stale ? '已回到旧版' : '已改用这一版') }}><Text>{busy ? '处理中…' : '用这条'}</Text></View> : null}
                <View className='flex min-h-11 items-center rounded-full bg-black/[0.06] px-5' onClick={() => sayAboutShot(current)}><Text>说一句改这镜</Text></View>
                {current.adoptedUrl ? <View className='flex min-h-11 items-center rounded-full bg-black/[0.06] px-5' onClick={() => void save(current)}><Text>存到相册</Text></View> : null}
              </View>
            </View>
          </View>
        ) : null}
        {toast ? <View className='fixed inset-x-6 bottom-8 z-[99] rounded-full bg-black/80 px-4 py-2.5 text-center'><Text className='text-ios-footnote text-white'>{toast}</Text></View> : null}
      </View>
    </PageShell>
  )
}
