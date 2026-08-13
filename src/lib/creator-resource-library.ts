export type CreatorResourceModelId = "gpt-image-2" | "gemini-3.1-flash-image";

export interface CreatorResource {
  id: string;
  modelId: CreatorResourceModelId;
  modelLabel: string;
  category: string;
  title: string;
  description: string;
  previewImageUrl?: string;
  useWhen: string;
  prompt: string;
  negativePrompt: string;
  imageSize: string;
  copies: number;
  workflowPreset: "product-shot" | "character-consistency" | "poster-variants" | "style-transfer";
  needsReference?: boolean;
  sourceName: string;
  sourceUrl: string;
  sourceCommit: string;
  license: string;
}

const GPT_IMAGE_2_SOURCE = {
  sourceName: "freestylefly/awesome-gpt-image-2",
  sourceUrl: "https://github.com/freestylefly/awesome-gpt-image-2",
  sourceCommit: "76fcd0e6b3961ef2b041547aac654f1efd1ef270",
  license: "MIT",
} as const;

const FREESTYLE_IMAGE_BASE = "https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/76fcd0e6b3961ef2b041547aac654f1efd1ef270/data/images";

const NANO_BANANA_PRO_SOURCE = {
  sourceName: "ZeroLu/awesome-nanobanana-pro",
  sourceUrl: "https://github.com/ZeroLu/awesome-nanobanana-pro",
  sourceCommit: "d865ef2c415c489e97af56a248fe45f470dffe9f",
  license: "CC BY 4.0 source index",
} as const;

const YOUMIND_SOURCE = {
  sourceName: "YouMind-OpenLab/awesome-gpt-image-2",
  sourceUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
  sourceCommit: "56d75956f727cc49dd45ef4fb397018a38a6e397",
  license: "CC BY 4.0 source index",
} as const;

const PICOTREX_SOURCE = {
  sourceName: "PicoTrex/Awesome-Nano-Banana-images",
  sourceUrl: "https://github.com/PicoTrex/Awesome-Nano-Banana-images",
  sourceCommit: "7d344750a40e9061821d4fdf1ef22bdc3a970ead",
  license: "CC BY 4.0 source index",
} as const;

