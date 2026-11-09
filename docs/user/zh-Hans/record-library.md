# 家庭视频

[English](../en/record-library.md) · [简体中文](record-library.md) · [繁體中文](../zh-Hant/record-library.md) · [日本語](../ja/record-library.md) · [한국어](../ko/record-library.md)

家庭视频是用于个人视频和图片的独立媒体库。它使用 `/record` 挂载点，不会把文件加入音频媒体库或任何作品。

## 设置

将主机目录挂载到 `/record`，打开**家庭视频**，然后选择**初始化根目录**。Kikoto 会写入 `.kikoto-record` 标记；只有显式初始化后才会开始扫描。生产环境的默认挂载如下：

```yaml
volumes:
  - ./record:/record
```

目录可以使用任意深度，页面会直接显示文件夹树：

```text
record/
├── artist1/
│   ├── folder-a/
│   └── folder-b/
└── artist2/
    └── folder-c/
```

## 扫描和 artwork

在页面中选择**扫描 record 媒体库**。扫描会作为持久工作流排队，并与正在运行的扫描合并。它按扩展名索引普通文件，跳过链接和 Kikoto 事务目录；根目录离线或扫描部分完成时会保留已有记录。只有完整扫描才会将已移除的目录和文件标记为缺失。

文件夹 artwork 使用以下图片名：`folder`、`poster` 或 `cover` 用作海报，`backdrop`、`fanart` 或 `background` 用作背景。支持的视频扩展名包括 `.mp4`、`.mkv`、`.webm`、`.mov`、`.avi`、`.m4v` 和 `.ts`；支持的图片扩展名包括 `.jpg`、`.jpeg`、`.png`、`.webp` 和 `.avif`。

选择视频后即可在页面中播放。播放位置按账户保存；全局音频播放器保持独立。
