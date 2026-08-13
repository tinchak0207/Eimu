export interface Suggestion {
  text: string;
  prompt: string;
}

const basePrompts: Suggestion[] = [
  {
    text: "海岸香氛大片",
    prompt:
      "帮我把这瓶香水放在落日海滩上，要有高级感环境光，像精品品牌广告。",
  },
  {
    text: "咖啡新品海报",
    prompt:
      "帮我做一张咖啡店新品海报，木质桌面、早晨阳光、奶油色调，整体干净又有质感。",
  },
  {
    text: "珠宝质感商品图",
    prompt:
      "把这款耳环做成棚拍商品图，背景干净，金属反光细致，整体要有高级感。",
  },
  {
    text: "甜点社交大片",
    prompt:
      "做一张适合发社交平台的甜点照片，草莓蛋糕放在窗边桌上，光线柔和，让人看了就想下单。",
  },
  {
    text: "品牌促销视觉",
    prompt:
      "帮我做一张小店限时优惠宣传图，画面简洁、好读，像品牌活动海报。",
  },
];

function shuffle<T>(array: T[]): T[] {
  const shuffled = [...array];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[index],
    ];
  }

  return shuffled;
}

export function getAllSuggestions(): Suggestion[] {
  return [...basePrompts];
}

export function getInitialSuggestions(suggestions: Suggestion[]): Suggestion[] {
  return [...suggestions];
}

export function getRandomSuggestions(count: number = 5): Suggestion[] {
  return shuffle(basePrompts).slice(0, count);
}
