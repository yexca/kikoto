# 使用者指南

[English](../en/index.md) · [簡體中文](index.md) · [繁體中文](../zh-Hant/index.md) · [日本語](../ja/index.md) · [한국어](../ko/index.md)

本组文件介绍安裝方式和使用者可见的行為。若改动影响界面、可用操作或工作流程名称，请先更新英文頁面，再標记各译文待複核。

- [媒體庫](library.md)
- [作品详情](work-detail.md)
- [來源](sources.md)
- [社團](circles.md)
- [聲優](voices.md)
- [播放](playback.md)
- [設定](settings.md)
- [工作流程](workflows.md)

## 产品原则

- 同一作品即使同時存在 Local、Cache、Tracked 和遠程來源，也只顯示為一個統一項目。
- 遠程來源發生故障時，Local 和 Cache 状态仍应可用。
- 遠程來源操作必须明确：Sync 更新來源數據，Cache 生成缓存文件，Fetch 將选定文件提升到本地 data 树。
- 长時间运行或需要审核的操作应在 Activity 中可见。

## 相關文件

- [核心边界](../../architecture/core-boundaries.md)
- [來源存在状态](../../architecture/source-presence.md)
- [前端指南](../../development/frontend-guidelines.md)
