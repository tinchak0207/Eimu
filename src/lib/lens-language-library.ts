/**
 * 镜头语言词库（Lens Language Thesaurus）— 142 条 / 12 类。
 *
 * 轮子来源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 源档：sql/aid-init.sql 的 `aid_prompt_lib` 初始资料（143 笔 INSERT，行 2301 起）
 * 取得日：2026-09-15
 * 逐字保留：prompt_type（→ group）/ prompt_name（→ name）/ prompt_content（→ text）
 * 白名单改写（仅此三处，其余逐行等价）：
 *   1. cover_url（AID 自建 OSS 路径 `/aid/storyboard/img/...`）→ 剔除。该图片资产属
 *      「官方资产包」，不在 AID 开源 Release 内，取不到；缩图走本站同名占位卡配方另行覆盖。
 *   2. 同 type 同名去重一笔：exposure_blur 的「深景深」有两笔（sort_order 不同、文本不同），
 *      保留首见者。原文一字未改，仅去重。
 *   3. 分组 label（构图/景别/…）为本站新增展示层栏位，不动原文。
 * 本档为纯资料常数，无逻辑。
 *
 * 消费入口：composeLensFragment()（注入用）／lensEntriesByGroup()（UI 选词用）。
 */

export interface LensLanguageEntry {
  /** AID 原始 prompt_type（分组键，逐字保留）。 */
  readonly group: string;
  /** AID 原始 prompt_name（逐字保留）。 */
  readonly name: string;
  /** AID 原始 prompt_content（逐字保留，含中文详解）。 */
  readonly text: string;
}

export const LENS_LANGUAGE_SOURCE = {
  repo: "gzxx-2025/aid-server",
  file: "sql/aid-init.sql (aid_prompt_lib)",
  license: "MIT",
  copyright: "光子讯息(杭州)科技有限公司",
  fetchedAt: "2026-09-15",
  totalEntries: 142,
} as const;

export const LENS_LANGUAGE_GROUP_LABELS: Readonly<Record<string, string>> = {

  composition: "构图",
  shot_size: "景别",
  camera_angle: "机位/视角",
  focal_length: "焦段",
  lens_type: "镜头类型",
  color_tone: "色调",
  lighting: "光线",
  exposure_blur: "曝光/虚化",
  camera_movement: "运镜",
  shooting_technique: "摄法/特殊技法",
  quality_base: "画质保底",
  negative_base: "负向词保底",
};

