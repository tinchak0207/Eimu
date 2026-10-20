import { saveTenantPermissionMode } from "./persistence.ts"
import { authorizationRuleSpecifier, evaluatePermission, isDeviceBridgeMode, isPathWithinRoot, isToolAllowed, sanitizeAuthorizedRoots, sanitizePermissionRules, sensitiveResultProblem, suggestAuthorizationRoot, type DeviceBridgeMode, type PermissionRule, type PermissionTool } from "./device-bridge-policy.ts"
import { SessionConsentStore } from "./device-bridge-session-consent.ts"
import { AUTHORIZATION_OPTIONS, ConsentTokenStore, DEVICE_CONSENT_TTL_MS, DEVICE_HEARTBEAT_TTL_MS, DEVICE_POLL_MAX_WAIT_MS, DEVICE_REQUEST_TIMEOUT_MS, OnceGrantStore, finalizeDeviceResult, mapAskReason, randomId, sanitizeToolArgs, type ConsentTokenError, type DeviceBridgeErrorCode, type DeviceRecord, type DeviceRequestMessage, type InvokeResult, type NeedsAuthorizationInfo, type PendingRequest, type PickDeviceResult, type PollWaiter, type SanitizeErr, type TenantDeviceDescription } from "./device-bridge-types.ts"
// ── 桥本体 ─────────────────────────────────────────────────────────────

export class DeviceBridge {
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly byConnection = new Map<string, string>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly queue = new Map<string, string[]>()
  private readonly pollWaiters = new Set<PollWaiter>()
  readonly tokens = new ConsentTokenStore()
  readonly grants = new OnceGrantStore()
  /**
   * session 级规则（记忆体，key＝tenant；**不持久化到共享库**）。gateway 重启后由落盘的
   * 会话同意（`consentStore`）重建，见 `hydratePersistedConsent`。
   */
  private readonly sessionRules = new Map<string, PermissionRule[]>()
  /**
   * 对话内授权的**同意记录**（key＝tenant）：session/permanent 各记一笔，供 invoke 随讯息
   * 送到装置落地（装置端只认自己的 mode/rules/roots，不知道云端对话发生了什么）。
   * 去重、上限 64。`once` **不进此表**（走 OnceGrantStore 的一次性核销）。
   */
  private readonly sessionConsent = new Map<string, { scope: "session" | "permanent"; root: string }[]>()
  /**
   * 会话同意的**行程外**落点（session 同意跨 gateway 重启续存；见
   * device-bridge-session-consent.ts）。production singleton 注入；未注入（测试／嵌入）
   * ＝纯行程内语义（旧行为）。
   */
  private readonly consentStore: SessionConsentStore | null

  constructor(
    private readonly opts: {
      requestTimeoutMs?: number
      consentTtlMs?: number
      heartbeatTtlMs?: number
      sessionConsentStore?: SessionConsentStore | null
    } = {},
  ) {
    this.consentStore = opts.sessionConsentStore ?? null
    this.hydratePersistedConsent()
  }

  private requestTimeoutMs(): number {
    return this.opts.requestTimeoutMs ?? DEVICE_REQUEST_TIMEOUT_MS
  }
  private consentTtlMs(): number {
    return this.opts.consentTtlMs ?? DEVICE_CONSENT_TTL_MS
  }
  private heartbeatTtlMs(): number {
    return this.opts.heartbeatTtlMs ?? DEVICE_HEARTBEAT_TTL_MS
  }
  private deviceKey(tenant: string, deviceId: string): string {
    return `${tenant}\u0000${deviceId}`
  }
  private getDevice(tenant: string, deviceId: string): DeviceRecord | undefined {
    return this.devices.get(this.deviceKey(tenant, deviceId))
  }

