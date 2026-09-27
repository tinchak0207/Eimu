import type { Metadata } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/react";
import { AuthProvider } from "@/hooks/use-auth";
import { Navbar } from "@/components/Navbar";
import { PricingSync } from "@/components/PricingSync";
import { PwaInstaller } from "@/components/PwaInstaller";
import { Toaster } from "@/components/ui/toaster";
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
  title: SITE_TITLE,
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
  alternates: { canonical: SITE_URL },
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

function getStructuredData() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
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
}

/** Next 15 將 viewport 欄位從 metadata 拆出獨立 export（含 themeColor）。 */
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
      <body className="font-sans antialiased text-[15px] text-foreground flex min-h-dvh flex-col">
        {/* 面板寬 pre-paint 同步套用（2026-09-24 暴君回報「Ctrl+Shift+R 聊天框
            先佔幾乎半屏、秒縮回 30% 以下」）：用戶真拖過寬的 v2 存值必須在首個
            paint 前落到 --ws-panel-w，否則冷載入＝首幀畫 CSS 默認 clamp（40vw
            半屏），JS chunk 下載完水合後才縮回存值寬——useLayoutEffect 救不了，
            它對「服務端 HTML 的首幀」而言已經太晚。next/script 的
            beforeInteractive 同樣太晚：實裝是把內聯腳本 push 進 self.__next_s，
            由 app-bootstrap（main-app chunk 執行時）才跑，與水合同期、在 paint
            之後。唯一首幀前路徑＝HTML 解析期同步執行的內聯 <script>（與下方
            boot 錯誤捕獲腳本同机制），放在 <body> 頂端、任何工作站標記之前。
            校驗與 use-chat-panel.parseStoredPanelWidth 逐字同範圍（320–720
            整數，v2 key；舊 key 垃圾值一律不認）。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var w=Number(localStorage.getItem("canvas-chat-panel-width.v2"));if(Number.isInteger(w)&&w>=320&&w<=720){document.documentElement.style.setProperty("--ws-panel-w",w+"px");}}catch(_){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
try{
window.__bootErrors=[];
window.addEventListener("error",function(e){window.__bootErrors.push(String(e.message).slice(0,300));try{localStorage.setItem("eimu_boot_err",JSON.stringify({t:Date.now(),m:String(e.message).slice(0,300),src:(e.filename||"").slice(-60)}))}catch(_){}});

window.addEventListener("unhandledrejection",function(e){window.__bootErrors.push("rej:"+String(e.reason).slice(0,200));});
setTimeout(function(){
  var w=window;
  if(w.__eimuHydrated)return;
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
},6000);
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
          {/* 首頁應用式滿屏（2026-09-10 F6）：body 是 flex 縱向殼（Navbar 自然高
              ＋ main 吃滿剩餘視口）。min-h-dvh 而非 h-dvh——視口過矮時 body 可
              長高、整頁滾動。其他頁面是文檔流根節點，作為 flex item 只是全寬
              自然高，行為等價 block。Toaster/PwaInstaller/Analytics 渲染 fixed
              或 null，不參與 flex 佈局。 */}
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
          <Toaster />
          <PwaInstaller />
        </AuthProvider>
        <Analytics />
      </body>
    </html>
  );
}
