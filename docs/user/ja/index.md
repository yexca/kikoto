# ユーザーガイド

[English](../en/index.md) · [简体中文](../zh-Hans/index.md) · [繁體中文](../zh-Hant/index.md) · [日本語](index.md) · [한국어](../ko/index.md)

このページでは、インストール方法とユーザーが確認できる動作を説明します。表示内容、利用できる操作、またはワークフロー名を変更する場合は、まず英語版を更新し、その後に翻訳の見直しが必要であることを示してください。

- [ライブラリ](library.md)
- [作品詳細](work-detail.md)
- [ソース](sources.md)
- [サークル](circles.md)
- [声優](voices.md)
- [再生](playback.md)
- [設定](settings.md)
- [ワークフロー](workflows.md)

## 製品の原則

- 作品にローカル、Cache、Tracked、リモートの各ソースがあっても、1 つの統合された項目として表示します。
- リモートソースに障害が発生しても、ローカルとキャッシュの状態は利用できるようにします。
- リモートソースの操作は明示的に行います。Sync はソースデータを更新し、Cache はキャッシュファイルを作成し、Fetch は選択したファイルをローカルのデータツリーへ移します。
- 長時間実行する操作やレビューが必要な操作は、Activity に表示します。

## 関連ドキュメント

- [コア境界](../../architecture/core-boundaries.md)
- [ソースの利用状況](../../architecture/source-presence.md)
- [フロントエンドガイドライン](../../development/frontend-guidelines.md)
