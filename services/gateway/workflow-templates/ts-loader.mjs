// ts-loader.mjs — node ESM resolve hook：为 bun 风格的 extensionless import 补上 .ts / /index.ts。
// 用于在没有 bun/tsx 的机器上以 node --experimental-transform-types 跑 gateway 的 .ts。
import { existsSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"

export async function resolve(specifier, context, next) {
  const isPath = specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")
  if (isPath && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      const target = specifier.startsWith("/") ? specifier : fileURLToPath(new URL(specifier, context.parentURL))
      if (existsSync(target) && statSync(target).isDirectory()) {
        try { return await next(specifier + "/index.ts", context) } catch {}
      }
      return await next(specifier + ".ts", context)
    } catch {}
  }
  return next(specifier, context)
}
