// Taro 的 postcss-loader 会向上找这份配置：Tailwind 生成 → weapp-tailwindcss
// 做小程序兼容转换（类名转义、伪类降级）。
//
// 单位策略（2026-10-21，对齐网页版手机端）：
//   Tailwind 的 rem 一律转成固定 px（1rem = 16px），Taro 的 pxtransform 关闭。
//   网页版在 430/390/375 上都是固定 CSS px，不做屏宽缩放；小程序若用 rpx，
//   430 宽机器上 15px 字会变成 17.2px，和「一模一样」冲突。固定 px 才逐像素同源。
//   旧页面 SCSS 里显式写的 rpx 不受影响。
const { getPlugins } = require('weapp-tailwindcss/postcss')
const remToPx = require('postcss-rem-to-responsive-pixel')

module.exports = {
  plugins: [
    require('tailwindcss')({}),
    require('autoprefixer')(),
    remToPx({ rootValue: 16, propList: ['*'], transformUnit: 'px' }),
    ...getPlugins({ rem2rpx: false }),
  ],
}
