# 快速開始
[English](../en/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [日本語](../ja/getting-started.md) · [한국어](../ko/getting-started.md)

## 系統需求

- Docker 與 Docker Compose。
- 本機開發時另需（選用）：
  - Go 1.26.9。
  - Node.js 24.19.0 與 npm 11.17.0。

## 使用 Docker 執行

將 `docker-compose.yml` 下載到一個空資料夾，然後拉取並啟動最新發佈的 Docker Hub 映像檔。啟動前不需要事先設定密碼：

```sh
docker compose up -d
```

預設映像檔為 `yexca/kikoto:latest`，每次公開發佈時，發佈工作流程都會更新它。`docker compose up -d` 會拉取本機缺少的映像檔，並且一律重新拉取 `latest`；`docker compose restart` 則會沿用目前容器所使用的映像檔。若要升級到固定版本，請先把 `KIKOTO_IMAGE` 更新為想要的標籤或摘要，再執行 `docker compose up -d`。若需要可重現的部署，請在 `.env` 中將 `KIKOTO_IMAGE` 設為經過審查的版本或摘要：

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d
```

開啟：

- 前端：`http://127.0.0.1:7655`

首次啟動時，前端會顯示 **設定 Kikoto**。請輸入 `docker compose logs kikoto` 或 `config/setup-token` 中的一次性設定權杖，然後選擇管理員的使用者名稱與密碼。若要重設忘記的密碼，請參閱[管理員初始設定與復原](../../operations/security.md#administrator-setup-and-recovery)。

正式環境的 Compose 堆疊會在連接埠 `7655` 上同時提供網頁應用程式與 API。連接埠 `7659` 是容器內部的後端連接埠，只有開發用的 Compose 堆疊才會另外對外發佈。

預設的執行階段掛載如下：

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

若要架設公開的唯讀站台，請使用 `deploy/compose/demo.yml`。它會拉取已發佈的映像檔，並使用獨立的 `./demo` 掛載。請將候選作品資料夾放在 `./demo/data` 之下；專用的啟動工作流程只會驗證並建立索引給全年齡且永久免費的作品。請參閱 [Docker](../../operations/docker.md#demo-stack)。

## Android 用戶端

簽署過的 Android APK 會附加在專案的 GitHub Releases 上。用戶端會將自己的版本與所連線的伺服器比對。較舊的用戶端會提供對應的 Release，較新的用戶端則會指出需要更新的是伺服器。網路失敗時，仍會保留獨立的**重新連線**操作。

Kikoto 不會在背景靜默安裝 Android 套件。開啟 Release 並安裝其 APK，仍然是需要使用者確認的 Android 系統流程。

## iOS 用戶端

每個 GitHub Release 同時附有一個未簽署的 iOS IPA，檔名為 `kikoto-<version>-unsigned.ipa`。iOS 無法直接安裝下載的檔案；側載工具會在安裝時使用你自己的 Apple 帳號重新簽署。和 Android 用戶端一樣，它會將自己的版本與所連線的伺服器比對。

## 首次媒體庫設定

1. 將支援的音訊作品資料夾放在 `data/` 之下，或將每個儲存磁碟掛載為 `data/` 的子資料夾（見下文）。
2. 啟動 Docker 堆疊並開啟前端。
3. 管理員帳號建立後，會開啟 **設定媒體庫**：
   - 選擇 **一般**（整個 `data/` 目錄就是一個媒體庫）或 **儲存池**（`data/` 中每個選取的第一層資料夾各自是一顆磁碟或一個雲端硬碟）；在儲存池模式下，還要選擇接收新取得內容的 **Fetch 池**。之後若變更模式或 Fetch 池，系統會要求確認，並在網站進入維護狀態期間移動受影響的檔案。
   - 掃描媒體庫。掃描會發現本機作品，無需等待來源提供中繼資料。
   - 若升級時保留了先前的自訂工作流程，請檢視它們。Kikoto 可以把完全符合預製項目的工作流程轉換為停用的觸發器；無法對應的定義可以匯出。全新安裝，以及沒有自訂工作流程的升級，會略過這一步。
   - 可選擇啟動中繼資料同步，它會在背景執行。
   - 決定是否在啟動時以及資料夾變更時執行掃描。全新安裝時兩者預設皆為關閉，之後可在工作流程中開啟。

**稍後**會先關閉設定，直到下次造訪時再顯示。從舊版升級的站台會保留標準配置及其掃描觸發器，但會看到這個設定畫面，以便選擇是否改用儲存池。改用儲存池時，會在其餘設定步驟之前先執行一次新的本機掃描。移動期間，管理員會看到進度；其他使用者則會看到維護通知。移動失敗時，可在檢查磁碟後重試。

### 儲存池

將每顆磁碟或雲端硬碟掛載為資料目錄中各自獨立的資料夾，例如：

```yaml
volumes:
  - ./config:/config
  - ./cache:/cache
  - ./data:/data
  - /mnt/disk1:/data/disk1
  - /mnt/cloud:/data/cloud
```

Kikoto 會在每個選取的資料夾中寫入 `.kikoto-pool` 標記。磁碟未掛載時，其資料夾是空的且沒有標記，因此該儲存池會顯示為離線，掃描時會保持其作品不變，而不是回報它們已遺失。取得作業會在接收檔案的儲存池內暫存並發佈，因此每次發佈都是同一顆磁碟上的重新命名。請在取得之前，先於設定 -> 媒體庫中選擇 Fetch 池；在此之前，取得功能會說明需要設定什麼。

## 驗證建置

以下指令用於驗證原始碼簽出。若要進行完整且一致的儲存庫檢查，請優先使用對應的 [Makefile](../../../Makefile) 目標。

後端（僅限原始碼簽出）：

```sh
cd backend
go test ./...
```

前端（僅限原始碼簽出）：

```sh
cd frontend
npm ci --strict-allow-scripts
npm run build
```

## 延伸閱讀

- [設定](../../operations/configuration.md)
- [Docker](../../operations/docker.md)
- [媒體庫](library.md)
- [來源](sources.md)
