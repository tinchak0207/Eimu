# Zero-to-Deploy Checklist

## Option A: Use an existing GitHub repository with a new branch

This is supported and is the easiest path if you do not want a new repo.

Recommended branch name:

```txt
codex/image-tinchak0207
```

### Suggested workflow

1. Copy this project into a folder inside your existing repo
2. Commit to a dedicated branch
3. Import that repo into Vercel
4. Set the production branch in Vercel to the branch you want to deploy from
5. Bind `image.tinchak0207.xyz`

## Option B: Keep `market` in the same repo

If your existing repo already powers `market.tinchak0207.xyz`, you can still:

- create a new branch for `image`
- or create a new directory/project inside the same monorepo

But it is cleaner if Vercel points only to the directory that contains this app.

## Required env vars

```env
IMAGE_API_KEY=...
IMAGE_API_BASE_URL=https://share-api.com/v1
IMAGE_API_MODEL=gpt-image-2
IMAGE_API_KEY_FALLBACK=...
IMAGE_API_BASE_URL_FALLBACK=https://happycode.vip/v1
```

## Health endpoint

```txt
/api/healthz
```

## Image generation endpoint

```txt
/api/generate-images
```
