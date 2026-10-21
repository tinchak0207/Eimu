import type { useAuth } from "@/hooks/use-auth";
import type { useImageGeneration } from "@/hooks/use-image-generation";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { PromoIntroOverlay } from "@/components/promo/PromoIntroOverlay";
import { WelcomeGiftDialog } from "@/components/welcome/WelcomeGiftDialog";
import { cn } from "@/lib/utils";

interface ImagePlaygroundFloatingOverlaysProps {
  pwaHandoffUrl: string | null;
  refresh: ReturnType<typeof useAuth>["refresh"];
  setPwaHandoffUrl: React.Dispatch<React.SetStateAction<string | null>>;
  promoOpen: boolean;
  handlePromoTrial: (text: string) => void;
  handlePromoDismiss: () => void;
  isLoggedIn: boolean;
  handlePromoLoginDismiss: () => void;
  welcomeGiftOpen: boolean;
  welcomeGift: ReturnType<typeof useAuth>["welcomeGift"];
  handleWelcomeGiftStart: () => void;
  handleWelcomeGiftSeen: () => void;
  showProgress: boolean;
  isLoading: boolean;
  failedProviders: ReturnType<typeof useImageGeneration>["failedProviders"];
  renderState: string;
}

export function ImagePlaygroundFloatingOverlays({ P }: { P: ImagePlaygroundFloatingOverlaysProps }) {
  const { pwaHandoffUrl, refresh, setPwaHandoffUrl, promoOpen, handlePromoTrial, handlePromoDismiss, isLoggedIn, handlePromoLoginDismiss, welcomeGiftOpen, welcomeGift, handleWelcomeGiftStart, handleWelcomeGiftSeen, showProgress, isLoading, failedProviders, renderState } = P;

  return (
    <>
      {pwaHandoffUrl && (
        <PwaHandoffPanel
          loginUrl={pwaHandoffUrl}
          onSuccess={() => {
            setPwaHandoffUrl(null);
            refresh().catch(() => {});
          }}
          onClose={() => setPwaHandoffUrl(null)}
        />
      )}

      {/* 未登入新访客的进站宣传片：z-[120] 在 navbar(z-80) 与既有 portal 弹层(z-90) 之上，
          浮层开著时底下的首页仍完整挂载——收尾的「开始试玩」要当场把话预填进输入框，
          整页跳转会把那个输入框连同画布一起重建。 */}
      {promoOpen && (
        <PromoIntroOverlay
          onTrial={handlePromoTrial}
          onDismiss={handlePromoDismiss}
          needsLogin={!isLoggedIn}
          onLoginDismiss={handlePromoLoginDismiss}
        />
      )}

      {/* 新人礼首登弹窗（已发放、未展示才弹）。标题/正文/币数全部来自服务端，
          这里不写死任何数字；与宣传片浮层同层级（z-[95] 的 portal）。 */}
      {welcomeGiftOpen && welcomeGift && welcomeGift.title && welcomeGift.body && (
        <WelcomeGiftDialog
          open
          title={welcomeGift.title}
          body={welcomeGift.body}
          onStart={handleWelcomeGiftStart}
          onLater={handleWelcomeGiftSeen}
        />
      )}

      {(!showProgress && (isLoading || failedProviders.length > 0)) && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4 sm:bottom-6">
          <div className="pointer-events-auto lg-bar flex items-center gap-3 rounded-ios-4xl px-5 py-2.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isLoading ? "bg-[#34C759] animate-pulse" : "bg-[#FF3B30]",
              )}
            />
            <span className="text-ios-footnote text-[rgba(0,0,0,0.58)]">{renderState}</span>
          </div>
        </div>
      )}
    </>
  );
}