export const LENS_LANGUAGE_LIBRARY: readonly LensLanguageEntry[] = [
  // ── 构图（composition，16 条）
  { group: 'composition', name: '三分构图', text: '三分法构图，主体置于三分线交点，画面均衡，视觉重心自然。' },
  { group: 'composition', name: '对称构图', text: '对称构图，画面以中轴线左右完全对称，两侧元素一一对应，秩序感强。' },
  { group: 'composition', name: '中心构图', text: '中心构图，主体绝对居中位于垂直中轴线上，四周元素向中心收拢。' },
  { group: 'composition', name: '引导线法', text: '引导线构图，画面中的线条元素自边角向纵深延伸，视线沿线条被牵引至主体。' },
  { group: 'composition', name: '框架构图', text: '框架构图，前景元素在四周围合成天然画框并虚化，主体位于框内明亮处。' },
  { group: 'composition', name: '前景层', text: '前景层构图，画面分前中后三层，前景大幅虚化形成柔纱，中景主体清晰，后景虚化。' },
  { group: 'composition', name: '对角构图', text: '对角线构图，主要元素沿画面对角线倾斜排布，形成强烈的方向动势。' },
  { group: 'composition', name: '三角构图', text: '三角构图，画面主要元素构成稳定的三角形分布，底边宽阔顶点收拢，视觉重心低而沉稳。' },
  { group: 'composition', name: '黄金比例', text: '黄金比例构图，画面元素按约一比一点六一八的黄金螺旋排布，主体位于螺旋终点。' },
  { group: 'composition', name: '负空间', text: '负空间构图，大面积留白占画面七成以上，主体极小并偏置一角，空间被极致放大。' },
  { group: 'composition', name: '霸总站位', text: '仰角中心构图，主体居中且位于画面高处，机位低于主体，形成被仰望的支配感。' },
  { group: 'composition', name: '双人并置', text: '双主体并置构图，两个主体平行并列，朝向一致而彼此微转，形成对等的交流关系。' },
  { group: 'composition', name: '镜面反射', text: '镜面反射构图，以反射面中的倒影为画面主体，焦点落在倒影上，实体退为次要。' },
  { group: 'composition', name: '缝隙窥视', text: '缝隙窥视构图，透过前景狭窄缝隙拍摄，缝隙虚化成暗色边框，主体在框内明亮处。' },
  { group: 'composition', name: '台阶站位', text: '高低差构图，主体位于高处，机位在低处仰角约二十度，前景向下层层延伸。' },
  { group: 'composition', name: '俯仰呼应', text: '多视角呼应构图，前景仰视、中景平视、背景俯视并置于同一画面，用广角压缩空间。' },
  // ── 景别（shot_size，10 条）
  { group: 'shot_size', name: '远景', text: '远景，主体全身占画面高度约三分之一，环境占据大部分画面，交代主体与空间的关系。' },
  { group: 'shot_size', name: '全景', text: '全景，主体全身刚好填满画框，头顶与脚下留少量余量，完整呈现主体形态。' },
  { group: 'shot_size', name: '中景', text: '中景，取景至主体腰部以上，兼顾主体动作与局部环境。' },
  { group: 'shot_size', name: '中近景', text: '中近景，取景至主体胸口以上，突出上半身与神态。' },
  { group: 'shot_size', name: '近景', text: '近景，取景至主体肩部以上，主体细节成为画面重点。' },
  { group: 'shot_size', name: '大特写', text: '大特写，取景仅保留主体最关键的局部并填满整个画面，细节被极致放大。' },
  { group: 'shot_size', name: '大远景', text: '大远景，主体占画面不足百分之五，以宏观环境为主，主体仅作点缀。' },
  { group: 'shot_size', name: '中全景/膝上景', text: '膝上景，取景至主体膝盖以上，保留大部分肢体动作与部分环境。' },
  { group: 'shot_size', name: '极特写', text: '极特写，单一细部占画面七成以上，超越常规特写的极限放大。' },
  { group: 'shot_size', name: '细节镜头', text: '细节镜头，聚焦于局部细部或微小对象，脱离整体独立成画。' },
  // ── 机位/视角（camera_angle，13 条）
  { group: 'camera_angle', name: '平视', text: '平视机位，相机与主体视平线等高，视角客观中立，无俯仰透视变形。' },
  { group: 'camera_angle', name: '鸟瞰', text: '鸟瞰机位，相机自正上方垂直向下俯拍，主体与环境呈平面化排布，投影被压缩至脚下。' },
  { group: 'camera_angle', name: '虫视角', text: '虫视机位，相机贴近地面极端仰拍，前景元素被极度放大，天空占据画面主体，透视变形强烈。' },
  { group: 'camera_angle', name: '第一人称视角', text: '第一人称主观机位，模拟观看者视线，带轻微自然晃动，主体正对镜头形成直接对视。' },
  { group: 'camera_angle', name: '荷兰角', text: '荷兰角机位，画面水平轴倾斜约十五度，地平线呈倾斜对角线，制造失衡与不安感。' },
  { group: 'camera_angle', name: '侧面视角', text: '正侧面机位，相机与主体朝向呈九十度，只呈现完整的侧面轮廓线。' },
  { group: 'camera_angle', name: '高角度', text: '高角度俯拍，相机高于主体约四十五度向下，主体显得内收，环境铺展开来。' },
  { group: 'camera_angle', name: '低角度', text: '低角度仰拍，相机低于主体约三十度向上，主体形体被拉长，存在感增强。' },
  { group: 'camera_angle', name: '过肩', text: '过肩机位，前景为另一主体的肩背形成天然景框，中景为被摄主体，建立对话关系。' },
  { group: 'camera_angle', name: '正面', text: '正面机位，相机与主体完全正对，左右对称，视线直接朝向镜头。' },
  { group: 'camera_angle', name: '四分之三正面', text: '四分之三正面机位，主体与相机呈约四十五度，露出四分之三正面，明暗自然分层。' },
  { group: 'camera_angle', name: '四分之三背面', text: '四分之三背面机位，主体背对相机微转，露出约四分之一侧面，留有回望的悬念。' },
  { group: 'camera_angle', name: '背面', text: '背面机位，主体完全背对相机，不呈现正面信息，以背影与环境构成留白。' },
  // ── 焦段（focal_length，9 条）
  { group: 'focal_length', name: '14mm 超广角', text: '十四毫米超广角，视野极宽，透视变形强烈，近大远小被极度夸张。' },
  { group: 'focal_length', name: '24mm 广角', text: '二十四毫米广角，视野开阔，透视有明显夸张，纵深感强。' },
  { group: 'focal_length', name: '35mm 小广角', text: '三十五毫米小广角，视野略宽于人眼，透视自然，纪实感强。' },
  { group: 'focal_length', name: '50mm 标准', text: '五十毫米标准，透视最接近人眼，无明显变形，最中性的镜头语言。' },
  { group: 'focal_length', name: '85mm 人像', text: '八十五毫米中长焦，主体比例最讨喜，背景虚化柔和，主体与背景分离干净。' },
  { group: 'focal_length', name: '105mm 中长焦', text: '一百零五毫米中长焦，透视轻度压缩，散景细腻，细节表现力强。' },
  { group: 'focal_length', name: '135mm 长焦', text: '一百三十五毫米长焦，空间压缩明显，背景奶油化。' },
  { group: 'focal_length', name: '200mm 远摄', text: '二百毫米远摄，空间被极度压缩近乎平面，主体与环境彻底剥离。' },
  { group: 'focal_length', name: '鱼眼', text: '十毫米鱼眼，严重桶形畸变，中央凸出四周向角落弯曲，直线全部变为弧线。' },
  // ── 镜头类型（lens_type，5 条）
  { group: 'lens_type', name: '广角', text: '二十四毫米广角，透视夸张，近处元素被放大远处被压缩，空间显得开阔纵深。' },
  { group: 'lens_type', name: '标准', text: '五十毫米标准，透视与人眼一致，远近比例关系最自然，不加修饰。' },
  { group: 'lens_type', name: '中长焦', text: '八十五毫米中长焦，主体比例最佳，背景明显虚化，主体与背景完全分离。' },
  { group: 'lens_type', name: '长焦', text: '二百毫米长焦，空间极度压缩，前后层次被压到同一平面，背景虚化成纯色。' },
  { group: 'lens_type', name: '裂焦', text: '裂焦，画面左右分别对焦于极近前景与远处主体，中间保留一条焦平面过渡线。' },
  // ── 色调（color_tone，15 条）
  { group: 'color_tone', name: '暖色调', text: '暖色调，整体色温偏暖约三千五百开尔文，橙黄金杏为主导色相，冷色被压低。' },
  { group: 'color_tone', name: '冷色调', text: '冷色调，整体色温偏冷约八千开尔文，蓝青紫银为主导色相，暖色被压低。' },
  { group: 'color_tone', name: '高饱和度', text: '高饱和，色彩饱和度整体提升约百分之四十，色相浓烈鲜明，对比强烈。' },
  { group: 'color_tone', name: '去饱和', text: '低饱和，色彩饱和度整体降低约百分之七十，接近褪色，仅保留微弱色相。' },
  { group: 'color_tone', name: '中性调', text: '中性调，色温约五千五百开尔文，还原自然白平衡，不做任何色彩倾向处理。' },
  { group: 'color_tone', name: '茶色/怀旧', text: '茶色调，全画面覆盖棕黄滤镜，色彩统一退化为棕黄色系的明度层次，四角加暗角。' },
  { group: 'color_tone', name: '蓝橙对比', text: '蓝橙对比，暖部推向橙色系冷部推向青蓝系，形成补色强对比。' },
  { group: 'color_tone', name: '红色调', text: '红色调，强化红通道，红与洋红饱和度单独提高，其余色相相对收敛。' },
  { group: 'color_tone', name: '蓝色调', text: '蓝色调，强化蓝通道，全画面笼罩一层透明蓝色薄纱，暖色被中和。' },
  { group: 'color_tone', name: '绿色调', text: '绿色调，强化绿通道，绿色层次被放大，黄绿至墨绿的过渡丰富。' },
  { group: 'color_tone', name: '金色调', text: '金色调，高光被染成香槟金，亮部偏金属金，暗部保持温暖棕，整体如浸金。' },
  { group: 'color_tone', name: '紫色调', text: '紫色调，叠加淡紫滤镜，蓝色向薰衣草紫偏移，紫与洋红被突显。' },
  { group: 'color_tone', name: '白色调', text: '高调白，整体提亮并去饱和推向白色，高光接近纯白，色彩降至最低。' },
  { group: 'color_tone', name: '黑色调', text: '低调黑，整体压暗并强化暗部，深色占主导，四角暗角极重，仅保留少量亮部。' },
  { group: 'color_tone', name: '粉色调', text: '粉色调，叠加淡粉滤镜，粉与暖白被突显，高光边缘带粉色光晕。' },
  // ── 光线（lighting，24 条）
  { group: 'lighting', name: '逆光', text: '逆光，主光自主体正后方射入，边缘被勾出一圈轮廓光，正面转入柔和剪影。' },
  { group: 'lighting', name: '侧光', text: '侧光，主光自正侧方九十度射入，明暗被精确分为两半，立体感与戏剧性最强。' },
  { group: 'lighting', name: '顶光', text: '顶光，主光自正上方垂直射下，凹陷处形成阴影，上表面被照亮。' },
  { group: 'lighting', name: '底光', text: '底光，主光自下方射入，光影关系倒置，下方被照亮上方偏暗，非常规的奇幻感。' },
  { group: 'lighting', name: '环境光', text: '环境光，无明确主光源方向，仅靠天空散射与周围反射，整体曝光均匀偏低。' },
  { group: 'lighting', name: '黄金时刻', text: '黄金时刻，日落前约一小时的低角度暖金光线，色温偏暖，投影被拉长。' },
  { group: 'lighting', name: '蓝调时刻', text: '蓝调时刻，日落后约二十分钟的深蓝暮光，色温偏冷，地平线残留一线暖橙。' },
  { group: 'lighting', name: '硬光', text: '硬光，强烈直射无漫射，阴影边缘锐利清晰，光比约六比一，对比强烈。' },
  { group: 'lighting', name: '柔光', text: '柔光，经漫射的柔和光线，阴影边缘过渡平滑，光比约二比一，无硬阴影。' },
  { group: 'lighting', name: '漫射光', text: '漫射光，光线自各方向均匀散射，几乎无方向性与阴影，接近无影状态。' },
  { group: 'lighting', name: '主光', text: '主光，画面中最主要的塑形光源，决定整体光影结构与主要投影方向。' },
  { group: 'lighting', name: '辅光', text: '辅光，用于填充主光形成的阴影，提亮暗部降低光比，不产生新的投影。' },
  { group: 'lighting', name: '背景光', text: '背景光，独立照亮主体之后的背景层，把主体从背景中分离出来。' },
  { group: 'lighting', name: '眼神光', text: '眼神光，一盏正面低强度补光，专门在眼球高光位打出明亮反光点，不改变整体曝光。' },
  { group: 'lighting', name: '高调', text: '高调，光比约一比一至一点五比一，几乎无阴影，整体明亮通透，高光接近纯白。' },
  { group: 'lighting', name: '低调', text: '低调，光比约六比一至八比一，大面积暗部主导，仅少量窄光照亮关键部位。' },
  { group: 'lighting', name: '中间调', text: '中间调，光比约二比一至三比一，明暗过渡自然，层次最丰富。' },
  { group: 'lighting', name: '剪影', text: '剪影，强逆光且无辅光，主体完全黑化只留轮廓线条，被明亮背景勾勒。' },
  { group: 'lighting', name: '月光', text: '月光，冷蓝色柔光自高处射入，整体曝光偏低，阴影深但边缘柔和。' },
  { group: 'lighting', name: '烛光', text: '烛光，暖橙色点光源自低处近距离照射，色温约两千开尔文，光照范围小且带跳动感。' },
  { group: 'lighting', name: '霓虹', text: '霓虹光，冷调彩色点光源与环境暖光冲突，主体被两种色温分割。' },
  { group: 'lighting', name: '实用光源', text: '实用光源，光源本身出现在画面内并可见，光照关系由画内光源解释。' },
  { group: 'lighting', name: '窗户光', text: '窗户光，单侧柔光自开口射入形成一束光柱，只照亮局部其余落入阴影。' },
  { group: 'lighting', name: '频闪', text: '频闪，极短促的冷白硬光瞬间照亮，动作被冻结，与环境光形成强烈反差。' },
  // ── 曝光/虚化（exposure_blur，15 条）
  { group: 'exposure_blur', name: '长曝光', text: '长曝光，运动轨迹拖曳成连续光带，流动介质被抹平，静止部分保持清晰。' },
  { group: 'exposure_blur', name: '浅景深虚化', text: '浅景深虚化，背景强烈散景，主体从环境中被干净剥离。' },
  { group: 'exposure_blur', name: '深景深', text: '深景深，前后景全部合焦，由近及远细节一致锐利。' },
  { group: 'exposure_blur', name: '微距摄影', text: '微距，极近对焦距离，微小对象被高倍放大，景深极浅。' },
  { group: 'exposure_blur', name: '移轴效果', text: '移轴，焦平面被倾斜，仅一条窄带合焦，真实尺度场景呈现微缩模型质感。' },
  { group: 'exposure_blur', name: '双重曝光', text: '双重曝光，两层影像叠加融合，形成半透明的复合画面。' },
  { group: 'exposure_blur', name: '运动模糊', text: '运动模糊，运动部分沿轨迹拖出模糊带，静止部分保持清晰，速度感强烈。' },
  { group: 'exposure_blur', name: '光斑散景', text: '散景，失焦光源化为柔和圆形光斑，背景呈梦幻光点质感。' },
  { group: 'exposure_blur', name: '微距', text: '一百毫米微距，最近对焦距离极短，微小结构被高倍放大，清晰范围仅数毫米。' },
  { group: 'exposure_blur', name: '移轴', text: '移轴，焦平面被倾斜，只有一条窄带合焦，真实尺度场景呈现微缩模型质感。' },
  { group: 'exposure_blur', name: '浅景深', text: '浅景深，大光圈极窄焦平面，仅主体关键部位合焦，前后景全部化为柔和色块与光斑。' },
  { group: 'exposure_blur', name: '拉焦/变焦', text: '拉焦，焦点在拍摄过程中自近处元素转移到远处主体，呈现焦平面移动的过渡状态。' },
  { group: 'exposure_blur', name: '柔焦', text: '柔焦，镜头前加柔光镜，高光向暗部溢出形成光晕，整体轮廓边缘柔化。' },
  { group: 'exposure_blur', name: '分裂焦点', text: '分裂焦点，前景与远景同时合焦，中间层虚化，形成远近共存的双焦平面。' },
  { group: 'exposure_blur', name: '失焦', text: '完全失焦，画面无任何清晰边缘，全部化为模糊色块，仅靠色彩与明暗关系辨识。' },
  // ── 运镜（camera_movement，17 条）
  { group: 'camera_movement', name: '固定机位', text: '固定机位，相机全程静止不动，构图不变，仅主体与环境自身发生变化。' },
  { group: 'camera_movement', name: '跟拍', text: '跟拍，相机保持在主体后方或侧方与主体同速移动，主体在画面中的位置相对稳定。' },
  { group: 'camera_movement', name: '环绕', text: '环绕运镜，相机以主体为圆心做平滑弧线运动，机位与主体的距离全程保持不变。' },
  { group: 'camera_movement', name: '变焦拉近', text: '推镜，相机匀速向前推进，取景范围由大变小，主体在画面中逐渐放大。' },
  { group: 'camera_movement', name: '变焦拉远', text: '拉镜，相机匀速向后退出，取景范围由小变大，逐步展开环境全貌。' },
  { group: 'camera_movement', name: '镜头左摇', text: '左摇，机位固定，镜头绕垂直轴向左平缓转动，画面内容自右向左推移。' },
  { group: 'camera_movement', name: '镜头右摇', text: '右摇，机位固定，镜头绕垂直轴向右平缓转动，画面内容自左向右推移。' },
  { group: 'camera_movement', name: '镜头上仰', text: '上摇，机位固定，镜头绕水平轴向上转动，视点由低处抬向高处。' },
  { group: 'camera_movement', name: '镜头下俯', text: '下摇，机位固定，镜头绕水平轴向下转动，视点由高处落向低处。' },
  { group: 'camera_movement', name: '前移', text: '前移，相机整体沿光轴向前平移靠近主体，透视关系随距离改变。' },
  { group: 'camera_movement', name: '后移', text: '后移，相机整体沿光轴向后平移远离主体，透视关系随距离改变。' },
  { group: 'camera_movement', name: '左移', text: '左移，相机整体水平向左平移，机位不旋转，主体相对画面向右偏移。' },
  { group: 'camera_movement', name: '右移', text: '右移，相机整体水平向右平移，机位不旋转，主体相对画面向左偏移。' },
  { group: 'camera_movement', name: '摆臂上升', text: '摇臂上升，相机由低机位平滑升起并转为俯视，视点自地面抬升至高处。' },
  { group: 'camera_movement', name: '摆臂下降', text: '摇臂下降，相机由高机位平滑降落并转为仰视，视点自高处沉向地面。' },
  { group: 'camera_movement', name: '无人机航拍', text: '航拍运镜，相机在高空大范围移动，兼具升降与横移，展现宏观空间关系。' },
  { group: 'camera_movement', name: '360度环绕', text: '三百六十度旋转，相机绕光轴自转一周，地平线完整翻转后回正，机位与朝向不变。' },
  // ── 摄法/特殊技法（shooting_technique，13 条）
  { group: 'shooting_technique', name: '希区柯克变焦', text: '希区柯克变焦，相机后退的同时镜头推近，主体大小不变而背景透视被剧烈压缩，产生眩晕感。' },
  { group: 'shooting_technique', name: '延时摄影', text: '延时摄影，长时间流逝被压缩播放，缓慢变化被加速，主体保持相对静止。' },
  { group: 'shooting_technique', name: '子弹时间', text: '子弹时间，相机绕主体高速环绕而主体动作被极度放慢，形成时间凝滞的环视效果。' },
  { group: 'shooting_technique', name: '极速甩镜', text: '甩镜，相机以极快速度横向或纵向摆动，画面拉出强烈动态模糊，用于场景切换。' },
  { group: 'shooting_technique', name: '变形宽银幕', text: '变形宽银幕，散景光斑被水平拉长成椭圆，逆光下出现水平方向的蓝色眩光条纹。' },
  { group: 'shooting_technique', name: '急推镜头', text: '急推，相机在极短时间内快速向前推进，取景由大到小，冲击感强烈。' },
  { group: 'shooting_technique', name: '急拉镜头', text: '急拉，相机在极短时间内快速向后拉远，取景由小到大，形成抽离感。' },
  { group: 'shooting_technique', name: '第一人称', text: '第一人称视点，自主体自身视线高度拍摄，肢体或持物自画面下缘入画。' },
  { group: 'shooting_technique', name: '探针镜头', text: '探针镜头，超微距广角贴地穿行，在狭小空间内连续穿越，透视夸张纵深极强。' },
  { group: 'shooting_technique', name: '旋转倾斜镜头', text: '旋转倾斜，相机绕光轴缓慢滚转，地平线由水平摇摆至倾斜再回正。' },
  { group: 'shooting_technique', name: 'FPV 穿梭', text: 'FPV穿越，相机高速连续穿行并伴随翻滚俯冲，一镜到底，空间关系急速变化。' },
  { group: 'shooting_technique', name: '微距特写', text: '微距推轨，相机贴近微小对象并向前推进，焦点由主体转移到近处细节。' },
  { group: 'shooting_technique', name: '慢镜头', text: '慢镜头，高帧率拍摄后放慢播放，动作细节被延展，运动轨迹清晰可辨。' },
  // ── 画质保底（quality_base，3 条）
  { group: 'quality_base', name: '通用极高画质', text: '高清，画面精致，极致细节，大师级构图，杰作' },
  { group: 'quality_base', name: '3D/渲染引擎画质', text: '3D渲染，虚幻引擎渲染，光线追踪，全局光照，极致光影，超精细建模' },
  { group: 'quality_base', name: '电影级光影保底', text: '电影感光影，戏剧性布光，体积光，宏大构图，超高清' },
  // ── 负向词保底（negative_base，2 条）
  { group: 'negative_base', name: '通用防崩坏负面词', text: '低质量，模糊，低分辨率，噪点杂乱，水印，文字，签名，logo，构图残缺，主体畸形' },
  { group: 'negative_base', name: '人体防崩坏负面词', text: '人体结构错误，比例失调，手部畸形，手指缺失，手指多余，肢体多余，关节反折，五官崩坏，脸部扭曲' },
];

/** 依分组取词条（UI 选词用；空/未知分组回空阵列，不抛）。 */
export function lensEntriesByGroup(group: string): readonly LensLanguageEntry[] {
  return LENS_LANGUAGE_LIBRARY.filter((e) => e.group === group);
}

/** 依名称精确取单条（agent 选词后取原文注入）。同名以首见为准。 */
export function lensEntryByName(name: string): LensLanguageEntry | undefined {
  return LENS_LANGUAGE_LIBRARY.find((e) => e.name === name);
}

/**
 * 把命中词条的原文拼成 prompt 片段（注入用）。
 * 未命中一律略过（不编造、不猜同义词）；`limit` 防注入爆炸，预设 6 条。
 */
export function composeLensFragment(names: readonly string[], limit = 6): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (out.length >= limit) break;
    if (seen.has(n)) continue;
    const hit = lensEntryByName(n);
    if (!hit) continue;
    seen.add(n);
    out.push(hit.text);
  }
  return out.join("；");
}
