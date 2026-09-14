# 播放

[English](../en/playback.md) · [简体中文](../zh-Hans/playback.md) · [繁體中文](../zh-Hant/playback.md) · [日本語](../ja/playback.md) · [한국어](../ko/playback.md)

播放由全局浏览器音频播放器处理。

## 主要内容

- Local 和 Cache 音频支持 HTTP Range，兼容格式会直接播放。
- 本地和已缓存的非兼容音频由 FFmpeg 生成完整 MP3 缓存，提供总时长、HTTP Range 跳转、续播和播放结束后自动下一首。
- 首次播放需要等待准备，后续复用缓存；原文件不变。音频缓存位于 `/cache/transcodes/audio`，与视频共用转码缓存配额，单次准备最多四分钟、单文件最多 512 MiB。
- 不兼容视频转换为可跳转的 HLS VOD，并按需生成片段。
- 远程媒体按来源策略原样代理，不进行兼容转码；完整 Cache 或 Fetch 后可使用本地兼容播放。
- 提供队列、速度、睡眠定时器、歌词、Media Session 和进度保存。
- 页面切换或局部错误不会清除播放器和本地状态。

## 相关文档

- [媒体库 / ライブラリ](library.md)
- [来源 / ソース](sources.md)
