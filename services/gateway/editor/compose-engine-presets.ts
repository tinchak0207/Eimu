export const CRF = { low: 28, medium: 23, high: 19 } as const;
export const ABR = { low: '128k', medium: '192k', high: '256k' } as const;
export const HW_BITRATE_1080P = { low: 4500, medium: 8000, high: 14000 } as const;
export const shq = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

/** 曲线变速预设：相对速度乘子（等分源时长片段），代码内做调和归一保总时长不变 */
export const CURVE_PRESETS: Record<string, number[]> = {
  montage: [0.6, 1.8, 0.6],          // 蒙太奇：慢-快-慢
  hero: [1.6, 0.35, 1.6],            // 英雄时刻：快-极慢-快
  bullet: [1, 2.6, 0.4, 1],          // 子弹时间
  flashin: [2.2, 0.7],               // 闪进
  flashout: [0.7, 2.2],              // 闪出
};