export const CREATOR_RESOURCES: CreatorResource[] = [
  {
    id: "gpt-ui-system", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "界面", title: "产品界面系统", description: "把功能说明变成可读的真实界面。", useWhen: "App、网站、仪表盘、社媒截图", prompt: "Create a high-fidelity {{platform}} interface for {{product}}. Show {{3-5 key modules}} in a clear hierarchy. Use exact visible copy: {{text}}. Define navigation, primary action, empty or live states, spacing, component system, and realistic device chrome. Keep text readable and layouts production-plausible.", negativePrompt: "unreadable text, placeholder gibberish, duplicated controls, floating random cards", imageSize: "1536x1024", copies: 2, workflowPreset: "poster-variants", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-infographic", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "信息图", title: "知识信息图", description: "把复杂概念压缩成有层级的视觉解释。", previewImageUrl: `${FREESTYLE_IMAGE_BASE}/case334.png`, useWhen: "流程、知识卡、技术解释、时间线", prompt: "Design an editorial infographic explaining {{topic}} for {{audience}}. Use exactly {{3-5}} numbered modules, short labels, a clear reading path, restrained iconography, and one visual metaphor. Keep every label legible, use a defined palette, and leave generous whitespace.", negativePrompt: "long paragraphs, tiny labels, cluttered arrows, decorative charts without meaning", imageSize: "1024x1536", copies: 2, workflowPreset: "poster-variants", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-ecommerce-detail", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "电商", title: "商品详情首屏", description: "商品、卖点和版式同时落地。", previewImageUrl: `${FREESTYLE_IMAGE_BASE}/case373.jpg`, useWhen: "主图、详情页、包装、销售页", prompt: "Create a premium e-commerce hero for {{product}}. Product occupies {{percentage}} of the frame. Show {{material}}, {{key benefit}}, and {{supporting prop}}. Use a controlled {{lighting}} setup, precise contact shadow, a clear headline area with exact text '{{headline}}', and one secondary benefit label.", negativePrompt: "wrong product geometry, random props, unreadable packaging, extra logos, harsh glare", imageSize: "1024x1024", copies: 3, workflowPreset: "product-shot", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-brand-board", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "品牌", title: "品牌识别板", description: "从定位生成一张能讨论的品牌系统板。", previewImageUrl: `${FREESTYLE_IMAGE_BASE}/case354.jpg`, useWhen: "Logo、色板、字体、品牌触点", prompt: "Build a cohesive identity board for {{brand}}. Positioning: {{positioning}}. Include one wordmark direction, palette with {{3}} named colors, typography hierarchy, packaging or app touchpoint, and a compact usage grid. Use exact brand text '{{brand}}' only. Make the board feel internally consistent, not like separate moodboard fragments.", negativePrompt: "misspelled brand name, unrelated logos, mixed visual styles, dense microcopy", imageSize: "1536x1024", copies: 2, workflowPreset: "poster-variants", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-campaign-board", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "品牌", title: "活动触点板", description: "在一个画面内检验整套活动是否一致。", useWhen: "包装、社媒、网页和线下陈列", prompt: "Create a campaign touchpoint board for {{campaign}}. Use one shared visual rule: {{art direction}}. Arrange {{4}} realistic touchpoints including {{touchpoint list}}. Preserve exact campaign title '{{title}}'. Establish a single palette, typography system, product treatment, and visual rhythm across all panels.", negativePrompt: "inconsistent palettes, unrelated subjects, too many mockups, illegible campaign text", imageSize: "1536x1024", copies: 2, workflowPreset: "poster-variants", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-space-concept", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "空间", title: "空间概念图", description: "将材质、动线和光线放到同一张空间图。", previewImageUrl: `${FREESTYLE_IMAGE_BASE}/case331.png`, useWhen: "室内、建筑、城市地图、空间方案", prompt: "Visualize {{space}} for {{use case}} from a {{camera viewpoint}}. Specify scale, circulation, {{materials}}, natural and artificial lighting, and {{three functional zones}}. Compose a plausible space with real construction logic and a quiet editorial finish.", negativePrompt: "impossible perspective, warped furniture, random doors, distorted scale, empty showroom feeling", imageSize: "1536x1024", copies: 2, workflowPreset: "product-shot", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-editorial-photo", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "摄影", title: "纪实人像", description: "用镜头、光线和环境控制真实感。", previewImageUrl: `${FREESTYLE_IMAGE_BASE}/case377.jpg`, useWhen: "肖像、街拍、电影感商业摄影", prompt: "Editorial photograph of {{subject}} in {{location}}. Frame at {{distance}} with a {{lens}} lens. Use {{light source}}, believable skin and fabric texture, {{gesture}}, and a specific moment before or after {{event}}. Color grade: {{reference mood}}. Preserve natural imperfections.", negativePrompt: "plastic skin, extra fingers, staged stock pose, beauty-filter face, artificial bokeh", imageSize: "1024x1536", copies: 2, workflowPreset: "character-consistency", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-illustration-direction", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "插画", title: "插画艺术指导", description: "让风格服务构图，而不是只给一个风格词。", useWhen: "插画、漫画、水彩、材质实验", prompt: "Illustrate {{subject}} in a {{composition}} composition. Art direction: {{visual language}}. Use {{palette}}, {{material or brush texture}}, and {{mood}}. Define foreground, midground, background, and a single focal point. Preserve {{reference element}} if an image is attached.", negativePrompt: "style without composition, muddy palette, duplicate subject, random text, visual noise", imageSize: "1024x1536", copies: 2, workflowPreset: "style-transfer", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-character-sheet", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "角色", title: "角色设定页", description: "固定身份锚点，再展开姿态与服装。", useWhen: "角色三视图、姿态表、IP设定", prompt: "Create a character design sheet for {{character}}. Identity anchors: {{face}}, {{hair}}, {{outfit}}, {{signature prop}}. Show front, side, back, and {{2}} action poses on a clean labeled grid. Keep proportions, facial features, costume details, and color logic consistent across every view.", negativePrompt: "changing face, inconsistent costume, too many poses, unreadable labels, cropped limbs", imageSize: "1536x1024", copies: 2, workflowPreset: "character-consistency", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-collectible", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "角色", title: "收藏级手办", description: "把人物或 IP 转成有材质和包装逻辑的收藏品。", previewImageUrl: `${FREESTYLE_IMAGE_BASE}/case17.jpg`, useWhen: "盲盒、3D角色、展示渲染", prompt: "Turn {{subject}} into a premium {{scale}} collectible figure. Preserve {{identity anchors}}. Specify {{material}}, base design, packaging window, accessory set, and studio display lighting. The result should read as a real manufactured object, with accurate seams, painted details, and plausible packaging.", negativePrompt: "generic toy body, distorted face, incoherent packaging, unreadable box text", imageSize: "1024x1024", copies: 2, workflowPreset: "character-consistency", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-storyboard", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "叙事", title: "分镜叙事页", description: "将人物、冲突和镜头信息转成可拍的分镜。", useWhen: "短片、广告、漫画、世界观", prompt: "Create a {{4}}-frame storyboard for {{story}}. Define who, where, when, conflict, and emotional change. For each frame specify shot size, camera angle, action, and lighting. Keep character identity and wardrobe consistent. Use concise frame labels only.", negativePrompt: "unrelated frames, changing characters, overly dense text, random cinematic effects", imageSize: "1536x1024", copies: 2, workflowPreset: "poster-variants", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "gpt-document-page", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "出版", title: "出版级页面", description: "把内容做成可阅读而非堆砌的版式。", useWhen: "白皮书、手册、报告、百科页", prompt: "Design a publication page about {{topic}} in {{format}}. Use a {{column count}} column grid, one clear headline '{{headline}}', a short standfirst, {{2}} figures with captions, and a restrained footer. Establish typographic hierarchy, consistent margins, and generous reading space.", negativePrompt: "tiny dense text, broken columns, inconsistent type hierarchy, filler paragraphs", imageSize: "1024x1536", copies: 2, workflowPreset: "poster-variants", ...GPT_IMAGE_2_SOURCE,
  },
  {
    id: "nano-virtual-try-on", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "虚拟试穿", description: "保持衣物细节，并把它自然落到人物身上。", useWhen: "上传服装图和人物图", prompt: "Use reference image 1 as the garment and reference image 2 as the model. Dress the model in the garment while preserving the garment's color, texture, logo placement, seams, and drape. Match body pose, ambient light, shadow direction, camera height, and the original model identity. Output a clean full-body {{lookbook style}} image.", negativePrompt: "altered garment logo, changed fabric pattern, broken anatomy, mismatched lighting, extra hands", imageSize: "1024x1536", copies: 2, workflowPreset: "character-consistency", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-product-reshoot", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "商品重拍", description: "从杂乱实拍提取商品并重建为干净商业图。", useWhen: "上传商品实拍图", prompt: "Use the uploaded image as the product source. Preserve the exact product geometry, color, material, label, and logo. Remove hands and background clutter. Re-shoot it on a {{background}} surface with {{lighting}} studio light, a subtle contact shadow, and one {{supporting prop}}. Keep the product visually identical to the source.", negativePrompt: "changed product shape, altered logo, extra packaging, harsh specular glare, floating product", imageSize: "1024x1024", copies: 3, workflowPreset: "product-shot", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-room-furnish", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "空房软装", description: "在不改建筑结构的前提下完成软装提案。", useWhen: "上传空房或平面图", prompt: "Use the uploaded room as the fixed architectural shell. Keep walls, doors, windows, perspective, and daylight direction unchanged. Furnish it for {{resident}} in a {{style}} direction with {{budget level}} materials. Add a coherent furniture plan, textiles, lighting, and storage while maintaining realistic scale and circulation.", negativePrompt: "moved windows, warped walls, impossible furniture scale, changed room proportions, clutter", imageSize: "1536x1024", copies: 2, workflowPreset: "style-transfer", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-wireframe-prototype", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "线框转原型", description: "保留信息架构，把草图升级成一张真实产品界面。", useWhen: "上传手绘或低保真线框", prompt: "Use the uploaded wireframe as the fixed information architecture. Convert it into a high-fidelity {{platform}} screen for {{product}}. Preserve all content zones and action priority. Apply a {{design system}} system, realistic content density, clear states, accessible contrast, and exact visible labels: {{text}}.", negativePrompt: "changed information architecture, decorative gradients, unreadable labels, random cards, fake device controls", imageSize: "1024x1536", copies: 2, workflowPreset: "style-transfer", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-whiteboard-chart", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "白板转流程图", description: "把手写结构变成可放进汇报的清晰图。", useWhen: "上传白板、草图或便签", prompt: "Read the uploaded sketch and recreate its logic as a professional flowchart. Preserve all meaningful nodes and relationships. Use a strict grid, orthogonal connectors, one restrained {{palette}} palette, clear sans-serif labels, and a presentation-ready white background. Ask no new questions inside the graphic; make ambiguous notes concise.", negativePrompt: "lost steps, curved random arrows, illegible handwriting, dense decorations, invented metrics", imageSize: "1536x1024", copies: 2, workflowPreset: "style-transfer", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-outpaint", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "构图扩展", description: "扩展画幅，同时锁住原图主体和环境逻辑。", useWhen: "上传需要扩展比例的图片", prompt: "Extend the uploaded image to {{target ratio}}. Preserve the original center image and subject exactly. Continue environment, lighting, weather, perspective, lens character, texture, and depth of field naturally beyond the existing edges. Complete cropped objects only when their continuation is visually inevitable.", negativePrompt: "altered main subject, duplicated objects, stretched edges, mismatched weather, blurry filled areas", imageSize: "1536x1024", copies: 2, workflowPreset: "style-transfer", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-crowd-cleanup", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "背景清场", description: "移除干扰人物，同时补回可信的环境纹理。", useWhen: "上传旅行、门店或活动照片", prompt: "Remove all unwanted people from the uploaded scene while preserving the primary subject. Reconstruct the background with logically matching surfaces, shadows, perspective, grain, focus depth, and lighting. Keep architecture, signage, and important objects unchanged unless explicitly marked for removal.", negativePrompt: "smudges, melted architecture, repeated textures, changed subject face, missing shadows", imageSize: "1536x1024", copies: 2, workflowPreset: "style-transfer", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-sign-localization", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "门店与菜单翻译", description: "翻译文字但保留原来的材质、排版和磨损。", useWhen: "上传菜单、招牌、展板", prompt: "Translate every visible {{source language}} label in the uploaded image to {{target language}}. Preserve prices, numbers, currency, layout, font style, surface texture, perspective, wear, reflections, and lighting. Place translations naturally on the original physical surface and keep non-text imagery untouched.", negativePrompt: "changed prices, wrong currency, floating text, erased texture, altered layout", imageSize: "1024x1536", copies: 2, workflowPreset: "style-transfer", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-comic-localization", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "漫画本地化", description: "替换气泡文字，保留分镜节奏和原画。", useWhen: "上传漫画、梗图、海报", prompt: "Localize the uploaded comic or meme from {{source language}} to {{target language}}. Replace only the text inside speech bubbles, captions, and signs. Match the original font weight, bubble shape, alignment, reading order, and expressive tone. Preserve every character, line, color, and panel boundary.", negativePrompt: "changed artwork, broken panel order, unreadable bubbles, invented text, cropped faces", imageSize: "1024x1536", copies: 2, workflowPreset: "style-transfer", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-mini-store", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "品牌", title: "品牌微缩店", description: "将产品语言变成可传播的微缩品牌场景。", useWhen: "品牌社媒、开业预热、IP周边", prompt: "Design a miniature concept store for {{brand}} whose architecture is inspired by {{iconic product}}. Use {{brand palette}}, two visible floors, tiny visitors, product-specific window displays, and a believable urban street context. Render as a premium collectible diorama with soft afternoon light and clear brand hierarchy.", negativePrompt: "generic storefront, misspelled brand, inconsistent palette, noisy crowd, plastic materials", imageSize: "1024x1536", copies: 2, workflowPreset: "poster-variants", ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-editorial-portrait", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "人像", title: "一致性时尚肖像", description: "保留人物身份，切换完整的时尚片表达。", useWhen: "上传人物参考图", prompt: "Use the uploaded reference as the identity source. Keep facial structure, skin tone, hairstyle, and key features consistent. Create a {{fashion era}} editorial portrait in {{location}} with {{wardrobe}}, {{camera and lens}}, and {{lighting}}. Keep natural skin texture and make the styling cohesive from head to frame edge.", negativePrompt: "changed identity, face warping, plastic skin, distorted hands, inconsistent hair", imageSize: "1024x1536", copies: 2, workflowPreset: "character-consistency", needsReference: true, ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "nano-commercial-poster", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "营销", title: "商业促销海报", description: "把商品、优惠和可读文案收进一张真正可用的海报。", useWhen: "活动、团购、门店、社媒投放", prompt: "Design a commercial poster for {{brand or product}}. Hero subject: {{subject}}. Exact title: '{{headline}}'. Exact offer: '{{offer}}'. Use a {{mood}} visual direction, one clear focal point, a deliberate text hierarchy, and a restrained footer. Ensure every supplied word is spelled exactly and integrated into the composition.", negativePrompt: "misspelled text, too many offers, random logos, unreadable type, weak product focus", imageSize: "1024x1536", copies: 3, workflowPreset: "poster-variants", ...NANO_BANANA_PRO_SOURCE,
  },
  {
    id: "gpt-avatar-direction", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "人像", title: "专业头像", description: "为个人身份生成稳定、克制的头像方案。", useWhen: "履历、团队页、社媒主页", prompt: "Create a professional portrait for {{person}}. Frame chest-up, preserve {{identity cues}}, use {{wardrobe}}, a {{background}} backdrop, and {{lighting}}. The expression should communicate {{trait}}. Keep skin texture natural, eye line precise, and composition suitable for a circular crop.", negativePrompt: "altered identity, beauty filter, plastic skin, distorted hands, distracting props", imageSize: "1024x1024", copies: 2, workflowPreset: "character-consistency", ...YOUMIND_SOURCE,
  },
  {
    id: "gpt-video-thumbnail", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "社媒", title: "视频封面", description: "把人物、主题和大标题压成一眼可懂的封面。", useWhen: "YouTube、抖音、B站、播客", prompt: "Design a {{platform}} thumbnail about {{topic}}. Put {{person or product}} on the {{left or right}}, reserve a clean text zone, and use exact headline '{{headline}}'. Show one unmistakable visual proof of {{promise}}. Use high contrast, clear face or product detail, and a single readable hierarchy.", negativePrompt: "clickbait clutter, unreadable text, duplicate faces, excessive arrows, random logos", imageSize: "1536x1024", copies: 3, workflowPreset: "poster-variants", ...YOUMIND_SOURCE,
  },
  {
    id: "gpt-ecommerce-main", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "电商", title: "电商主图", description: "用商品比例和材质表达建立第一眼信任。", useWhen: "商城首图、平台搜索卡、上新图", prompt: "Create a marketplace main image for {{product}}. Preserve accurate {{material}}, {{color}}, and {{silhouette}}. Use {{background}} with one controlled accent prop. Make the product occupy {{percentage}} of the frame, stay instantly recognizable at small size, and leave no unnecessary text or brand claims.", negativePrompt: "changed product design, cluttered background, extra text, cropped product, harsh reflections", imageSize: "1024x1024", copies: 3, workflowPreset: "product-shot", ...YOUMIND_SOURCE,
  },
  {
    id: "gpt-app-concept", modelId: "gpt-image-2", modelLabel: "GPT Image 2", category: "界面", title: "应用概念页", description: "把一个产品想法变成可评审的关键页面。", useWhen: "产品概念、融资演示、功能探索", prompt: "Create a polished {{platform}} concept screen for {{product idea}}. User goal: {{goal}}. Prioritize {{three actions}} in a realistic interaction flow. Use exact labels '{{labels}}', useful content density, a defined visual system, and a believable empty or loading state where relevant.", negativePrompt: "unusable navigation, lorem ipsum, floating widgets, unreadable type, generic dashboard", imageSize: "1024x1536", copies: 2, workflowPreset: "poster-variants", ...YOUMIND_SOURCE,
  },
  {
    id: "nano-multi-image-composite", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "多图合成", description: "让多个真实素材共享同一光线、透视和画面逻辑。", useWhen: "上传主体、场景和道具图", prompt: "Combine the uploaded references into one coherent {{scene}}. Preserve the identity and material of each specified source: {{source mapping}}. Match perspective, focal length, contact shadows, color temperature, scale, occlusion, and depth of field. The final image must look like one photographed moment, not a collage.", negativePrompt: "cutout edges, mismatched lighting, wrong scale, floating objects, changed source identity", imageSize: "1536x1024", copies: 2, workflowPreset: "style-transfer", needsReference: true, ...PICOTREX_SOURCE,
  },
  {
    id: "nano-character-consistency", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "角色一致性场景", description: "在换装和换场景时仍锁住身份锚点。", useWhen: "上传角色或真人参考图", prompt: "Use the uploaded person or character as the identity anchor. Keep face, hairstyle, proportions, {{signature features}}, and {{core outfit details}} consistent while placing them in {{new scene}} performing {{action}}. Match lighting and perspective to the new scene without weakening identity recognition.", negativePrompt: "face drift, altered age, inconsistent hair, changed costume details, extra limbs", imageSize: "1024x1536", copies: 2, workflowPreset: "character-consistency", needsReference: true, ...PICOTREX_SOURCE,
  },
  {
    id: "nano-material-swap", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "编辑", title: "商品材质替换", description: "保留产品结构，只替换材质或配色进行 A/B 决策。", useWhen: "上传商品或包装实拍", prompt: "Use the uploaded product as fixed geometry. Preserve its shape, logo placement, labels, camera angle, and composition. Replace only {{target material or color}} with {{new material or color}}. Render accurate surface response, seams, edges, reflections, and contact shadows under the original lighting.", negativePrompt: "changed silhouette, altered label, wrong logo, melted edges, inconsistent reflections", imageSize: "1024x1024", copies: 3, workflowPreset: "style-transfer", needsReference: true, ...PICOTREX_SOURCE,
  },
  {
    id: "nano-story-frames", modelId: "gemini-3.1-flash-image", modelLabel: "Nano Banana Pro", category: "叙事", title: "一致性连帧", description: "从一个角色或产品参考延展连续故事画面。", useWhen: "广告分镜、IP内容、产品故事", prompt: "Using the uploaded reference as the continuity anchor, create a {{3}}-frame visual sequence for {{story}}. Preserve the same subject identity, product design, palette, and wardrobe. Vary camera angle and action across frames while keeping time, location, and lighting progression logically connected.", negativePrompt: "identity drift, unrelated locations, changing product, repeated pose, broken sequence", imageSize: "1536x1024", copies: 2, workflowPreset: "character-consistency", needsReference: true, ...PICOTREX_SOURCE,
  },
];

export const CREATOR_RESOURCE_CATEGORIES = Array.from(new Set(CREATOR_RESOURCES.map((resource) => resource.category)));
