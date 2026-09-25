# 快速开始

[English](../en/getting-started.md) · [简体中文](getting-started.md)

## 环境要求

- Docker 和 Docker Compose。
- 本地开发可选：Go 1.26.6；Node.js 24.19.0 与 npm 11.17.0。

## 使用 Docker 运行

将 `docker-compose.yml` 下载到空目录，然后拉取并启动最新发布的 Docker Hub 镜像，启动前无需设置密码：

```sh
docker compose up -d --pull always
```

默认镜像为 `yexca/kikoto:latest`，发布流程会在每次公开发布时更新它。`docker compose up -d` 会拉取缺少的镜像，并始终拉取 `latest`；`docker compose restart` 会复用当前容器的镜像。升级固定标签时也可使用 `--pull always`。如需可复现部署，请在 `.env` 中将 `KIKOTO_IMAGE` 固定为经过审核的版本或 digest：

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d --pull always
```

打开前端：`http://127.0.0.1:7655`。首次启动时页面会显示“设置 Kikoto”：输入 `docker compose logs kikoto` 或 `config/setup-token` 中的一次性初始化令牌，再设置管理员用户名和密码。忘记密码时请参阅[管理员初始化与恢复](../../operations/security.md#administrator-setup-and-recovery)。

生产 Compose 会在 `7655` 端口同时发布 Web 应用和 API。`7659` 是容器内部的后端端口，只有开发 Compose 才会单独发布它。

默认挂载目录：

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

如需公开只读实例，请使用 `deploy/compose/demo.yml`。它会拉取发布镜像并使用独立的 `./demo` 挂载目录。将候选作品目录放入 `./demo/data`；启动流程只会验证并索引全年龄且永久免费的作品。参见 [Docker](../../operations/docker.md#demo-stack)。

## Android 客户端

签名 Android APK 附在项目的 GitHub Releases 中。客户端会将自身版本与连接的服务器比较：客户端较旧时提供匹配的 Release，客户端较新时提示更新服务器组件。网络失败时仍会保留单独的重新连接操作。

Kikoto 不会静默安装 Android 软件包。打开 Release 并安装 APK 始终是由用户确认的 Android 系统流程。

## 首次设置媒体库

1. 将受支持的音频作品目录放入 `data/`，或将每块存储盘挂载为 `data/` 下的文件夹（见下文）。
2. 启动 Docker 栈并打开前端。
3. 创建管理员后会打开 **设置媒体库**：
   - 选择 **普通**（整个 `data/` 是一个媒体库）或 **存储池**（`data/` 下每个选中的一级文件夹是独立的磁盘或云盘）；存储池模式下还要选择接收新 Fetch 的 **Fetch 池**。找到本地作品后模式将固定。
   - 扫描媒体库。扫描会发现本地作品，无需等待元数据提供方。
   - 可选：开始元数据同步，它在后台运行。
   - 决定是否在启动时和文件夹变化时自动扫描。新安装时两者默认关闭，之后可在工作流中开启。

**稍后** 会关闭设置，下次访问时再显示。从旧版本升级的实例保持普通模式和原有扫描触发器，不会显示此设置。

### 存储池

将每块磁盘或云盘挂载为数据目录下各自的文件夹，例如：

```yaml
volumes:
  - ./config:/config
  - ./cache:/cache
  - ./data:/data
  - /mnt/disk1:/data/disk1
  - /mnt/cloud:/data/cloud
```

Kikoto 会在每个选中的文件夹写入 `.kikoto-pool` 标记。磁盘未挂载时文件夹为空且没有标记，该池显示为离线，扫描会保持其中作品不变，而不是标记为缺失。Fetch 在接收文件的池内暂存和发布，因此每次发布都是同一块磁盘上的重命名。获取作品前请在 设置 -> 媒体库 中选择 Fetch 池，否则 Fetch 会提示需要配置的内容。

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
