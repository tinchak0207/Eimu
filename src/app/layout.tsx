import type { Metadata } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/react";
import AuthProvider from "@/hooks/use-auth";
import Navbar from "@/components/Navbar";
import PricingSync from "@/components/PricingSync";
import PwaInstaller from "@/components/PwaInstaller";
import AttributionCapture from "@/components/AttributionCapture";
import Toaster from "@/components/ui/toaster";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import {
  SITE_DESCRIPTION,
  SITE_FEATURE_LIST,
  SITE_TITLE,
} from "@/lib/site-copy";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  display: "swap",
});

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // 子页只写自己的标题，品牌尾巴由 template 统一补上；首页用 absolute 取全名。
  title: { default: SITE_TITLE, template: "%s | Eimu" },
  description: SITE_DESCRIPTION,
  keywords: [
    "Eimu",
    "Eimu AI",
    "AI 影像工作台",
    "AI 智能体",
    "一句话生成视频",
    "AI生图",
    "AI 在线生图",
    "GPT Image 2",
    "Nano Banana Pro",
    "图片生成器",
    "AI画图工具",
  ],
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: SITE_URL,
    siteName: "Eimu",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Eimu",
  },
  formatDetection: {
    telephone: false,
  },
};

/**
 * 站点实体图（2026-09-27 SEO 重构）：Organization＋WebSite＋SoftwareApplication
 * 用 @id 互相引用。Google 靠 Organization/WebSite 认出「Eimu 这个品牌＝eimu.dev」，
 * 否则品牌词会和同名的个人作品集、Easy IMU 硬体混在一起。
 */
function getStructuredData() {
  const orgId = `${SITE_URL}/#organization`;
  const siteId = `${SITE_URL}/#website`;
  const organization = {
    "@type": "Organization",
    "@id": orgId,
    name: "Eimu",
    url: SITE_URL,
    logo: { "@type": "ImageObject", url: `${SITE_URL}/icon-512.png`, width: 512, height: 512 },
    description: SITE_DESCRIPTION,
  };
  const website = {
    "@type": "WebSite",
    "@id": siteId,
    name: "Eimu",
    alternateName: ["Eimu AI", "eimu.dev"],
    url: SITE_URL,
    inLanguage: "zh-CN",
    publisher: { "@id": orgId },
  };
  const app = {
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#app`,
    publisher: { "@id": orgId },
    name: "Eimu",
    alternateName: SITE_URL.replace(/^https?:\/\//, ""),
    url: SITE_URL,
    applicationCategory: "DesignApplication",
    operatingSystem: "Web",
    description: SITE_DESCRIPTION,
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "CNY",
      lowPrice: "9.9",
      highPrice: "69",
      offerCount: "3",
    },
    featureList: [...SITE_FEATURE_LIST],
  };
  return { "@context": "https://schema.org", "@graph": [organization, website, app] };
}

/** Next 15 将 viewport 栏位从 metadata 拆出独立 export（含 themeColor）。 */
export const viewport = {
  width: "device-width" as const,
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#1f2328",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const structuredData = getStructuredData();

  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="font-sans antialiased text-[0.9375rem] text-foreground flex min-h-dvh flex-col">
        {/* 面板宽 pre-paint 同步套用（2026-09-24 暴君回报「Ctrl+Shift+R 聊天框
            先占几乎半屏、秒缩回 30% 以下」）：用户真拖过宽的 v2 存值必须在首个
            paint 前落到 --ws-panel-w，否则冷载入＝首帧画 CSS 默认 clamp（40vw
            半屏），JS chunk 下载完水合后才缩回存值宽——useLayoutEffect 救不了，
            它对「服务端 HTML 的首帧」而言已经太晚。next/script 的
            beforeInteractive 同样太晚：实装是把内联脚本 push 进 self.__next_s，
            由 app-bootstrap（main-app chunk 执行时）才跑，与水合同期、在 paint
            之后。唯一首帧前路径＝HTML 解析期同步执行的内联 <script>（与下方
            boot 错误捕获脚本同机制），放在 <body> 顶端、任何工作站标记之前。
            校验与 use-chat-panel.parseStoredPanelWidth 逐字同范围（320–720
            整数，v2 key；旧 key 垃圾值一律不认）。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var w=Number(localStorage.getItem("canvas-chat-panel-width.v2"));if(Number.isInteger(w)&&w>=320&&w<=720){document.documentElement.style.setProperty("--ws-panel-w",w+"px");}}catch(_){}})();`,
          }}
        />
        {/* 启动自愈：水合没发生＝清 SW／快取后刷新一次。2026-10-01 收紧触发：6 秒未水合且已有启动错误才动手，
            没有错误就等到 15 秒——慢机／慢网水合本来就久，不能把「慢」误判成「坏」、反手清空快取再重载（只会更慢）。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
try{
window.__bootErrors=[];
window.addEventListener("error",function(e){window.__bootErrors.push(String(e.message).slice(0,300));try{localStorage.setItem("eimu_boot_err",JSON.stringify({t:Date.now(),m:String(e.message).slice(0,300),src:(e.filename||"").slice(-60)}))}catch(_){}});

window.addEventListener("unhandledrejection",function(e){window.__bootErrors.push("rej:"+String(e.reason).slice(0,200));});
var heal=function(late){
  var w=window;
  if(w.__eimuHydrated)return;
  if(!late&&!(w.__bootErrors&&w.__bootErrors.length)){setTimeout(function(){heal(true)},9000);return;}
  if(sessionStorage.getItem("eimu_selfheal"))return;
  sessionStorage.setItem("eimu_selfheal","1");
  (async function(){
    try{
      var regs=await navigator.serviceWorker.getRegistrations();
      for(var i=0;i<regs.length;i++)regs[i].unregister();
      var keys=await caches.keys();
      for(var j=0;j<keys.length;j++)await caches.delete(keys[j]);
      localStorage.setItem("eimu_boot_err",JSON.stringify({t:Date.now(),m:"self-heal: no hydration, cleared SW+caches"}));
      location.reload();
    }catch(_){}
  })();
};
setTimeout(function(){heal(false)},6000);
}catch(_){}
})();`,
          }}
        />
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <AuthProvider>
          <PricingSync />
          <Navbar />
          {/* 首页应用式满屏（2026-09-10 F6）：body 是 flex 纵向壳（Navbar 自然高
              ＋ main 吃满剩余视口）。min-h-dvh 而非 h-dvh——视口过矮时 body 可
              长高、整页滚动。其他页面是文档流根节点，作为 flex item 只是全宽
              自然高，行为等价 block。Toaster/PwaInstaller/Analytics 渲染 fixed
              或 null，不参与 flex 布局。 */}
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
          <Toaster />
          <PwaInstaller />
          {/* 首次触达归因采集（utm/referrer host/落地路径 → eimu_first_touch cookie，90 天，
              首触不覆盖）。渲染 null，不参与布局。 */}
          <AttributionCapture />
        </AuthProvider>
        <Analytics />
      </body>
    </html>
  );
}
