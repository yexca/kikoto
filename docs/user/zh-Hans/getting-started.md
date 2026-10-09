# 入门指南
[English](../en/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [日本語](../ja/getting-started.md) · [한국어](../ko/getting-started.md)

## 环境要求

- Docker 和 Docker Compose。
- 本地开发可选：
  - Go 1.26.9。
  - Node.js 24.19.0 及 npm 11.17.0。

## 使用 Docker 运行

将 `docker-compose.yml` 下载到一个空目录，然后拉取并启动 Docker Hub 上最新发布的镜像。启动前无需设置密码：

```sh
docker compose up -d
```

默认镜像是 `yexca/kikoto:latest`，发布工作流会在每次公开发布时更新它。`docker compose up -d` 会拉取缺失的镜像，并且始终拉取 `latest`；`docker compose restart` 则沿用当前的容器镜像。升级到固定版本时，请先把 `KIKOTO_IMAGE` 改为所需的标签或摘要，再运行 `docker compose up -d`。若要获得可复现的部署，请在 `.env` 中把 `KIKOTO_IMAGE` 设置为经过审阅的版本或摘要：

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d
```

打开：

- 前端：`http://127.0.0.1:7655`

首次启动时，前端会显示**设置 Kikoto**。请输入 `docker compose logs kikoto` 输出或 `config/setup-token` 中的一次性初始化令牌，然后选择管理员用户名和密码。如需重置忘记的密码，请参阅[管理员初始化与恢复](../../operations/security.md#administrator-setup-and-recovery)。

生产环境的 Compose 部署会在端口 `7655` 上同时提供 Web 应用和 API。端口 `7659` 是容器内部的后端端口，仅由开发环境的 Compose 部署单独发布。

默认的运行时挂载如下：

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

如需公开的只读实例，请使用 `deploy/compose/demo.yml`。它会拉取已发布的镜像，并使用独立的 `./demo` 挂载。请把候选作品文件夹放在 `./demo/data` 下；专用的启动工作流只会验证并索引适合所有年龄段且永久免费的作品。参见 [Docker](../../operations/docker.md#demo-stack)。

## Android 客户端

已签名的 Android APK 会附在项目的 GitHub Releases 中。客户端会将自身版本与所连接的服务器比较：客户端较旧时，会提示对应的 Release；客户端较新时，则会指出需要更新的是服务器。网络故障时会保留单独的“重新连接”操作。

Kikoto 不会静默安装 Android 安装包。打开 Release 并安装其中的 APK，仍是由用户确认的 Android 系统流程。

## iOS 客户端

每个 GitHub Release 还包含一个未签名的 iOS IPA，文件名为 `kikoto-<version>-unsigned.ipa`。iOS 无法直接安装下载下来的 IPA；需要由侧载工具在安装时用你自己的 Apple 账户重新签名。与 Android 客户端一样，它会将自身版本与所连接的服务器比较。

## 首次设置媒体库

1. 将受支持的音频作品文件夹放到 `data/` 下，或者把每块存储磁盘挂载为 `data/` 的一个子文件夹（见下文）。
2. 启动 Docker 部署并打开前端。
3. 管理员账户创建后，会打开**设置媒体库**：
   - 选择**普通**（整个 `data/` 目录是一个媒体库）或**存储池**（`data/` 下每个选中的一级文件夹是各自独立的磁盘或云盘）；在存储池模式下，还要选择接收新 Fetch 的 **Fetch 池**。之后若更改模式或 Fetch 池，会要求确认，并在站点处于维护状态期间移动受影响的文件。
   - 扫描媒体库。扫描会发现本地作品，而无需等待提供方的元数据。
   - 如果升级时保留了早期的自定义工作流，请审阅它们。Kikoto 可以把与预制工作流完全匹配的项转换为已停用的触发器；无法匹配的定义可以导出。全新安装以及没有自定义工作流的升级会跳过这一步。
   - 可选择启动元数据同步，它会在后台运行。
   - 决定是否在启动时以及文件夹发生变化时运行扫描。新安装时两者默认关闭，之后可以在“工作流”中开启。

**稍后**会关闭设置，直到下次访问时再次出现。从早期版本升级的实例会保留标准布局及其扫描触发器，但会看到这个设置，以便选择是否迁移到存储池。迁移到存储池会在其余设置步骤之前运行一次新的本地扫描。迁移期间，管理员可以看到进度；其他用户会看到维护提示。迁移失败后，可以在检查磁盘后重试。

### 存储池

把每块磁盘或云盘挂载为数据目录下各自的文件夹，例如：

```yaml
volumes:
  - ./config:/config
  - ./cache:/cache
  - ./data:/data
  - /mnt/disk1:/data/disk1
  - /mnt/cloud:/data/cloud
```

Kikoto 会在每个选中的文件夹中写入一个 `.kikoto-pool` 标记。磁盘未挂载时，其文件夹为空且没有标记，因此该存储池会显示为离线，扫描也会保持其作品不变，而不是报告它们缺失。Fetch 在接收文件的存储池内暂存并发布，因此每次发布都是同一块磁盘上的重命名。进行 Fetch 之前，请先在“设置 -> 媒体库”中选择 Fetch 池；在此之前，Fetch 会提示需要配置什么。

## 验证构建

以下命令用于验证源码检出。如需完整且一致的仓库检查，请优先使用相应的 [Makefile](../../../Makefile) 目标。

后端（仅限源码检出）：

```sh
cd backend
go test ./...
```

前端（仅限源码检出）：

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
