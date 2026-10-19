# Deployment

自托管部署步骤见 [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)。

可用的部署模板：

- `deploy/vps/docker-compose.yml`：站点、worker、账户系统与反向代理。
- `deploy/vps/control-plane-compose.yml`：Postgres、控制面 API 与 worker。
- `deploy/vps/Dockerfile`：Next.js standalone runner 与 generation worker 两个目标。
- `deploy/imagesite/nginx/default.conf`：Nginx 反向代理示例。
- `render.yaml`：Render 单服务示例。

官方托管服务 [eimu.dev](https://eimu.dev/) 的部署拓扑不随本仓库发布；本仓库只提供可复现的通用模板。
