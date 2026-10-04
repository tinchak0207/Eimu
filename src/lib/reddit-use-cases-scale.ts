import type { RedditEvidence, UseCase } from "./use-cases";

const AUTHOR = {
  name: "Eimu 创作者工作台",
  jobTitle: "AI 图片与视频创作平台",
  url: "https://eimu.dev",
};

type ScalePage = {
  slug: string;
  keyword: string;
  title: string;
  tagline: string;
  description: string;
  variants: string[];
  steps: string[];
  boundary: string;
  prompts: [string, string];
  evidence: [RedditEvidence, RedditEvidence];
  related: string[];
  /** 所属行业枢纽 slug（/use-cases/<category>）。 */
  category: string;
};

function page(input: ScalePage): UseCase {
  return {
    slug: input.slug,
    keyword: input.keyword,
    title: input.title,
    tagline: input.tagline,
    heroDescription: input.description,
    painPoints: [
      `现有工具经常不能稳定完成“${input.keyword}”所需的局部约束。`,
      "一次改变太多变量后，很难判断哪一步破坏了原本可用的结果。",
      "缺少可回退的版本与明确验收项，会让多轮生成变成重复试错。",
    ],
    statInsight: "以下 Reddit 帖子是公开社区中的定性需求证据，用来说明用户如何描述任务与失败边界；它们不是搜索量、市场规模或成功率统计。",
    citation: { label: `Reddit 讨论：${input.evidence[0].title}`, url: input.evidence[0].url },
    promptExamples: [
      { title: "保守版本", prompt: input.prompts[0] },
      { title: "变化版本", prompt: input.prompts[1] },
    ],
    faqs: [
      { question: `${input.keyword}应该从哪一步开始？`, answer: "先保留原图或基准版本，只改变一个明确变量，并把必须保留的主体、结构、颜色或身份特征写进提示词。" },
      { question: "一次生成就能直接交付吗？", answer: "不建议这样承诺。应并排检查主体、边缘、文字、比例和参考特征，再对问题区域继续编辑。" },
      { question: "Image Studio 能保证结果完全一致吗？", answer: "不能。参考图、工作流恢复和支持模型的编辑可以减少漂移，但交付前仍需要人工检查。" },
    ],
    author: AUTHOR,
    relatedSlugs: input.related,
    categorySlug: input.category,
    searchVariants: input.variants,
    workflowSteps: input.steps,
    fitBoundary: input.boundary,
    redditEvidence: input.evidence,
  };
}

