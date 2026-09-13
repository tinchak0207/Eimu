/**
 * ReferenceImage 建構點共用的自然尺寸測量（blob URL 圖片解碼取 naturalWidth/Height）。
 * 與 ReferenceImageUpload.tsx 的本地實作同源（該檔由並發任務持有，留本地副本不動）。
 * 載入失敗回 null，不阻塞參考圖入列。
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
