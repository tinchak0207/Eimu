// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave1）：出站文本剥离（S2b/R4-A/R5-C，原 index.ts 736–888 行）。
// 2026-09-21 拆分：本档只留纯剥离逻辑（零 gateway 模组 import，node:test 可直跑）；
// emitSanitizedDelta 出口（依赖 sse-core/metrics/events-translate）移居
// outbound-emit.ts，行为零变化。拆分动机：单测曾因 emit 函数的
// sse-core → persistence → bun:sqlite import 链在 node 环境跑不动。

// ─── S2b（2026-08-27）：出站文本内部框架段剥离 ───
// 评测实锤：assistant 出站文本反覆出现 ## Objective / ## Work State /
// ## Next Move / ## Relevant Files 四个内部框架段——这是 agent 大脑的工作
// 状态骨架，不是给用户的正文。在出站路径（message.delta 发射前）按行剥离：
// 标题行起删，直到下一个非内部 markdown 标题或文本结束。行级状态机 + 尾行
// 扣留（未见换行不外发），保证不切烂正文句子、也不因 delta 边界拆漏标题。
// R2-C①（2026-08-27）：内部框架段扩到第二批——## Important Details /
// ### Completed / ### Active / ### Blocked（评测 event 208 起实锤泄漏）。
// 2026-09-21 e2e（60s 百合番 OP MV 野兽模式全流程）扩充第三批：
// ## Progress Summary ＋ critic 交付契约机器栏位名（verdict/issues/evidence/
// beats/shots/timeline_ops）——模型把它们当 markdown 标题输出时直达用户＝
// 内部泄漏。整词整行锚定（[ \t]*:?[ \t]*$），正文句子里出现这些单词不会命中。
// 全部是 ASCII 词组精确匹配 + 行尾锚定，中文字节永不命中 \w 词表，不误伤中文标题。
export const INTERNAL_SECTION_HEADING_RE = /^#{1,6}[ \t]*(objective|work state|next move|relevant files|important details|completed|active|blocked|progress summary|verdict|issues|evidence|beats|shots|timeline_ops)[ \t]*:?[ \t]*$/i
export const ANY_HEADING_RE = /^#{1,6}[ \t]/
// 2026-10-04 W：R5-C 繁→简改为**无条件生效**（站点只做简体；书写体镜像家族已整体拆除）。
export type PartStripState = { pending: string; suppress: boolean; fence: boolean; sawEnglish: boolean; hi?: string }

