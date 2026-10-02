// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave1）：出站文本剝離（S2b/R4-A/R5-C，原 index.ts 736–888 行）。
// 2026-09-21 拆分：本檔只留純剝離邏輯（零 gateway 模組 import，node:test 可直跑）；
// emitSanitizedDelta 出口（依賴 sse-core/metrics/events-translate）移居
// outbound-emit.ts，行為零變化。拆分動機：單測曾因 emit 函數的
// sse-core → persistence → bun:sqlite import 鏈在 node 環境跑不動。

// ─── S2b（2026-08-27）：出站文本內部框架段剝離 ───
// 評測實錘：assistant 出站文本反覆出現 ## Objective / ## Work State /
// ## Next Move / ## Relevant Files 四個內部框架段——這是 agent 大腦的工作
// 狀態骨架，不是給用戶的正文。在出站路徑（message.delta 發射前）按行剝離：
// 標題行起刪，直到下一個非內部 markdown 標題或文本結束。行級狀態機 + 尾行
// 扣留（未見換行不外發），保證不切爛正文句子、也不因 delta 邊界拆漏標題。
// R2-C①（2026-08-27）：內部框架段擴到第二批——## Important Details /
// ### Completed / ### Active / ### Blocked（評測 event 208 起實錘泄漏）。
// 2026-09-21 e2e（60s 百合番 OP MV 野獸模式全流程）擴充第三批：
// ## Progress Summary ＋ critic 交付契約機器欄位名（verdict/issues/evidence/
// beats/shots/timeline_ops）——模型把它們當 markdown 標題輸出時直達用戶＝
// 內部洩漏。整詞整行錨定（[ \t]*:?[ \t]*$），正文句子裡出現這些單詞不會命中。
// 全部是 ASCII 詞組精確匹配 + 行尾錨定，中文字節永不命中 \w 詞表，不誤傷中文標題。
export const INTERNAL_SECTION_HEADING_RE = /^#{1,6}[ \t]*(objective|work state|next move|relevant files|important details|completed|active|blocked|progress summary|verdict|issues|evidence|beats|shots|timeline_ops)[ \t]*:?[ \t]*$/i
export const ANY_HEADING_RE = /^#{1,6}[ \t]/
// R9-B（2026-09-30）：t2s = 本 part 正文是否做 R5-C 繁→簡（缺省/undefined ＝ 轉，舊行為）。
// 由 outbound-emit 按會話用戶書寫體決定（shouldT2sForUserScript）；繁體用戶置 false。
export type PartStripState = { pending: string; suppress: boolean; fence: boolean; sawEnglish: boolean; t2s?: boolean; hi?: string }

