# 家庭影片

[English](../en/record-library.md) · [简体中文](../zh-Hans/record-library.md) · [繁體中文](record-library.md) · [日本語](../ja/record-library.md) · [한국어](../ko/record-library.md)

家庭影片是用於個人影片和圖片的獨立媒體庫。它使用 `/record` 掛載點，不會將檔案加入音訊媒體庫或任何作品。

## 設定

將主機資料夾掛載到 `/record`，開啟**家庭影片**，然後選擇**初始化根目錄**。Kikoto 會寫入 `.kikoto-record` 標記；只有明確初始化後才會開始掃描。正式環境的預設掛載如下：

```yaml
volumes:
  - ./record:/record
```

資料夾可以使用任意深度，頁面會直接顯示資料夾樹：

```text
record/
├── artist1/
│   ├── folder-a/
│   └── folder-b/
└── artist2/
    └── folder-c/
```

## 掃描和 artwork

在頁面中選擇**掃描 record 媒體庫**。掃描會作為持久工作流程排隊，並與正在執行的掃描合併。它按副檔名索引一般檔案，跳過連結和 Kikoto 交易目錄；根目錄離線或掃描只完成部分時會保留既有記錄。只有完整掃描才會將已移除的資料夾和檔案標記為遺失。

資料夾 artwork 使用以下圖片名稱：`folder`、`poster` 或 `cover` 作為海報，`backdrop`、`fanart` 或 `background` 作為背景。支援的影片副檔名包括 `.mp4`、`.mkv`、`.webm`、`.mov`、`.avi`、`.m4v` 和 `.ts`；支援的圖片副檔名包括 `.jpg`、`.jpeg`、`.png`、`.webp` 和 `.avif`。

選擇影片後即可在頁面中播放。播放位置按帳戶保存；全域音訊播放器保持獨立。
