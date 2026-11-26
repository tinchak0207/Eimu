import { defineConfig } from '@tarojs/cli'
// Tailwind 的 class 里带 px/rem 语义（1rem=16px），而本档的 px 也按 375 设计稿写；
// designWidth 375 ⇒ 1px 输出 2rpx（375 宽屏上正好 1 CSS px），与 rem2rpx 的
// rootValue 32（1rem→32rpx）同一条换算。
import { UnifiedWebpackPluginV5 } from 'weapp-tailwindcss/webpack'
import devConfig from './dev'
import prodConfig from './prod'
import { loadEnv } from './env'

const env = loadEnv()

// Taro 的 defineConstants 是编译期文本替换（小程序运行时没有 process.env），
// 所以键名必须写成 'process.env.X' 字串，值用 JSON.stringify 包成字面量。
export default defineConfig(async (merge) => {
  const baseConfig = {
    projectName: 'eimu-miniapp',
    date: '2026-10-20',
    designWidth: 375,
    deviceRatio: {
      375: 2,
      640: 2.34 / 2,
      750: 1,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    // loadEnv 已对 TARO_APP_* 做归一化（trim、去末尾斜杠、空值回退默认），
    // 默认值只在 config/env.js 的 DEFAULT_URLS 维护一份。
    defineConstants: {
      'process.env.TARO_APP_API_BASE_URL': JSON.stringify(env.TARO_APP_API_BASE_URL),
      'process.env.TARO_APP_AGENT_ORIGIN': JSON.stringify(env.TARO_APP_AGENT_ORIGIN),
      'process.env.TARO_APP_WEB_ORIGIN': JSON.stringify(env.TARO_APP_WEB_ORIGIN),
    },
    copy: {
      patterns: [],
      options: {},
    },
    framework: 'react',
    compiler: {
      type: 'webpack5',
      prebundle: { enable: false },
    },
    cache: {
      enable: false,
    },
    mini: {
      // weapp-tailwindcss：类名转义（含 JSX 里的 class 字串）与小程序 CSS 兼容。
      // postcss 侧负责生成/转换 CSS（见 apps/miniapp/postcss.config.js），这里负责把
      // 模板里的 `text-[0.9375rem]` 之类同步成转义后的类名，两边必须成对存在。
      webpackChain(chain: any) {
        chain.plugin('weapp-tailwindcss').use(UnifiedWebpackPluginV5, [
          {
            appType: 'taro',
          },
        ])
      },
      postcss: {
        pxtransform: {
          // 固定 px 策略：Tailwind rem 已在 postcss 转 px，pxtransform 再转会把
          // 1px 描边变成 2rpx、字级随屏宽漂移。详见 apps/miniapp/postcss.config.js 档首。
          enable: false,
          config: {},
        },
        url: {
          enable: true,
          config: {
            limit: 1024,
          },
        },
        cssModules: {
          enable: false,
          config: {
            namingPattern: 'module',
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
    },
    h5: {
      publicPath: '/',
      staticDirectory: 'static',
      postcss: {
        autoprefixer: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false,
          config: {
            namingPattern: 'module',
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
    },
  }

  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, devConfig)
  }
  return merge({}, baseConfig, prodConfig)
})