// ── R4-A S1（2026-08-28）：英文正文守门 ──
// R4 实锤（死线一）：message.delta 出现成段英文 reasoning（event 5180 "The
// Chapter 1 narrative begins at line 97…"、5540-5543 "Let me check…"）。
// 硬要求：中文内容不丢、不调 LLM 重写、代码块与引文不误伤。取最小可信方案：
// 行级检测（复用 S2b 行状态机，长行同样等 \n 完整再判）——无 CJK、非引文
//（> 开头）、非链接、非表格行，且英文词数达标（≥5 词且句末有标点，或 ≥8 词）
// 判为英文成句正文 → 整行压制，发一帧一次性中文提示替代。书名/章节列表行
//（无句末标点）与代码栅栏内容直通。短行（术语/标识符/型号）永不命中。
export function isEnglishProseLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/[\u4e00-\u9fff]/.test(t)) return false // 任何中文 → 放行（硬要求：中文不丢）
  if (t.startsWith(">")) return false // markdown 引文 → 放行
  if (t.startsWith("|")) return false // 表格行 → 放行
  if (/https?:\/\//.test(t)) return false // 链接行 → 放行
  const words = t.match(/[A-Za-z]{2,}/g)
  const n = words ? words.length : 0
  if (n < 5) return false
  if (n >= 8) return true
  return /[.!?…]["')\]]?$/.test(t) // 5-7 词仅在成句（句末标点收尾）时判定
}

// ── R5-C（2026-08-28）：繁体正文转简体守门 ──
// 站点文案一律简体是硬规范。正文行（非栅栏/引文/表格/链接——这些在上游已
// 放行不进转换）检出繁体常用字 → 按高频繁简映射表逐字转换。VPS/本机均无
// opencc（已核实 gateway node_modules），按规格用精简高频表；(繁,简) 二字
// 一组串接；未收录的罕用字原样保留，不猜测不误转。
export const T2S_PAIRS =
  "這这裡里裏里後后時时間间會会來来對对開开關关門门電电話话說说請请謝谢應应該该當当處处動动靜静聽听寫写讀读學学練练體体飛飞車车馬马鳥鸟魚鱼龍龙鳳凤樹树葉叶華华國国圖图書书畫画藝艺術术醫医藥药錢钱銀银買买賣卖貴贵質质費费資资億亿遠远運运進进過过達达選选邊边還还鄉乡長长麼么麗丽義义樂乐橋桥樣样檔档機机構构業业歷历歸归歲岁殘残湯汤溫温無无為为烏乌燒烧热热愛爱親亲個个價价儀仪兒儿內内冊册幾几廠厂廣广強强復复複复徵征憶忆懷怀戲戏掛挂揚扬揮挥擊击據据擴扩攝摄數数斷断舊旧顯显條条標标檢检欄栏權权歐欧濟济營营環环發发髮发眾众優优傳传傷伤僅仅儘尽務务勝胜匯汇區区協协單单嚴严圓圆壓压廢废從从執执場场塊块壯壮夢梦奮奋婦妇媽妈孫孙實实寧宁寶宝專专導导層层屬属島岛幣币幹干廳厅張张彈弹彎弯徑径戰战擔担擁拥攔拦敵敌於于顧顾鏡镜頭头繼继續续閒闲額额語语譯译課课論论護护議议訊讯記记講讲認认訓训設设訪访評评詞词試试詩诗調调談谈誠诚誤误誰谁諾诺變变讓让讚赞計计財财貨货貧贫賽赛贈赠跡迹軍军輕轻較较載载輸输辦办辭辞遲迟適适郵邮鄰邻鋼钢錄录錯错鍵键鎮镇鏈链鎖锁難难霧雾響响項项順顺須须領领頻频題题顏颜願愿類类顆颗風风飯饭養养館馆駐驻驗验鬆松鬧闹鳴鸣麥麦麵面點点黨党龜龟給给紐纽級级約约結结絕绝經经統统維维網网綜综線线緊紧總总縮缩織织紅红綠绿縣县紀纪純纯紙纸綱纲縱纵紛纷紹绍備备準准溝沟滅灭滾滚漢汉漸渐潔洁潑泼灑洒灣湾爺爷爾尔牆墙獲获獨独獸兽猶犹獻献產产畢毕殺杀殼壳毀毁滿满潛潜爛烂狀状獎奖禮礼筆笔稅税監监盡尽礙碍禍祸種种稱称穀谷穩稳窮穷竄窜節节範范簡简簽签籌筹糧粮臟脏與与艙舱萬万萊莱蓋盖蔣蒋蕭萧薦荐藍蓝蠻蛮褲裤視视覺觉覽览觸触誇夸誼谊誦诵諸诸謀谋謂谓謙谦謹谨證证豈岂貓猫賓宾賈贾賊贼賠赔賦赋賭赌賴赖贏赢趙赵趕赶躍跃軌轨軒轩軟软軸轴輛辆輩辈輪轮輯辑轉转農农迴回連连週周遊游遷迁遺遗遼辽醜丑釀酿釋释鐘钟鋪铺鍋锅鐵铁鑽钻閃闪閉闭闆板隊队際际隨随隱隐雖虽雙双雜杂雞鸡離离靈灵韓韩頂顶頃顷預预頑顽頒颁頗颇顛颠飄飘飲饮饅馒餅饼餓饿餘余餵喂饋馈饒饶驅驱驚惊鬍胡鬥斗魯鲁鮮鲜兩两嚇吓櫃柜桿杆棄弃極极榮荣樓楼橫横補补裝装製制臺台颱台隻只誌志嘆叹團团圍围壞坏聲声妝妆尋寻幫帮慶庆彌弥徹彻態态懼惧掃扫擬拟攏拢擇择擋挡報报堅坚壇坛爾尔榮荣團团"
  + "測测現现沒没碼码戶户帶带確确換换號号別别並并啟启則则敗败帳帐註注錘锤幀帧參参見见決决庫库頁页組组規规問问閘闸刪删編编側侧腳脚審审盤盘終终併并鈕钮齊齐針针佔占聯联丟丢綁绑詢询觀观憑凭瀏浏綴缀釘钉異异劇剧創创糾纠識识們们錨锚寬宽淨净衛卫衝冲卻却倉仓冪幂階阶剝剥陣阵負负貼贴訂订險险疊叠邏逻員员繞绕紋纹銷销濾滤籤签鑑鉴凍冻鑰钥屍尸喚唤違违許许賬账積积驟骤憲宪緩缓診诊暫暂損损細细兌兑採采斂敛遞递緒绪競竞劃划燈灯蹤踪偽伪拋抛況况陰阴殭僵譜谱臨临減减檻槛熱热佈布氣气緣缘燼烬儲储恆恒偵侦陳陈膠胶舉举東东閱阅鉤钩亂乱謊谎澱淀臉脸雲云夾夹詳详潰溃敘叙樁桩沖冲搶抢緋绯剛刚慣惯託托責责鑄铸勢势煙烟懸悬頓顿嗎吗夠够螢萤彙汇捨舍撐撑兇凶腦脑騙骗佇伫師师洩泄虛虚欽钦縫缝繪绘閾阈癒愈髒脏坏坯頸颈湊凑礎础係系脫脱篩筛職职槓杠脈脉絡络棧栈屜屉滯滞擾扰虧亏撈捞懶懒撿捡陽阳輔辅罰罚嘗尝將将飾饰擺摆慮虑暈晕銅铜納纳豎竖聖圣禦御遙遥礦矿攤摊駁驳陸陆飽饱黃黄貫贯貢贡習习曉晓漲涨擠挤貝贝騰腾淺浅絲丝墊垫謎谜購购"
export const T2S_MAP = new Map<string, string>()
for (let i = 0; i + 1 < T2S_PAIRS.length; i += 2) T2S_MAP.set(T2S_PAIRS[i]!, T2S_PAIRS[i + 1]!)
export const T2S_RE = new RegExp(`[${Array.from(T2S_MAP.keys()).join("")}]`, "g")

// ── R9-B（2026-09-30）：假名行不转 ──
// 实锤：日文歌词被 R5-C 逐字转（「この距離が」→「この距离が」）。日文汉字不是繁体中文，
// 任何含平假名/片假名的行一律原样放行。・（U+30FB）与 ー（U+30FC）中文排版也常用，不算证据。
// 2026-10-04 W：原「跟随用户书写体」的 t2s/s2t 双向分支已随书写体镜像家族拆除——出口一律简体。
export const KANA_RE = /[\u3041-\u309F\u30A1-\u30FA\u30FD-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/

/** 正文行繁→简转换：无映射命中原样返回；有转换时留 journal 证据行。含假名的行（日文）原样返回。 */
export function t2sLine(line: string): string {
  if (!line) return line
  if (KANA_RE.test(line)) return line // R9-B ①：日文行不转
  let converted = false
  const out = line.replace(T2S_RE, (c) => {
    converted = true
    return T2S_MAP.get(c) ?? c
  })
  if (converted) console.log(`[gateway] R5-C t2s: line converted: ${out.slice(0, 60)}`)
  return out
}

// ── R4-A S2（2026-08-28）：内部条款编号剥离 ──
// R4 实锤：正文出现「按 §3.8.3」「按 §3.8.2 默认使用…」——内部手册编号不得
// 直达用户。剥编号留语义：§\d+(\.\d+)* 整体替换为「内部规定」。
export const SECTION_REF_RE = /按\s*§\s?\d+(?:\.\d+)*/g
export const SECTION_TOKEN_RE = /§\s?\d+(?:\.\d+)*/g

// ── 2026-09-28 漫剧工作室评测：内部路径／规则代号剥离 ──
// 实锤：面向工作室的进度简报出现「spec 已落盘 `runs/txj-ep01/audio/…md`」「R7 止损线执行正确」
// 「完整结果已落盘 outputs/subagent/…」——AGENTS.md §0 已禁内部标识入正文，模型仍会带出。
// 出站确定性兜底：URL 段原样保留（交付物链接是给用户的），只在非 URL 段替换工作区路径
// （/opt/agent-harness/…、outputs/…、runs/…、以及带文档/数据副档名的相对路径）与 R 系列规则代号。
const URL_SEGMENT_RE = /(https?:\/\/[^\s)）\]」>`"']+)/
export const INTERNAL_PATH_RE = /`?(?:\/opt\/agent-harness\/[^\s`，。；、（）()「」\[\]]+|(?:outputs|runs)\/[^\s`，。；、（）()「」\[\]]+|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:md|json|jsonl|txt|ts|py|mjs|srt|ass))`?/g
export const INTERNAL_RULE_CODE_RE = /\bR\d{1,2}(?:-[A-Z]\d?)?\s*(止损线|止损条款|止损|铁律)/g

export function scrubInternalRefs(line: string): string {
  if (!line) return line
  return line
    .split(URL_SEGMENT_RE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(INTERNAL_PATH_RE, "（内部存档）").replace(INTERNAL_RULE_CODE_RE, "$1")))
    .join("")
}

// ── 2026-10-02 e2e 成片评测：UTF-8/UTF-16 边界乱码守门 ──
// 实锤：SSE 出现「未��用」（多位元组字被上游在边界切断，解码成 U+FFFD）。
// 出口确定性兜底：① 剔除 U+FFFD（宁缺一字不外发方块）；② 孤立代理项剔除，
// 尾部高代理项扣留到下个 chunk 拼成完整码点（emoji 跨 delta 不再变 �）。
export function cleanUtf16Chunk(st: { hi?: string }, chunk: string, flush = false): string {
  let s = (st.hi ?? "") + chunk
  st.hi = undefined
  if (!flush && s && /[\uD800-\uDBFF]/.test(s.slice(-1))) {
    st.hi = s.slice(-1)
    s = s.slice(0, -1)
  }
  return s.replace(/\uFFFD/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
}

/** 喂入一个 chunk，回传可安全外发的文本（行未完整时扣留，可能回空串）。 */
export function stripOutboundFeed(st: PartStripState, chunk: string): string {
  chunk = cleanUtf16Chunk(st, chunk)
  if (!chunk) return ""
  const lines = (st.pending + chunk).split("\n")
  st.pending = lines.pop() ?? "" // 最后一段是未完成行（无换行终结），扣留待判
  let out = ""
  for (const line of lines) {
    // 代码栅栏：栅栏内容直通（S1 硬要求：代码块不误伤）。
    if (st.fence) {
      out += line + "\n"
      if (/^\s*(```|~~~)/.test(line)) st.fence = false
      continue
    }
    if (/^\s*(```|~~~)/.test(line)) {
      st.fence = true
      out += line + "\n"
      continue
    }
    if (st.suppress) {
      // 内部段到下一个「非内部」标题为止；下一个内部段标题继续吞
      if (ANY_HEADING_RE.test(line) && !INTERNAL_SECTION_HEADING_RE.test(line)) {
        st.suppress = false
        out += t2sLine(line) + "\n" // R5-C：正文行繁→简（无条件，出口一律简体）
      }
      continue
    }
    if (INTERNAL_SECTION_HEADING_RE.test(line)) {
      st.suppress = true
      continue
    }
    // S1：成段英文正文 → 整行压制，记录待发中文提示。
    if (isEnglishProseLine(line)) {
      st.sawEnglish = true
      continue
    }
    // S2：内部条款编号剥离（留语义）+ R5-C 繁→简守门。
    out += t2sLine(scrubInternalRefs(line).replace(SECTION_REF_RE, "按内部规定").replace(SECTION_TOKEN_RE, "内部规定")) + "\n"
  }
  return out
}

/** 回合/部件结束：残留尾行按当前抑制状态一次性判定（无换行终结，不再扣留）。 */
export function stripOutboundFlush(st: PartStripState): string {
  const line = st.pending + cleanUtf16Chunk(st, "", true)
  st.pending = ""
  if (!line) return ""
  if (st.fence) return line // 栅栏未闭合：尾部原样吐出
  if (st.suppress) {
    if (ANY_HEADING_RE.test(line) && !INTERNAL_SECTION_HEADING_RE.test(line)) {
      st.suppress = false
      return t2sLine(line) // R5-C：正文行繁→简（无条件，出口一律简体）
    }
    return ""
  }
  if (INTERNAL_SECTION_HEADING_RE.test(line)) {
    st.suppress = true
    return ""
  }
  if (isEnglishProseLine(line)) {
    st.sawEnglish = true
    return ""
  }
  return t2sLine(scrubInternalRefs(line).replace(SECTION_REF_RE, "按内部规定").replace(SECTION_TOKEN_RE, "内部规定"))
}

// ── R9-B（2026-09-30）：part 尾行即时吐出，回合结束不再补播过期旁白 ──
// R9 实锤（eval-yuri-op-mv-0930 SSE 9888–9894）：工具调用前的单行旁白 text part
//（「我先掌握行情…」「先让歌跑起来：」「付费通路是活的…」，均无尾换行）被
// stripOutboundFeed 的尾行扣留机制整行压在 pending，整个回合没有外发（SSE 全档
// 各只出现一次）；session.idle 按 partStripState 插入序一次性 flush → 7 句过期
// 旁白接在最终答覆（9861–9887）之后、turn.done（9895）之前「报幕」。
// 修法：新 text part 开始／工具调用开始时，把其他 part 扣住的尾行当场吐出
//（加段落分隔，保持与工具/下一段的时序）；回合结束只吐最后一个 part 的尾行。

/** 把 exceptPid 以外各 part 扣住的尾行吐出（即时、按插入序），回传待发文本（可能空串）。 */
export function flushOtherPartTails(map: Map<string, PartStripState>, exceptPid?: string): string {
  let out = ""
  for (const [pid, st] of map) {
    if (pid === exceptPid || !st.pending) continue
    const tail = stripOutboundFlush(st)
    if (tail) out += tail + "\n\n"
  }
  return out
}

/** 回合结束：只吐最后一个 part（最终答覆）的尾行；更早 part 的残留一律丢弃不补播。 */
export function takeTurnEndTail(map: Map<string, PartStripState>): { tail: string; dropped: string[] } {
  const entries = Array.from(map.values())
  const dropped: string[] = []
  for (let i = 0; i < entries.length - 1; i++) {
    const t = stripOutboundFlush(entries[i]!)
    if (t) dropped.push(t)
  }
  const last = entries[entries.length - 1]
  return { tail: last ? stripOutboundFlush(last) : "", dropped }
}
