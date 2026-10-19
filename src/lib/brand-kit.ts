// 品牌资产：B 端用户跨任务复用的品牌约束信息，持久化到 localStorage。

export interface BrandKit {
  brandName: string;
  colors: string;
  tone: string;
  bannedWords: string;
}

const STORAGE_KEY = "pro-workstation-brand-kit-v1";

export const EMPTY_BRAND_KIT: BrandKit = {
  brandName: "",
  colors: "",
  tone: "",
  bannedWords: "",
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function loadBrandKit(): BrandKit {
  // SSR 环境无 localStorage，直接返回空品牌资产
  if (typeof window === "undefined") return { ...EMPTY_BRAND_KIT };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_BRAND_KIT };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { ...EMPTY_BRAND_KIT };
    }
    const record = parsed as Record<string, unknown>;
    return {
      brandName: asString(record.brandName),
      colors: asString(record.colors),
      tone: asString(record.tone),
      bannedWords: asString(record.bannedWords),
    };
  } catch {
    return { ...EMPTY_BRAND_KIT };
  }
}

export function saveBrandKit(kit: BrandKit): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kit));
  } catch {
    // 存储不可用（如隐私模式配额受限）时静默忽略
  }
}

export function clearBrandKit(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上，静默忽略
  }
}

export function hasBrandKit(kit: BrandKit): boolean {
  return (
    kit.brandName.trim() !== "" ||
    kit.colors.trim() !== "" ||
    kit.tone.trim() !== "" ||
    kit.bannedWords.trim() !== ""
  );
}

export function buildBrandContext(kit: BrandKit): string {
  if (!hasBrandKit(kit)) return "";
  const parts: string[] = [];
  const brandName = kit.brandName.trim();
  const colors = kit.colors.trim();
  const tone = kit.tone.trim();
  const bannedWords = kit.bannedWords.trim();
  if (brandName) parts.push(`品牌名称：${brandName}。`);
  if (colors) parts.push(`品牌主色：${colors}。`);
  if (tone) parts.push(`品牌调性：${tone}。`);
  if (bannedWords) parts.push(`禁止出现：${bannedWords}。`);
  return parts.join("");
}
