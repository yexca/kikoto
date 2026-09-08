# 用户指南

[English](../en/index.md) · [简体中文](index.md) · [繁體中文](../zh-Hant/index.md) · [日本語](../ja/index.md) · [한국어](../ko/index.md)

本组文档介绍安装方式和用户可见的行为。若改动影响界面、可用操作或工作流名称，请先更新英文页面，再标记各译文待复核。

- [媒体库](library.md)
- [作品详情](work-detail.md)
- [来源](sources.md)
- [社团](circles.md)
- [声优](voices.md)
- [播放](playback.md)
- [设置](settings.md)
- [工作流](workflows.md)

## 产品原则

- 同一作品即使同时存在 Local、Cache、Tracked 和远程来源，也只显示为一个统一项目。
- 远程来源发生故障时，Local 和 Cache 状态仍应可用。
- 远程来源操作必须明确：Sync 更新来源数据，Cache 生成缓存文件，Fetch 将选定文件提升到本地 data 树。
- 长时间运行或需要审核的操作应在 Activity 中可见。

## 相关文档

- [核心边界](../../architecture/core-boundaries.md)
- [来源存在状态](../../architecture/source-presence.md)
- [前端指南](../../development/frontend-guidelines.md)
