export interface ReplicateFilm {
  id: string;
  title: string;
  /** 点卡即发出的那一句。可替换主题写在句内，不另开字段。 */
  sentence: string;
}

export const REPLICATE_FILMS: readonly ReplicateFilm[] = [
  {
    id: "morning-toilette",
    title: "晨时梳妆",
    sentence: "晨时梳妆：15 秒短剧，四镜，窗棂光束，特写收到近景。主题换成「晨时梳妆」",
  },
  {
    id: "period-tavern",
    title: "古风酒楼",
    sentence: "古风酒楼：12 秒，中景切特写。主题换成「古风酒楼」",
  },
  {
    id: "wedding-dinner-playlist",
    title: "婚礼晚宴歌单",
    sentence: "婚礼晚宴歌单：四小时，长辈一半，不放分手和离世。换成「婚礼晚宴」的场合",
  },
  {
    id: "moon-city-pop",
    title: "月亮代表我的心改成 City Pop",
    sentence: "月亮代表我的心改成 City Pop：只出编曲方案，先不要生成。换成「月亮代表我的心」",
  },
  {
    id: "tea-ad",
    title: "茶饮广告",
    sentence: "茶饮广告：15 秒，三镜，16:9。产品换成「茶饮」",
  },
  {
    id: "coffee-poster",
    title: "咖啡新品海报",
    sentence: "咖啡新品海报：一张图，木质桌面，早晨光。店名换成「咖啡」",
  },
];
