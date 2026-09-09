# 播放

[English](../en/playback.md) · [简体中文](../zh-Hans/playback.md) · [繁體中文](../zh-Hant/playback.md) · [日本語](../ja/playback.md) · [한국어](../ko/playback.md)

播放由全局浏览器音频播放器处理。

## 主要内容

- Local 和 Cache 音频支持 HTTP Range，兼容格式会直接播放。
- 无法解码的音频可由 FFmpeg 转换为 MP3 流。
- 不兼容视频转换为可跳转的 HLS VOD，并按需生成片段。
- 远程媒体按来源策略代理，只有明确的 Cache 操作会创建下载。
- 提供队列、速度、睡眠定时器、歌词、Media Session 和进度保存。
- 页面切换或局部错误不会清除播放器和本地状态。

## 相关文档

- [媒体库 / ライブラリ](library.md)
- [来源 / ソース](sources.md)
