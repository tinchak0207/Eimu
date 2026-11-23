import { WebView } from '@tarojs/components'

// 定价入口：网页版既有页面（/pricing），小程序不另外设计一套套餐 UI。
// 域名从 .env 注入（TARO_APP_WEB_ORIGIN），默认生产域名；
// 需要在小程序后台把该域名配为业务域名，web-view 才能内嵌。
const WEB_ORIGIN = process.env.TARO_APP_WEB_ORIGIN || 'https://eimu.dev'

export default function PricingPage() {
  return <WebView src={`${WEB_ORIGIN}/pricing`} />
}
