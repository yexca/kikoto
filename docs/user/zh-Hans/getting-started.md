# 快速开始

[English](../en/getting-started.md) · [简体中文](getting-started.md)

## 环境要求

- Docker 和 Docker Compose。
- 本地开发可选：Go 1.26.6；Node.js 24.19.0 与 npm 11.17.0。

## 使用 Docker 运行

将 `docker-compose.yml` 下载到空目录，然后拉取并启动最新发布的 Docker Hub 镜像。在启动前于该目录创建 `.env`：

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
```

```sh
docker compose up -d --pull always
```

默认镜像为 `yexca/kikoto:latest`，发布流程会在每次公开发布时更新它。`docker compose up -d` 会拉取缺少的镜像，并始终拉取 `latest`；`docker compose restart` 会复用当前容器的镜像。升级固定标签时也可使用 `--pull always`。如需可复现部署，请在 `.env` 中将 `KIKOTO_IMAGE` 固定为经过审核的版本或 digest：

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d --pull always
```

打开前端：`http://127.0.0.1:7655`。

生产 Compose 会在 `7655` 端口同时发布 Web 应用和 API。`7659` 是容器内部的后端端口，只有开发 Compose 才会单独发布它。

默认挂载目录：

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

如需公开只读实例，请使用 `docker-compose.demo.yaml`。它会拉取发布镜像并使用独立的 `./demo` 挂载目录。将候选作品目录放入 `./demo/data`；启动流程只会验证并索引全年龄且永久免费的作品。参见 [Docker](../../operations/docker.md#demo-stack)。

## Android 客户端

签名 Android APK 附在项目的 GitHub Releases 中。客户端会将自身版本与连接的服务器比较：客户端较旧时提供匹配的 Release，客户端较新时提示更新服务器组件。网络失败时仍会保留单独的重新连接操作。

Kikoto 不会静默安装 Android 软件包。打开 Release 并安装 APK 始终是由用户确认的 Android 系统流程。

## 首次扫描媒体库

1. 将受支持的音频作品目录放入 `data/`。
2. 启动 Docker 栈。
3. 打开前端。
4. 在 Workflows 中运行 Local library scan；它会发现本地作品并更新 Local 来源状态，无需等待元数据提供方。
5. 可选：单独运行 metadata sync 丰富已发现作品，或启用扫描中默认关闭的 `Follow-up run`，在扫描完成后排队执行。

## 验证构建

以下命令用于验证源码检出。完整且一致的仓库检查请优先使用对应的 [Makefile](../../../Makefile) 目标。

后端（仅源码检出）：

```sh
cd backend
go test ./...
```

前端（仅源码检出）：

```sh
cd frontend
npm ci --strict-allow-scripts
npm run build
```

## 后续阅读

- [配置](../../operations/configuration.md)
- [Docker](../../operations/docker.md)
- [媒体库](library.md)
- [来源](sources.md)
