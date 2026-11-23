export default {
  pages: [
    // 单页入口：一进来就是 agent 聊天页面。
    'pages/agent/index',
    // 以下页面仅从顶栏汉堡抽屉进入（不再是入口，也不再挂 tabBar）。
    'pages/index/index',
    'pages/works/index',
    'pages/mine/index',
    'pages/detail/index/index',
    'pages/templates/index/index',
    'pages/pricing/index',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: 'Eimu',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f5fbff',
    // 自绘顶栏（与网页版手机端逐像素对齐），原生导航条一律不画。
    navigationStyle: 'custom',
  },
}
