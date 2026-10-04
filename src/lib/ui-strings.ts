/**
 * 界面文案单一来源（**只做禁硬编码基座，不做多语**）。
 *
 * 规则：
 * 1. 本期三个新面（C2 AdminStatistics／B2 ProjectAssetLibraryPanel／D1 LineageDrawer）的
 *    用户可见字串全部收在本档，元件内零硬编文案（守门件 `src/lib/ui-strings.test.ts`）。
 * 2. 文案内容＝改造前上屏原文，逐字不动＝UI 视觉零变化。
 * 3. `{name}` 是插值占位符，由 `text(key, params)` 填充；缺参数保留占位符（可诊断，不吐 undefined）。
 * 4. **未来要上 i18n 时的唯一接缝是本档的 `text()`**（加一个 language 参数＋一张语言表即可），
 *    元件端不需要动——所以本档刻意不放语言栏位、语系型别、fallback 机制等未使用的骨架。
 */

export const UI_STRINGS = {
  // ── 共用 ─────────────────────────────────────────────────
  "common.close": "关闭",
  "common.noRecord": "无记录",
  "common.noDescription": "（无描述）",
  /** 数值缺口占位符（读不到就不画数字，用破折号表达「无值」）。 */
  "common.placeholder": "—",

  // ── 剧本入口曝光（P0-1，2026-09-28）───────────────────────
  // 只做曝光：文案指向既有 novel_film 产线（长文本/小说改编成片），不改任何判定阈値。
  /** 首屏模板库 novel_film 正面卡上的一行提示：讲清「丢文本」这个入口。 */
  "templates.scriptEntry.hint": "有剧本或小说原文？丢进来，自动拆成分镜成片",

  // ── C2 /admin 用量统计 ───────────────────────────────────
  "stats.title": "用量统计",
  "stats.subtitle": "全部数字都是既有账本的只读投影：每个数字都能指回一条 billing_operation / capability 记录，无数据源不画。",
  "stats.refresh": "刷新",
  "stats.window.days": "近 {days} 天",
  "stats.window.summary": "窗口：近 {days} 天（日界 {timezone}）· 生成于 {generatedAt}",
  "stats.traffic.exclude": "不含内部流量",
  "stats.traffic.include": "含内部流量",
  "stats.traffic.summary": "内部用户 {ids}（env INTERNAL_USER_IDS）",
  "stats.traffic.none": "未配置内部用户",
  "stats.funnel.title": "激活漏斗",
  "stats.funnel.subtitle": "窗口内注册的新用户逐步转化：发起生成 → 至少一单成功 → 首次生成后 7 日内另一天再来 → 现金充值。每一步都是上一步的子集。",
  "stats.funnel.window": "近 {days} 天注册",
  "stats.funnel.step.registered": "注册",
  "stats.funnel.step.generated": "发起过生成",
  "stats.funnel.step.succeeded": "至少一单成功",
  "stats.funnel.step.returned": "7 日内回访",
  "stats.funnel.step.paid": "现金充值",
  "stats.funnel.users": "{count} 人",
  "stats.funnel.fromPrevious": "较上一步",
  "stats.funnel.fromRegistered": "占注册",
  "stats.funnel.userIdsTitle": "用户 id：{ids}",
  "stats.funnel.unavailable": "激活漏斗暂不可用：{reason}",
  "stats.funnel.excludedInternal": "已剔除 {count} 个内部注册",
  "stats.funnel.d1": "次日（D1）回访 {count} 人",
  "stats.funnel.immature": "{count} 人的 7 日回访窗口尚未走完，回访数可能继续上升",
  "stats.funnel.paidAny": "窗口内注册且有现金充值（不论是否走完前序步骤）{count} 人",
  "stats.funnel.nonCash": "已排除 {count} 条非现金入账（开户基线 / 签到 / 新人礼 / 赠送）",
  "stats.funnel.truncated": "读取达上限，人数为下界",
  "stats.funnel.sources.title": "按注册来源拆分",
  "stats.funnel.sources.subtitle": "同一批注册用户按首次触达来源分组（utm_source → 来源域名 → direct，首触不覆盖）。各来源人数相加等于总数；没有归因记录的归入未标记。",
  "stats.funnel.sources.source": "来源",
  "stats.funnel.sources.registered": "注册",
  "stats.funnel.sources.generated": "发起",
  "stats.funnel.sources.succeeded": "成功",
  "stats.funnel.sources.paid": "付费",
  "stats.funnel.sources.unknown": "未标记",
  "stats.funnel.sources.empty": "窗口内没有可拆分的注册用户。",
  "stats.funnel.sources.unavailable": "注册来源读取失败，全部归入未标记（请确认已套用 db/migrations/025 迁移）。",
  "stats.firstImage.title": "新用户首图耗时",
  "stats.firstImage.subtitle": "只统计上面漏斗里的新用户；分位数为最近秩口径。",
  "stats.firstImage.registerToSuccess": "注册 → 首张成功图完成",
  "stats.firstImage.firstJob": "首单 创建 → 结束",
  "stats.firstImage.percentiles": "p50 {p50} · p90 {p90}",
  "stats.firstImage.samples": "样本 {count}",
  "stats.firstImage.empty": "暂无样本",
  "stats.firstImage.firstJobMeta": "首单未结束 {unfinished} · 首单未成功 {notSucceeded}",
  "stats.duration.seconds": "{value} 秒",
  "stats.duration.minutes": "{value} 分钟",
  "stats.duration.hours": "{value} 小时",
  "stats.duration.days": "{value} 天",
  "stats.error.read": "读取统计数据失败。",
  "stats.error.generic": "读取失败。",
  "stats.notConfigured": "本实例没有控制面数据库连线（GENERATION_DATABASE_URL），统计不可用——不展示任何推测数字。",
  "stats.card.windowCoins": "窗口内消耗（币）",
  "stats.card.totalQuota": "账本 quota 原值 {quota}",
  "stats.card.windowCoinsCharged": "扣费 {charged} 币 · 已退款 {refunded} 币（净额已相减）",
  "stats.card.ledgerRows": "已落账账本行",
  "stats.card.ledgerSource": "billing_operation commit+refund/applied",
  "stats.card.refunded": "已退款（币）",
  "stats.refunded.breakdown": "{rows} 笔退款账本行 · {jobs} 个任务全额退款",
  "stats.card.unattributed": "未归因消耗（币）",
  "stats.card.unattributedNote": "{rows} 行无成功尝试，未摊派给任何渠道",
  "stats.card.remainingQuota": "剩余额度（币）",
  "stats.card.knownIdentities": "{count} 个付费身份已回读",
  "stats.card.unknownIdentities": " · {count} 个无法判定",
  "stats.card.noQuota": "资料不足：new-api 未回读任何额度",
  "stats.card.unknownIdentitiesShort": "（{count} 个身份未知）",
  "stats.card.quotaTruncated": "仅覆盖前 {covered}/{total} 个身份（单次上限 {limit}）——合计不是全部身份之和",
  "stats.daily.title": "每日消耗",
  "stats.daily.subtitle": "按账本 applied_at 切日（{timezone}）；只画有账本行的日子，缺日的空白就是没有记录。",
  "stats.daily.coins": "{coins} 币",
  "stats.daily.empty": "窗口内没有任何已落账记录。",
  "stats.daily.partial": "部分",
  "stats.daily.partialTitle": "窗口起点落在 {day} 日中（日界 {timezone}）：该日只含起点之后的记录，是半日桶，不是完整一天。",
  "stats.byModel.title": "模型分布",
  "stats.byModel.subtitle": "按 generation_job.model_id 汇总已落账消耗；无记录模型不出现在此表。",
  "stats.byModel.key": "模型",
  "stats.byChannel.title": "渠道用量",
  "stats.byChannel.subtitle": "按实际交付的那次 generation_attempt 归因到 supplier；找不到成功尝试的消耗单列为「未归因」。",
  "stats.byChannel.key": "渠道",
  "stats.bucket.empty": "窗口内没有任何已落账的扣费记录——不做 0 曲线，这里是「无记录」。",
  "stats.bucket.colCoins": "消耗（币）",
  "stats.bucket.colLedgerRows": "账本行数",
  "stats.bucket.colRecords": "记录",
  "stats.records.none": "无记录",
  "stats.records.sampleTitle": "账本行 id 样本：\n{ids}",
  "stats.records.total": "共 {total} 笔",
  "stats.rate.insufficient": "资料不足（{samples}/{minimum} 样本）",
  "stats.rate.samples": "({count} 样本)",
  "stats.rate.percent": "{value}%",
  "stats.health.title": "渠道健康（三态判活）",
  "stats.health.subtitle": "判据与执行侧调度同一把尺（supplier_capability / supplier / supplier_account 的启用与冷却），不是自造健康分；没有任何能力记录的渠道如实画成「无法判定」。",
  "stats.health.empty": "未读到任何渠道记录（supplier 表为空或不可达）。",
  "stats.health.colChannel": "渠道",
  "stats.health.colLiveness": "判活",
  "stats.health.colCapabilities": "可调度能力",
  "stats.health.colSuccessRate": "历史成功率",
  "stats.health.colLastSuccess": "最近成功",
  "stats.health.colReason": "判据",
  "stats.liveness.available": "可用",
  "stats.liveness.unavailable": "不可用",
  "stats.liveness.unknown": "无法判定",
  "stats.quota.title": "剩余额度明细",
  "stats.quota.subtitle": "数据源 new-api users.quota（与配额预检同通路）；读不到的身份标「未知」，不以 0 计入合计。",
  "stats.quota.empty": "窗口内没有产生扣费的付费身份。",
  "stats.quota.coverage": "窗口内付费身份共 {total} 个，本次只读取前 {covered} 个（单次上限 {limit}）——合计为部分身份之和，不是全部身份。",
  /** 付费身份标识（billing_user_id）。 */
  "stats.quota.userId": "user #{id}",
  "stats.quota.entryCoins": "{coins} 币",
  "stats.quota.entryRaw": "quota {quota}",
  "stats.quota.unknown": "资料不足：未知（{reason}）",
  "stats.quota.unknownReason": "上游未回读",
  "stats.models.title": "模型活性（与 C 端模型菜单同一份判活）",
  "stats.models.subtitle": "直接消费既有 /api/user/model-status（与 /v1/model-status 同源），本页不重算判活口径。",
  "stats.models.unavailableDict": "无法判定：未取到模型活性字典（fail-open 时字典为空，不代表模型健康）。",
  "stats.models.counts": "{availableLabel} {available} · {unavailableLabel} {unavailable} · {unknownLabel} {unknown}",
  "stats.models.emptyDict": "模型活性字典为空——是「取不到」，不是「全挂」。",
  "stats.sources.title": "数据来源对照",
  "stats.sources.subtitle": "每个数字指回哪张表，逐条列明。",
  "stats.sources.colMetric": "指标",
  "stats.sources.colSource": "数据源",
  "stats.sources.colNote": "口径",

  // ── B2 项目资产库面板 ────────────────────────────────────
  "assets.title": "项目资产库",
  "assets.subtitle": "挂用＝在本项目建本地副本（改来源不影响副本，删来源副本仍可用）；跨项目复用需先显式分享",
  "assets.refresh": "刷新资产库",
  "assets.close": "关闭资产库",
  "assets.searchPlaceholder": "搜索资产名 / 标签",
  "assets.filter.all": "全部",
  "assets.filter.pack": "资产包",
  "assets.filter.card": "卡片",
  "assets.mountedOnly": "仅看已挂用",
  "assets.guest": "登录后可用项目资产库",
  "assets.noProject": "本项目尚未建号（画布为空）· 先放一个节点再挂用资产",
  "assets.loading": "正在读取资产库…",
  "assets.loadError": "加载失败：{error}",
  "assets.error.loadFailed": "加载失败",
  "assets.error.action": "操作失败",
  "assets.error.share": "分享失败",
  "assets.empty": "没有可见资产 · 去「资源库 / 角色卡」存一个",
  "assets.emptyMounted": "本项目还没有挂用的资产",
  "assets.summary": "共 {total} 项 · 已挂用 {mounted}",
  "assets.mount.busy": "…",
  "assets.mount.mount": "挂用",
  "assets.mount.release": "已挂用 · 解除",
  /** REQ-B2b：挂用＝copy-on-use（建本地副本并锁进本项目生成用的卡）。 */
  "assets.mount.created": "已挂用：已在本项目建本地副本并锁定（生成用的是副本）",
  "assets.mount.existing": "此前已挂用（幂等，未重复建副本）",
  "assets.mount.skipped": "已挂用：包内 {count} 个条目没有卡投影（如 LoRA / 3D 产物），未复制成卡",
  "assets.mount.unmounted": "已解除挂用（副本已回收并停止注入）",
  "assets.scope.toPersonal": "归属改回个人",
  "assets.scope.toProject": "归属到本项目",
  "assets.share.targetPlaceholder": "目标项目 id",
  "assets.share.action": "显式分享",
  "assets.share.created": "已显式分享到该项目",
  "assets.share.existing": "此前已分享过该项目（幂等，未重复建记录）",
  "assets.visibility.owner": "个人",
  "assets.visibility.inProject": "本项目",
  "assets.visibility.inTeam": "本团队",
  "assets.visibility.sharedIn": "分享进来",

  // ── D1 资产血统溯源抽屉 ──────────────────────────────────
  "lineage.title": "溯源 · {hostKind}",
  "lineage.back": "返回上一级链",
  "lineage.loading": "正在加载血统数据…",
  "lineage.noLineage": "来源不明：这条记录没有可恢复的血统登记（存量早于溯源功能，或生成时未携带可解析的来源）。",
  "lineage.kind.root": "本级",
  "lineage.status.deleted": "已删除 · 曾有引用，记录已不在",
  "lineage.status.unscanned": "查无 · 本范围扫描不完整",
  "lineage.status.unknownOrigin": "来源不明 · 未登记血统",
  "lineage.status.self": "自引用 · 已忽略",
  "lineage.status.cycle": "成环 · 祖先链已出现",
  "lineage.status.pruned": "更深链未展开",
  "lineage.truncated": "直接来源超过上限，仅保留最近 5 个（截断已标记）",
  "lineage.openSource": "打开该来源",
  "lineage.openRecord": "打开该记录",
  "lineage.jumpTitle": "跳转到这一级",
  "lineage.expandMore": "继续向上（当前展开 {depth} 层）",
  "lineage.footerPartial": "本层链已按当前可见记录展开；数据加载不完整时不会把「查无」说成「已删除」。",
  "lineage.footerDefault": "默认展开 {depth} 层，点击箭头可逐级向上追溯。",
} as const;

export type UiStringKey = keyof typeof UI_STRINGS;

/** 插值参数（值由呼叫方给，元件内不做字串拼接）。 */
export type UiStringParams = Readonly<Record<string, string | number>>;

/**
 * 文案唯一取用口。未来上 i18n 时在这里加语言参数与语言表，
 * 呼叫端（元件）一行都不用改。
 */
export function text(key: UiStringKey, params?: UiStringParams): string {
  const template: string = UI_STRINGS[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/**
 * 数字/日期格式化用的语言标签（与文案同层，未来上 i18n 时跟随文案一起切换）。
 */
export const NUMBER_LOCALE = "zh-CN";
