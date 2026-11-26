import { useCallback, useRef, useState } from 'react'
import { Image, ScrollView, Text, Textarea, Video, View } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh, useRouter, useShareAppMessage } from '@tarojs/taro'
import { ensureLogin } from '../../lib/session'
import { PageShell } from '../../components/pages/PageShell'
import {
  adoptVersion, fetchMaster, fetchShared, forkShared, importScript, publishShare, revokeShare, type SharedView, fetchProjects, fetchReview, type MasterReceipt, saveToAlbum, stashAgentDraft, STATE_LABEL,
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
  const router = useRouter()
  const sharedId = typeof router.params?.shareId === 'string' ? router.params.shareId : ''
  const [shared, setShared] = useState<SharedView | null>(null)
  const [myShareId, setMyShareId] = useState('')
  useShareAppMessage(() => ({ title: review?.title || 'Eimu 作品', path: myShareId ? `/pages/project/index?shareId=${myShareId}` : '/pages/project/index' }))
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [review, setReview] = useState<ProjectReview | null>(null)
  const [episode, setEpisode] = useState<number | null>(null)
  const [openShot, setOpenShot] = useState<string | null>(null)
  const [compare, setCompare] = useState<string | null>(null)
  const [master, setMaster] = useState<MasterReceipt | null>(null)
  const backToList = useRef(false)
  const [scriptText, setScriptText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  const flash = useCallback((text: string) => { setToast(text); setTimeout(() => setToast(''), 2200) }, [])

  const load = useCallback(async (projectId?: string) => {
    setError('')
    try {
      await ensureLogin()
      if (projectId) { const [r, m] = await Promise.all([fetchReview(projectId), fetchMaster(projectId)]); setReview(r); setMaster(m); return }
      const list = await fetchProjects()
      setProjects(list)
      // 只有一个项目＝直接进去，不让人多点一下。
      if (list.length === 1 && !backToList.current) { const [r, m] = await Promise.all([fetchReview(list[0].id), fetchMaster(list[0].id)]); setReview(r); setMaster(m) }
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取作品失败')
    } finally { Taro.stopPullDownRefresh() }
  }, [])

  useDidShow(() => {
    const openId = typeof router.params?.open === 'string' ? router.params.open : ''
    if (openId && !review) { void load(openId); return }
    if (sharedId) { void fetchShared(sharedId).then(setShared).catch(() => setError('这个分享不存在或已被撤销')); return }
    void load(review?.projectId)
  })
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

  async function share() {
    if (!review || busy) return
    setBusy(true)
    try {
      const id = await publishShare(review.projectId)
      setMyShareId(id)
      flash('已发布这一刻的版本：点右上角「…」转发给朋友；之后你再改，不影响已发布的这份')
    } catch (err) { flash(err instanceof Error ? err.message : '发布失败') } finally { setBusy(false) }
  }
  async function unshare() {
    if (!myShareId) return
    try { await revokeShare(myShareId); setMyShareId(''); flash('已撤销，对方再打开会看到「已撤销」') } catch (err) { flash(err instanceof Error ? err.message : '撤销失败') }
  }
  async function copyShared() {
    if (!sharedId || busy) return
    setBusy(true)
    try {
      await ensureLogin()
      const id = await forkShared(sharedId)
      flash('已复制成你的项目，可以接着做')
      await Taro.redirectTo({ url: `/pages/project/index?open=${encodeURIComponent(id)}` }).catch(() => undefined)
    } catch (err) { flash(err instanceof Error ? err.message : '复制失败，没有创建任何东西') } finally { setBusy(false) }
  }

  async function doImport() {
    if (!scriptText.trim() || busy) return
    setBusy(true)
    try {
      const result = await importScript(scriptText)
      setScriptText('')
      if (result.sampleDraft) stashAgentDraft(result.sampleDraft)
      flash(result.policy === 'finished' ? `已按原文切成 ${result.shotCount} 镜，台词一字不改` : `已建好项目（${result.shotCount} 镜）`)
      await load(result.projectId)
      backToList.current = false
    } catch (err) { flash(err instanceof Error ? err.message : '导入失败，没有创建任何东西') } finally { setBusy(false) }
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

        {sharedId && shared ? (
          <View className='space-y-3'>
            <Text className='block text-ios-title3 font-semibold text-foreground'>{shared.title || '分享的作品'}</Text>
            <Text className='block text-ios-footnote text-foreground/55'>{shared.summary}（这是作者发布的版本，只读）</Text>
            <View className='flex min-h-11 items-center justify-center rounded-full bg-ios-blue text-white' onClick={() => void copyShared()}><Text>{busy ? '复制中…' : '复制成我的项目，接着做'}</Text></View>
            <View className='grid grid-cols-2 gap-2'>
              {shared.shots.map(shot => (
                <View key={`${shot.episodeNo ?? 0}-${shot.shotNumber}`} className='lg-sheet rounded-ios-2xl p-2'>
                  <Thumb url={shot.adoptedUrl} kind={shot.adoptedKind} />
                  <Text className='mt-1.5 block text-ios-footnote font-medium text-foreground'>{`${shot.episodeNo ? `第${shot.episodeNo}集 ` : ''}第 ${shot.shotNumber} 镜`}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {sharedId ? null : !review ? (
          <View className='space-y-2'>
            <Text className='text-ios-title3 font-semibold text-foreground'>我的作品</Text>
            {projects.length === 0 && !error ? <Text className='block text-ios-subhead text-foreground/50'>还没有作品。回到对话说出想拍的片子，做出来后会出现在这里。</Text> : null}
            <View className='lg-sheet rounded-ios-2xl px-4 py-3'>
              <Text className='block text-ios-subhead font-medium text-foreground'>已有剧本？直接导入</Text>
              <Text className='mt-0.5 block text-ios-caption2 text-foreground/45'>按原文切镜，台词不改；导入不花钱。之后可先只试第 1 镜的风格。</Text>
              <Textarea value={scriptText} onInput={e => setScriptText(e.detail.value)} maxlength={20000} autoHeight placeholder='场1 天台 黄昏&#10;她：你来晚了。' className='mt-2 min-h-24 w-full rounded-ios-xl bg-black/[0.04] p-3 text-ios-subhead' />
              <View className={`mt-2 flex min-h-11 items-center justify-center rounded-full ${scriptText.trim() ? 'bg-ios-blue text-white' : 'bg-black/[0.06] text-foreground/40'}`} onClick={() => void doImport()}><Text>{busy ? '导入中…' : '导入并开始'}</Text></View>
            </View>
            {projects.map(p => (
              <View key={p.id} className='lg-sheet rounded-ios-2xl px-4 py-3' onClick={() => { backToList.current = false; void load(p.id) }}>
                <Text className='block text-ios-subhead font-medium text-foreground'>{p.title || '未命名作品'}</Text>
                <Text className='block text-ios-caption2 text-foreground/45'>{p.nodeCount} 个节点</Text>
              </View>
            ))}
          </View>
        ) : (
          <View className='space-y-3'>
            <View className='flex items-center justify-between'>
              <Text className='text-ios-title3 font-semibold text-foreground'>{review.title || '未命名作品'}</Text>
              <Text className='text-ios-footnote text-ios-blue' onClick={() => { backToList.current = true; setReview(null); setMaster(null); setEpisode(null); void load() }}>全部作品 / 导入剧本</Text>
            </View>
            {/* 做完了没有：一句话说清手里有什么、缺什么 */}
            <View className='lg-sheet rounded-ios-2xl px-4 py-3'>
              <Text className='block text-ios-subhead text-foreground'>{review.summary.headline}</Text>
              {review.summary.nextAction ? <View className='mt-2 flex min-h-11 items-center justify-center rounded-full bg-ios-blue text-white' onClick={() => { stashAgentDraft(review.summary.nextAction!.label); void Taro.navigateTo({ url: '/pages/agent/index' }).catch(() => Taro.reLaunch({ url: '/pages/agent/index' })) }}><Text>下一步：{review.summary.nextAction.label}</Text></View> : <Text className='mt-1 block text-ios-footnote text-ios-green'>全部镜头都可直接用</Text>}
              {review.continuity.cardCount > 0 || review.continuity.narrationVoice ? (
                <Text className='mt-1 block text-ios-caption2 text-foreground/45'>
                  已留存：{review.continuity.cardCount} 张角色/场景卡{review.continuity.narrationVoice ? ` · 旁白音色 ${review.continuity.narrationVoice}` : ''}，接着做下一集会沿用
                </Text>
              ) : null}
            </View>
            {/* 整片：做完了就能直接播、存走；没有就如实说没有 */}
            <View className='lg-sheet rounded-ios-2xl px-4 py-3'>
              {master?.hasCut && master.latest ? (
                <View>
                  <Text className='block text-ios-subhead font-medium text-foreground'>整片已导出{master.latest.durationSec ? ` · ${Math.round(master.latest.durationSec)} 秒` : ''}</Text>
                  <Video src={master.latest.deliveryUrl} controls className='mt-2 h-44 w-full rounded-ios-xl bg-black' />
                  <View className='mt-2 flex min-h-11 items-center justify-center rounded-full bg-ios-blue text-white' onClick={async () => flash((await saveToAlbum(master.latest!.deliveryUrl, 'video')) ? '整片已存到相册' : '没存成，请在授权后重试')}><Text>存整片到相册</Text></View>
                </View>
              ) : (
                <Text className='block text-ios-footnote text-foreground/55'>{master?.known === false ? '暂时查不到整片状态' : '还没有导出整片：镜头都满意后对我说「合成整片」'}</Text>
              )}
            </View>
            <View className='flex gap-2'>
              <View className='flex min-h-11 flex-1 items-center justify-center rounded-full bg-black/[0.06]' onClick={() => void share()}><Text>{myShareId ? '重新发布当前版本' : '发布给朋友（可接着做）'}</Text></View>
              {myShareId ? <View className='flex min-h-11 items-center justify-center rounded-full bg-black/[0.06] px-4' onClick={() => void unshare()}><Text>撤销</Text></View> : null}
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
                  <Text className={`block text-ios-caption2 ${STATE_TONE[shot.state]}`}>{shot.newVersionWaiting ? '新版等你选' : STATE_LABEL[shot.state]}{shot.versions.length > 1 ? ` · ${shot.versions.length} 版` : ''}</Text>
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
