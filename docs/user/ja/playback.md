# 再生

[English](../en/playback.md) · [简体中文](../zh-Hans/playback.md) · [繁體中文](../zh-Hant/playback.md) · [日本語](../ja/playback.md) · [한국어](../ko/playback.md)

再生はグローバルなブラウザオーディオプレーヤーで行います。

## 主要内容

- Local と Cache の対応音声は HTTP Range で直接再生します。
- デコードできない音声は互換モードで FFmpeg が MP3 ストリームへ変換します。
- 非対応動画はシーク可能な HLS VOD として必要なセグメントだけを生成します。
- リモートメディアは設定済みソースポリシーに従ってプロキシされます。
- キュー、速度、スリープタイマー、歌詞、Media Session、進捗を提供します。
- ページ移動や局所的なエラーがプレーヤーを消さないようにします。

## 相关文档

- [媒体库 / ライブラリ](library.md)
- [来源 / ソース](sources.md)
