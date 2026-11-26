import type { AgentSkillSpec } from "./types";

export const CINEMA_AUTEUR_SKILLS: AgentSkillSpec[] = [
  {
    "id": "cine-shoma-daily-realism",
    "name": "日常写实克制美学",
    "oneLiner": "以家庭日常肌理拍出克制轻盈的情感片",
    "family": "cinema-auteur",
    "useScenario": "家庭题材文艺片、温情品牌片、生活流短片",
    "inputType": "故事梗概或剧本、人物关系、可选氛围参考图",
    "outputContent": "情绪板、角色与场景资产图、逐镜分镜表、成片视频",
    "outputKind": "video",
    "toolIds": [
      "script_scene_parse",
      "moodboard_diverge_converge",
      "style_anchor_sref",
      "image_generate",
      "last_frame_video_chain",
      "timeline_master"
    ],
    "expertId": "video-director",
    "tags": ["日常写实", "克制情感", "自然光", "固定机位", "家庭题材", "文艺片"],
    "aesthetic": "低照度自然光与室内窗光为主，固定或极缓慢横移机位，中景与大量留白，生活道具入画、不摆拍，表演克制、以停顿与空景收尾。"
  },
  {
    "id": "cine-youth-poetic-light",
    "name": "青春诗意光线美学",
    "oneLiner": "用逆光与天空拍出外放又诗意的青春情感",
    "family": "cinema-auteur",
    "useScenario": "青春成长短片、纯爱题材、日系写真向广告",
    "inputType": "故事或一句创意、角色设定、三个必出现元素",
    "outputContent": "情绪板、角色图、场景图、逐镜分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "moodboard_diverge_converge",
      "style_anchor_sref",
      "character_dna_turnaround",
      "image_generate",
      "last_frame_video_chain",
      "music_gen"
    ],
    "expertId": "video-director",
    "tags": ["青春", "逆光", "天空", "诗意光线", "纯爱", "日系"],
    "aesthetic": "高键逆光与镜头光斑、过曝天空与云层渐层，手持微晃跟拍与慢速推近，浅景深特写与广角对称并置，色调偏青蓝与暖肤对撞。"
  },
  {
    "id": "cine-urban-stasis-mood",
    "name": "都市情绪凝滞美学",
    "oneLiner": "在霓虹与窄巷里拍出时间凝滞的都市孤独",
    "family": "cinema-auteur",
    "useScenario": "都市情感短片、城市情绪片、品牌氛围片",
    "inputType": "人物设定、城市地点、情绪关键词、可选参考图",
    "outputContent": "情绪板、角色与场景资产、镜头卡、成片视频",
    "outputKind": "video",
    "toolIds": [
      "moodboard_diverge_converge",
      "style_dna_extract",
      "character_dna_turnaround",
      "image_generate",
      "keyframe_render",
      "timeline_style"
    ],
    "expertId": "video-director",
    "tags": ["都市", "凝滞", "霓虹", "窄巷", "抽格", "情绪流"],
    "aesthetic": "高饱和冷暖对撞的霓虹色块、雨夜反光湿地与镜面倒影，广角近拍加遮挡前景，抽格与升格交错、镜头缓慢横移，独白式旁白以停顿断句。"
  },
  {
    "id": "cine-cold-longtake",
    "name": "冷调长镜头美学",
    "oneLiner": "以冷调固定长镜头让空间与沉默自己说话",
    "family": "cinema-auteur",
    "useScenario": "作者电影、社会写实长片片段、美术馆影像",
    "inputType": "场景设定与场次大纲、人物调度意图",
    "outputContent": "场面调度方案、固定长镜头分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "script_scene_parse",
      "world_bible_extract",
      "image_generate",
      "keyframe_render",
      "last_frame_video_chain",
      "timeline_lint"
    ],
    "expertId": "video-director",
    "tags": ["长镜头", "冷调", "固定机位", "场面调度", "沉默", "作者电影"],
    "aesthetic": "极简冷调低饱和，固定机位超长镜头与深焦前后景并置，人物被门窗或画框边缘切割，环境音与沉默主导，几乎不使用配乐。"
  },
  {
    "id": "cine-wuxia-classical",
    "name": "武侠古典美学",
    "oneLiner": "把武侠灵感做成古典质感的江湖短片",
    "family": "cinema-auteur",
    "useScenario": "武侠短片、古装广告、侠义题材预告",
    "inputType": "一句武侠创意或完整剧情、角色关系、是否打斗",
    "outputContent": "创作脊柱、角色与场景资产、首尾帧、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "world_bible_extract",
      "character_dna_turnaround",
      "scene_pack_batch",
      "storyboard_qc_17",
      "last_frame_video_chain",
      "timeline_rhythm"
    ],
    "expertId": "video-director",
    "tags": ["武侠", "古典", "江湖", "竹林", "剑", "胡金铨式"],
    "aesthetic": "仿胶片颗粒与茶褐低饱和，竹林与客栈的实景质感，几何化构图配客观机位，武打以短促剪切配定点亮相，雾气与侧逆光勾勒身形。"
  },
  {
    "id": "cine-xianxia-ethereal",
    "name": "东方仙侠氛围美学",
    "oneLiner": "用人像参考生成仙气飘逸的东方氛围短片",
    "family": "cinema-auteur",
    "useScenario": "国风写真大片、仙侠氛围短片、社媒美学向内容",
    "inputType": "人像参考图、角色设定、氛围关键词",
    "outputContent": "角色与场景资产、逐镜分镜表格、仙侠氛围成片视频",
    "outputKind": "video",
    "toolIds": [
      "character_dna_turnaround",
      "style_anchor_sref",
      "scene_pack_batch",
      "image_generate",
      "last_frame_video_chain",
      "music_gen"
    ],
    "expertId": "video-director",
    "tags": ["仙侠", "国风", "仙气", "云海", "飘逸", "氛围"],
    "aesthetic": "高调柔光与雾面扩散、云海与瀑布的纵深层次，慢速升降与环绕运镜，衣袂与发丝飘动为主要动态，色调为冷白金与淡青。"
  },
  {
    "id": "cine-eastern-megastructure",
    "name": "东方巨构空间美学",
    "oneLiner": "以巨物与人的尺度差拍出东方奇观短片",
    "family": "cinema-auteur",
    "useScenario": "东方科幻短片、巨构题材视觉、国风奇观片",
    "inputType": "一句创意或剧本、可选人像与造型参考图",
    "outputContent": "角色与场景资产、逐镜分镜、巨构短片成片",
    "outputKind": "video",
    "toolIds": [
      "world_bible_extract",
      "scene_pack_batch",
      "image_generate",
      "keyframe_render",
      "last_frame_video_chain",
      "multi_aspect_reflow"
    ],
    "expertId": "video-director",
    "tags": ["巨构", "尺度差", "东方", "奇观", "仰角", "科幻"],
    "aesthetic": "极端仰角与俯角强调尺度差，巨构体量填满画框、人物缩为剪影，雾与尘埃分层制造空气透视，单一重色调（青灰或赭红）配硬边光。"
  },
  {
    "id": "cine-new-chinese-aesthetic",
    "name": "新中式视觉美学",
    "oneLiner": "从妆造布景到成片做出新中式全案视觉",
    "family": "cinema-auteur",
    "useScenario": "品牌国风广告、新中式妆造大片、产品美学片",
    "inputType": "产品图与卖点、调性关键词、可选模特参考图",
    "outputContent": "妆造与场景资产、分镜、旁白与配乐、完整成片",
    "outputKind": "mixed",
    "toolIds": [
      "product_lock",
      "product_conditioned_generation",
      "garment_dna_lock",
      "scene_pack_batch",
      "image_generate",
      "tts_speak"
    ],
    "expertId": "video-director",
    "tags": ["新中式", "国风", "妆造", "产品", "对称", "东方留白"],
    "aesthetic": "对称构图与中轴线布局、屏风格栅与圆窗框景，水墨灰配朱红黛青的有限色盘，柔光加局部硬光勾边，材质强调丝绸、宣纸与木纹。"
  },
  {
    "id": "cine-dreamcore-subconscious",
    "name": "梦核潜意识美学",
    "oneLiner": "把梦境逻辑做成失重错位的潜意识短片",
    "family": "cinema-auteur",
    "useScenario": "概念短片、梦境叙事、音乐视觉",
    "inputType": "梦境描述或关键词、情绪基调、可选参考图",
    "outputContent": "概念情绪板、梦境场景图、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "moodboard_diverge_converge",
      "emotion_board_matrix",
      "image_generate",
      "style_aligned_batch",
      "last_frame_video_chain",
      "timeline_mix"
    ],
    "expertId": "video-director",
    "tags": ["梦核", "潜意识", "超现实", "失重", "错位", "梦境逻辑"],
    "aesthetic": "无重力悬浮与空间错位、尺度与透视被刻意违反，饱和色块与过曝光晕，缓慢漂浮运镜与无缝转场，音场为低频嗡鸣与空间残响。"
  },
  {
    "id": "cine-taiwan-new-wave-gaze",
    "name": "台湾新浪潮凝视美学",
    "oneLiner": "以疏离凝视拍出写实感的人文长镜",
    "family": "cinema-auteur",
    "useScenario": "社会纪实剧情片、温情电影或广告、人文短片",
    "inputType": "故事或剧本、人物背景、年代设定",
    "outputContent": "情绪板、角色与场景资产、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "script_scene_parse",
      "moodboard_diverge_converge",
      "character_dna_turnaround",
      "image_generate",
      "last_frame_video_chain",
      "timeline_master"
    ],
    "expertId": "video-director",
    "tags": ["凝视", "疏离", "写实", "长镜", "人文", "年代感"],
    "aesthetic": "自然光实景与略为过曝的窗景，中远景固定机位长时间凝视，人物常置于画框一侧或背向镜头，同期声与静默并置，低对比柔和调色。"
  },
  {
    "id": "cine-showa-nostalgia",
    "name": "昭和怀旧美学",
    "oneLiner": "以昭和质感拍出旧年代的温吞日常",
    "family": "cinema-auteur",
    "useScenario": "年代怀旧短片、复古广告、家庭记忆题材",
    "inputType": "年代与地点设定、故事片段、参考物件清单",
    "outputContent": "年代情绪板、场景与道具资产、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "moodboard_diverge_converge",
      "style_dna_extract",
      "scene_pack_batch",
      "image_generate",
      "last_frame_video_chain",
      "music_gen"
    ],
    "expertId": "video-director",
    "tags": ["昭和", "怀旧", "年代", "胶片", "暖调", "日常"],
    "aesthetic": "暖黄钨丝灯与泛红胶片颗粒、略为低饱和的旧式冲印感，方正构图与水平机位，风扇与收音机的机械动态，画面带轻微暗角与耀斑。"
  },
  {
    "id": "cine-japanese-pure-love",
    "name": "日系纯爱美学",
    "oneLiner": "以细腻青春感拍出日系纯爱短片",
    "family": "cinema-auteur",
    "useScenario": "纯爱短片、青春剧集片段、日式美学广告",
    "inputType": "故事或剧本、三个必出现元素、角色设定",
    "outputContent": "情绪板、角色与场景资产、配乐、成片视频",
    "outputKind": "video",
    "toolIds": [
      "moodboard_diverge_converge",
      "character_dna_turnaround",
      "style_anchor_sref",
      "image_generate",
      "last_frame_video_chain",
      "music_gen"
    ],
    "expertId": "video-director",
    "tags": ["纯爱", "日系", "青春", "细腻", "校园", "初恋"],
    "aesthetic": "柔焦与大光圈浅景深、逆光发丝与散景光斑，手持轻晃与慢速推进，色调清透偏青白、肤色红润，以季节元素承载情绪。"
  },
  {
    "id": "cine-cyber-eastasia-neon",
    "name": "赛博东亚霓虹美学",
    "oneLiner": "以东亚霓虹街景拍出赛博质感短片",
    "family": "cinema-auteur",
    "useScenario": "赛博题材短片、电子音乐视觉、游戏宣传片",
    "inputType": "世界观设定、角色造型、可选街景参考图",
    "outputContent": "世界观圣经、角色与场景资产、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "world_bible_extract",
      "character_dna_turnaround",
      "scene_pack_batch",
      "image_generate",
      "last_frame_video_chain",
      "timeline_style"
    ],
    "expertId": "video-director",
    "tags": ["赛博", "霓虹", "东亚", "雨夜", "高饱和", "未来都市"],
    "aesthetic": "霓虹招牌与电子广告的洋红与青蓝双色对撞，雨夜反光与蒸汽雾，广角低机位强透视，高对比带轻微色差，电子低频铺底配环境噪音。"
  },
  {
    "id": "cine-handdrawn-warmth",
    "name": "手绘动画温暖美学",
    "oneLiner": "用手绘质感与暖色拍出温度感的动画短片",
    "family": "cinema-auteur",
    "useScenario": "二维动画短片、绘本风品牌片、亲子题材",
    "inputType": "绘本式故事、角色设定、可选风格参考图",
    "outputContent": "角色三视图、场景图、分镜、手绘风成片视频",
    "outputKind": "video",
    "toolIds": [
      "character_dna_turnaround",
      "style_anchor_sref",
      "sketch_lock",
      "image_generate",
      "last_frame_video_chain",
      "tts_speak"
    ],
    "expertId": "motion-director",
    "tags": ["手绘", "动画", "温暖", "绘本", "暖色", "二维"],
    "aesthetic": "可见笔触与纸纹肌理、水彩般柔和边缘晕染，暖橙与奶油色主调，圆润造型与简化五官，动作以关键张节奏与轻微抖动表现手作感。"
  },
  {
    "id": "cine-inkwash-negative-space",
    "name": "水墨留白美学",
    "oneLiner": "以水墨笔势与大片留白拍出东方写意短片",
    "family": "cinema-auteur",
    "useScenario": "国风写意短片、文化品牌片、舞台影像",
    "inputType": "主题与意境关键词、可选参考图",
    "outputContent": "意境情绪板、场景与角色图、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "moodboard_diverge_converge",
      "style_anchor_sref",
      "style_dna_extract",
      "image_generate",
      "last_frame_video_chain",
      "timeline_rhythm"
    ],
    "expertId": "video-director",
    "tags": ["水墨", "留白", "写意", "东方", "笔触", "意境"],
    "aesthetic": "黑白灰墨阶与大片负空间、宣纸纤维质感，构图取散点透视与一河两岸，动态以墨晕扩散与笔锋运动为主，画面静而气韵流动。"
  },
  {
    "id": "cine-street-market-realism",
    "name": "市井烟火写实美学",
    "oneLiner": "以市井生活肌理拍出烟火气写实短片",
    "family": "cinema-auteur",
    "useScenario": "小城人文片、餐饮品牌片、非戏剧性情绪短片",
    "inputType": "地点与人物设定、生活片段或一句创意",
    "outputContent": "人文情绪板、场景与道具资产、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "scene_pack_batch",
      "moodboard_diverge_converge",
      "image_generate",
      "keyframe_render",
      "last_frame_video_chain",
      "timeline_master"
    ],
    "expertId": "video-director",
    "tags": ["市井", "烟火气", "写实", "小城", "人文", "生活流"],
    "aesthetic": "混光环境下的自然色温、摊位灯笼的暖点光源，肩扛手持跟拍与人群遮挡，蒸气与油烟水气入画，构图不刻意、保留生活原貌的杂乱感。"
  },
  {
    "id": "cine-post-disaster-wasteland",
    "name": "灾后废土东亚美学",
    "oneLiner": "以废墟与残存日常拍出灾后废土短片",
    "family": "cinema-auteur",
    "useScenario": "末世题材短片、废土视觉、社会寓言片",
    "inputType": "世界观设定、主角设定、废墟场景描述",
    "outputContent": "世界观圣经、角色与场景资产、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "world_bible_extract",
      "character_dna_turnaround",
      "scene_pack_batch",
      "image_generate",
      "last_frame_video_chain",
      "upscale_audit"
    ],
    "expertId": "video-director",
    "tags": ["废土", "灾后", "废墟", "末世", "灰尘", "寓言"],
    "aesthetic": "去饱和的灰土与铁锈色盘、强侧光与长阴影，广角空景配孤立主体，画面保留粉尘与悬浮颗粒，以水平线压低天空占比。"
  },
  {
    "id": "cine-court-imperial-texture",
    "name": "宫廷质感美学",
    "oneLiner": "以宫廷空间与仪典质感拍出古典大剧",
    "family": "cinema-auteur",
    "useScenario": "古装宫廷剧、质感预告片、宫廷题材广告",
    "inputType": "剧本或人物设定、朝代与空间设定",
    "outputContent": "服制与场景资产、场面调度方案、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "world_bible_extract",
      "garment_dna_lock",
      "cast_asset_lock",
      "scene_pack_batch",
      "image_generate",
      "last_frame_video_chain"
    ],
    "expertId": "video-director",
    "tags": ["宫廷", "古典", "仪典", "对称", "服制", "质感"],
    "aesthetic": "对称轴向构图与建筑框景、深宫纵深层层递进，压暗环境光配窗格漏光，织金配暗红与黛青的厚重色盘，人物调度以行列与仪典队形为主。"
  },
  {
    "id": "cine-road-movie",
    "name": "公路电影美学",
    "oneLiner": "以公路与远景拍出漂泊感的旅程短片",
    "family": "cinema-auteur",
    "useScenario": "公路题材短片、旅拍叙事、汽车品牌故事",
    "inputType": "路线与地点、人物关系、旅程意图",
    "outputContent": "分场路线图、角色与场景资产、分镜、成片视频",
    "outputKind": "video",
    "toolIds": [
      "script_scene_parse",
      "character_dna_turnaround",
      "image_generate",
      "keyframe_render",
      "last_frame_video_chain",
      "timeline_rhythm"
    ],
    "expertId": "video-director",
    "tags": ["公路", "旅程", "远景", "漂泊", "空景", "公路片"],
    "aesthetic": "宽画幅大远景与地平线构图、长焦压缩的公路线条，车内固定机位与侧窗流逝风景交替，日光硬调配黄昏长阴影，配乐驱动段落节奏。"
  },
  {
    "id": "cine-observational-doc",
    "name": "纪录观察式美学",
    "oneLiner": "以观察式纪录语法拍出不煽情的人文短片",
    "family": "cinema-auteur",
    "useScenario": "纪录短片、人物志、非虚构品牌故事",
    "inputType": "人物与场景背景、可拍摄的生活片段、可选访谈素材",
    "outputContent": "观察脚本、场景资产、成片视频与字幕",
    "outputKind": "mixed",
    "toolIds": [
      "script_scene_parse",
      "asset_search",
      "image_generate",
      "last_frame_video_chain",
      "tts_speak",
      "timeline_master"
    ],
    "expertId": "video-director",
    "tags": ["纪录", "观察", "非虚构", "人文", "克制", "访谈"],
    "aesthetic": "可用光实景与不补光的自然色，手持跟拍与长焦远观并用，不介入的打断式剪辑与留白，同期声优先、极少或不用配乐，保留未修饰的质地。"
  }
];
