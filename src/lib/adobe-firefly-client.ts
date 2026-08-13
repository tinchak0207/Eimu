const ADOBE_EMBED_SDK_URL = "https://cc-embed.adobe.com/sdk/v4/CCEverywhere.js";
const ADOBE_PUBLISH_ID = "image-studio-firefly-publish";
const ADOBE_OVERLAY_TAG_PREFIX = "CC-EVERYWHERE-CONTAINER-";

type AdobePublishParams = {
  asset?: Array<{ data?: string }>;
};

type AdobeEmbedModule = {
  createImageFromText: (appConfig: object, exportConfig: object[]) => void;
};

type AdobeInitializeConfig = {
  loginMode?: "delayed";
  skipBrowserSupportCheck?: boolean;
};

declare global {
  interface Window {
    CCEverywhere?: {
      initialize: (
        hostInfo: { clientId: string; appName: string },
        config: AdobeInitializeConfig,
      ) => Promise<{ module: AdobeEmbedModule }>;
    };
  }
}

let sdkLoadPromise: Promise<void> | undefined;
let adobeModulePromise: Promise<AdobeEmbedModule> | undefined;

export function normalizeAdobeImageData(image: string) {
  return image.replace(/^data:[^,]*;base64,/i, "");
}

function loadAdobeEmbedSdk() {
  if (window.CCEverywhere) return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ADOBE_EMBED_SDK_URL;
    script.async = true;
    script.onload = () => window.CCEverywhere ? resolve() : reject(new Error("Adobe Embed SDK did not initialize."));
    script.onerror = () => reject(new Error("Adobe Embed SDK failed to load."));
    document.head.append(script);
  });
  return sdkLoadPromise;
}

function isAdobeOverlayHost(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.tagName.startsWith(ADOBE_OVERLAY_TAG_PREFIX);
}

function takeOverAdobeViewport() {
  const FULLSCREEN_CSS = `
    #cc-everywhere-root {
      inset: 0 !important;
      width: 100vw !important;
      height: 100dvh !important;
      max-width: none !important;
      max-height: none !important;
      padding: 0 !important;
      border-radius: 0 !important;
    }
    #cc-everywhere-iframe-container {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      border-radius: 0 !important;
    }
    #cc-everywhere-iframe {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      border-radius: 0 !important;
    }
  `;

  const adoptFullscreenStyle = (root: ShadowRoot) => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(FULLSCREEN_CSS);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      // Fallback: append a <style> element
      if (!root.querySelector("[data-adobe-firefly-fullscreen]")) {
        const style = document.createElement("style");
        style.dataset.adobeFireflyFullscreen = "";
        style.textContent = FULLSCREEN_CSS;
        root.append(style);
      }
    }
  };

  const enforceInlineFullscreen = (root: ShadowRoot) => {
    const setImportant = (el: HTMLElement, props: Record<string, string>) => {
      for (const [key, value] of Object.entries(props)) {
        el.style.setProperty(key, value, "important");
      }
    };

    const rootEl = root.getElementById("cc-everywhere-root");
    if (rootEl) {
      setImportant(rootEl, {
        inset: "0", width: "100vw", height: "100dvh",
        "max-width": "none", "max-height": "none",
        padding: "0", "border-radius": "0",
      });
    }

    const container = root.getElementById("cc-everywhere-iframe-container");
    if (container) {
      setImportant(container, {
        width: "100%", height: "100%",
        "max-width": "none", "max-height": "none",
        margin: "0", "border-radius": "0",
      });
    }

    const iframe = root.getElementById("cc-everywhere-iframe");
    if (iframe) {
      setImportant(iframe, {
        width: "100%", height: "100%",
        "max-width": "none", "max-height": "none",
        "border-radius": "0",
      });
    }
  };

  const elevate = (node: Node) => {
    if (!isAdobeOverlayHost(node)) return;
    Object.assign(node.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100dvh",
      zIndex: "2147483647",
      overflow: "hidden",
    });

    const root = node.shadowRoot;
    if (!root) return;

    // 1. Inject via adoptedStyleSheets (highest priority in Shadow DOM cascade)
    adoptFullscreenStyle(root);

    // 2. Directly set inline !important styles on known elements
    enforceInlineFullscreen(root);

    // 3. Watch for SDK re-renders that might reset inline styles
    const shadowObserver = new MutationObserver(() => enforceInlineFullscreen(root));
    shadowObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });

    // 4. Re-apply on window resize (SDK may recalculate layout)
    const onResize = () => enforceInlineFullscreen(root);
    window.addEventListener("resize", onResize);

    // Store cleanup
    const cleanup = () => {
      shadowObserver.disconnect();
      window.removeEventListener("resize", onResize);
    };
    node.dataset.adobeFireflyCleanup = ""; // marker for cleanup tracking
    return cleanup;
  };

  const cleanups: Array<() => void> = [];
  Array.from(document.body.children).forEach((child) => {
    const cleanup = elevate(child);
    if (cleanup) cleanups.push(cleanup);
  });

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((child) => {
        const cleanup = elevate(child);
        if (cleanup) cleanups.push(cleanup);
      });
    });
  });
  observer.observe(document.body, { childList: true });

  return () => {
    observer.disconnect();
    cleanups.forEach((fn) => fn());
  };
}

export async function generateAdobeFireflyImage(prompt: string) {
  const clientId = process.env.NEXT_PUBLIC_ADOBE_EMBED_CLIENT_ID?.trim();
  if (!clientId) throw new Error("Adobe Firefly is not configured.");

  try {
  } catch {
    // Token fetch failed — SDK will show its own login dialog
  }

  if (!adobeModulePromise) {
    adobeModulePromise = (async () => {
      await loadAdobeEmbedSdk();
      const result = await window.CCEverywhere!.initialize(
        { clientId, appName: "Project 1" },
        { skipBrowserSupportCheck: true, loginMode: "delayed" },
      );
      return result.module;
    })().catch((error) => {
      adobeModulePromise = undefined;
      throw error;
    });
  }

  const adobeModule = await adobeModulePromise;
  const releaseViewport = takeOverAdobeViewport();

  return new Promise<{ image: string; endpointLabel: string }>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      releaseViewport();
      callback();
    };

    adobeModule.createImageFromText({
      appVersion: "2",
      promptText: prompt,
      thumbnailOptions: ["rich-preview", "publish"],
      publishConfig: { id: ADOBE_PUBLISH_ID, label: "Save image" },
      callbacks: {
        onCancel: () => finish(() => reject(new Error("Adobe Firefly generation cancelled."))),
        onError: (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
        onPublish: (_intent: unknown, publishParams: AdobePublishParams) => {
          const image = publishParams.asset?.[0]?.data;
          if (!image) return finish(() => reject(new Error("Adobe Firefly did not return an image.")));
          finish(() => resolve({ image: normalizeAdobeImageData(image), endpointLabel: "adobe-embed" }));
        },
      },
    }, [
      {
        id: ADOBE_PUBLISH_ID,
        label: "Save image",
        action: { target: "publish", outputType: "base64", closeTargetOnExport: true },
        style: { uiType: "button" },
      },
    ]);
  });
}
