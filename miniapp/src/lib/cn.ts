import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 与网页版 src/lib/utils.ts 的 cn 同一实作（clsx + tailwind-merge），冲突消解行为一致。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
