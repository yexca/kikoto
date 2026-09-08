# ワークフロー

[English](../en/workflows.md) · [简体中文](../zh-Hans/workflows.md) · [繁體中文](../zh-Hant/workflows.md) · [日本語](../ja/workflows.md) · [한국어](../ko/workflows.md)

ワークフローはバックグラウンド処理を確認可能にします。

## 主要内容

- Workflows で定義とトリガーを管理し、Activity で実行状態を確認します。
- スキャン、メタデータ Sync、リモート Sync、Cache、Fetch、クリーンアップは独立した実行です。
- 消えたフォルダーは `missing`、重複コードは Review に残します。
- Fetch は canonical Work ごとに一件へ統合され、転送量を Activity に表示します。
- 復旧を宣言したワークフローだけがチェックポイントと再試行をサポートします。

## 相关文档

- [媒体库 / ライブラリ](library.md)
- [来源 / ソース](sources.md)