// ── R4-A S1（2026-08-28）：英文正文守門 ──
// R4 實錘（死線一）：message.delta 出現成段英文 reasoning（event 5180 "The
// Chapter 1 narrative begins at line 97…"、5540-5543 "Let me check…"）。
// 硬要求：中文內容不丟、不調 LLM 重寫、代碼塊與引文不誤傷。取最小可信方案：
// 行級檢測（複用 S2b 行狀態機，長行同樣等 \n 完整再判）——無 CJK、非引文
//（> 開頭）、非鏈接、非表格行，且英文詞數達標（≥5 詞且句末有標點，或 ≥8 詞）
// 判為英文成句正文 → 整行壓制，發一幀一次性中文提示替代。書名/章節列表行
//（無句末標點）與代碼柵欄內容直通。短行（術語/標識符/型號）永不命中。
export function isEnglishProseLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/[\u4e00-\u9fff]/.test(t)) return false // 任何中文 → 放行（硬要求：中文不丟）
  if (t.startsWith(">")) return false // markdown 引文 → 放行
  if (t.startsWith("|")) return false // 表格行 → 放行
  if (/https?:\/\//.test(t)) return false // 鏈接行 → 放行
  const words = t.match(/[A-Za-z]{2,}/g)
  const n = words ? words.length : 0
  if (n < 5) return false
  if (n >= 8) return true
  return /[.!?…]["')\]]?$/.test(t) // 5-7 詞僅在成句（句末標點收尾）時判定
}

// ── R5-C（2026-08-28）：繁體正文轉簡體守門 ──
// 站點文案一律簡體是硬規範。正文行（非柵欄/引文/表格/鏈接——這些在上游已
// 放行不進轉換）檢出繁體常用字 → 按高频繁简映射表逐字轉換。VPS/本機均無
// opencc（已核實 gateway node_modules），按規格用精簡高頻表；(繁,简) 二字
// 一組串接；未收錄的罕用字原樣保留，不猜測不誤轉。
export const T2S_PAIRS =
  "這这裡里裏里後后時时間间會会來来對对開开關关門门電电話话說说請请謝谢應应該该當当處处動动靜静聽听寫写讀读學学練练體体飛飞車车馬马鳥鸟魚鱼龍龙鳳凤樹树葉叶華华國国圖图書书畫画藝艺術术醫医藥药錢钱銀银買买賣卖貴贵質质費费資资億亿遠远運运進进過过達达選选邊边還还鄉乡長长麼么麗丽義义樂乐橋桥樣样檔档機机構构業业歷历歸归歲岁殘残湯汤溫温無无為为烏乌燒烧热热愛爱親亲個个價价儀仪兒儿內内冊册幾几廠厂廣广強强復复複复徵征憶忆懷怀戲戏掛挂揚扬揮挥擊击據据擴扩攝摄數数斷断舊旧顯显條条標标檢检欄栏權权歐欧濟济營营環环發发髮发眾众優优傳传傷伤僅仅儘尽務务勝胜匯汇區区協协單单嚴严圓圆壓压廢废從从執执場场塊块壯壮夢梦奮奋婦妇媽妈孫孙實实寧宁寶宝專专導导層层屬属島岛幣币幹干廳厅張张彈弹彎弯徑径戰战擔担擁拥攔拦敵敌於于顧顾鏡镜頭头繼继續续閒闲額额語语譯译課课論论護护議议訊讯記记講讲認认訓训設设訪访評评詞词試试詩诗調调談谈誠诚誤误誰谁諾诺變变讓让讚赞計计財财貨货貧贫賽赛贈赠跡迹軍军輕轻較较載载輸输辦办辭辞遲迟適适郵邮鄰邻鋼钢錄录錯错鍵键鎮镇鏈链鎖锁難难霧雾響响項项順顺須须領领頻频題题顏颜願愿類类顆颗風风飯饭養养館馆駐驻驗验鬆松鬧闹鳴鸣麥麦麵面點点黨党龜龟給给紐纽級级約约結结絕绝經经統统維维網网綜综線线緊紧總总縮缩織织紅红綠绿縣县紀纪純纯紙纸綱纲縱纵紛纷紹绍備备準准溝沟滅灭滾滚漢汉漸渐潔洁潑泼灑洒灣湾爺爷爾尔牆墙獲获獨独獸兽猶犹獻献產产畢毕殺杀殼壳毀毁滿满潛潜爛烂狀状獎奖禮礼筆笔稅税監监盡尽礙碍禍祸種种稱称穀谷穩稳窮穷竄窜節节範范簡简簽签籌筹糧粮臟脏與与艙舱萬万萊莱蓋盖蔣蒋蕭萧薦荐藍蓝蠻蛮褲裤視视覺觉覽览觸触誇夸誼谊誦诵諸诸謀谋謂谓謙谦謹谨證证豈岂貓猫賓宾賈贾賊贼賠赔賦赋賭赌賴赖贏赢趙赵趕赶躍跃軌轨軒轩軟软軸轴輛辆輩辈輪轮輯辑轉转農农迴回連连週周遊游遷迁遺遗遼辽醜丑釀酿釋释鐘钟鋪铺鍋锅鐵铁鑽钻閃闪閉闭闆板隊队際际隨随隱隐雖虽雙双雜杂雞鸡離离靈灵韓韩頂顶頃顷預预頑顽頒颁頗颇顛颠飄飘飲饮饅馒餅饼餓饿餘余餵喂饋馈饒饶驅驱驚惊鬍胡鬥斗魯鲁鮮鲜兩两嚇吓櫃柜桿杆棄弃極极榮荣樓楼橫横補补裝装製制臺台颱台隻只誌志嘆叹團团圍围壞坏聲声妝妆尋寻幫帮慶庆彌弥徹彻態态懼惧掃扫擬拟攏拢擇择擋挡報报堅坚壇坛爾尔榮荣團团"
  + "測测現现沒没碼码戶户帶带確确換换號号別别並并啟启則则敗败帳帐註注錘锤幀帧參参見见決决庫库頁页組组規规問问閘闸刪删編编側侧腳脚審审盤盘終终併并鈕钮齊齐針针佔占聯联丟丢綁绑詢询觀观憑凭瀏浏綴缀釘钉異异劇剧創创糾纠識识們们錨锚寬宽淨净衛卫衝冲卻却倉仓冪幂階阶剝剥陣阵負负貼贴訂订險险疊叠邏逻員员繞绕紋纹銷销濾滤籤签鑑鉴凍冻鑰钥屍尸喚唤違违許许賬账積积驟骤憲宪緩缓診诊暫暂損损細细兌兑採采斂敛遞递緒绪競竞劃划燈灯蹤踪偽伪拋抛況况陰阴殭僵譜谱臨临減减檻槛熱热佈布氣气緣缘燼烬儲储恆恒偵侦陳陈膠胶舉举東东閱阅鉤钩亂乱謊谎澱淀臉脸雲云夾夹詳详潰溃敘叙樁桩沖冲搶抢緋绯剛刚慣惯託托責责鑄铸勢势煙烟懸悬頓顿嗎吗夠够螢萤彙汇捨舍撐撑兇凶腦脑騙骗佇伫師师洩泄虛虚欽钦縫缝繪绘閾阈癒愈髒脏坏坯頸颈湊凑礎础係系脫脱篩筛職职槓杠脈脉絡络棧栈屜屉滯滞擾扰虧亏撈捞懶懒撿捡陽阳輔辅罰罚嘗尝將将飾饰擺摆慮虑暈晕銅铜納纳豎竖聖圣禦御遙遥礦矿攤摊駁驳陸陆飽饱黃黄貫贯貢贡習习曉晓漲涨擠挤貝贝騰腾淺浅絲丝墊垫謎谜購购"
export const T2S_MAP = new Map<string, string>()
for (let i = 0; i + 1 < T2S_PAIRS.length; i += 2) T2S_MAP.set(T2S_PAIRS[i]!, T2S_PAIRS[i + 1]!)
export const T2S_RE = new RegExp(`[${Array.from(T2S_MAP.keys()).join("")}]`, "g")

// ── 2026-10-02：中文輸出「簡→繁」矯正（繁體會話的繁簡混雜兜底）──
// 背景：R5-C 只做繁→簡（簡體/未判定會話）；繁體用戶走 t2s=false 原樣放行，
// 模型漏出的簡體字（如「回來后」「视觉」→「视觉」）便直達用戶＝繁簡混雜。
// 本段補反向矯正：由既有 R5-C 對照表反向導出（不另造大表），僅在 t2s===false
// （已判定為繁體用戶）時生效。映射鍵全為 CJK，故英文／ASCII JSON 鍵／代碼符號
// 天然不受影響；URL 段與含假名的日文行原樣放行（同 t2sLine）。
//
// 歧義排除：部分簡體字形同時是「正確的繁體字」（同形異義），逐字回轉會改壞合法
// 繁體文——里(公里)、只(只有)、面(方面)、回(回來)、干(干涉)、志(志願)、復/複、
// 並/併、盡/儘 等一律不轉，寧缺勿錯；其餘按表回轉。后/台/个/么 為高頻且幾乎必
// 為簡體，允許回轉（與 OpenCC s2t 默認一致），僅皇后/台端等罕用詞可能被改，屬
// 已知且可接受的上界（見 2026-10-02 本輪驗收）。
export const S2T_SKIP = new Set(Array.from("里只面干志占布周游回冲丑范几松谷胡斗板征划云迹夸荐洒杆柜愿喂并复尽"))
export const S2T_MAP = new Map<string, string>()
for (const [trad, simp] of T2S_MAP) {
  if (trad === simp || S2T_SKIP.has(simp) || S2T_MAP.has(simp)) continue
  S2T_MAP.set(simp, trad) // 首見為準（T2S_PAIRS 順序＝決定性）
}
export const S2T_RE = new RegExp(`[${Array.from(S2T_MAP.keys()).join("")}]`, "g")

// ── R9-B（2026-09-30）：R5-C 跟隨用戶書寫體 ──
// R9 實錘（eval-yuri-op-mv-0930 SSE 9861–9887）：用戶以繁體書寫，出口仍按 R5-C
// 逐字繁→簡，精簡表只覆蓋部分字 → 「帳號余额」「現在交不出成片」繁簡混雜；
// 日文歌詞被轉（「この距離が」→「この距离が」、「放課後」→「放课后」）。
// R5-C 原意（站點文案簡體）保留給簡體用戶與無法判定者；規則：
//  ① 任何含平假名/片假名的行一律不轉（日文漢字不是繁體中文）；
//  ② 會話用戶書寫體 = 繁體 → 不轉；簡體/未判定 → 照舊轉。
// ・（U+30FB）與 ー（U+30FC）中文排版也常用，不算假名證據。
export const KANA_RE = /[\u3041-\u309F\u30A1-\u30FA\u30FD-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/

export type UserScript = "hant" | "hans" | "unknown"
// 簡體證據字：映射表的簡體側，扣掉繁體文本裡同樣常見的共用字（后/台/只/面/余/于…），
// 避免繁體用戶寫「皇后」「台北」被誤判為簡體。
const T2S_SHARED = new Set(Array.from("里后发复干台只志谷松胡斗板周游回制征范丑面余于喂迹夸荐洒杆柜愿几个松尽并占布冲云叙划"))
const TRAD_EVIDENCE = new Set<string>()
const SIMP_EVIDENCE = new Set<string>()
for (const [t, sc] of T2S_MAP) {
  if (t === sc) continue
  TRAD_EVIDENCE.add(t)
  if (!T2S_SHARED.has(sc) && !T2S_MAP.has(sc)) SIMP_EVIDENCE.add(sc)
}

/** 判定一段用戶文本的書寫體：繁體特徵字多→hant，簡體特徵字多→hans，否則 unknown。 */
export function detectUserScript(text: string): UserScript {
  if (!text) return "unknown"
  let hant = 0
  let hans = 0
  for (const c of text) {
    if (TRAD_EVIDENCE.has(c)) hant++
    else if (SIMP_EVIDENCE.has(c)) hans++
  }
  if (hant > hans) return "hant"
  if (hans > hant) return "hans"
  return "unknown"
}

/** 會話書寫體黏性：本條消息無判定力（如「A」「好」）時沿用上一次判定。 */
export function resolveUserScript(prev: UserScript | undefined, userText: string | undefined): UserScript {
  const cur = detectUserScript(userText ?? "")
  return cur !== "unknown" ? cur : (prev ?? "unknown")
}

/** 該書寫體下出口是否做 R5-C 繁→簡：只有繁體用戶不轉（簡體/未判定保 R5-C 舊行為）。 */
export function shouldT2sForUserScript(script: UserScript): boolean {
  return script !== "hant"
}

/** 正文行繁→簡轉換：無映射命中原樣返回；有轉換時留 journal 證據行。含假名的行（日文）原樣返回。 */
export function t2sLine(line: string): string {
  if (!line) return line
  if (KANA_RE.test(line)) return line // R9-B ①：日文行不轉
  let converted = false
  const out = line.replace(T2S_RE, (c) => {
    converted = true
    return T2S_MAP.get(c) ?? c
  })
  if (converted) console.log(`[gateway] R5-C t2s: line converted: ${out.slice(0, 60)}`)
  return out
}

/** 正文行簡→繁矯正（繁體用戶出口）：只動 CJK，URL 段原樣；含假名的日文行原樣。
 *  歧義字見 S2T_SKIP 註釋；有轉換時留 journal 證據行。 */
export function s2tLine(line: string): string {
  if (!line) return line
  if (KANA_RE.test(line)) return line // 日文行不轉（同 t2sLine）
  let converted = false
  const out = line
    .split(URL_SEGMENT_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(S2T_RE, (c) => {
            converted = true
            return S2T_MAP.get(c) ?? c
          }),
    )
    .join("")
  if (converted) console.log(`[gateway] S2T s2t: line converted: ${out.slice(0, 60)}`)
  return out
}

// ── R4-A S2（2026-08-28）：內部條款編號剝離 ──
// R4 實錘：正文出現「按 §3.8.3」「按 §3.8.2 默認使用…」——內部手冊編號不得
// 直達用戶。剝編號留語義：§\d+(\.\d+)* 整體替換為「内部规定」。
export const SECTION_REF_RE = /按\s*§\s?\d+(?:\.\d+)*/g
export const SECTION_TOKEN_RE = /§\s?\d+(?:\.\d+)*/g

// ── 2026-09-28 漫劇工作室評測：內部路徑／規則代號剝離 ──
// 實錘：面向工作室的進度簡報出現「spec 已落盘 `runs/txj-ep01/audio/…md`」「R7 止损线执行正确」
// 「完整结果已落盘 outputs/subagent/…」——AGENTS.md §0 已禁內部標識入正文，模型仍會帶出。
// 出站確定性兜底：URL 段原樣保留（交付物鏈接是給用戶的），只在非 URL 段替換工作區路徑
// （/opt/agent-harness/…、outputs/…、runs/…、以及帶文檔/數據副檔名的相對路徑）與 R 系列規則代號。
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

/** R9-B：本 part 的正文轉換出口（t2s === false ＝ 繁體用戶會話 → 簡→繁矯正；
 *  其餘 → R5-C 繁→簡）。 */
function bodyT2s(st: PartStripState, line: string): string {
  return st.t2s === false ? s2tLine(line) : t2sLine(line)
}

// ── 2026-10-02 e2e 成片評測：UTF-8/UTF-16 邊界亂碼守門 ──
// 實錘：SSE 出現「未��用」（多位元組字被上游在邊界切斷，解碼成 U+FFFD）。
// 出口確定性兜底：① 剔除 U+FFFD（寧缺一字不外發方塊）；② 孤立代理項剔除，
// 尾部高代理項扣留到下個 chunk 拼成完整碼點（emoji 跨 delta 不再變 �）。
export function cleanUtf16Chunk(st: { hi?: string }, chunk: string, flush = false): string {
  let s = (st.hi ?? "") + chunk
  st.hi = undefined
  if (!flush && s && /[\uD800-\uDBFF]/.test(s.slice(-1))) {
    st.hi = s.slice(-1)
    s = s.slice(0, -1)
  }
  return s.replace(/\uFFFD/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
}

/** 餵入一個 chunk，回傳可安全外發的文本（行未完整時扣留，可能回空串）。 */
export function stripOutboundFeed(st: PartStripState, chunk: string): string {
  chunk = cleanUtf16Chunk(st, chunk)
  if (!chunk) return ""
  const lines = (st.pending + chunk).split("\n")
  st.pending = lines.pop() ?? "" // 最後一段是未完成行（無換行終結），扣留待判
  let out = ""
  for (const line of lines) {
    // 代碼柵欄：柵欄內容直通（S1 硬要求：代碼塊不誤傷）。
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
      // 內部段到下一個「非內部」標題為止；下一個內部段標題繼續吞
      if (ANY_HEADING_RE.test(line) && !INTERNAL_SECTION_HEADING_RE.test(line)) {
        st.suppress = false
        out += bodyT2s(st, line) + "\n" // R5-C：正文行繁→簡（R9-B：跟隨用戶書寫體）
      }
      continue
    }
    if (INTERNAL_SECTION_HEADING_RE.test(line)) {
      st.suppress = true
      continue
    }
    // S1：成段英文正文 → 整行壓制，記錄待發中文提示。
    if (isEnglishProseLine(line)) {
      st.sawEnglish = true
      continue
    }
    // S2：內部條款編號剝離（留語義）+ R5-C 繁→簡守門。
    out += bodyT2s(st, scrubInternalRefs(line).replace(SECTION_REF_RE, "按内部规定").replace(SECTION_TOKEN_RE, "内部规定")) + "\n"
  }
  return out
}

/** 回合/部件結束：殘留尾行按當前抑制狀態一次性判定（無換行終結，不再扣留）。 */
export function stripOutboundFlush(st: PartStripState): string {
  const line = st.pending + cleanUtf16Chunk(st, "", true)
  st.pending = ""
  if (!line) return ""
  if (st.fence) return line // 柵欄未閉合：尾部原樣吐出
  if (st.suppress) {
    if (ANY_HEADING_RE.test(line) && !INTERNAL_SECTION_HEADING_RE.test(line)) {
      st.suppress = false
      return bodyT2s(st, line) // R5-C：正文行繁→簡（R9-B：跟隨用戶書寫體）
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
  return bodyT2s(st, scrubInternalRefs(line).replace(SECTION_REF_RE, "按内部规定").replace(SECTION_TOKEN_RE, "内部规定"))
}

// ── R9-B（2026-09-30）：part 尾行即時吐出，回合結束不再補播過期旁白 ──
// R9 實錘（eval-yuri-op-mv-0930 SSE 9888–9894）：工具調用前的單行旁白 text part
//（「我先掌握行情…」「先让歌跑起来：」「付费通路是活的…」，均無尾換行）被
// stripOutboundFeed 的尾行扣留機制整行壓在 pending，整個回合沒有外發（SSE 全檔
// 各只出現一次）；session.idle 按 partStripState 插入序一次性 flush → 7 句過期
// 旁白接在最終答覆（9861–9887）之後、turn.done（9895）之前「報幕」。
// 修法：新 text part 開始／工具調用開始時，把其他 part 扣住的尾行當場吐出
//（加段落分隔，保持與工具/下一段的時序）；回合結束只吐最後一個 part 的尾行。

/** 把 exceptPid 以外各 part 扣住的尾行吐出（即時、按插入序），回傳待發文本（可能空串）。 */
export function flushOtherPartTails(map: Map<string, PartStripState>, exceptPid?: string): string {
  let out = ""
  for (const [pid, st] of map) {
    if (pid === exceptPid || !st.pending) continue
    const tail = stripOutboundFlush(st)
    if (tail) out += tail + "\n\n"
  }
  return out
}

/** 回合結束：只吐最後一個 part（最終答覆）的尾行；更早 part 的殘留一律丟棄不補播。 */
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
