# Deployment Plan

## Recommended split

- `image.tinchak0207.xyz`
  - Deploy on **Vercel**
  - Use for this Next.js image generation frontend
- `market.tinchak0207.xyz`
  - Keep on **Render**
  - Suitable for services that still depend on backend + database

This avoids putting the image frontend behind Render free cold starts.

## Part 1: Deploy `image.tinchak0207.xyz` to Vercel

1. Push this repository to GitHub.
2. Import the repo in Vercel.
3. Set these environment variables in Vercel:

```env
IMAGE_API_KEY=your_primary_api_key
IMAGE_API_BASE_URL=https://share-api.com/v1
IMAGE_API_MODEL=gpt-image-2

IMAGE_API_KEY_FALLBACK=your_fallback_api_key
IMAGE_API_BASE_URL_FALLBACK=https://happycode.vip/v1
```

4. Deploy once and confirm the generated `*.vercel.app` URL works.
5. In Vercel project settings, add domain:

```txt
image.tinchak0207.xyz
```

6. In your DNS provider, create the CNAME record required by Vercel.
7. Wait until Vercel marks the domain as valid.

## Part 2: Keep `market.tinchak0207.xyz` on Render

If `market` still needs backend + DB, keep it on Render.

Recommended:

- Render Web Service: paid if you want no cold starts
- Render Postgres: non-free for production stability

If you want to import this repo into Render directly, a starter config is included:

- [render.yaml](</C:/Users/user/Documents/New project/image-tinchak0207/render.yaml>)

## Part 3: Free keepalive for Render

If you must stay on Render free temporarily:

- Use the included Cloudflare Worker keepalive
- Ping a real health endpoint, not `/robots.txt`

Use:

- [deploy/cloudflare-keepalive/worker.js](</C:/Users/user/Documents/New project/image-tinchak0207/deploy/cloudflare-keepalive/worker.js>)
- [deploy/cloudflare-keepalive/wrangler.toml.example](</C:/Users/user/Documents/New project/image-tinchak0207/deploy/cloudflare-keepalive/wrangler.toml.example>)

### Target endpoint

Use this endpoint on the Render service:

```txt
https://market.tinchak0207.xyz/api/healthz
```

If the backend does not yet expose `/api/healthz`, add one first.

### Cloudflare Worker deployment

1. Install Wrangler locally:

```bash
npm install -g wrangler
```

2. Copy `wrangler.toml.example` to `wrangler.toml`
3. Replace `RENDER_HEALTHCHECK_URL`
4. Run:

```bash
wrangler deploy
```

5. Confirm Cron Trigger is active

The default cron runs every 10 minutes:

```txt
*/10 * * * *
```

## Part 4: Health checks

This repo already includes:

- [src/app/api/healthz/route.ts](</C:/Users/user/Documents/New project/image-tinchak0207/src/app/api/healthz/route.ts>)

You can verify locally:

```txt
http://localhost:3000/api/healthz
```

Or run:

```bash
npm run healthz
```

To verify real image generation locally:

```bash
npm run smoke:image
```

## Important reality check

Render free cold starts are not truly solved by GitHub Actions.

Free keepalive is only a workaround.

If `market.tinchak0207.xyz` is production-critical:

1. Upgrade the Render service
2. Or move the frontend to Vercel and keep only the backend/API on Render
