# 快速開始

[English](../en/getting-started.md) · [簡體中文](getting-started.md)

## 環境要求

- Docker 和 Docker Compose。
- 本地開發可选：Go 1.26.6；Node.js 24.19.0 與 npm 11.17.0。

## 使用 Docker 运行

將 `docker-compose.yml` 下载到空目錄，然後拉取並啟動最新發布的 Docker Hub 映像，啟動前無需設定密碼：

```sh
docker compose up -d --pull always
```

預設映像為 `yexca/kikoto:latest`，發布流程會在每次公開發布時更新它。`docker compose up -d` 會拉取缺少的映像，並一律拉取 `latest`；`docker compose restart` 會重用目前容器的映像。升級固定標籤時也可使用 `--pull always`。如需可重現部署，請在 `.env` 中將 `KIKOTO_IMAGE` 固定為經過審核的版本或 digest：

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d --pull always
```

開啟前端：`http://127.0.0.1:7655`。首次啟動時頁面會顯示「設定 Kikoto」：輸入 `docker compose logs kikoto` 或 `config/setup-token` 中的一次性初始化權杖，再設定管理員使用者名稱和密碼。忘記密碼時請參閱[管理員初始化與復原](../../operations/security.md#administrator-setup-and-recovery)。

生产 Compose 會在 `7655` 端口同時發布 Web 应用和 API。`7659` 是容器內部的后端端口，只有開發 Compose 才會单独發布它。

默認挂载目錄：

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

如需公开只读实例，请使用 `deploy/compose/demo.yml`。它會拉取發布镜像並使用独立的 `./demo` 挂载目錄。將候选作品目錄放入 `./demo/data`；啟动流程只會验證並索引全年龄且永久免费的作品。参见 [Docker](../../operations/docker.md#demo-stack)。

## Android 客户端

签名 Android APK 附在項目的 GitHub Releases 中。客户端會將自身版本與连接的服務器比较：客户端较旧時提供匹配的 Release，客户端较新時提示更新服務器组件。網络失败時仍會保留单独的重新连接操作。

Kikoto 不會静默安裝 Android 软件包。打开 Release 並安裝 APK 始终是由使用者确認的 Android 系统流程。

## 首次設定媒體庫

1. 將受支援的音訊作品目錄放入 `data/`，或將每顆儲存磁碟掛載為 `data/` 下的資料夾（見下文）。
2. 啟動 Docker 堆疊並開啟前端。
3. 建立管理員後會開啟 **設定媒體庫**：
   - 選擇 **一般**（整個 `data/` 是一個媒體庫）或 **儲存池**（`data/` 下每個選取的第一層資料夾是獨立的磁碟或雲端硬碟）；儲存池模式下還要選擇接收新 Fetch 的 **Fetch 池**。找到本機作品後模式將固定。
   - 掃描媒體庫。掃描會發現本機作品，無需等待中繼資料提供者。
   - 可選：開始中繼資料同步，它在背景執行。
   - 決定是否在啟動時和資料夾變更時自動掃描。新安裝時兩者預設關閉，之後可在工作流程中開啟。

**稍後** 會關閉設定，下次造訪時再顯示。從舊版本升級的實例保持一般模式和原有掃描觸發器，不會顯示此設定。

### 儲存池

將每顆磁碟或雲端硬碟掛載為資料目錄下各自的資料夾，例如：

```yaml
volumes:
  - ./config:/config
  - ./cache:/cache
  - ./data:/data
  - /mnt/disk1:/data/disk1
  - /mnt/cloud:/data/cloud
```

Kikoto 會在每個選取的資料夾寫入 `.kikoto-pool` 標記。磁碟未掛載時資料夾為空且沒有標記，該池顯示為離線，掃描會保持其中作品不變，而不是標記為缺失。Fetch 在接收檔案的池內暫存和發佈，因此每次發佈都是同一顆磁碟上的重新命名。取得作品前請在 設定 -> 媒體庫 中選擇 Fetch 池，否則 Fetch 會提示需要設定的內容。

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
