# 工作流

[English](../en/workflows.md) · [简体中文](../zh-Hans/workflows.md) · [繁體中文](../zh-Hant/workflows.md) · [日本語](../ja/workflows.md) · [한국어](../ko/workflows.md)

工作流让后台处理过程可查看。

## 主要内容

- 在 Workflows 管理定义和触发器，在 Activity 查看执行状态。
- 本地扫描、元数据 Sync、远程 Sync、Cache、Fetch 和清理是独立运行。
- 消失的文件夹标记为 `missing`，重复代码保留在 Review。
- 每个 canonical Work 只保留一个排队或运行中的 Fetch，Activity 显示传输字节数。
- 只有声明支持恢复的工作流才支持检查点和重试。

Workflows 右上角的 Activity 打开桌面面板或手机底部面板。运行中的任务显示在上方，下方分为 **Needs attention** 和 **History**。待处理候选项、元数据问题和未确认失败进入前者；已解决的元数据运行提示自动解除，其他失败可按用户确认。History 保留原始执行状态。作品管理集中处理作品问题和元数据设置，并提供同步工作流快捷入口。

## 相关文档

- [媒体库 / ライブラリ](library.md)
- [来源 / ソース](sources.md)
