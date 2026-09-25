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
export type PartStripState = { pending: string; suppress: boolean; fence: boolean; sawEnglish: boolean }

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
export const T2S_MAP = new Map<string, string>()
for (let i = 0; i + 1 < T2S_PAIRS.length; i += 2) T2S_MAP.set(T2S_PAIRS[i]!, T2S_PAIRS[i + 1]!)
export const T2S_RE = new RegExp(`[${Array.from(T2S_MAP.keys()).join("")}]`, "g")

/** 正文行繁→簡轉換：無映射命中原樣返回；有轉換時留 journal 證據行。 */
export function t2sLine(line: string): string {
  if (!line) return line
  let converted = false
  const out = line.replace(T2S_RE, (c) => {
    converted = true
    return T2S_MAP.get(c) ?? c
  })
  if (converted) console.log(`[gateway] R5-C t2s: line converted: ${out.slice(0, 60)}`)
  return out
}

// ── R4-A S2（2026-08-28）：內部條款編號剝離 ──
// R4 實錘：正文出現「按 §3.8.3」「按 §3.8.2 默認使用…」——內部手冊編號不得
// 直達用戶。剝編號留語義：§\d+(\.\d+)* 整體替換為「内部规定」。
export const SECTION_REF_RE = /按\s*§\s?\d+(?:\.\d+)*/g
export const SECTION_TOKEN_RE = /§\s?\d+(?:\.\d+)*/g

/** 餵入一個 chunk，回傳可安全外發的文本（行未完整時扣留，可能回空串）。 */
export function stripOutboundFeed(st: PartStripState, chunk: string): string {
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
        out += t2sLine(line) + "\n" // R5-C：正文行繁→簡
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
    out += t2sLine(line.replace(SECTION_REF_RE, "按内部规定").replace(SECTION_TOKEN_RE, "内部规定")) + "\n"
  }
  return out
}

/** 回合/部件結束：殘留尾行按當前抑制狀態一次性判定（無換行終結，不再扣留）。 */
export function stripOutboundFlush(st: PartStripState): string {
  const line = st.pending
  st.pending = ""
  if (!line) return ""
  if (st.fence) return line // 柵欄未閉合：尾部原樣吐出
  if (st.suppress) {
    if (ANY_HEADING_RE.test(line) && !INTERNAL_SECTION_HEADING_RE.test(line)) {
      st.suppress = false
      return t2sLine(line) // R5-C：正文行繁→簡
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
  return t2sLine(line.replace(SECTION_REF_RE, "按内部规定").replace(SECTION_TOKEN_RE, "内部规定"))
}
