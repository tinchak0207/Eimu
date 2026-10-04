/**
 * ReferenceImage 建构点共用的自然尺寸测量（blob URL 图片解码取 naturalWidth/Height）。
 * 与 ReferenceImageUpload.tsx 的本地实作同源（该档由并发任务持有，留本地副本不动）。
 * 载入失败回 null，不阻塞参考图入列。
 */
export function measureNaturalSize(
  url: string,
): Promise<{ naturalWidth: number; naturalHeight: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
