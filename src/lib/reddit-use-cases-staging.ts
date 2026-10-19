import type { UseCase } from "./use-cases";

const AUTHOR = {
  name: "Eimu 创作者工作台",
  jobTitle: "AI 图片与视频创作平台",
  url: "https://eimu.dev",
};

export const REDDIT_USE_CASES_STAGING: UseCase[] = [
  {
    slug: "reddit-room-photo-virtual-staging-directions",
    categorySlug: "architecture",
    keyword: "房间照片 AI 软装方案对比",
    title: "用现有房间照片对比软装与虚拟布置方向，同时保留空间辨识度",
    tagline: "固定房间结构，一次比较多套家具与装饰方向",
    heroDescription:
      "上传同一张房间照片，先把墙体、门窗、固定开口、主要视角和已有不可移动部分列为保留项，再分别生成温暖自然、现代简洁或更有层次的软装方向。重点是并排比较家具、地毯、窗帘、灯具与装饰组合，而不是把房间重画成另一个空间。",
    painPoints: [
      "只看单件家具或色卡，很难判断它放进真实房间后是否协调。",
      "每轮同时改结构、镜头和软装，会失去与原照片可比较的基线。",
      "在购买家具、窗帘或装饰前，需要先看到几种整体方向，而不是只听零散建议。",
    ],
    statInsight:
      "Reddit 的公开帖子提供了定性需求证据：有人上传已布置的客厅照片，具体询问窗饰、控制台下方装饰与沙发方向；也有人在预算有限、已有基础家具和画作的房间里，询问地毯等调整能否让空间更完整。另一条 RealEstatePhotography 帖子直接询问如何学习 virtual staging。它们说明用户希望基于现有空间预览并比较布置方向，但不构成效果成功率、市场规模或尺寸准确性的统计。",
    citation: {
      label: "Reddit 讨论：如何提升现有客厅空间",
      url: "https://www.reddit.com/r/DesignMyRoom/comments/15xstve/is_what_ive_done_so_far_working_how_can_i_elevate/",
    },
    promptExamples: [
      {
        title: "温暖自然的客厅软装方向",
        prompt:
          "以这张客厅照片为唯一空间参考，保留墙体、门窗、固定开口、地面边界、主要家具位置关系和原始相机视角，使房间仍可辨认；只调整可移动软装，加入浅木色边几、米色纹理地毯、亚麻窗帘、暖光落地灯和少量绿植，形成温暖自然方向。不要新增门窗，不改变房间尺度。",
      },
      {
        title: "现代简洁的同房间对比方案",
        prompt:
          "基于同一张房间照片制作现代简洁虚拟布置方案，严格保留墙面、窗户、门洞、天花线、地面轮廓与拍摄视角；将软装改为低饱和沙发、几何地毯、简洁窗帘、黑色细框灯具和克制墙饰。保持通道清楚，不拆改结构，让结果可与原图及温暖方案并排比较。",
      },
    ],
    faqs: [
      {
        question: "怎样让不同软装方案仍然看得出是同一个房间？",
        answer:
          "每个提示词都重复写明必须保留的墙体、门窗、固定开口、地面轮廓和相机视角，只改变可移动家具、灯具、窗帘、地毯与装饰，并始终用同一张原图作为参考。",
      },
      {
        question: "应该一次生成很多变化，还是分方向比较？",
        answer:
          "先定义三种清楚且互相可区分的方向，例如温暖自然、现代简洁和色彩层次；每轮只改软装语言，保持结构基线一致，再并排筛选值得继续细化的一套。",
      },
      {
        question: "虚拟布置图能直接用来购买家具或施工吗？",
        answer:
          "不能直接据此下单或施工。生成图可能改变比例、遮挡和细节，应回到现场实测尺寸，并核对门窗开启、通道、插座和真实材质后再决定。",
      },
    ],
    author: AUTHOR,
    relatedSlugs: [
      "reddit-compare-ai-image-models",
      "reddit-control-specific-ai-image",
      "reddit-move-resize-object-only",
    ],
    searchVariants: [
      "AI 房间软装效果图",
      "现有客厅照片虚拟布置",
      "房间照片家具风格对比",
      "virtual staging from room photo",
    ],
    workflowSteps: [
      "选择能清楚看到墙体、门窗、地面边界和主要通道的房间原照片，并保留它作为所有方案的共同基线。",
      "列出不得改变的结构与视角，再标记允许替换或新增的家具、地毯、窗帘、灯具和装饰。",
      "分别生成至少三种明确的软装方向，每轮沿用同一原图、同一保留项和相近构图要求。",
      "把结果与原图并排检查房间辨识度、通道、视觉重心和软装协调性，只继续细化结构漂移最少的方向。",
      "购买或实施前回到现场测量，并核对门窗开启、动线、插座、承重与材料实物。",
    ],
    fitBoundary:
      "适合用现有房间照片预览和比较家具、地毯、窗帘、灯具、墙饰与配色等视觉方向；不适合作为施工图、装修许可材料、承重判断、精确尺寸测量、家具必然放得下或完工验收的证明。模型可能改变比例、遮挡和固定结构细节，任何购买、拆改与安装决定都必须以现场测量和专业核验为准。",
    redditEvidence: [
      {
        title: "Is what I’ve done so far “working”? How can I elevate this space?",
        quote:
          "发帖者基于现有客厅照片询问如何提升空间，并明确提到尚未决定窗饰、控制台下方放什么，以及未来可能更换沙发。",
        url: "https://www.reddit.com/r/DesignMyRoom/comments/15xstve/is_what_ive_done_so_far_working_how_can_i_elevate/",
      },
      {
        title: "Help me elevate my space on a budget. Something feels off",
        quote:
          "发帖者与室友已有基础家具并新加了画作，但仍觉得空间不协调，具体询问餐桌下是否应增加地毯，希望在预算内改善现有房间。",
        url: "https://www.reddit.com/r/DesignMyRoom/comments/15z6u9v/help_me_elevate_my_space_on_a_budget_something/",
      },
      {
        title: "How should I decorate this entryway?",
        quote:
          "发帖者希望把现有入口布置得更有欢迎感，并要求入口的元素与照片中相邻起居室的风格形成联系。",
        url: "https://www.reddit.com/r/DesignMyRoom/comments/15x7wyd/how_should_i_decorate_this_entryway/",
      },
      {
        title: "How to get into Virtual Staging?",
        quote:
          "一位有室内设计背景的发帖者直接询问从哪里学习 virtual staging、是否有课程，以及应如何入门。",
        url: "https://www.reddit.com/r/RealEstatePhotography/comments/16df9cn/how_to_get_into_virtual_staging/",
      },
    ],
  },
];
