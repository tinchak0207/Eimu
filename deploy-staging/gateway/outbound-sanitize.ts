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
const OPENUI_STATEMENT_RE = /^[A-Za-z_$][\w$]*\s*=\s*(?:[A-Za-z_][\w]*\s*\(|@[A-Za-z]+\(|\[)/
export function isEnglishProseLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/[\u4e00-\u9fff]/.test(t)) return false // 任何中文 → 放行（硬要求：中文不丢）
  if (t.startsWith(">")) return false // markdown 引文 → 放行
  if (t.startsWith("|")) return false // 表格行 → 放行
  if (/https?:\/\//.test(t)) return false // 链接行 → 放行
  // 2026-10-18 OpenUI：模型偶尔不套围栏直接输出 openui 语句（`form = Form("p", btns, [f1, f2])`）。
  // 这类「标识符 = 组件调用/数组/动作」的程序行不是英文正文，压掉会让前端拿到半截程序。
  if (OPENUI_STATEMENT_RE.test(t)) return false
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
// 这是「用户永远看不到繁体」的功能数据表，方向是繁→简，不是繁体文案。
// 2026-10-04 F5/Y：安全规则 opencc t2s(c)!=c 且 c∉image(t2s) 生成的**完整** 繁體专字→简体 映射
// （扫描 0x3400–0xA000 实测 3755 对；795 对的目标字落在 Unicode 补充平面，故配对一律
//  码点感知（Array.from）。表内键一律不是任何简化的目标字 ⇒ 简体输入永不被改坏；
//  回归：为什么坏了/干干净净/面条/后面/台北/里面 逐字不变。）
export const T2S_PAIRS =
  "㑮𫝈㑯㑔㑳㑇㑶㐹㒓𠉂㓄𪠟㓨刾㔋𪟎㖮𪠵㗲𠵾㗿𪡛㘉𠰱㘓𪢌㘔𫬐㘚㘎㛝𫝦㜄㚯㜏㛣㜐𫝧㜗𡞋㜢𡞱㜷𡝠㞞𪨊㟺𪩇㠏㟆㠣𫵷㢗𪪑㢝𢋈㥮㤘㦎𢛯㦛𢗓㦞𪫷㨻𪮃㩋𪮋㩜㨫㩳㧐㩵擜㪎𪯋㯤𣘐㰙𣗙㵗𣳆㵾𪷍㶆𫞛㷍𤆢㷿𤈷㸇𤎺㹽𫞣㺏𤠋㺜𪺻㻶𪼋㿖𪽮㿗𤻊㿧𤽯䀉𥁢䀹𥅴䁪𥇢䁻䀥䂎𥎝䃮鿎䅐𫀨䅳𫀬䆉𫁂䉑𫁲䉙𥬀䉬𫂈䉲𥮜䉶𫁷䊭𥺅䊷䌶䊺𫄚䋃𫄜䋔𫄞䋙䌺䋚䌻䋦𫄩䋹䌿䋻䌾䋼𫄮䋿𦈓䌈𦈖䌋𦈘䌖𦈜䌝𦈟䌟𦈞䌥𦈠䌰𦈙䍤𫅅䍦䍠䍽𦍠䎙𫅭䎱䎬䓣𬜯䕤𫟕䕳𦰴䖅𫟑䗅𫊪䗿𧉞䙔𫋲䙡䙌䙱𧜭䚩𫌯䛄𫍠䛳𫍫䜀䜧䜖𫟢䝭𫎧䝻𧹕䝼䞍䞈𧹑䞋𫎪䞓𫎭䟃𫎺䟆𫎳䟐𫎱䠆𫏃䠱𨅛䡐𫟤䡩𫟥䡵𫟦䢨𨑹䤤𫟺䥄𫠀䥇䦂䥑鿏䥕𬭯䥗𫔋䥩𨱖䥯𫔆䥱䥾䦘𨸄䦛䦶䦟䦷䦯𫔵䦳𨷿䧢𨸟䪊𫖅䪏𩏼䪗𩐀䪘𩏿䪴𫖫䪾𫖬䫀𫖱䫂𫖰䫟𫖲䫴𩖗䫶𫖺䫻𫗇䫾𫠈䬓𫗊䬘𩙮䬝𩙯䬞𩙧䬧𫗟䭀𩠇䭃𩠈䭑𫗱䭔𫗰䭿𩧭䮄𫠊䮝𩧰䮞𩨁䮠𩧿䮫𩨇䮰𫘮䮳𩨏䮾𩧪䯀䯅䯤𩩈䰾鲃䱀𫚐䱁𫚏䱙𩾈䱧𫚠䱬𩾊䱰𩾋䱷䲣䱸𫠑䱽䲝䲁鳚䲅𫚜䲖𩾂䲘鳤䲰𪉂䳜𫛬䳢𫛰䳤𫛮䳧𫛺䳫𫛼䴉鹮䴋𫜅䴬𪎈䴱𫜒䴴𪎋䴽𫜔䵳𪑅䵴𫜙䶕𫜨䶲𫜳丟丢並并乾干亂乱亙亘亞亚佇伫佈布佔占併并來来侖仑侶侣侷局俁俣係系俓𠇹俔伣俠侠俥伡俬私倀伥倆俩倈俫倉仓個个們们倖幸倫伦倲㑈偉伟偑㐽側侧偵侦偽伪傌㐷傑杰傖伧傘伞備备傢家傭佣傯偬傳传傴伛債债傷伤傾倾僂偻僅仅僉佥僑侨僕仆僞伪僤𫢸僥侥僨偾僱雇價价儀仪儁俊儂侬億亿儈侩儉俭儎傤儐傧儔俦儕侪儘尽償偿儣𠆲優优儭𠋆儲储儷俪儸㑩儺傩儻傥儼俨兇凶兌兑兒儿兗兖內内兩两冊册冑胄冪幂凈净凍冻凙𪞝凜凛凱凯別别刪删剄刭則则剋克剎刹剗刬剛刚剝剥剮剐剴剀創创剷铲剾𠛅劃划劄札劇剧劉刘劊刽劌刿劍剑劏㓥劑剂劚㔉勁劲勑𠡠動动務务勛勋勝胜勞劳勢势勣𪟝勩勚勱劢勳勋勵励勸劝勻匀匭匦匯汇匱匮區区協协卹恤卻却卽即厙厍厠厕厤历厭厌厲厉厴厣參参叄叁叢丛吒咤吳吴吶呐呂吕咼呙員员哯𠯟唄呗唓𪠳唸念問问啓启啞哑啟启啢唡喎㖞喚唤喪丧喫吃喬乔單单喲哟嗆呛嗇啬嗊唝嗎吗嗚呜嗩唢嗰𠮶嗶哔嗹𪡏嘆叹嘍喽嘓啯嘔呕嘖啧嘗尝嘜唛嘩哗嘪𪡃嘮唠嘯啸嘰叽嘳𪡞嘵哓嘸呒嘺𪡀嘽啴噁恶噅𠯠噓嘘噚㖊噝咝噞𪡋噠哒噥哝噦哕噯嗳噲哙噴喷噸吨噹当嚀咛嚇吓嚌哜嚐尝嚕噜嚙啮嚛𪠸嚥咽嚦呖嚧𠰷嚨咙嚮向嚲亸嚳喾嚴严嚶嘤嚽𪢕囀啭囁嗫囂嚣囃𠱞囅冁囈呓囉啰囌苏囑嘱囒𪢠囪囱圇囵國国圍围園园圓圆圖图團团圞𪢮垻坝埡垭埨𫭢埬𪣆埰采執执堅坚堊垩堖垴堚𪣒堝埚堯尧報报場场塊块塋茔塏垲塒埘塗涂塚冢塢坞塤埙塵尘塸𫭟塹堑塿𪣻墊垫墜坠墠𫮃墮堕墰坛墲𪢸墳坟墶垯墻墙墾垦壇坛壈𡒄壋垱壎埙壓压壗𡋤壘垒壙圹壚垆壜坛壞坏壟垄壠垅壢坜壣𪤚壩坝壪塆壯壮壺壶壼壸壽寿夠够夢梦夥伙夾夹奐奂奧奥奩奁奪夺奬奖奮奋奼姹妝妆姍姗姦奸娙𫰛娛娱婁娄婡𫝫婦妇婭娅媈𫝨媧娲媯妫媰㛀媼媪媽妈嫋袅嫗妪嫵妩嫺娴嫻娴嫿婳嬀妫嬃媭嬇𫝬嬈娆嬋婵嬌娇嬙嫱嬡嫒嬣𪥰嬤嬷嬦𫝩嬪嫔嬰婴嬸婶嬻𪥿孃娘孄𫝮孆𫝭孇𪥫孋㛤孌娈孎𡠟孫孙學学孻𡥧孾𪧀孿孪宮宫寀采寠𪧘寢寝實实寧宁審审寫写寬宽寵宠寶宝將将專专尋寻對对導导尷尴屆届屍尸屓屃屜屉屢屡層层屨屦屩𪨗屬属岡冈峯峰峴岘島岛峽峡崍崃崑昆崗岗崙仑崢峥崬岽嵐岚"
  + "嵗岁嵼𡶴嵽𫶇嵾㟥嶁嵝嶄崭嶇岖嶈𡺃嶔嵚嶗崂嶘𡺄嶠峤嶢峣嶧峄嶨峃嶮崄嶸嵘嶹𫝵嶺岭嶼屿嶽岳巊𪩎巋岿巒峦巔巅巖岩巗𪨷巘𪩘巰巯巹卺帥帅師师帳帐帶带幀帧幃帏幓㡎幗帼幘帻幝𪩷幟帜幣币幩𪩸幫帮幬帱幷并幹干幾几庫库廁厕廂厢廄厩廈厦廎庼廕荫廚厨廝厮廞𫷷廟庙廠厂廡庑廢废廣广廧𪪞廩廪廬庐廳厅弒弑弔吊弳弪張张強强彃𪪼彄𫸩彆别彈弹彌弥彎弯彔录彙汇彠彟彥彦彫雕彲彨彿佛後后徑径從从徠徕復复徵征徹彻徿𪫌恆恒恥耻悅悦悞悮悵怅悶闷悽凄惡恶惱恼惲恽惻恻愛爱愜惬愨悫愴怆愷恺愻𢙏愾忾慄栗態态慍愠慘惨慚惭慟恸慣惯慤悫慪怄慫怂慮虑慳悭慶庆慺㥪慼戚慾欲憂忧憊惫憐怜憑凭憒愦憖慭憚惮憢𢙒憤愤憫悯憮怃憲宪憶忆憸𪫺憹𢙐懀𢙓懇恳應应懌怿懍懔懎𢠁懞蒙懟怼懣懑懤㤽懨恹懲惩懶懒懷怀懸悬懺忏懼惧懾慑戀恋戇戆戔戋戧戗戩戬戰战戱戯戲戏戶户扞捍拋抛拚拼挩捝挱挲挾挟捨舍捫扪捱挨捲卷掃扫掄抡掆㧏掗挜掙挣掚𪭵掛挂採采揀拣揚扬換换揮挥揯搄損损搖摇搗捣搵揾搶抢摋𢫬摐𪭢摑掴摜掼摟搂摯挚摳抠摶抟摺折摻掺撈捞撊𪭾撏挦撐撑撓挠撝㧑撟挢撣掸撥拨撧𪮖撫抚撲扑撳揿撻挞撾挝撿捡擁拥擄掳擇择擊击擋挡擓㧟擔担據据擟𪭧擠挤擡抬擣捣擫𢬍擬拟擯摈擰拧擱搁擲掷擴扩擷撷擺摆擻擞擼撸擽㧰擾扰攄摅攆撵攋𪮶攏拢攔拦攖撄攙搀攛撺攜携攝摄攢攒攣挛攤摊攪搅攬揽敎教敓敚敗败敘叙敵敌數数斂敛斃毙斅𢽾斆敩斕斓斬斩斷断斸𣃁於于旂旗旣既昇升時时晉晋晛𬀪晝昼暈晕暉晖暐𬀩暘旸暢畅暫暂曄晔曆历曇昙曉晓曊𪰶曏向曖暧曠旷曥𣆐曨昽曬晒書书會会朥𦛨朧胧朮术東东枴拐柵栅柺拐査查桱𣐕桿杆梔栀梖𪱷梘枧梜𬂩條条梟枭梲棁棄弃棊棋棖枨棗枣棟栋棡㭎棧栈棲栖棶梾椏桠椲㭏楇𣒌楊杨楓枫楨桢業业極极榘矩榦干榪杩榮荣榲榅榿桤構构槍枪槓杠槤梿槧椠槨椁槫𣏢槮椮槳桨槶椢槼椝樁桩樂乐樅枞樑梁樓楼標标樞枢樠𣗊樢㭤樣样樤𣔌樧榝樫㭴樳桪樸朴樹树樺桦樿椫橈桡橋桥機机橢椭橫横橯𣓿檁檩檉柽檔档檜桧檟槚檢检檣樯檭𣘴檮梼檯台檳槟檵𪲛檸柠檻槛櫃柜櫅𪲎櫍𬃊櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎櫠𪲮櫥橱櫧槠櫨栌櫪枥櫫橥櫬榇櫱蘖櫳栊櫸榉櫻樱欄栏欅榉欇𪳍權权欍𣐤欏椤欐𪲔欑𪴙欒栾欓𣗋欖榄欘𣚚欞棂欽钦歎叹歐欧歟欤歡欢歲岁歷历歸归歿殁殘残殞殒殢𣨼殤殇殨㱮殫殚殭僵殮殓殯殡殰㱩殲歼殺杀殻壳殼壳毀毁毆殴毊𪵑毿毵氂牦氈毡氌氇氣气氫氢氬氩氭𣱝氳氲氾泛汎泛汙污決决沒没沖冲況况泝溯洩泄洶汹浹浃浿𬇙涇泾涗涚涼凉淒凄淚泪淥渌淨净淩凌淪沦淵渊淶涞淺浅渙涣減减渢沨渦涡測测渾浑湊凑湋𣲗湞浈湧涌湯汤溈沩準准溝沟溡𪶄溫温溮浉溳涢溼湿滄沧滅灭滌涤滎荥滙汇滬沪滯滞滲渗滷卤滸浒滻浐滾滚滿满漁渔漊溇漍𬇹漚沤漢汉漣涟漬渍漲涨漵溆漸渐漿浆潁颍潑泼潔洁潕𣲘潙沩潚㴋潛潜潣𫞗潤润潯浔潰溃潷滗潿涠澀涩澅𣶩澆浇澇涝澐沄澗涧澠渑澤泽澦滪澩泶澫𬇕澬𫞚澮浍澱淀澾㳠濁浊濃浓濄㳡濆𣸣濕湿濘泞濚溁濛蒙濜浕濟济濤涛濧㳔濫滥濰潍濱滨濺溅濼泺濾滤濿𪵱瀂澛瀃𣽷瀅滢瀆渎瀇㲿瀉泻瀋沈瀏浏瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋瀾澜灃沣灄滠灍𫞝灑洒灒𪷽灕漓"
  + "灘滩灙𣺼灝灏灡㳕灣湾灤滦灧滟灩滟災灾為为烏乌烴烃無无煇𪸩煉炼煒炜煙烟煢茕煥焕煩烦煬炀煱㶽熂𪸕熅煴熉𤈶熌𤇄熒荧熓𤆡熗炝熚𤇹熡𤋏熰𬉼熱热熲颎熾炽燀𬊤燁烨燈灯燉炖燒烧燖𬊈燙烫燜焖營营燦灿燬毁燭烛燴烩燶㶶燻熏燼烬燾焘爃𫞡爄𤇃爇𦶟爍烁爐炉爖𤇭爛烂爥𪹳爧𫞠爭争爲为爺爷爾尔牀床牆墙牘牍牽牵犖荦犛牦犞𪺭犢犊犧牺狀状狹狭狽狈猌𪺽猙狰猶犹猻狲獁犸獃呆獄狱獅狮獊𪺷獎奖獨独獩𤞃獪狯獫猃獮狝獰狞獱㺍獲获獵猎獷犷獸兽獺獭獻献獼猕玀猡玁𤞤珼𫞥現现琱雕琺珐琿珲瑋玮瑒玚瑣琐瑤瑶瑩莹瑪玛瑲玱瑻𪻲瑽𪻐璉琏璊𫞩璕𬍤璗𬍡璝𪻺璡琎璣玑璦瑷璫珰璯㻅環环璵玙璸瑸璼𫞨璽玺璾𫞦璿璇瓄𪻨瓅𬍛瓊琼瓏珑瓔璎瓕𤦀瓚瓒瓛𤩽甌瓯甕瓮產产産产畝亩畢毕畫画異异畵画當当畼𪽈疇畴疊叠痙痉痠酸痮𪽪痾疴瘂痖瘋疯瘍疡瘓痪瘞瘗瘡疮瘧疟瘮瘆瘱𪽷瘲疭瘺瘘瘻瘘療疗癆痨癇痫癉瘅癐𤶊癒愈癘疠癟瘪癡痴癢痒癤疖癥症癧疬癩癞癬癣癭瘿癮瘾癰痈癱瘫癲癫發发皁皂皚皑皟𤾀皰疱皸皲皺皱盃杯盜盗盞盏盡尽監监盤盘盧卢盨𪾔盪荡眝𪾣眞真眥眦眾众睍𪾢睏困睜睁睞睐瞘眍瞜䁖瞞瞒瞤𥆧瞶瞆瞼睑矇蒙矉𪾸矑𪾦矓眬矚瞩矯矫硃朱硜硁硤硖硨砗硯砚碕埼碙𥐻碩硕碭砀碸砜確确碼码碽䂵磑硙磚砖磠硵磣碜磧碛磯矶磽硗磾䃅礄硚礎础礐𬒈礒𥐟礙碍礦矿礪砺礫砾礬矾礮𪿫礱砻祕秘祿禄禍祸禎祯禕祎禡祃禦御禪禅禮礼禰祢禱祷禿秃秈籼稅税稈秆稏䅉稜棱稟禀種种稱称穀谷穇䅟穌稣積积穎颖穠秾穡穑穢秽穩稳穫获穭穞窩窝窪洼窮穷窯窑窵窎窶窭窺窥竄窜竅窍竇窦竈灶竊窃竚𥩟竪竖竱𫁟競竞筆笔筍笋筧笕筴䇲箇个箋笺箏筝箚札節节範范築筑篋箧篔筼篘𥬠篠筿篢𬕂篤笃篩筛篳筚篸𥮾簀箦簂𫂆簍篓簑蓑簞箪簡简簢𫂃簣篑簫箫簹筜簽签簾帘籃篮籅𥫣籋𥬞籌筹籔䉤籙箓籛篯籜箨籟籁籠笼籤签籩笾籪簖籬篱籮箩籲吁粵粤糉粽糝糁糞粪糧粮糰团糲粝糴籴糶粜糹纟糺𫄙糾纠紀纪紂纣紃𬘓約约紅红紆纡紇纥紈纨紉纫紋纹納纳紐纽紓纾純纯紕纰紖纼紗纱紘纮紙纸級级紛纷紜纭紝纴紞𬘘紟𫄛紡纺紬䌷紮扎細细紱绂紲绁紳绅紵纻紹绍紺绀紼绋紿绐絀绌絁𫄟終终絃弦組组絅䌹絆绊絍𫟃絎绗結结絕绝絙𫄠絛绦絝绔絞绞絡络絢绚絥𫄢給给絧𫄡絨绒絪𬘡絰绖統统絲丝絳绛絶绝絹绢絺𫄨綀𦈌綁绑綃绡綄𬘫綆绠綇𦈋綈绨綉绣綋𫟄綌绤綎𬘩綏绥綐䌼綑捆經经綖𫄧綜综綝𬘭綞缍綟𫄫綠绿綡𫟅綢绸綣绻綧𬘯綪𬘬綫线綬绶維维綯绹綰绾綱纲網网綳绷綴缀綵彩綸纶綹绺綺绮綻绽綽绰綾绫綿绵緄绲緇缁緊紧緋绯緍𦈏緑绿緒绪緓绬緔绱緗缃緘缄緙缂線线緝缉緞缎緟𫟆締缔緡缗緣缘緤𫄬緦缌編编緩缓緬缅緮𫄭緯纬緰𦈕緱缑緲缈練练緶缏緷𦈉緸𦈑緹缇緻致緼缊縈萦縉缙縊缢縋缒縍𫄰縎𦈔縐绉縑缣縕缊縗缞縛缚縝缜縞缟縟缛縣县縧绦縫缝縬𦈚縭缡縮缩縯𬙂縰𫄳縱纵縲缧縳䌸縴纤縵缦縶絷縷缕縸𫄲縹缥縺𦈐總总績绩繂𫄴繃绷繅缫繆缪繈𫄶繏𦈝繐𰬸繒缯繓𦈛織织繕缮繚缭繞绕繟𦈎繡绣繢缋繨𫄤繩绳繪绘繫系繬𫄱繭茧繮缰繯缳繰缲繳缴繶𫄷繷𫄣繸䍁繹绎繻𦈡繼继繽缤繾缱繿䍀纁𫄸纆𬙊纇颣纈缬纊纩續续纍累纏缠纓缨纔才纕𬙋纖纤纗𫄹纘缵纚𫄥纜缆缽钵罃䓨罈坛罌罂"
  + "罎坛罰罚罵骂罷罢羅罗羆罴羈羁羋芈羣群羥羟羨羡義义羵𫅗羶膻習习翫玩翬翚翹翘翽翙耬耧耮耢聖圣聞闻聯联聰聪聲声聳耸聵聩聶聂職职聹聍聻𫆏聽听聾聋肅肃脅胁脈脉脛胫脣唇脥𣍰脩修脫脱脹胀腎肾腖胨腡脶腦脑腪𣍯腫肿腳脚腸肠膃腽膕腘膚肤膞䏝膠胶膢𦝼膩腻膹𪱥膽胆膾脍膿脓臉脸臍脐臏膑臗𣎑臘腊臚胪臟脏臠脔臢臜臥卧臨临臺台與与興兴舉举舊旧舘馆艙舱艣𫇛艤舣艦舰艫舻艱艰艷艳芻刍茲兹荊荆莊庄莖茎莢荚莧苋菕𰰨華华菴庵菸烟萇苌萊莱萬万萴荝萵莴葉叶葒荭葝𫈎葤荮葦苇葯药葷荤蒍𫇭蒐搜蒓莼蒔莳蒕蒀蒞莅蒭𫇴蒼苍蓀荪蓆席蓋盖蓧𦰏蓮莲蓯苁蓴莼蓽荜蔄𬜬蔔卜蔘参蔞蒌蔣蒋蔥葱蔦茑蔭荫蔯𫈟蔿𫇭蕁荨蕆蒇蕎荞蕒荬蕓芸蕕莸蕘荛蕝𫈵蕢蒉蕩荡蕪芜蕭萧蕳𫈉蕷蓣蕽𫇽薀蕰薆𫉁薈荟薊蓟薌芗薑姜薔蔷薘荙薟莶薦荐薩萨薳䓕薴苧薵䓓薹苔薺荠藍蓝藎荩藝艺藥药藪薮藭䓖藴蕴藶苈藷𫉄藹蔼藺蔺蘀萚蘄蕲蘆芦蘇苏蘊蕴蘋苹蘚藓蘞蔹蘟𦻕蘢茏蘭兰蘺蓠蘿萝虆蔂虉𬟁處处虛虚虜虏號号虧亏虯虬蛺蛱蛻蜕蜆蚬蝀𬟽蝕蚀蝟猬蝦虾蝨虱蝸蜗螄蛳螞蚂螢萤螮䗖螻蝼螿螀蟂𫋇蟄蛰蟈蝈蟎螨蟘𫋌蟜𫊸蟣虮蟬蝉蟯蛲蟲虫蟳𫊻蟶蛏蟻蚁蠀𧏗蠁蚃蠅蝇蠆虿蠍蝎蠐蛴蠑蝾蠔蚝蠙𧏖蠟蜡蠣蛎蠦𫊮蠨蟏蠱蛊蠶蚕蠻蛮蠾𧑏衆众衊蔑術术衕同衚胡衛卫衝冲袞衮袷夹裊袅裏里補补裝装裡里製制複复褌裈褘袆褲裤褳裢褸褛褻亵襀𫌀襇裥襉裥襏袯襓𫋹襖袄襗𫋷襘𫋻襝裣襠裆襤褴襪袜襬摆襯衬襰𧝝襲袭襴襕襵𫌇覈核見见覎觃規规覓觅視视覘觇覛𫌪覡觋覥觍覦觎親亲覬觊覯觏覲觐覷觑覹𫌭覺觉覼𫌨覽览覿觌觀观觴觞觶觯觸触訁讠訂订訃讣計计訊讯訌讧討讨訏𬣙訐讦訑𫍙訒讱訓训訕讪訖讫託托記记訛讹訜𫍛訝讶訞𫍚訟讼訢䜣訣诀訥讷訨𫟞訩讻訪访設设許许訴诉訶诃診诊註注証证詀𧮪詁诂詆诋詊𫟟詎讵詐诈詑𫍡詒诒詓𫍜詔诏評评詖诐詗诇詘诎詛诅詝𬣞詞词詠咏詡诩詢询詣诣試试詩诗詪𬣳詫诧詬诟詭诡詮诠詰诘話话該该詳详詵诜詷𫍣詼诙詿诖誂𫍥誄诔誅诛誆诓誇夸誋𫍪誌志認认誑诳誒诶誕诞誘诱誚诮語语誠诚誡诫誣诬誤误誥诰誦诵誨诲說说誫𫍨説说誰谁課课誳𫍮誴𫟡誶谇誷𫍬誹诽誺𫍧誼谊誾訚調调諂谄諄谆談谈諉诿請请諍诤諏诹諑诼諒谅諓𬣡論论諗谂諛谀諜谍諝谞諞谝諟𬤊諡谥諢诨諣𫍩諤谔諥𫍳諦谛諧谐諫谏諭谕諮咨諯𫍱諰𫍰諱讳諲𬤇諳谙諴𫍯諶谌諷讽諸诸諺谚諼谖諾诺謀谋謁谒謂谓謄誊謅诌謆𫍸謉𫍷謊谎謎谜謏𫍲謐谧謔谑謖谡謗谤謙谦謚谥講讲謝谢謠谣謡谣謨谟謫谪謬谬謭谫謯𫍹謱𫍴謳讴謸𫍵謹谨謾谩譁哗譂𫟠譅𰶎譆𫍻證证譊𫍢譎谲譏讥譑𫍤譓𬤝譖谮識识譙谯譚谭譜谱譞𫍽譟噪譨𫍦譫谵譭毁譯译議议譴谴護护譸诪譽誉譾谫讀读讅谉變变讋詟讌䜩讎雠讒谗讓让讕谰讖谶讚赞讜谠讞谳谿溪豈岂豎竖豐丰豔艳豬猪豵𫎆豶豮貍狸貓猫貗𫎌貙䝙貝贝貞贞貟贠負负財财貢贡貧贫貨货販贩貪贪貫贯責责貯贮貰贳貲赀貳贰貴贵貶贬買买貸贷貺贶費费貼贴貽贻貿贸賀贺賁贲賂赂賃赁賄贿賅赅資资賈贾賊贼賑赈賒赊賓宾賕赇賙赒賚赉賜赐賝𫎩賞赏賟𧹖賠赔賡赓賢贤賣卖賤贱賦赋賧赕質质賫赍賬账賭赌賰䞐賴赖賵赗賺赚賻赙購购賽赛賾赜贃𧹗贄贽贅赘"
  + "贇赟贈赠贉𫎫贊赞贋赝贍赡贏赢贐赆贑𫎬贓赃贔赑贖赎贗赝贚𫎦贛赣贜赃赬赪趕赶趙赵趨趋趲趱跡迹踐践踰逾踴踊蹌跄蹔𫏐蹕跸蹟迹蹠跖蹣蹒蹤踪蹳𫏆蹺跷蹻𫏋躂跶躉趸躊踌躋跻躍跃躎䟢躑踯躒跞躓踬躕蹰躘𨀁躚跹躝𨅬躡蹑躥蹿躦躜躪躏軀躯軉𨉗車车軋轧軌轨軍军軏𫐄軑轪軒轩軔轫軕𫐅軗𨐅軛轭軜𫐇軝𬨂軟软軤轷軨𫐉軫轸軬𫐊軲轱軷𫐈軸轴軹轵軺轺軻轲軼轶軾轼軿𫐌較较輄𨐈輅辂輇辁輈辀載载輊轾輋𪨶輒辄輓挽輔辅輕轻輖𫐏輗𫐐輛辆輜辎輝辉輞辋輟辍輢𫐎輥辊輦辇輨𫐑輩辈輪轮輬辌輮𫐓輯辑輳辏輶𬨎輷𫐒輸输輻辐輼辒輾辗輿舆轀辒轂毂轄辖轅辕轆辘轇𫐖轉转轊𫐕轍辙轎轿轐𫐗轔辚轗𫐘轟轰轠𫐙轡辔轢轹轣𫐆轤轳辦办辭辞辮辫辯辩農农迴回逕径這这連连週周進进遊游運运過过達达違违遙遥遜逊遞递遠远遡溯適适遱𫐷遲迟遷迁選选遺遗遼辽邁迈還还邇迩邊边邏逻邐逦郟郏郵邮鄆郓鄉乡鄒邹鄔邬鄖郧鄟𫑘鄧邓鄩𬩽鄭郑鄰邻鄲郸鄳𫑡鄴邺鄶郐鄺邝酇酂酈郦醃腌醖酝醜丑醞酝醟蒏醣糖醫医醬酱醱酦醲𬪩醶𫑷釀酿釁衅釃酾釅酽釋释釐厘釒钅釓钆釔钇釕钌釗钊釘钉釙钋釚𫟲針针釟𫓥釣钓釤钐釦扣釧钏釨𫓦釩钒釲𫟳釳𨰿釴𬬩釵钗釷钍釹钕釺钎釾䥺釿𬬱鈀钯鈁钫鈃钘鈄钭鈅钥鈆𫓪鈇𫓧鈈钚鈉钠鈋𨱂鈍钝鈎钩鈐钤鈑钣鈒钑鈔钞鈕钮鈖𫟴鈗𫟵鈛𫓨鈞钧鈠𨱁鈡钟鈣钙鈥钬鈦钛鈧钪鈮铌鈯𨱄鈰铈鈲𨱃鈳钶鈴铃鈷钴鈸钹鈹铍鈺钰鈽钸鈾铀鈿钿鉀钾鉁𨱅鉅巨鉆钻鉈铊鉉铉鉊𬬿鉋铇鉍铋鉑铂鉔𫓬鉕钷鉗钳鉚铆鉛铅鉝𫟷鉞钺鉠𫓭鉢钵鉤钩鉥𬬸鉦钲鉧𬭁鉬钼鉭钽鉮𬬹鉳锫鉶铏鉷𫟹鉸铰鉺铒鉻铬鉽𫟸鉾𫓴鉿铪銀银銁𫓲銂𫟻銃铳銅铜銈𫓯銊𫓰銍铚銏𫟶銑铣銓铨銖铢銘铭銚铫銛铦銜衔銠铑銣铷銥铱銦铟銨铵銩铥銪铕銫铯銬铐銱铞銳锐銶𨱇銷销銹锈銻锑銼锉鋁铝鋂𰾄鋃锒鋅锌鋇钡鋉𨱈鋌铤鋏铗鋐𬭎鋒锋鋗𫓶鋙铻鋝锊鋟锓鋠𫓵鋣铘鋤锄鋥锃鋦锔鋨锇鋩铓鋪铺鋭锐鋮铖鋯锆鋰锂鋱铽鋶锍鋸锯鋹𬬮鋼钢錀𬬭錁锞錂𨱋錄录錆锖錇锫錈锩錏铔錐锥錒锕錕锟錘锤錙锱錚铮錛锛錜𫓻錝𫓽錞𬭚錟锬錠锭錡锜錢钱錤𫓹錥𫓾錦锦錨锚錩锠錫锡錮锢錯错録录錳锰錶表錸铼錼镎錽𫓸鍀锝鍁锨鍃锪鍄𨱉鍅钫鍆钔鍇锴鍈锳鍉𫔂鍊炼鍋锅鍍镀鍒𫔄鍔锷鍘铡鍚钖鍛锻鍠锽鍤锸鍥锲鍩锘鍬锹鍭𬭤鍮𨱎鍰锾鍵键鍶锶鍺锗鍼针鍾钟鎂镁鎄锿鎇镅鎈𫟿鎊镑鎌镰鎍𫔅鎓𬭩鎔镕鎖锁鎘镉鎙𫔈鎚锤鎛镈鎝𨱏鎞𫔇鎡镃鎢钨鎣蓥鎦镏鎧铠鎩铩鎪锼鎬镐鎭镇鎮镇鎯𨱍鎰镒鎲镋鎳镍鎵镓鎶鿔鎷𨰾鎸镌鎿镎鏃镞鏆𨱌鏇旋鏈链鏉𨱒鏌镆鏍镙鏏𬭬鏐镠鏑镝鏗铿鏘锵鏚𬭭鏜镗鏝镘鏞镛鏟铲鏡镜鏢镖鏤镂鏥𫔊鏦𫓩鏨錾鏰镚鏵铧鏷镤鏹镪鏺䥽鏻𬭸鏽锈鏾𫔌鐃铙鐄𨱑鐇𫔍鐈𫓱鐋铴鐍𫔎鐎𨱓鐏𨱔鐐镣鐒铹鐓镦鐔镡鐘钟鐙镫鐝镢鐠镨鐥䦅鐦锎鐧锏鐨镄鐩𬭼鐪𫓺鐫镌鐮镰鐯䦃鐲镯鐳镭鐵铁鐶镮鐸铎鐺铛鐼𫔁鐽𫟼鐿镱鑀𰾭鑄铸鑉𫠁鑊镬鑌镔鑑鉴鑒鉴鑔镲鑕锧鑞镴鑠铄鑣镳鑥镥鑪𬬻鑭镧鑰钥鑱镵鑲镶鑴𫔔鑷镊鑹镩鑼锣鑽钻鑾銮鑿凿钁镢钂镋長长門门閂闩閃闪閆闫閈闬閉闭開开閌闶閍𨸂閎闳閏闰閐𨸃閑闲閒闲間间閔闵閗𫔯閘闸閝𫠂閞𫔰閡阂閣阁閤合閥阀閨闺閩闽閫阃閬阆閭闾閱阅閲阅閵𫔴閶阊閹阉閻阎閼阏閽阍"
  + "閾阈閿阌闃阒闆板闇暗闈闱闉𬮱闊阔闋阕闌阑闍阇闐阗闑𫔶闒阘闓闿闔阖闕阙闖闯關关闞阚闠阓闡阐闢辟闤阛闥闼陘陉陝陕陣阵陰阴陳陈陸陆陽阳隉陧隊队階阶隑𬮿隕陨際际隤𬯎隨随險险隮𬯀隯陦隱隐隴陇隸隶隻只雋隽雖虽雙双雛雏雜杂雞鸡離离難难雲云電电霑沾霢霡霣𫕥霧雾霼𪵣霽霁靂雳靄霭靆叇靈灵靉叆靚靓靜静靝靔靦腼靧𫖃靨靥鞏巩鞝绱鞦秋鞽鞒鞾𫖇韁缰韃鞑韆千韉鞯韋韦韌韧韍韨韓韩韙韪韚𫠅韛𫖔韜韬韝鞲韞韫韠𫖒韻韵響响頁页頂顶頃顷項项順顺頇顸須须頊顼頌颂頍𫠆頎颀頏颃預预頑顽頒颁頓顿頔𬱖頗颇領领頜颌頠𬱟頡颉頤颐頦颏頫𫖯頭头頮颒頰颊頲颋頴颕頵𫖳頷颔頸颈頹颓頻频頽颓顂𩓋顃𩖖顅𫖶顆颗題题額额顎颚顏颜顒颙顓颛顔颜顗𫖮願愿顙颡顛颠類类顢颟顣𫖹顥颢顧顾顫颤顬颥顯显顰颦顱颅顳颞顴颧風风颭飐颮飑颯飒颰𩙥颱台颳刮颶飓颷𩙪颸飔颺飏颻飖颼飕颾𩙫飀飗飄飘飆飙飈飚飋𫗋飛飞飠饣飢饥飣饤飥饦飦𫗞飩饨飪饪飫饫飭饬飯饭飱飧飲饮飴饴飵𫗢飶𫗣飼饲飽饱飾饰飿饳餃饺餄饸餅饼餈糍餉饷養养餌饵餎饹餏饻餑饽餒馁餓饿餔𫗦餕馂餖饾餗𫗧餘余餚肴餛馄餜馃餞饯餡馅餦𫗠餧𫗪館馆餪𫗬餫𫗥餬糊餭𫗮餱糇餳饧餵喂餶馉餷馇餸𩠌餺馎餼饩餾馏餿馊饁馌饃馍饅馒饈馐饉馑饊馓饋馈饌馔饑饥饒饶饗飨饘𫗴饜餍饞馋饟𫗵饠𫗩饢馕馬马馭驭馮冯馯𫘛馱驮馳驰馴驯馹驲馼𫘜駁驳駃𫘝駉𬳶駊𫘟駎𩧨駐驻駑驽駒驹駓𬳵駔驵駕驾駘骀駙驸駚𩧫駛驶駝驼駞𫘞駟驷駡骂駢骈駤𫘠駧𩧲駩𩧴駪𬳽駫𫘡駭骇駰骃駱骆駶𩧺駸骎駻𫘣駼𬳿駿骏騁骋騂骍騃𫘤騄𫘧騅骓騉𫘥騊𫘦騌骔騍骒騎骑騏骐騑𬴂騔𩨀騖骛騙骗騚𩨊騜𫘩騝𩨃騞𬴃騟𩨈騠𫘨騤骙騧䯄騪𩨄騫骞騭骘騮骝騰腾騱𫘬騴𫘫騵𫘪騶驺騷骚騸骟騻𫘭騼𫠋騾骡驀蓦驁骜驂骖驃骠驄骢驅驱驊骅驋𩧯驌骕驍骁驎𬴊驏骣驓𫘯驕骄驗验驙𫘰驚惊驛驿驟骤驢驴驤骧驥骥驦骦驨𫘱驪骊驫骉骯肮髏髅髒脏體体髕髌髖髋髮发鬆松鬍胡鬖𩭹鬚须鬠𫘽鬢鬓鬥斗鬧闹鬨哄鬩阋鬮阄鬱郁鬹鬶魎魉魘魇魚鱼魛鱽魟𫚉魢鱾魥𩽹魦𫚌魨鲀魯鲁魴鲂魵𫚍魷鱿魺鲄魽𫠐鮀𬶍鮁鲅鮃鲆鮄𫚒鮅𫚑鮆𫚖鮈𬶋鮊鲌鮋鲉鮍鲏鮎鲇鮐鲐鮑鲍鮒鲋鮓鲊鮚鲒鮜鲘鮝鲞鮞鲕鮟𩽾鮠𬶏鮡𬶐鮣䲟鮤𫚓鮦鲖鮪鲔鮫鲛鮭鲑鮮鲜鮯𫚗鮰𫚔鮳鲓鮵𫚛鮶鲪鮸𩾃鮺鲝鮿𫚚鯀鲧鯁鲠鯄𩾁鯆𫚙鯇鲩鯉鲤鯊鲨鯒鲬鯔鲻鯕鲯鯖鲭鯗鲞鯛鲷鯝鲴鯞𫚡鯡鲱鯢鲵鯤鲲鯧鲳鯨鲸鯪鲮鯫鲰鯬𫚞鯰鲶鯱𩾇鯴鲺鯶𩽼鯷鳀鯻𬶟鯽鲫鯾𫚣鯿鳊鰁鳈鰂鲗鰃鳂鰆䲠鰈鲽鰉鳇鰊𬶠鰋𫚢鰌䲡鰍鳅鰏鲾鰐鳄鰑𫚊鰒鳆鰓鳃鰕𫚥鰛鳁鰜鳒鰟鳑鰠鳋鰣鲥鰤𫚕鰥鳏鰦𫚤鰧䲢鰨鳎鰩鳐鰫𫚦鰭鳍鰮鳁鰱鲢鰲鳌鰳鳓鰵鳘鰶𬶭鰷鲦鰹鲣鰺鲹鰻鳗鰼鳛鰽𫚧鰾鳔鱀𬶨鱂鳉鱄𫚋鱅鳙鱆𫠒鱇𩾌鱈鳕鱉鳖鱊𫚪鱒鳟鱔鳝鱖鳜鱗鳞鱘鲟鱚𬶮鱝鲼鱟鲎鱠鲙鱢𫚫鱣鳣鱤鳡鱧鳢鱨鲿鱭鲚鱮𫚈鱯鳠鱲𫚭鱷鳄鱸鲈鱺鲡鳥鸟鳧凫鳩鸠鳬凫鳲鸤鳳凤鳴鸣鳶鸢鳷𫛛鳼𪉃鳽𫛚鳾䴓鴀𫛜鴃𫛞鴅𫛝鴆鸩鴇鸨鴉鸦鴐𫛤鴒鸰鴔𫛡鴕鸵鴗𫁡鴛鸳鴜𪉈鴝鸲鴞鸮鴟鸱鴣鸪鴥𫛣鴦鸯鴨鸭鴮𫛦鴯鸸鴰鸹鴲𪉆鴳𫛩鴴鸻鴷䴕鴻鸿鴽𫛪鴿鸽鵁䴔鵂鸺鵃鸼鵊𫛥鵏𬷕鵐鹀鵑鹃鵒鹆鵓鹁鵚𪉍鵜鹈鵝鹅鵟𫛭鵠鹄鵡鹉鵧𫛨鵩𫛳鵪鹌鵫𫛱鵬鹏鵮鹐鵯鹎鵰雕"
  + "鵲鹊鵷鹓鵾鹍鶄䴖鶇鸫鶉鹑鶊鹒鶌𫛵鶒𫛶鶓鹋鶖鹙鶗𫛸鶘鹕鶚鹗鶠𬸘鶡鹖鶥鹛鶦𫛷鶩鹜鶪䴗鶬鸧鶭𫛯鶯莺鶰𫛫鶱𬸣鶲鹟鶴鹤鶹鹠鶺鹡鶻鹘鶼鹣鶿鹚鷀鹚鷁鹢鷂鹞鷄鸡鷅𫛽鷉䴘鷊鹝鷐𫜀鷓鹧鷔𪉑鷖鹥鷗鸥鷙鸷鷚鹨鷟𬸦鷣𫜃鷤𫛴鷥鸶鷦鹪鷨𪉊鷩𫜁鷫鹔鷭𬸪鷯鹩鷲鹫鷳鹇鷴鹇鷷𫜄鷸鹬鷹鹰鷺鹭鷽鸴鷿𬸯鸂㶉鸇鹯鸊䴙鸋𫛢鸌鹱鸏鹲鸑𬸚鸕鸬鸗𫛟鸘鹴鸚鹦鸛鹳鸝鹂鸞鸾鹵卤鹹咸鹺鹾鹼碱鹽盐麗丽麥麦麨𪎊麩麸麪面麫面麬𤿲麯曲麲𪎉麳𪎌麴曲麵面麷𫜑麼么麽么黃黄黌黉點点黨党黲黪黴霉黶黡黷黩黽黾黿鼋鼂鼌鼉鼍鼕冬鼴鼹齊齐齋斋齎赍齏齑齒齿齔龀齕龁齗龂齘𬹼齙龅齜龇齟龃齠龆齡龄齣出齦龈齧啮齩𫜪齪龊齬龉齭𫜭齮𬺈齯𫠜齰𫜬齲龋齴𫜮齶腭齷龌齼𬺓齾𫜰龍龙龎厐龐庞龑䶮龓𫜲龔龚龕龛龜龟龭𩨎龯𨱆鿁䜤鿓鿒"
// 码点感知配对：值可含补充平面字（各占 2 个 UTF-16 单元），逐码点两两切分。
const T2S_CPS = Array.from(T2S_PAIRS)
export const T2S_MAP = new Map<string, string>()
for (let i = 0; i + 1 < T2S_CPS.length; i += 2) T2S_MAP.set(T2S_CPS[i]!, T2S_CPS[i + 1]!)
export const T2S_RE = new RegExp(`[${Array.from(T2S_MAP.keys()).join("")}]`, "gu")
// F5：无状态的高速预检（非全局，可安全反复 .test，不受 lastIndex 影响）。
export const T2S_HAS_RE = new RegExp(`[${Array.from(T2S_MAP.keys()).join("")}]`, "u")

// F5：係 的系词读法（错字表：Lyria 係對指令 → Lyria 是对指令）。前接空格/拉丁、
// 且后不接系类词素（統/列/數/關/聯/體…）的 係 判为「是」；其余由字符表给「系」。
export const T2S_COPULA_SHI_RE = /(?<=[\sA-Za-z0-9])係(?![統列數数關关聯联體体])/g

// ── R9-B（2026-09-30）：假名行不转 ──
// 实锤：日文歌词被 R5-C 逐字转（「この距離が」→「この距离が」）。日文汉字不是繁体中文，
// 任何含平假名/片假名的行一律原样放行。・（U+30FB）与 ー（U+30FC）中文排版也常用，不算证据。
// 2026-10-04 W：原「跟随用户书写体」的 t2s/s2t 双向分支已随书写体镜像家族拆除——出口一律简体。
export const KANA_RE = /[\u3041-\u309F\u30A1-\u30FA\u30FD-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/

/** 正文行繁→简转换：无映射命中原样返回；有转换时留 journal 证据行。含假名的行（日文）原样返回。
 *  copula=true 时先判 係 的系词读法（Lyria 係對指令 → 是对指令）再由字符表兜底（係統 → 系统）；
 *  仅用于**有整行缓冲**的正文通道。copula=false 用于 reasoning/subagent 等增量分片通道：
 *  该启发式依赖 係 的前后邻字，跨 chunk 被切断会得出不同结果，故增量通道只做逐字映射（保证
 *  分片边界不漏转、不转坏、与整段一次转换逐字一致）。 */
export function t2sLine(line: string, copula = true): string {
  if (!line) return line
  if (KANA_RE.test(line)) return line // R9-B ①：日文行不转
  let converted = false
  // 2026-10-04 F5：係 系词读法先判，逐字表只能给一种读法，两读由这条确定性规则分开。
  let out = copula
    ? line.replace(T2S_COPULA_SHI_RE, () => {
        converted = true
        return "是"
      })
    : line
  out = out.replace(T2S_RE, (c) => {
    converted = true
    return T2S_MAP.get(c) ?? c
  })
  if (converted) console.log(`[gateway] R5-C t2s: line converted: ${out.slice(0, 60)}`)
  return out
}

// ── 2026-10-04 F5：出站文字单一咽喉点（emitToSession）的 T2S 收口 ──
// 口径：只做大陆生意，出站一律简体。任何用户可见文字在离开进程前过一次 T2S。
// 判定：只有「人读文字字段」的字符串值被转换；JSON 键名、结构化字段（url/src/
// task_id/serviceData/event_id…）与媒体 payload 一律原样。T2S 对 ASCII 是恒等
// 映射，故 URL/base64/数字/键名天然不被改动。代码栅栏（```/~~~）内不转。
export const T2S_TEXT_FIELDS: ReadonlySet<string> = new Set([
  "text", "message", "human_message", "description", "label", "summary",
  "reason", "title", "prompt", "content", "answer", "question", "header",
  "hint", "errorDetails", "detail", "details", "notice", "note", "caption",
  // 2026-10-04 F5：全量核查 emit 载荷后补的三个人读字段（均在用户眼前）：
  // turn.plan.plan（计划正文）、tool.invoke.args_summary（工具卡参数摘要）、
  // tool.result.error.auth_reason（本机档案授权卡片原因）。
  "plan", "args_summary", "auth_reason",
])

/** 人读文字串的繁→简：逐行转换，代码栅栏内、URL 段与日文行原样放行；无繁体字时零成本恒等返回。 */
export function t2sVisibleText(s: string): string {
  if (!s || !T2S_HAS_RE.test(s)) return s
  let inFence = false
  return s
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      // URL 段原样保留（交付物链接／成品地址是给用户的，转字形会让链接失效）；
      // 只在非 URL 段转。URL 是 ASCII 时 T2S 本就恒等，这里防的是 URL 内含中文。
      return line
        .split(URL_SEGMENT_RE)
        .map((part, i) => {
          if (i % 2 === 1) return part
          if (KANA_RE.test(part)) return part
          return t2sLine(part, false) // 增量分片通道：不做依赖邻字的系词启发式（见 t2sLine 注）
        })
        .join("")
    })
    .join("\n")
}

/** 递归对帧载荷里白名单字段的字符串值过 T2S；无改动时返回原对象（零额外分配）。 */
export function t2sVisibleData(data: unknown): unknown {
  if (data === null || typeof data !== "object") return data
  if (Array.isArray(data)) {
    let changed = false
    const out = data.map((v) => {
      const nv = t2sVisibleData(v)
      if (nv !== v) changed = true
      return nv
    })
    return changed ? out : data
  }
  const src = data as Record<string, unknown>
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    const nv = typeof v === "string" && T2S_TEXT_FIELDS.has(k) ? t2sVisibleText(v) : t2sVisibleData(v)
    if (nv !== v) changed = true
    out[k] = nv
  }
  return changed ? out : data
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
// （/opt/eimu-harness/…、outputs/…、runs/…、以及带文档/数据副档名的相对路径）与 R 系列规则代号。
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

// ── 2026-10-18：尾行即时吐出（首字被扣住修复）──
// 旧行为：无换行的尾行一律进 pending，等到换行/新 part/回合结束才吐——中文单段
// 回答在模型吐完整段前前端一片空白；工具前的单行旁白可能整轮不出现（见下方 R9 注）。
// 新判定（逐 chunk 重新评估 pending）：只有「仍可能被抑制/改写规则命中」的尾行才扣留：
//   ① 可能成为代码栅栏（```/~~~ 开头，或只打了 1-2 个反引号/波浪号的前缀）；
//   ② 可能成为 markdown 标题——已能按前缀判定为非内部标题（如「## 你好」）时提前吐出；
//   ③ 目前全是可打印 ASCII（无 CJK）——英文守门：已达 isEnglishProseLine 判据立即压制；
//      否则扣留到完整行，超过 120 字符仍无判据则立即吐出；
//   ④ 纯空白（可能是 ①② 的前缀）；
//   其余（出现 CJK、emoji、假名…）立即吐出。跨 chunk 会被改坏的窄后缀例外：
//   路径 token（含 / 或 \，≤512 字）从 token 起点扣留；行尾「係」连 lookbehind 上下文
//   一起扣留（否则拼回后系词启发式失准）。
// 完整行仍走原状态机（fence/suppress/英文/繁简/内部引用）语义不变；suppress 置位后
// 仍吞到下一个非内部标题（非标题尾行不可能变成标题，故可立即吞掉，结果等价）。
const FENCE_LINE_START_RE = /^[ \t]*(?:```|~~~)/
const FENCE_PREFIX_RE = /^[ \t]*(?:`{1,2}|~{1,2})$/
const HEADING_LINE_START_RE = /^[ \t]*#/
const WHITESPACE_ONLY_RE = /^[ \t]*$/
const PRINTABLE_ASCII_ONLY_RE = /^[\t\x20-\x7E]*$/
const TAIL_ASCII_HOLD_MAX = 120
// 与上方 INTERNAL_SECTION_HEADING_RE 的英文段名保持同步；用于「标题是否仍可能成为
// 内部段」的前缀判定（判定为否时提前吐出，见 headingMayBecomeInternal）。
const INTERNAL_SECTION_NAMES = [
  "objective", "work state", "next move", "relevant files", "important details",
  "completed", "active", "blocked", "progress summary", "verdict", "issues",
  "evidence", "beats", "shots", "timeline_ops",
]
const HEADING_MARK_RE = /^#{1,6}[ \t]*/
// 尾 token 分隔符＝空白 + 常见标点；刻意排除 / \ . - _ ~ ` :（路径 token 自身字符）。
const TAIL_TOKEN_SEP_RE = /[\s,;!?()\[\]{}<>"'|，。；、：！？（）【】「」『』《》〈〉…—]/
const PATH_TOKEN_PREFIX_RE = /^(?:runs|uploads|out|tmp|\.opencode|\/opt|\/home|\/tmp|\/var|~)[/\\]/
const PATH_TOKEN_MAX = 512

/** 标题是否仍可能命中 INTERNAL_SECTION_HEADING_RE（按已见正文前缀判断）。
 *  例："## Object" → true（还可能是 Objective）；"## 你好" → false（英文段名永不
 *  含 CJK，整行已可判定为非内部标题，可提前吐出）。 */
function headingMayBecomeInternal(tail: string): boolean {
  const m = HEADING_MARK_RE.exec(tail)
  if (!m) return false
  const body = tail.slice(m[0].length).toLowerCase().replace(/[ \t]*:?[ \t]*$/, "")
  return INTERNAL_SECTION_NAMES.some((n) => n.startsWith(body))
}

/** 尾行中「必须等下一个 chunk 才能正确改写」的后缀起点；无则 -1。
 *  ① 路径续写：最后一个分隔符之后的 token 含 / 或 \（或命中路径前缀）→ 从 token 起点扣留；
 *     token > 512 视为普通文本。② 繁简系词：以 係 结尾 → 扣留 係 及其 lookbehind 上下文
 *     字符（[\\sA-Za-z0-9]），否则下一行拼回时 lookbehind 丢失会把「A 係對」误转成「系」。 */
function rewriteHoldStart(tail: string): number {
  if (!tail) return -1
  let i = tail.length - 1
  while (i >= 0 && !TAIL_TOKEN_SEP_RE.test(tail[i]!)) i--
  const start = i + 1
  const token = tail.slice(start)
  if (token && token.length <= PATH_TOKEN_MAX && (/[/\\]/.test(token) || PATH_TOKEN_PREFIX_RE.test(token))) {
    return start
  }
  if (tail.endsWith("係")) {
    let from = tail.length - 1
    const prev = tail[from - 1]
    if (prev !== undefined && /[\sA-Za-z0-9]/.test(prev)) from -= 1
    return from
  }
  return -1
}

/** 吐出尾行；若尾部仍需跨 chunk 改写，则把该窄后缀留在 pending。 */
function emitTail(st: PartStripState, tail: string): string {
  const from = rewriteHoldStart(tail)
  if (from < 0) return transformBodyLine(tail)
  st.pending = tail.slice(from)
  const prefix = tail.slice(0, from)
  return prefix ? transformBodyLine(prefix) : ""
}

/** 尾行正文（非栅栏）与完整行走同一套改写：内部引用剥离 + 条款编号 + 繁→简。 */
function transformBodyLine(line: string): string {
  return t2sLine(scrubInternalRefs(line).replace(SECTION_REF_RE, "按内部规定").replace(SECTION_TOKEN_RE, "内部规定"))
}

/** 喂入一个 chunk，回传可安全外发的文本（仅「可能被规则命中」的尾行扣留，可回空串）。 */
export function stripOutboundFeed(st: PartStripState, chunk: string): string {
  chunk = cleanUtf16Chunk(st, chunk)
  if (!chunk) return ""
  const lines = (st.pending + chunk).split("\n")
  st.pending = ""
  const tail = lines.pop() ?? "" // 最后一段是未完成行（无换行终结），按下方规则决定去留
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
  // ── 尾行去留（2026-10-18）──
  const mayBecomeFence = FENCE_LINE_START_RE.test(tail) || FENCE_PREFIX_RE.test(tail)
  const mayBecomeHeading = HEADING_LINE_START_RE.test(tail)
  const headingSafe = mayBecomeHeading && !headingMayBecomeInternal(tail)
  if (st.fence) {
    // 栅栏内容直通；但围栏标记（含 1-2 个字符的前缀）必须等整行才能判开/关。
    if (mayBecomeFence || WHITESPACE_ONLY_RE.test(tail)) st.pending = tail
    else out += tail
  } else if (st.suppress) {
    // 内部段：标题/栅栏可能结束或穿透抑制，需等整行；已判定为非内部标题则立即恢复正文。
    if (mayBecomeFence || (mayBecomeHeading && !headingSafe) || WHITESPACE_ONLY_RE.test(tail)) {
      st.pending = tail
    } else if (headingSafe) {
      st.suppress = false
      out += emitTail(st, tail)
    }
    // 其余正文反正会被吞，立即丢弃。
  } else if (mayBecomeFence || WHITESPACE_ONLY_RE.test(tail)) {
    st.pending = tail
  } else if (mayBecomeHeading && !headingSafe) {
    // 仍可能是内部章节标题：等完整行再判。
    st.pending = tail
  } else if (PRINTABLE_ASCII_ONLY_RE.test(tail)) {
    // 已经满足英文正文判据（≥8 词等）→ 立即压制；否则扣留到完整行或 120 字符上限。
    if (isEnglishProseLine(tail)) st.sawEnglish = true
    else if (tail.length <= TAIL_ASCII_HOLD_MAX) st.pending = tail
    else out += emitTail(st, tail)
  } else {
    // CJK/emoji/假名等（或已判定安全的标题/超长 ASCII）：立即吐出；只有路径续写
    // 与尾部「係」这类跨 chunk 改写窄后缀才留在 pending。
    out += emitTail(st, tail)
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
