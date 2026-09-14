# 快速開始

[English](../en/getting-started.md) · [簡體中文](getting-started.md)

## 環境要求

- Docker 和 Docker Compose。
- 本地開發可选：Go 1.26.6；Node.js 24.19.0 與 npm 11.17.0。

## 使用 Docker 运行

將 `docker-compose.yml` 下载到空目錄，然后拉取並啟动最新發布的 Docker Hub 镜像。在啟动前於该目錄创建 `.env`：

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
```

```sh
docker compose up -d --pull always
```

預設映像為 `yexca/kikoto:latest`，發布流程會在每次公開發布時更新它。`docker compose up -d` 會拉取缺少的映像，並一律拉取 `latest`；`docker compose restart` 會重用目前容器的映像。升級固定標籤時也可使用 `--pull always`。如需可重現部署，請在 `.env` 中將 `KIKOTO_IMAGE` 固定為經過審核的版本或 digest：

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d --pull always
```

打开前端：`http://127.0.0.1:7655`。

生产 Compose 會在 `7655` 端口同時發布 Web 应用和 API。`7659` 是容器內部的后端端口，只有開發 Compose 才會单独發布它。

默認挂载目錄：

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

如需公开只读实例，请使用 `docker-compose.demo.yaml`。它會拉取發布镜像並使用独立的 `./demo` 挂载目錄。將候选作品目錄放入 `./demo/data`；啟动流程只會验證並索引全年龄且永久免费的作品。参见 [Docker](../../operations/docker.md#demo-stack)。

## Android 客户端

签名 Android APK 附在項目的 GitHub Releases 中。客户端會將自身版本與连接的服務器比较：客户端较旧時提供匹配的 Release，客户端较新時提示更新服務器组件。網络失败時仍會保留单独的重新连接操作。

Kikoto 不會静默安裝 Android 软件包。打开 Release 並安裝 APK 始终是由使用者确認的 Android 系统流程。

## 首次掃描媒體庫

1. 將受支援的音頻作品目錄放入 `data/`。
2. 啟动 Docker 栈。
3. 打开前端。
4. 在 Workflows 中运行 Local library scan；它會發現本地作品並更新 Local 來源状态，无需等待元數據提供方。
5. 可选：单独运行 metadata sync 丰富已發現作品，或啟用掃描中默認關闭的 `Follow-up run`，在掃描完成后排队执行。

## 验證构建

以下命令用於验證源码检出。完整且一致的仓库检查请优先使用对应的 [Makefile](../../../Makefile) 目標。

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
- [媒體庫](library.md)
- [來源](sources.md)