export const REDDIT_SCALE_USE_CASES: UseCase[] = [
  page({
    slug: "reddit-move-resize-object-only",
    category: "photography",
    keyword: "AI 移动物体不改变其他区域",
    title: "只移动或缩放图片里的一个物体，不重画整张图",
    tagline: "固定背景、光线和主体，只改目标物体的位置",
    description: "已有图片接近完成时，重新生成整图会破坏原本满意的部分。先标明目标物体、原位置和新位置，再要求保持其余区域不变，可以把任务收窄成可检查的局部编辑。",
    variants: ["图片移动物体位置 AI", "AI reposition object without changing image", "局部移动商品不换背景"],
    steps: ["保留原图并标出要移动的物体。", "描述新位置、尺寸和遮挡关系。", "锁定背景、光线、镜头与其他主体。", "对比边缘、接触阴影和原图差异。"],
    boundary: "适合边界清楚、遮挡较少的单个物体调整；复杂反射、透明材质、严重遮挡和大幅透视变化可能需要后期修图，不能承诺其余像素完全不变。",
    prompts: ["保持整张图不变，只把桌上的玻璃瓶向右移动约一个瓶身宽度，保留大小、标签、光线和接触阴影。", "保持人物和房间不变，把左侧台灯缩小 15% 并移到书架右端，补全自然阴影。"],
    evidence: [
      { title: "Move or resize one object without affecting the rest", quote: "发帖者希望移动或缩放瓶子等单个物体，同时不影响图片其余部分。", url: "https://www.reddit.com/r/comfyui/comments/1f49c8d/hello_this_image_was_made_with_flux_devrealism/", score: 14, comments: 31 },
      { title: "Is there a workflow to replace a head or an entire body", quote: "发帖者寻找只替换指定主体部分的工作流，反映了限定修改范围的需求。", url: "https://www.reddit.com/r/comfyui/comments/1f6ipd6/is_there_any_workflow_to_replace_a_head_or_an/", score: 22, comments: 25 },
    ],
    related: ["reddit-control-specific-ai-image", "reddit-edit-remove-reflections-defects", "reddit-upscale-preserve-details"],
  }),
  page({
    slug: "reddit-edit-one-face-in-group-photo",
    category: "photography",
    keyword: "AI 只修改合照中的一张脸",
    title: "合照里只修一个人的脸，避免其他人物一起变化",
    tagline: "先选中目标人物，再锁定其他人的身份与位置",
    description: "多人合照中自动修脸容易误改戴眼镜的人、侧脸或旁边人物。把目标人物的位置、可见特征和编辑范围写清楚，再逐人验收，可以减少整组人物被一起重绘。",
    variants: ["合照单人修脸 AI", "edit one selected face in group photo", "多人照片只换一个人脸"],
    steps: ["标出要修复的人物及其画面位置。", "锁定其他人物的脸、发型、姿势和服装。", "只描述目标面部需要修复的细节。", "逐人比较编辑前后身份与边缘。"],
    boundary: "适合人物位置清楚、脸部尺寸足够的普通合照修复；不用于身份验证或法证用途，严重遮挡、极端侧脸和低分辨率会显著增加误改其他人物的风险。",
    prompts: ["只修复后排右侧戴眼镜人物的闭眼问题，保持其余四个人的脸、表情、姿势和背景完全不重绘。", "只自然细化左侧人物的眼睛与嘴部，保留侧脸角度；不要修改中间和右侧人物。"],
    evidence: [
      { title: "Use FaceDetailer only on a specifically chosen face", quote: "发帖者询问如何只选择并编辑一张指定面孔，而不是自动处理所有面孔。", url: "https://www.reddit.com/r/comfyui/comments/1f73emz/how_to_use_facedetailer_but_only_to_inpaintedit_a/", score: 7, comments: 3 },
      { title: "FaceDetailer masking eyes for people wearing glasses", quote: "发帖者遇到面部细化遮掉眼镜人物眼睛的问题，说明多人或配饰场景需要明确选择范围。", url: "https://www.reddit.com/r/comfyui/comments/1f58rye/facedetailer_masking_out_eyes_for_people_wearing/", score: 5, comments: 3 },
    ],
    related: ["reddit-repair-sideways-face", "reddit-multiple-characters-no-mixing", "reddit-background-swap-keep-person"],
  }),
  page({
    slug: "reddit-generate-inpaint-detail-workflow",
    category: "design",
    keyword: "AI 生成后局部修复再细化工作流",
    title: "先生成构图，再局部修复，最后细化高风险区域",
    tagline: "把整图生成、问题修复和细节增强拆成三步",
    description: "把所有要求塞进一次生成会让构图和细节互相牵制。先得到可用整体，再只修手、脸、文字或边缘，最后做有限细化，更容易保留已经满意的区域。",
    variants: ["AI 生成局部重绘细化流程", "generate inpaint detail workflow", "生图后修手修脸工作流"],
    steps: ["先生成并选定整体构图。", "列出需要局部修复的区域。", "逐区编辑并锁定其余画面。", "最后放大检查高风险细节并保存版本。"],
    boundary: "适合整体构图已经可用、问题集中在少数区域的图片；若主体、透视或光线从根本上错误，应回到生成阶段，局部修复不能保证挽救所有结构问题。",
    prompts: ["保持整体构图，只修复人物右手的手指数和关节，保持袖口、姿势、背景和光线。", "保持产品与场景不变，只清理包装边缘和接触阴影，最后轻度增强材质细节。"],
    evidence: [
      { title: "Generate, inpaint, detailing in the same workflow", quote: "发帖者直接询问如何把生成、局部修补和细化串到同一工作流。", url: "https://www.reddit.com/r/comfyui/comments/1f4b4le/how_to_do_generate_inpaint_detailing_in_the_same/", score: 2, comments: 8 },
      { title: "Inpaint as beautiful as Fooocus", quote: "发帖者比较不同局部修补结果，说明生成后的局部质量修复是独立痛点。", url: "https://www.reddit.com/r/comfyui/comments/1f7xo5m/inpaint_as_beautiful_as_fooocus/", score: 4, comments: 15 },
    ],
    related: ["reddit-control-specific-ai-image", "reddit-upscale-preserve-details", "reddit-edit-remove-reflections-defects"],
  }),
  page({
    slug: "reddit-clean-background-segmentation-edges",
    category: "ecommerce",
    keyword: "AI 抠图与换背景边缘自然",
    title: "AI 抠图或换背景后边缘发硬：先检查头发、透明物和光线",
    tagline: "让主体边缘、环境光和新背景真正融合",
    description: "换背景失败常出现在头发、玻璃、毛绒和半透明边缘。先检查分割范围，再补齐环境光、颜色溢出和接触阴影，能减少明显的剪贴感。",
    variants: ["AI 换背景边缘融合", "improve image segmentation edges AI", "抠图头发边缘自然"],
    steps: ["检查主体边缘和半透明区域。", "确认新背景的光线与色温。", "针对头发、玻璃和阴影做局部融合。", "在明暗两种底色上检查残边。"],
    boundary: "适合主体轮廓可辨认的一般抠图与背景融合；运动模糊、透明薄纱、复杂毛发和与背景同色的边缘可能仍需专业蒙版工具，不保证自动得到像素级干净边缘。",
    prompts: ["保留人物和发型，在浅灰背景上重建自然发丝边缘，匹配左上方柔光，不要出现白边。", "替换产品背景为深色棚拍，保留透明瓶身边缘与折射，补充可信接触阴影。"],
    evidence: [
      { title: "How to improve image segmentation?", quote: "发帖者直接询问如何改善图像分割质量，体现主体边缘处理需求。", url: "https://www.reddit.com/r/comfyui/comments/1exbso8/how_to_improve_image_segmentation/", score: 2, comments: 4 },
      { title: "YOLOv8 segmentation mask not working for inpainting", quote: "发帖者描述分割遮罩用于局部修补时失效，说明边缘与遮罩质量会影响编辑。", url: "https://www.reddit.com/r/comfyui/comments/1f3md8j/why_is_yolov8_seg_mask_not_working_for_inpainting/", score: 2, comments: 3 },
    ],
    related: ["reddit-background-swap-keep-person", "reddit-edit-remove-reflections-defects", "reddit-control-specific-ai-image"],
  }),
  page({
    slug: "reddit-multiple-lora-style-conflicts",
    category: "anime",
    keyword: "AI 多 LoRA 风格冲突对比",
    title: "多个 LoRA 一起用效果打架：固定基准图再逐个调整权重",
    tagline: "先测试单个效果，再组合，不把冲突留到最后",
    description: "多个 LoRA 或风格资源同时启用时，人物、服装和画风可能互相覆盖。固定 seed、prompt 和尺寸，先逐个测试，再组合权重，可以更快判断冲突来自哪一个资源。",
    variants: ["多个 LoRA 效果冲突", "compare multiple LoRA same seed", "多 LoRA 权重怎么调"],
    steps: ["固定 prompt、尺寸和基准结果。", "逐个启用资源记录单独效果。", "两两组合并只调整一个权重。", "保存可复现的最终组合与边界。"],
    boundary: "适合平台已提供并允许组合的 LoRA 或风格资源对比；不提供本地文件安装、训练、节点兼容、GGUF/NF4 或显存排障，也不保证任意模型和任意 LoRA 可以组合。",
    prompts: ["固定同一人物、seed、构图和尺寸，分别测试写实光影 LoRA 与服装 LoRA，记录单独结果。", "在基准结果上组合两个已验证资源，只降低风格资源权重，保持人物脸型和服装结构。"],
    evidence: [
      { title: "Can I successfully use multiple Lora with Flux?", quote: "发帖者询问多个 LoRA 能否共同使用，体现组合效果与兼容性的实际需求。", url: "https://www.reddit.com/r/comfyui/comments/1eut164/can_i_successfully_use_multiple_lora_with_flux/", score: 7, comments: 5 },
      { title: "Test multiple loras with the same seeds", quote: "发帖者希望在相同 seed 下测试多个 LoRA，以便进行可比的效果判断。", url: "https://www.reddit.com/r/comfyui/comments/1euq1h3/does_anyone_have_a_flux_workflow_to_test_multiple/", score: 3, comments: 4 },
    ],
    related: ["reddit-compare-ai-image-models", "reddit-simple-image-workflow-recall", "reddit-reference-photo-to-style"],
  }),
  page({
    slug: "reddit-product-color-material-variants",
    category: "ecommerce",
    keyword: "AI 商品颜色与材质变体图",
    title: "同一商品快速比较配色和材质，不重新设计产品结构",
    tagline: "固定几何、标签和机位，只改变指定表面变量",
    description: "商品上新和打样前经常需要比较颜色、涂层或材质方向。上传真实商品作为结构锚点，限定修改区域并并排生成变体，可以减少重复拍摄与不可比较的构图变化。",
    variants: ["产品图片换颜色 AI", "AI product material variations", "商品换材质保持造型"],
    steps: ["上传结构清晰的商品参考图。", "标出只允许变化的表面区域。", "锁定轮廓、标签、机位和光线。", "并排检查颜色、反射、接缝和边缘。"],
    boundary: "适合营销概念、SKU 方向和打样前视觉比较；不作为色彩管理、材料工程、生产验收或真实样品证明，复杂透明材质和精确品牌色仍需实物校对。",
    prompts: ["保持耳机结构、标志、按钮和机位不变，只把外壳从黑色改为哑光深绿色，保留真实接缝和反射。", "固定同一手袋轮廓与五金，把表面从光面皮革改为细纹帆布，保持背景和阴影。"],
    evidence: [
      { title: "How do I sell customized items", quote: "发帖者讨论定制商品销售，反映同一产品多变体展示的商业需求。", url: "https://www.reddit.com/r/ecommerce/comments/1f363lq/how_do_i_sell_customized_items/", score: 5, comments: 5 },
      { title: "DTF vs DTG colors question", quote: "发帖者比较不同印刷方式的颜色表现，说明材质和颜色预览需要明确边界。", url: "https://www.reddit.com/r/printondemand/comments/16jnfmm/dtf_vs_dtg_colors_question/", score: 5, comments: 4 },
    ],
    related: ["reddit-product-multi-reference-composite", "reddit-marketplace-thumbnail-small-size", "reddit-reference-photo-to-style"],
  }),
  page({
    slug: "reddit-product-multi-reference-composite",
    category: "ecommerce",
    keyword: "AI 多参考图合成商品场景",
    title: "把商品、背景和道具参考图合成一张自然商业图",
    tagline: "统一比例、透视、光线和接触阴影",
    description: "多图合成最容易暴露剪贴边缘、比例错误和光线不一致。为每张参考图指定角色，再统一镜头、遮挡和接触阴影，可以让结果更像同一次拍摄。",
    variants: ["商品背景道具多图融合", "combine product and scene references AI", "AI 多图合成商业摄影"],
    steps: ["分别上传商品、场景和道具参考。", "声明每张图在最终画面中的角色。", "统一镜头、比例、光线和遮挡。", "检查商品结构、边缘与接触阴影。"],
    boundary: "适合营销概念和一般商品场景合成；不保证包装小字、商标、透明反射或产品几何完全不变，法律合规、品牌授权和最终交付仍需人工检查。",
    prompts: ["参考图 1 为商品，图 2 为厨房背景，图 3 为木托盘；保持商品标签和结构，统一晨光与接触阴影。", "把香水瓶、石材台面和花枝三张参考图合成棚拍，匹配透视、焦距和冷暖反射。"],
    evidence: [
      { title: "Move or resize an object without affecting the rest", quote: "发帖者希望在已有画面里控制单个物体位置，体现多素材合成中的局部控制需求。", url: "https://www.reddit.com/r/comfyui/comments/1f49c8d/hello_this_image_was_made_with_flux_devrealism/", score: 14, comments: 31 },
      { title: "Wont blend with mask", quote: "发帖者尝试把生成图和原图通过遮罩融合但无法自然合成，直接反映融合痛点。", url: "https://www.reddit.com/r/comfyui/comments/1f6jvs6/wont_blend_wmask/", score: 2, comments: 8 },
    ],
    related: ["reddit-clean-background-segmentation-edges", "reddit-control-specific-ai-image", "reddit-background-swap-keep-person"],
  }),
  page({
    slug: "reddit-campaign-visual-consistency",
    category: "marketing",
    keyword: "AI 营销活动多图视觉一致",
    title: "一场营销活动的多张素材保持同一视觉方向",
    tagline: "复用色板、构图语言和工作流，而不是每张重新猜",
    description: "跨广告、社媒和网页的活动素材如果每张都从零生成，色板、主体处理和氛围会快速漂移。先建立基准图和可恢复工作流，再改变比例与信息层级，可以形成更连贯的素材系列。",
    variants: ["campaign 视觉一致性 AI", "AI consistent campaign visuals", "营销素材系列统一风格"],
    steps: ["确定一张基准主视觉。", "保存色板、光线、主体处理和构图规则。", "按渠道只改变比例与信息层级。", "并排检查系列一致性并回退漂移版本。"],
    boundary: "适合活动概念和素材系列的视觉统一；不替代品牌规范、商标审核、准确文字排版或投放效果测试，也不保证不同模型输出完全一致。",
    prompts: ["沿用基准主视觉的红黑色板、硬光和产品居中规则，生成 1:1 社媒版本，保留右上角标题区。", "恢复活动工作流，生成 9:16 竖版，保持产品处理和道具语言，只调整留白与构图。"],
    evidence: [
      { title: "Facebook Ads: test multiple creatives at once", quote: "发帖者询问如何高效同时测试多套创意，说明持续生产可比较素材的需求。", url: "https://www.reddit.com/r/ecommerce/comments/1f6hm75/facebook_ads_how_to_efficiently_test_multiple/", score: 4, comments: 4 },
      { title: "Alternatives to adcreative.ai", quote: "发帖者寻找可以规模化生成广告创意的替代工具，体现批量素材生产压力。", url: "https://www.reddit.com/r/FacebookAds/comments/165xgm1/any_alternatives_to_adcreativeai/", score: 3, comments: 23 },
    ],
    related: ["reddit-accurate-text-in-ai-images", "reddit-edit-compare-recompose-crops", "reddit-simple-image-workflow-recall"],
  }),
  page({
    slug: "reddit-marketplace-thumbnail-small-size",
    category: "ecommerce",
    keyword: "电商缩略图小尺寸主体清晰",
    title: "商品图缩小和平台裁切后仍然一眼看清主体",
    tagline: "先检查安全区、主体占比和移动端缩略图",
    description: "详情图在搜索列表里会被缩小和裁切，复杂背景、主体过小或关键部分靠边都会降低可读性。先以缩略图尺寸检查，再生成不同裁切候选，更接近真实展示环境。",
    variants: ["Etsy 商品缩略图裁切", "marketplace thumbnail safe zone", "商品图小尺寸可读性"],
    steps: ["确认平台比例和裁切规则。", "让商品主体进入安全区并提高占比。", "生成方图、横图和竖图候选。", "在移动端缩略尺寸检查辨识度。"],
    boundary: "适合商品搜索卡和店铺列表的构图优化；不保证点击率或转化提升，不替代平台规则检查，文字、价格、徽标和商品准确性仍需人工验收。",
    prompts: ["将商品置于 1:1 安全区中央，占画面约 72%，简化背景，缩小到 160px 时仍能识别轮廓。", "为同一商品生成 4:3 列表缩略图，保留完整顶部和底部，避免平台裁掉把手与包装边缘。"],
    evidence: [
      { title: "Which crop should I go with?", quote: "发帖者并排比较不同裁切方案并征求选择意见，反映裁切决策的实际痛点。", url: "https://www.reddit.com/r/postprocessing/comments/1740rer/which_crop_should_i_go_with/", score: 37, comments: 43 },
      { title: "Which crop should I go with, or crop further?", quote: "发帖者讨论是否继续收紧裁切，说明主体占比和画面边界需要比较。", url: "https://www.reddit.com/r/postprocessing/comments/16ewz46/which_crop_should_i_go_with_or_should_i_crop_in/", score: 52, comments: 33 },
    ],
    related: ["reddit-clean-background-segmentation-edges", "reddit-edit-compare-recompose-crops", "reddit-product-color-material-variants"],
  }),
  page({
    slug: "reddit-sticker-merch-illustration-set",
    category: "design",
    keyword: "AI 贴纸与周边插画套图",
    title: "生成同主题贴纸和周边插画套图，保持系列语言",
    tagline: "固定轮廓、色板和细节密度，再批量扩展主题",
    description: "单张插画好看并不等于能组成套图。先确定统一轮廓、色板、描边和留白规则，再逐个改变主体，可以减少套图中风格和细节密度漂移。",
    variants: ["AI sticker pack generator", "同主题周边插画套图", "贴纸系列统一风格 AI"],
    steps: ["确定套图的色板、描边和轮廓规则。", "制作一张基准插画。", "复用工作流逐个替换主题。", "并排检查尺寸、留白与系列一致性。"],
    boundary: "适合贴纸和周边的概念插画系列；不保证矢量、透明底、刀模、出血、印刷色或版权可直接商用，生产前需完成清稿与知识产权检查。",
    prompts: ["制作六张太空咖啡主题贴纸，统一粗白描边、深蓝紫色板和简洁阴影，每张独立主体。", "沿用基准图的扁平轮廓和三色规则，扩展四个露营道具角色，保持相同细节密度。"],
    evidence: [
      { title: "How do you get art for POD stores?", quote: "发帖者询问 POD 店铺如何获取图稿以及是否会购买，体现持续图案生产需求。", url: "https://www.reddit.com/r/printondemand/comments/16sn6zm/how_do_you_get_art_for_your_pod_stores_would_you/", score: 5, comments: 17 },
      { title: "Improve my first print-on-demand design", quote: "发帖者展示第一张设计并寻求改进建议，说明周边图稿需要迭代与系列化质量控制。", url: "https://www.reddit.com/r/printondemand/comments/16cpap3/i_want_to_start_a_print_on_demand_business_and_i/", score: 5, comments: 13 },
    ],
    related: ["reddit-multiple-lora-style-conflicts", "reddit-campaign-visual-consistency", "reddit-reference-photo-to-style"],
  }),
];
