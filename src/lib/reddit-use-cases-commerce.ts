import type { UseCase } from "./use-cases";

const AUTHOR = {
  name: "Eimu 创作者工作台",
  jobTitle: "AI 图片与视频创作平台",
  url: "https://eimu.dev",
};

/** Evidence-backed commerce/content use cases isolated from the general catalog. */
export const REDDIT_COMMERCE_USE_CASES: UseCase[] = [
  {
    slug: "reddit-ai-self-publishing-book-cover-concepts",
    keyword: "AI 自出版书封视觉概念",
    title: "AI 自出版书封视觉概念：先探索 artwork，再把字体与印刷交给后期",
    tagline: "用视觉概念加速书封方向探索",
    heroDescription:
      "自出版作者和书封创作者在 Reddit 上反复讨论自制封面、风格取舍、纹理处理以及寻找合适的封面艺术家。这个用例把 AI 放在 artwork 与视觉概念探索的位置：先生成符合题材的主体、意象和氛围，再由作者或设计师完成书名、作者名、书脊、出血和印刷文件设置。",
    painPoints: [
      "作者需要在闪耀与克制、象征意象与题材识别之间比较多个封面方向。",
      "自制封面常常还要继续处理纹理、字体和整体层次，单张生成图不是交付文件。",
      "纸书封面涉及正面、书脊和背面排版，视觉概念与印刷生产设置不能混为一谈。",
    ],
    statInsight:
      "指定 Reddit 数据中，BookCovers 帖子直接展示了重绘前后方案比较、恐怖小说象征意象的克制处理、自制 Photoshop 封面纹理取舍，以及历史小说寻找特定印刷字体风格的需求；selfpublish 帖子还把封面设计与内页格式化分开讨论。这些是公开讨论样本，支持 artwork/概念探索与后期制作边界，不代表生成质量、销量或出版成功率。",
    citation: {
      label: "Reddit 书封讨论：I Redrew My Cover After I Learned Procreate",
      url: "https://reddit.com/r/BookCovers/comments/18atpto/i_redrew_my_cover_after_i_learned_procreate_which/",
    },
    promptExamples: [
      {
        title: "恐怖小说象征概念",
        prompt:
          "为一部心理恐怖小说探索三种书封 artwork 概念：蛇是贯穿全书的创伤象征，画面克制、留白充足、避免俗套血腥；只生成视觉主体与氛围，不生成书名、作者名、书脊或背封文字。",
      },
      {
        title: "历史小说印刷质感",
        prompt:
          "为一部设定在 1700 年代英格兰的历史小说制作书封视觉概念：古老印刷厂纸张、时代感插画、克制的棕黑与暗红色板，正面构图清晰；只生成 artwork，不生成任何可交付字体、正文或印刷标记。",
      },
    ],
    faqs: [
      {
        question: "AI 能直接生成可印刷的整套书封吗？",
        answer:
          "不应这样承诺。这里的证据支持 AI 用于 artwork 和视觉方向探索；书名、作者名、书脊、背封、出血、尺寸与印刷规范仍应在设计或排版软件中完成并校对。",
      },
      {
        question: "书封概念应该一次生成几个方向？",
        answer:
          "可以先生成多个明确区分的方向，例如象征物、构图和色调分别变化，再挑选一个继续细化。Reddit 的书封讨论本身就包含重绘前后和不同视觉取舍的比较。",
      },
      {
        question: "历史题材的字体能交给图像模型吗？",
        answer:
          "不建议把需要准确的字体和文字交给模型。模型可以探索时代感的纸张、印刷质感和装饰 artwork，实际字体、字距、书脊和印刷文件应由后期排版控制。",
      },
    ],
    author: AUTHOR,
    relatedSlugs: ["content-1", "ecommerce-3"],
    searchVariants: [
      "奇幻小说封面概念图",
      "AI book cover artwork concept",
      "self publishing book cover art ideas",
    ],
    workflowSteps: [
      "先写清题材、读者感受和一到两个核心意象，只要求生成 artwork 概念。",
      "分别生成构图、色板和媒介不同的多个方向，保留每个方向的提示词与参考图。",
      "选定方向后，用局部编辑完善主体、纹理、光线和边缘，不把整套文字排版混进生成任务。",
      "在设计软件中加入书名、作者名、书脊、背封、出血和印刷设置，并逐项检查后导出。",
    ],
    fitBoundary:
      "适合自出版或独立书封项目中的 artwork、象征物、构图和氛围探索，以及交给设计师继续处理的概念草案；不适合把准确书名、作者名、字体、书脊、背封、条码、出血或最终印刷规格一次性交给图像模型，也不覆盖内页排版、出版发行或销量预测。",
    redditEvidence: [
      {
        title: "I Redrew My Cover After I Learned Procreate. Which is Better?",
        quote:
          "发帖者比较学习 Procreate 后重绘的书封与之前方案，说明书封 artwork 会经历工具和方案迭代，而不是一次生成即定稿。",
        url: "https://reddit.com/r/BookCovers/comments/18atpto/i_redrew_my_cover_after_i_learned_procreate_which/",
        score: 28,
        comments: 27,
      },
      {
        title: "Been working on a cover - don’t want it flashy but also not too bland. Thoughts?",
        quote:
          "恐怖小说作者说明蛇是贯穿全书的创伤象征，并询问如何在不浮夸也不单调之间处理封面视觉。",
        url: "https://reddit.com/r/BookCovers/comments/19b0fkl/been_working_on_a_cover_dont_want_it_flashy_but/",
        score: 24,
        comments: 22,
      },
      {
        title: "How are these book covers for being self-made? I used photoshop to edit and create them.",
        quote:
          "发帖者展示自制 Photoshop 书封，并具体询问第二张封面是否也应使用同样的纹理效果，体现 artwork 与后期效果的取舍。",
        url: "https://reddit.com/r/BookCovers/comments/17isgv3/how_are_these_book_covers_for_being_selfmade_i/",
        score: 20,
        comments: 11,
      },
      {
        title: "Looking for an artist to work on a book cover for a historical fiction in the style and font of a 1700s English printing press document",
        quote:
          "历史小说作者寻找能处理 1700 年代英格兰题材、时代字体与印刷风格的书封艺术家，显示视觉概念与字体制作需要协作和后期控制。",
        url: "https://reddit.com/r/BookCovers/comments/16i0ywz/looking_for_an_artist_to_work_on_a_book_cover_for/",
        score: 7,
        comments: 5,
      },
    ],
  },
 ];