  // ── W6b：session 规则与权限状态 ──────────────────────────────────────
  private tenantRules(tenant: string): PermissionRule[] {
    return this.sessionRules.get(tenant) ?? []
  }
  /** 装置级规则 ＋ 该 tenant 的 session 规则（顺序：装置在前，session 在后）。 */
  private allRulesFor(rec: DeviceRecord): PermissionRule[] {
    return [...rec.rules, ...this.tenantRules(rec.tenant)]
  }
  /** 加一条 session 规则（authorize scope=session/permanent 用）。 */
  addSessionRule(tenant: string, rule: PermissionRule): void {
    const list = this.sessionRules.get(tenant) ?? []
    if (list.length >= 64) return
    list.push(rule)
    this.sessionRules.set(tenant, list)
  }
  /** 清掉某 tenant 的 session 规则（测试／会话结束用）。 */
  clearSessionRules(tenant: string): void {
    this.sessionRules.delete(tenant)
  }
  /** 记忆体内记一笔同意（同 {scope,root} 去重，上限 64）；不做任何落盘。 */
  private applyConsent(tenant: string, scope: "session" | "permanent", root: string): void {
    const list = this.sessionConsent.get(tenant) ?? []
    if (list.some((e) => e.scope === scope && e.root === root)) return
    if (list.length >= 64) return
    list.push({ scope, root })
    this.sessionConsent.set(tenant, list)
  }
  /**
   * 记录一笔对话内授权同意（session/permanent）；同 {scope,root} 去重，上限 64。
   * session/permanent 另**落 gateway 本地单档**（跨重启续存）；`once` 不走本函式。
   * `tool` 供重启后精确重建规则（缺省＝`*`，与 authorize 端点未指定 tool 的语义一致）。
   */
  addSessionConsent(
    tenant: string,
    entry: { scope: "session" | "permanent"; root: string; tool?: PermissionTool },
  ): void {
    this.applyConsent(tenant, entry.scope, entry.root)
    this.consentStore?.record({ tenant, root: entry.root, scope: entry.scope, tool: entry.tool ?? "*" })
  }
  /**
   * 启动时载入落盘的会话同意并**重建规则与同意记录**：gateway 重启（部署）后，已
   * session 授权的目录不再回 needs_authorization。载入项已在 store 内经安全复核
   * （denylist／档案系统根／敏感一律丢弃）。
   */
  private hydratePersistedConsent(): void {
    const store = this.consentStore
    if (!store) return
    for (const entry of store.load()) {
      const specifier = authorizationRuleSpecifier(entry.root)
      const rules = this.sessionRules.get(entry.tenant) ?? []
      // 同 specifier 只重建一条（session 与 permanent 同根时避免重复规则）。
      if (!rules.some((r) => r.specifier === specifier && r.tool === entry.tool)) {
        this.addSessionRule(entry.tenant, { effect: "allow", tool: entry.tool, specifier })
      }
      this.applyConsent(entry.tenant, entry.scope, entry.root)
    }
  }
  /** 该 tenant 目前的同意记录（唯读快照）。 */
  private tenantConsent(tenant: string): { scope: "session" | "permanent"; root: string }[] {
    return this.sessionConsent.get(tenant) ?? []
  }
  /** 清掉某 tenant 的同意记录（测试／会话结束用）。 */
  clearSessionConsent(tenant: string): void {
    this.sessionConsent.delete(tenant)
  }
  /** 挑代表装置（唯读；与 describeTenantDevices 同一语义）。 */
  private representativeDevice(tenant: string, now: number): DeviceRecord | undefined {
    const mine = [...this.devices.values()].filter((r) => r.tenant === tenant)
    if (mine.length === 0) return undefined
    const picked = this.pickDeviceForTenant(tenant, now)
    if (picked.ok) return mine.find((r) => r.deviceId === picked.deviceId) ?? mine[0]
    return mine.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.deviceId.localeCompare(b.deviceId))[0]
  }
  /** 某租户目前的权限状态（mode ＋ 合并规则）；无装置时回预设 ask 与该 tenant session 规则。 */
  permissionStateForTenant(tenant: string, now: number = Date.now()): { mode: DeviceBridgeMode; rules: PermissionRule[] } {
    const rep = this.representativeDevice(tenant, now)
    if (!rep) return { mode: "ask", rules: [...this.tenantRules(tenant)] }
    return { mode: rep.mode, rules: this.allRulesFor(rep) }
  }
  /** 某租户代表装置自报的家目录（authorize 的 too_broad 判定用）；无＝null。 */
  homeForTenant(tenant: string, now: number = Date.now()): string | null {
    return this.representativeDevice(tenant, now)?.home ?? null
  }

  /**
   * 注册：绑定 tenant(userId) ↔ deviceId ↔ connectionId。同装置重注册＝换连线（旧连线作废）。
   * `roots`＝使用者已授权的绝对路径根（H2 递回夹制用）；未带／全非法＝空集 ⇒ grep/list_dir 全拒。
   */
  register(input: {
    tenant: string
    userId: number | null
    apiKeyHash: string
    deviceId?: string
    roots?: unknown
    mode?: unknown
    rules?: unknown
    home?: unknown
    now?: number
  }): {
    deviceId: string
    connectionId: string
    heartbeatIntervalMs: number
    pollUrl: string
    authorizedRoots: string[]
    mode: DeviceBridgeMode
    permissionsEnabled: boolean
  } {
    const now = input.now ?? Date.now()
    const deviceId = input.deviceId && input.deviceId.trim() ? input.deviceId.trim().slice(0, 128) : randomId("dev")
    const key = this.deviceKey(input.tenant, deviceId)
    const prev = this.devices.get(key)
    if (prev) {
      this.byConnection.delete(prev.connectionId)
      // 换连线＝旧连线关闭：唤醒并清掉它残留的长轮询 waiter。它醒后重验 connectionId 会回
      // stale，不会取走新连线的请求（否则幽灵 waiter 会吞掉重连后的第一发 invoke）。
      this.dropWaitersForConnection(prev.connectionId)
    }
    const connectionId = randomId("conn")
    // 相容策略：只有呼叫端**明确**给了 mode 或 rules 才启用新决策引擎；否则维持升级前
    // 行为（denylist ＋ 递回根夹制）。缺省 mode 的「语义预设」仍为 `ask`（status 回报）。
    const modeRaw = input.mode
    const rules = sanitizePermissionRules(input.rules)
    const permissionsEnabled = isDeviceBridgeMode(modeRaw) || rules.length > 0
    const mode: DeviceBridgeMode = isDeviceBridgeMode(modeRaw) ? modeRaw : "ask"
    const home = typeof input.home === "string" && input.home.trim() ? input.home.trim() : null
    this.devices.set(key, {
      deviceId,
      tenant: input.tenant,
      userId: input.userId,
      apiKeyHash: input.apiKeyHash,
      connectionId,
      authorizedRoots: sanitizeAuthorizedRoots(input.roots),
      mode,
      permissionsEnabled,
      rules,
      home,
      registeredAt: now,
      lastSeenAt: now,
    })
    this.byConnection.set(connectionId, key)
    if (isDeviceBridgeMode(modeRaw)) saveTenantPermissionMode(input.tenant, mode)
    return {
      deviceId,
      connectionId,
      heartbeatIntervalMs: 30_000,
      pollUrl: "/agent/v1/device-bridge/poll",
      authorizedRoots: this.devices.get(key)!.authorizedRoots,
      mode,
      permissionsEnabled,
    }
  }

  /** 心跳：刷新 lastSeenAt；回待办数。connectionId 不符＝换连线后旧连线不再有效。 */
  heartbeat(input: { tenant: string; deviceId: string; connectionId: string; now?: number }): {
    ok: boolean
    code?: DeviceBridgeErrorCode
    pendingCount: number
    serverTimeMs: number
  } {
    const now = input.now ?? Date.now()
    const rec = this.getDevice(input.tenant, input.deviceId)
    if (!rec) return { ok: false, code: "device_offline", pendingCount: 0, serverTimeMs: now }
    if (rec.connectionId !== input.connectionId) return { ok: false, code: "device_connection_stale", pendingCount: 0, serverTimeMs: now }
    rec.lastSeenAt = now
    return { ok: true, pendingCount: this.queue.get(this.deviceKey(input.tenant, input.deviceId))?.length ?? 0, serverTimeMs: now }
  }

  private isOnline(rec: DeviceRecord, now: number): boolean {
    return now - rec.lastSeenAt <= this.heartbeatTtlMs()
  }

  /**
   * 轮询（出站长连线的本机端主动来取件）：有待办立刻回；否则若 waitMs>0，
   * 等到有件或逾时（回 request:null）。本机端执行前必须验 consent_token。
   */
  async poll(input: { tenant: string; deviceId: string; connectionId: string; waitMs?: number; now?: number }): Promise<
    { ok: true; request: DeviceRequestMessage | null } | { ok: false; code: DeviceBridgeErrorCode }
  > {
    const now = input.now ?? Date.now()
    const rec = this.getDevice(input.tenant, input.deviceId)
    if (!rec) return { ok: false, code: "device_offline" }
    if (rec.connectionId !== input.connectionId) return { ok: false, code: "device_connection_stale" }
    rec.lastSeenAt = now

    const key = this.deviceKey(input.tenant, input.deviceId)
    const take = (): DeviceRequestMessage | null => {
      const q = this.queue.get(key)
      while (q && q.length > 0) {
        const requestId = q.shift()!
        const p = this.pending.get(requestId)
        if (p && !p.settled) return p.message
      }
      return null
    }
    // 本条长轮询此刻是否仍绑在有效连线上；重连＝换 connectionId ⇒ false。
    const connectionValid = (): boolean => {
      const r = this.getDevice(input.tenant, input.deviceId)
      return !!r && r.connectionId === input.connectionId
    }

    const first = take()
    if (first) return { ok: true, request: first }
    const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, DEVICE_POLL_MAX_WAIT_MS))
    if (waitMs === 0) return { ok: true, request: null }

    const waiter: PollWaiter = {
      tenant: input.tenant,
      deviceId: input.deviceId,
      connectionId: input.connectionId,
      timer: null,
      wake: () => {},
    }
    await new Promise<void>((resolve) => {
      let done = false
      const wake = () => {
        if (done) return
        done = true
        this.pollWaiters.delete(waiter)
        if (waiter.timer) clearTimeout(waiter.timer)
        resolve()
      }
      waiter.wake = wake
      waiter.timer = setTimeout(wake, waitMs)
      this.pollWaiters.add(waiter)
    })

    // 唤醒后**重验连线**：被重连取代的旧 waiter 不得把新连线刚下发的请求 shift 走、回给已
    // abort 的旧 HTTP。已取到件但连线已失效＝放回伫列头（re-queue，不吞件），回 stale。
    const taken = take()
    if (!connectionValid()) {
      if (taken) this.requeueRequest(input.tenant, input.deviceId, taken.request_id)
      return { ok: false, code: "device_connection_stale" }
    }
    return { ok: true, request: taken }
  }

  /** 唤醒并清掉某连线残留的长轮询 waiter（连线关闭／被取代时呼叫；醒后重验会回 stale）。 */
  private dropWaitersForConnection(connectionId: string): void {
    for (const w of [...this.pollWaiters]) {
      if (w.connectionId === connectionId) w.wake()
    }
  }

  /** 把已取出的请求放回该 deviceKey 伫列头（waiter 醒后连线已失效时不得吞件）。 */
  private requeueRequest(tenant: string, deviceId: string, requestId: string): void {
    const key = this.deviceKey(tenant, deviceId)
    const q = this.queue.get(key) ?? []
    q.unshift(requestId)
    this.queue.set(key, q)
  }

  private notifyPoll(): void {
    for (const w of [...this.pollWaiters]) w.wake()
  }

  /** 逾时取消：清待办与票，回明确错误码。 */
  private cancelPending(requestId: string): void {
    const p = this.pending.get(requestId)
    if (!p) return
    p.settled = true
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(requestId)
    const q = this.queue.get(this.deviceKey(p.tenant, p.deviceId))
    if (q) {
      const i = q.indexOf(requestId)
      if (i >= 0) q.splice(i, 1)
    }
    p.resolve({ ok: false, code: "device_request_timeout", message: "device did not answer before timeout", requestId })
  }

  /**
   * 云端 agent 发起一次本机档案操作：验工具白名单与路径 denylist → 检查装置在线 →
   * 下发请求（带逐次同意票）→ 等装置回传或逾时。
   */
  async invoke(input: {
    tenant: string
    deviceId: string
    tool: unknown
    args?: unknown
    timeoutMs?: number
    /** scope=once 的一次性授权许可（authorize 端点签发）。 */
    authorizationToken?: unknown
  }): Promise<InvokeResult> {
    if (!isToolAllowed(input.tool)) {
      return { ok: false, code: "tool_not_allowed", message: `tool not allowed: ${String(input.tool)}` }
    }
    const tool = input.tool
    // H2：递回型工具（grep/list_dir）的根夹制需要装置的授权根，故先取记录读授权集
    // （这一步只读授权集，不是「装置在线」判定；denylist 仍先于在线检查）。
    const rec = this.getDevice(input.tenant, input.deviceId)
    const configured = rec?.permissionsEnabled === true
    const cleaned = sanitizeToolArgs(tool, input.args, {
      authorizedRoots: rec?.authorizedRoots,
      // 启用决策引擎时，递回根的授权判断交给 evaluatePermission（模式语义）；
      // 未启用＝沿用升级前的递回根夹制。
      deferRecursiveRootCheck: configured,
    })
    if (!cleaned.ok) {
      // gateway tsconfig 为 strict:false（boolean 字面量判别式不窄化），显式转型。
      const err = cleaned as SanitizeErr
      return { ok: false, code: err.code, message: err.message }
    }

    const now = Date.now()
    if (!rec) return { ok: false, code: "device_offline", message: "device not registered" }
    if (!this.isOnline(rec, now)) return { ok: false, code: "device_offline", message: "device heartbeat expired" }

    // W6b：决策引擎（硬 denylist → safety → 规则 → 模式）。只有明确配置的装置才启用；
    // 未配置＝沿用升级前行为（此处不介入）。denylist 已在 sanitizeToolArgs 内先挡。
    let consent: DeviceRequestMessage["consent"] | undefined
    if (rec.permissionsEnabled) {
      const path = typeof cleaned.args.path === "string" ? cleaned.args.path : ""
      const explicitToken = input.authorizationToken !== undefined && input.authorizationToken !== null
      let granted = false
      /** once 自动核销成功的许可根（仅在无显式 token 且规则未放行时产生）。 */
      let onceRoot: string | null = null
      if (explicitToken) {
        granted = this.grants.consume(input.authorizationToken, { tenant: input.tenant, tool, path }, now).ok
      }
      if (!granted) {
        const verdict = evaluatePermission({
          tool,
          resolvedPath: path,
          mode: rec.mode,
          rules: this.allRulesFor(rec),
          authorizedRoots: rec.authorizedRoots,
          home: rec.home,
        })
        if (verdict.decision === "deny") {
          const code: DeviceBridgeErrorCode = verdict.reason === "denylist" ? "sensitive_path" : "permission_denied"
          return { ok: false, code, message: `path denied by policy (${verdict.reason})` }
        }
        if (verdict.decision === "ask") {
          // once 自动核销：opencode 的 local_files 从不下发 authorization_token ⇒ once 结构性
          // 死路。显式 token 已在上方优先处理；此处只处理「完全没带 token」的情形：主动找一笔
          // {tenant, tool, path} 相符、未使用的一次性许可核销，成功即本次放行。找不到仍维持
          // needs_authorization（且 denylist／safety 的 deny 已先返回，不放宽）。
          if (!explicitToken) {
            const match = this.grants.consumeMatching({ tenant: input.tenant, tool, path }, now)
            if (match.ok) {
              granted = true
              onceRoot = match.root
            }
          }
          if (!granted) {
            const isDirectory = tool === "list_dir" || tool === "grep"
            const root = suggestAuthorizationRoot(path, rec.home, isDirectory) ?? path
            return {
              ok: false,
              code: "needs_authorization",
              message: "此路径尚未授权。",
              needsAuthorization: { root, reason: mapAskReason(verdict.reason), options: AUTHORIZATION_OPTIONS },
            }
          }
        }
      }
      // 组同意记录（随本则 message 送到装置落地）：once 核销优先；否则送 session/permanent
      // 的累积同意。**依本请求路径落在哪种 scope 的根决定下发 scope**，且 roots 只取该
      // scope 的：绝不把 session 同意以 permanent 名义送到装置（否则装置会把 session 根
      // 永久落盘＝把同意升级；spec 硬禁）。没有任何记录＝不带此栏位（装置端不得无条件落盘）。
      if (onceRoot !== null) {
        consent = { scope: "once", roots: [onceRoot] }
      } else {
        const records = this.tenantConsent(input.tenant)
        if (records.length > 0) {
          const reqPath = typeof cleaned.args.path === "string" ? cleaned.args.path : ""
          const withinPermanent = records.some((r) => r.scope === "permanent" && isPathWithinRoot(reqPath, r.root))
          const sendScope: "session" | "permanent" = withinPermanent ? "permanent" : "session"
          const roots = [...new Set(records.filter((r) => r.scope === sendScope).map((r) => r.root))]
          if (roots.length > 0) consent = { scope: sendScope, roots }
        }
      }
      // full 语义＝家目录：装置端 allowlist 需要 home 随 consent 下发才放行家目录。
      if (rec.mode === "full" && rec.home) {
        const home = rec.home
        if (consent && consent.scope === "once") {
          // once 保持 once（不升级成 session），仅并入 home。
          if (!consent.roots.includes(home)) consent.roots = [...consent.roots, home]
        } else {
          // 不得以 permanent 下发 home：装置会把 session 根落盘成永久授权。
          const roots = consent ? consent.roots.slice() : []
          if (!roots.includes(home)) roots.push(home)
          consent = { scope: "session", roots }
        }
      }
    }

    const requestId = randomId("req")
    const token = this.tokens.mint({ deviceId: rec.deviceId, tool, requestId }, this.consentTtlMs(), now)
    const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? this.requestTimeoutMs(), 10 * 60_000))
    const message: DeviceRequestMessage = {
      request_id: requestId,
      tool,
      args: cleaned.args,
      consent_token: token,
      issued_at: now,
      expires_at: now + Math.min(timeoutMs, this.consentTtlMs()),
    }
    if (consent) message.consent = consent

    return await new Promise<InvokeResult>((resolve) => {
      const pending: PendingRequest = {
        requestId,
        tenant: input.tenant,
        deviceId: rec.deviceId,
        message,
        settled: false,
        timer: null,
        resolve,
      }
      this.pending.set(requestId, pending)
      const q = this.queue.get(this.deviceKey(input.tenant, rec.deviceId)) ?? []
      q.push(requestId)
      this.queue.set(this.deviceKey(input.tenant, rec.deviceId), q)
      pending.timer = setTimeout(() => this.cancelPending(requestId), timeoutMs)
      this.notifyPoll()
    })
  }

  /** 本机端执行完（或失败）后回传；闸道在此**再验一次同意票**（过期/不匹配/重放）。 */
  submitResult(input: {
    tenant: string
    deviceId: string
    connectionId: string
    requestId: string
    consentToken: unknown
    result?: unknown
    error?: string
    now?: number
  }): { ok: true } | { ok: false; code: DeviceBridgeErrorCode; message: string } {
    const now = input.now ?? Date.now()
    const rec = this.getDevice(input.tenant, input.deviceId)
    if (!rec) return { ok: false, code: "device_offline", message: "device not registered" }
    if (rec.connectionId !== input.connectionId) return { ok: false, code: "device_connection_stale", message: "connection is stale" }
    rec.lastSeenAt = now

    const p = this.pending.get(input.requestId)
    if (!p || p.settled || p.tenant !== input.tenant || p.deviceId !== rec.deviceId) {
      return { ok: false, code: "device_request_not_found", message: "no pending request with that id" }
    }
    const verdict = this.tokens.consume(
      input.consentToken,
      { deviceId: rec.deviceId, tool: p.message.tool, requestId: p.requestId },
      now,
    )
    if (!verdict.ok) {
      // 验票失败不落地：票留给原请求（可能只是本机端送错票），请求照旧等／逾时。
      const err = verdict as { ok: false; code: ConsentTokenError }
      return { ok: false, code: err.code, message: `consent ${err.code}` }
    }

    p.settled = true
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(p.requestId)
    if (typeof input.error === "string" && input.error.trim()) {
      p.resolve({ ok: false, code: "device_op_failed", message: input.error.trim().slice(0, 500), requestId: p.requestId })
      return { ok: true }
    }
    // H2 契约面第二层：装置自报递回时触碰敏感段 → 整笔拒绝、结果不落地。
    const reported = sensitiveResultProblem(input.result)
    if (reported) {
      p.resolve({ ok: false, code: "sensitive_path", message: reported, requestId: p.requestId })
      return { ok: false, code: "sensitive_path", message: reported }
    }
    const finalized = finalizeDeviceResult(input.result)
    p.resolve({
      ok: true,
      requestId: p.requestId,
      tool: p.message.tool,
      result: finalized.result,
      truncated: finalized.truncated,
      bytes: finalized.bytes,
    })
    return { ok: true }
  }

  /**
   * 唯读快照：某 userId 的装置在线概况。**不改动任何状态**（不刷 lastSeenAt、不动
   * 待办／票），供环境事实层回答「本回合的装置桥是否可用」。`now` 可注入以便测试逾时。
   */
  runtimeStateFor(userId: number | null, now: number = Date.now()): {
    online: boolean
    deviceCount: number
    authorizedRootCount: number
  } {
    let deviceCount = 0
    let onlineCount = 0
    let authorizedRootCount = 0
    for (const rec of this.devices.values()) {
      if (rec.userId !== userId) continue
      deviceCount++
      if (this.isOnline(rec, now)) {
        onlineCount++
        authorizedRootCount += rec.authorizedRoots.length
      }
    }
    return { online: onlineCount > 0, deviceCount, authorizedRootCount }
  }

  /**
   * W6b：某 userId 目前在线（最近心跳）装置的权限模式与授权根（环境事实层用）。
   * 无在线装置 → null（呼叫端不得猜）。**唯读、零副作用**。
   */
  policyStateFor(userId: number | null, now: number = Date.now()): { mode: DeviceBridgeMode; authorizedRoots: string[] } | null {
    let best: DeviceRecord | undefined
    for (const rec of this.devices.values()) {
      if (rec.userId !== userId) continue
      if (!this.isOnline(rec, now)) continue
      if (!best || rec.lastSeenAt > best.lastSeenAt) best = rec
    }
    if (!best) return null
    return { mode: best.mode, authorizedRoots: [...best.authorizedRoots] }
  }

  /**
   * 依租户挑一台装置（内部路由寻址）。**不做任何动作、不改状态**。
   * 见 `PickDeviceResult` 的五态语义。
   */
  pickDeviceForTenant(tenant: string, now: number = Date.now()): PickDeviceResult {
    const mine = [...this.devices.values()].filter((r) => r.tenant === tenant)
    if (mine.length === 0) {
      return { ok: false, code: "no_device_registered", message: "no device registered for this tenant" }
    }
    const online = mine.filter((r) => this.isOnline(r, now))
    if (mine.length === 1) {
      const only = mine[0]
      return this.isOnline(only, now)
        ? { ok: true, deviceId: only.deviceId }
        : { ok: false, code: "device_offline", message: "the registered device is offline" }
    }
    if (online.length === 1) return { ok: true, deviceId: online[0].deviceId }
    return {
      ok: false,
      code: "device_ambiguous",
      message: `multiple devices registered for tenant (${mine.length}), ${online.length} online`,
    }
  }

  /**
   * 唯读装置概况：该租户的代表装置（见下）的 online／roots／lastHeartbeat。
   * 0 台已注册 → null。代表装置＝`pickDeviceForTenant` 可判断时取之，否则取最近心跳者
   * （唯读查询，不涉及动作选择，故可回报「最近看到的那台」；**不**用于 invoke 寻址）。
   */
  describeTenantDevices(tenant: string, now: number = Date.now()): TenantDeviceDescription | null {
    const mine = [...this.devices.values()].filter((r) => r.tenant === tenant)
    if (mine.length === 0) return null
    const picked = this.pickDeviceForTenant(tenant, now)
    const rep = picked.ok
      ? mine.find((r) => r.deviceId === picked.deviceId) ?? mine[0]
      : mine.slice().sort((a, b) => (b.lastSeenAt - a.lastSeenAt) || a.deviceId.localeCompare(b.deviceId))[0]
    return { online: this.isOnline(rep, now), roots: [...rep.authorizedRoots], lastHeartbeatMs: rep.lastSeenAt }
  }

  /** 测试/运维用：装置数、待办数。 */
  stats(): { devices: number; pending: number; consentTokens: number } {
    return { devices: this.devices.size, pending: this.pending.size, consentTokens: this.tokens.size() }
  }
}
