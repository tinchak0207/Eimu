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
5. Bind `eimu.dev`

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

## eimu-site 站点发版（本机免 sudo，`deploy/vps/site-release.sh`）

本机构建镜像 → scp → VPS load/换装；**绝不在 VPS 构建**。本机 docker 系统守护进程不在、`sudo` 要密码时也能走：

1. `bash deploy/vps/site-release.sh engine` —— 体检引擎（系统 socket / rootless socket / subuid / userns）。
2. 无引擎：`engine-install`（下载与 `/usr/bin/dockerd` 同版本的 docker-rootless-extras 到 `~/.local/opt`，sha256 落盘）→ `engine-up`（用户态 rootless dockerd，`unix:///run/user/$UID/docker.sock`）。全程不用 sudo；替代方案是机主手动 `sudo systemctl start docker`。
3. `preflight --sha <commit> [--overlay-patch <p> --tag-suffix -ui2]` —— 只读闸：VPS 根盘 ≥3GiB、内存不塌方、网关在途=0、激活锁空闲、线上 revision 是候选祖先、线上带 overlay 时候选也要带。
4. `release --sha <commit> ... --check-absent /plugin/eimu/README.md::not_ready` —— 一次性：本机构建+冒烟 → 复检闸 → 上传 → 远端锁内 load、终检在途、停旧（改名 `eimu-site-prev-*` 保留）→ 起新 → 经 nginx 轮询 healthz；失败自动恢复旧容器，不重试。旧镜像保留作回滚锚，脚本从不 `rmi`。
5. 回滚：`rollback --to image-control-plane-generation-api:site-<sha9>[-ui2]`。
