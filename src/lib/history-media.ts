/** Preview requests only use sources accepted by next.config.mjs. Original URLs stay intact for playback/download. */
export function historyThumbnailProps(src: string, filmstrip = false): { src: string; srcSet?: string; sizes?: string } {
  let url: URL;
  try { url = new URL(src); } catch { return { src }; }
  const allowed = url.protocol === "https:" && !url.port && !url.username && !url.password && (
    /^[^.]+\.public\.blob\.vercel-storage\.com$/.test(url.hostname)
    || (url.hostname === "raw.githubusercontent.com" && url.pathname.startsWith("/freestylefly/awesome-gpt-image-2/"))
  );
  // SVG optimization is disabled by Next; data/blob/private URLs must remain direct.
  if (!allowed || /\.svg$/i.test(url.pathname)) return { src };
  const optimized = (width: number) => `/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=70`;
  const widths = filmstrip ? [64, 128] : [256, 384, 640, 750, 1080];
  return {
    src: optimized(filmstrip ? 128 : 640),
    srcSet: widths.map((width) => `${optimized(width)} ${width}w`).join(", "),
    sizes: filmstrip ? "56px" : "(min-width: 1280px) 25vw, (min-width: 900px) 33vw, (min-width: 480px) 50vw, 100vw",
  };
}

/** Retry the original once if an upstream image cannot be resized. */
export function retryOriginalHistoryImage(image: HTMLImageElement, original: string): boolean {
  if (!image.getAttribute("src")?.startsWith("/_next/image?")) return false;
  image.removeAttribute("srcset");
  image.removeAttribute("sizes");
  image.src = original;
  return true;
}
