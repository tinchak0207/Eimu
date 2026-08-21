import type { UseCase } from "./use-cases";

const AUTHOR = {
  name: "Eimu 创作者工作台",
  jobTitle: "AI 图片与视频创作平台",
  url: "https://eimu.dev",
};

export const REDDIT_EDITING_USE_CASES: UseCase[] = [
  {
    slug: "reddit-edit-remove-reflections-defects",
    keyword: "AI 图片去反射与缺陷修复",
    title: "照片里的反光和镜头缺陷怎么去：先做小范围、低改动修复",
    tagline: "尽量保留原图，只清理影响主体的瑕疵",
    heroDescription: "珠宝、夜景和风景照片里的反射、光斑或滤镜环纹，往往只占画面一小部分，却会破坏主体。这个编辑流程先识别缺陷与周围纹理，再限制修改范围，优先保留原来的构图、材质和光线关系。",
    painPoints: [
      "反射可能覆盖珠宝表面、车灯周围或玻璃后的细节，简单降低高光会连主体一起变暗。",
      "镜头反光和光斑通常形状、亮度与背景不同，整张图重做会引入更多不必要变化。",
      "滤镜造成的环纹或其他拍摄缺陷不一定能靠一个通用修复词稳定消除。",
    ],
    statInsight: "Reddit 讨论提供了明确的定性需求：用户询问如何去掉珠宝摄影中的物体反射、夜景照片中的车灯反射，以及滤镜造成的 Newton Rings。帖子记录的是具体问题和求助，不证明某个模型或编辑方法一定能无损修复所有反射与镜头缺陷。",
    citation: { label: "Reddit 讨论：How can I remove the reflection in this photo?", url: "https://www.reddit.com/r/photoshop/comments/1615cmy/how_can_i_remove_the_reflection_in_this_photo/" },
    promptExamples: [
      { title: "清理珠宝表面反射", prompt: "只编辑首饰表面被标记的强反射区域，尽量恢复连续的金属与宝石纹理；保持首饰轮廓、材质颜色、阴影、背景和相机视角不变，做最小改动。" },
      { title: "减少夜景镜头光斑", prompt: "只降低画面上方由车灯造成的明显镜头反光和光斑，不改变道路、建筑、天空、车灯本体或整体曝光；保持真实夜景光线和原始构图。" },
    ],
    faqs: [
      { question: "去反射是不是把高光全部压暗？", answer: "不应该。高光可能是主体材质的一部分，先限定反射区域并保留自然高光，再比较编辑前后的材质、轮廓和阴影。" },
      { question: "一张照片里的反光能保证完全消失吗？", answer: "不能。反射若遮住了原始细节，模型无法可靠地恢复真实信息；复杂玻璃、金属、多重反射和强光斑都需要人工检查。" },
      { question: "应该整张重生成还是局部修改？", answer: "如果构图和主体已经可用，优先局部修改缺陷区域并保留原图。整张重生成会同时改变本来正确的材质、光线和背景。" },
    ],
    author: AUTHOR,
    relatedSlugs: ["reddit-upscale-preserve-details", "reddit-background-swap-keep-person", "reddit-control-specific-ai-image"],
    searchVariants: ["AI 去除照片反光", "图片镜头光斑缺陷修复", "remove reflection and lens flare from photo AI"],
    workflowSteps: [
      "保留原始照片，标出需要清理的反射、光斑或环纹，并确认主体哪些细节不能改变。",
      "先只描述缺陷区域与周围应延续的纹理，避免同时改变构图、颜色和光线。",
      "比较局部编辑结果与原图，检查材质连续性、边缘、阴影和未选区域是否漂移。",
      "若缺陷仍在，缩小范围分轮处理；保留每轮结果，必要时回到变化更少的版本。",
    ],
    fitBoundary: "适合清理照片中局部、可辨认的反射、光斑与拍摄瑕疵，同时尽量保留主体和构图；不适合承诺恢复被强反射完全遮住的真实细节，也不适合法证、医学或要求像素级真实性的用途。",
    redditEvidence: [
      { title: "How can I remove the reflection in this photo?", quote: "发帖者为珠宝品牌拍摄，询问如何处理反光物体上的环境与灯光反射，说明反射会直接影响商品表面细节。", url: "https://www.reddit.com/r/photoshop/comments/1615cmy/how_can_i_remove_the_reflection_in_this_photo/", score: 36, comments: 59 },
      { title: "Annoying lens reflection", quote: "发帖者说车灯在照片空气中形成的反射平时还能接受，但这张照片中的反射让其无法接受，求助于后期处理。", url: "https://www.reddit.com/r/postprocessing/comments/16vy59j/annoying_lens_reflection/", score: 26, comments: 17 },
      { title: "Newton Rings on northern lights photos", quote: "发帖者怀疑 UV 滤镜导致北极光照片出现 Newton Rings，并询问是否能在后期移除，属于拍摄缺陷修复需求。", url: "https://www.reddit.com/r/postprocessing/comments/16upvh2/i_think_i_have_newton_rings_on_these_northern/", score: 14, comments: 10 },
    ],
  },
  {
    slug: "reddit-edit-transfer-texture-film-surface",
    keyword: "AI 图片迁移纹理颗粒胶片表面",
    title: "想复刻颗粒、胶片或绘画表面：只迁移质感，不重画内容",
    tagline: "把表面语言拆出来，控制强度再叠回原图",
    heroDescription: "用户常常不是要换掉照片内容，而是想接近另一张图的颗粒、褪色边缘、墨水渗化或绘画笔触。这个工作流把主体、颜色与表面质感分开描述，先确认纹理方向，再逐步调整强度，避免效果盖住原本的细节。",
    painPoints: [
      "只说‘复古’或‘像油画’过于宽泛，模型可能同时改变主体、构图和颜色。",
      "颗粒、墨水渗化和笔触的尺度不同，强度过高会让照片失去清晰度。",
      "参考风格和原始内容混在一起时，很难判断到底是表面不对还是画面被重画了。",
    ],
    statInsight: "Reddit 帖子直接记录了用户希望得到 ink bleed、grainy、vintage 视觉效果、近似绘画的后期效果，以及在 Photoshop 中制作笔触的疑问。这些是风格编辑的定性样本；它们没有证明某个模型能精确复制任意艺术家的独特风格，也不构成效果保证。",
    citation: { label: "Reddit 讨论：ink bleed/grainy/vintage look", url: "https://www.reddit.com/r/graphic_design/comments/1exr29d/can_anybody_help_me_achieve_this_ink/" },
    promptExamples: [
      { title: "低强度胶片颗粒", prompt: "保持原照片的主体、构图、肤色和细节不变，只加入细腻、均匀、低强度的 35mm 胶片颗粒与轻微褪色边缘；不要添加划痕，不要改变物体形状。" },
      { title: "迁移绘画表面", prompt: "保留参考照片中的人物位置、轮廓和主要颜色，只叠加可见但克制的干刷笔触与纸张纤维表面；效果像手工绘画印刷，不改变人物身份或背景结构。" },
    ],
    faqs: [
      { question: "怎么避免加了颗粒后照片变糊？", answer: "先要求细腻、低强度、保留原始细节，并从较弱效果开始比较。颗粒大小和不透明度应结合输出尺寸检查，不能只看缩略图。" },
      { question: "‘胶片感’和‘绘画感’应该一起写吗？", answer: "最好先选一个主要表面目标。胶片颗粒、褪色和纸张笔触是不同视觉约束，分轮加入更容易判断哪一步改变了结果。" },
      { question: "可以精确复制某位艺术家的风格吗？", answer: "不能这样承诺。可以描述可观察的媒介、颗粒、笔触、色彩和纸张属性，但结果仍会受参考图、模型和强度影响，也应尊重相关作品与创作者。" },
    ],
    author: AUTHOR,
    relatedSlugs: ["reddit-reference-photo-to-style", "reddit-control-specific-ai-image", "reddit-compare-ai-image-models"],
    searchVariants: ["AI 复刻照片胶片颗粒质感", "图片转绘画笔触表面效果", "transfer film grain painting texture to photo AI"],
    workflowSteps: [
      "选定要保留的主体、构图和颜色，先把表面效果拆成颗粒、褪色、墨水渗化或笔触等可观察属性。",
      "上传原图或参考图，只描述目标表面质感，不同时改变人物、物体位置和镜头。",
      "从低强度版本开始，对比纹理尺度、清晰度、边缘和颜色是否仍符合原图。",
      "确认方向后一次只增加一种表面属性，并保存每轮结果以便回退或比较。",
    ],
    fitBoundary: "适合为照片、海报和插画增加可描述的颗粒、胶片、纸张、墨水或绘画表面效果；不适合承诺逐像素复制某件艺术作品，也不适合用模糊的风格词替代明确的内容与版权判断。",
    redditEvidence: [
      { title: "How do I achieve this look in Photoshop? Advice on textures", quote: "发帖者询问在 Photoshop 中通过纹理和技术实现示例效果，表明其目标是复现表面处理而非单纯重新构图。", url: "https://www.reddit.com/r/photoshop/comments/15zfcwp/how_do_i_achieve_this_look_in_photoshop_advice_on/", score: 13, comments: 6 },
      { title: "Why does digital grain not look good?", quote: "发帖者观察到，刻意加入颗粒的数字图像很多时候在审美上并不讨喜，并围绕数字颗粒为何效果不好提出疑问，直接对应颗粒质感编辑的取舍。", url: "https://www.reddit.com/r/postprocessing/comments/17f8a9i/why_does_digital_grain_not_look_good/", score: 7, comments: 10 },
      { title: "Ink bleed/grainy/vintage look in Photopea", quote: "发帖者希望在 Photopea 中实现 ink bleed、grainy、vintage 外观，并询问这种设计效果的名称和做法。", url: "https://www.reddit.com/r/graphic_design/comments/1exr29d/can_anybody_help_me_achieve_this_ink/", score: 38, comments: 67 },
    ],
  },
  {
    slug: "reddit-edit-compare-recompose-crops",
    keyword: "AI 图片裁剪方案比较与重构",
    title: "一张图到底怎么裁：先并排比较裁剪，再重构成目标比例",
    tagline: "保留主体关系，比较不同画幅后再定稿",
    heroDescription: "同一张照片可能同时适合横幅、方图和竖版封面，但裁得太近会损失呼吸空间，裁得太远又会削弱主体。先围绕主体位置、视线方向和留白做几种候选裁剪，再选择一个方案进行局部重构，比直接让模型重画整张图更容易保留原始内容。",
    painPoints: [
      "不同平台比例会迫使用户在主体、环境和留白之间取舍，单一裁剪很难兼顾所有用途。",
      "只看原图或只看一个裁剪版本，难以判断主体是否太挤、视线是否撞边。",
      "裁剪后缺少边缘内容时，整图重生成可能改变已经满意的主体和光线。",
    ],
    statInsight: "Reddit 的两条 postprocessing 讨论都以“Which crop should I go with?”为标题，分别寻求多个裁剪方案之间的选择，并询问是否应该继续裁近。证据支持“先比较裁剪取舍”的需求，但没有提供通用构图规则，也不证明任何自动重构一定比手动裁剪更好。",
    citation: { label: "Reddit 讨论：Which crop should I go with. Or should I crop in further?", url: "https://www.reddit.com/r/postprocessing/comments/16ewz46/which_crop_should_i_go_with_or_should_i_crop_in/" },
    promptExamples: [
      { title: "同图三种裁剪方案", prompt: "基于这张现有照片给出三个不改变主体的构图候选：原始横幅、4:5 竖版和 1:1 方图；分别保留主体视线方向的留白，标出主体位置，不添加新物体。" },
      { title: "重构竖版边缘", prompt: "将现有横向照片重构为 4:5 竖版，保持人物脸部、服装、姿势、原有背景和光线不变，只在裁切后缺失的边缘延续相邻环境纹理；不要把主体放大到贴边。" },
    ],
    faqs: [
      { question: "怎么判断应该裁近还是保留环境？", answer: "先看主体是否需要更强注意力、视线和动作是否有前进空间，以及目标平台的画幅。并排比较候选版本后再决定，不要只凭原图印象。" },
      { question: "不同平台需要重新生成一张图吗？", answer: "不一定。先从原图制作不同裁剪候选；只有目标比例确实缺少边缘内容时，再尝试在保持主体的前提下做有限重构。" },
      { question: "AI 重构裁剪外的区域会改变原图吗？", answer: "可能会。生成式重构不是像素级延展，边缘纹理、物体形状和光线可能出现变化，因此应保留原图并逐项检查接缝与主体。" },
    ],
    author: AUTHOR,
    relatedSlugs: ["reddit-compare-ai-image-models", "reddit-control-specific-ai-image", "reddit-upscale-preserve-details"],
    searchVariants: ["AI 图片裁剪比例比较", "照片裁剪构图方案选择", "compare crop options recompose existing image AI"],
    workflowSteps: [
      "明确图片用途和目标比例，保留原图并列出主体、视线、动作方向和必要留白。",
      "围绕同一原图制作横幅、方图和竖版等候选裁剪，先比较主体权重与边缘呼吸感。",
      "选择最符合用途的裁剪；若边缘内容不足，再只对裁剪外区域做有限重构。",
      "放大检查主体脸部、物体轮廓、接缝和光线，保存原图、候选裁剪与最终版本。",
    ],
    fitBoundary: "适合为社交封面、商品宣传、文章配图和短视频封面比较常见画幅，并对缺失边缘做有限重构；不适合要求精确恢复画外真实场景、法证级真实性或把自动裁剪结果当作唯一构图判断。",
    redditEvidence: [
      { title: "Which crop should I go with. Or should I crop in further?", quote: "发帖者在 postprocessing 社区直接比较裁剪方案，并询问是否应该进一步裁近，体现了主体与画面范围之间的取舍需求。", url: "https://www.reddit.com/r/postprocessing/comments/16ewz46/which_crop_should_i_go_with_or_should_i_crop_in/", score: 52, comments: 33 },
      { title: "Which crop should I go with?", quote: "另一条 postprocessing 帖子同样以选择裁剪版本为问题，说明现有图片的画幅选择本身就是后期决策。", url: "https://www.reddit.com/r/postprocessing/comments/1740rer/which_crop_should_i_go_with/", score: 37, comments: 43 },
      { title: "How can I improve my edit of this sunrise shot?", quote: "该讨论提供了带 RAW 的日出照片后期改进场景，支持在保留既有照片基础上逐步比较与调整，而非把任务限定为从零生成。", url: "https://www.reddit.com/r/postprocessing/comments/17ftu2k/how_can_i_improve_my_edit_of_this_sunrise_shot/", score: 23, comments: 4 },
    ],
  },
];
