FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `COPY . .` 让本层每次都失效；.next/cache 放 BuildKit 快取挂载，next build
# 跨部署沿用 webpack 持久快取，改一行不再从零编译。
RUN --mount=type=cache,id=image-control-next-cache,target=/app/.next/cache npm run build

# Durable generation work must not live in the Next.js HTTP container. This target
# keeps the same source/dependencies but runs the Postgres-backed worker loop.
# 不在 npm ci 之后拆 node_modules（three 等被运行时间接引用，乱删会启动失败）。
# 瘦身只靠 .dockerignore：排除 *.mp4（public 下站点片除外）、*.out、tests、docs、
# playwright 报告。worker 不从 builder 复制 .next；前端构建产物只留在 builder/runner。
FROM deps AS generation-worker
WORKDIR /app
ENV NODE_ENV=production
COPY . .
# 开机先迁移再播种，然后才进 worker 循环。缺了这一步，pixai 模型没有
# supplier_capability，生图会一直回 overloaded —— 详见 tools/control-plane-bootstrap.ts。
CMD ["npm", "run", "generation:bootstrap"]

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
