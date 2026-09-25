<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.zh-Hant.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

# Kikoto

ローカル優先の個人オーディオライブラリ、ソースブラウザー、プレーヤーです。DLsite 形式のメタデータ、ローカルフォルダー、再構築可能な Cache、Kikoeru 互換のリモートファイルソースを一つの Work モデルにまとめます。セルフホスト型 Web アプリと Android クライアントを提供します。

> [!IMPORTANT]
> Kikoto は開発中です。アップグレード前に `config/` と `data/` をバックアップし、ネットワークへ公開する前に[セキュリティ文書](../security/index.md)を確認してください。

> [!NOTE]
> **カスタムワークフローは削除されました。** ワークフローは組み込みのみになります。旧カスタムエディターの代わりに、少数の検証済みパラメーターを持つプリセットワークフロー（サークルをフォロー、シリーズをフォロー、声優をフォロー）を提供します。アップグレード時にユーザー作成の定義とそのトリガーは削除されますが、実行履歴は Activity で引き続き参照できます。

## クイックスタート

1. 空のディレクトリに [`docker-compose.yml`](../../docker-compose.yml) を置きます。事前にパスワードを設定する必要はありません。
2. `config`、`cache`、`data` ディレクトリを作成し、対応する作品フォルダーを `data/` に入れます。
3. 起動します。

```sh
docker compose up -d --pull always
```

<http://127.0.0.1:7655> を開きます。初回起動時は「Kikoto のセットアップ」画面が表示されます。一回限りのセットアップトークンを入力し、管理者のユーザー名とパスワードを設定してください。トークンはサービスログ（`docker compose logs kikoto`）に出力され、`config/setup-token` にも保存されます。最初の管理者を作成すると無効になります。root アカウントを `.env` で定義する場合は、`KIKOTO_ROOT_ACCOUNT_MODE=environment` と `KIKOTO_ROOT_PASSWORD` を設定してください。パスワードを忘れた場合は[管理者のセットアップと復旧](../operations/security.md#administrator-setup-and-recovery)を参照してください。

Production Compose はホストの `7655` で Web アプリと API を同時に提供します。`7659` はコンテナ内部の Backend ポートで、Development Compose のみ個別に公開します。

[`.env.example`](../../.env.example) を参考に、同じディレクトリの `.env` でイメージ、スキャン深度、Cookie のセキュリティ設定、コンテナ内パスを変更できます。シェルの環境変数が `.env` より優先されます。変更後は `docker compose up -d` を実行してください。パス変数はホストのマウント先を変更しません。詳しくは [Compose 設定](../operations/docker.md#configure-with-env) を参照してください。

`docker compose restart` は現在のコンテナイメージを再利用し、環境変数の変更は適用しません。`docker compose up -d` は Compose の既定ポリシーに従い、未取得のイメージを取得し、`latest` タグは毎回取得します。アップグレード時は `--pull always` を使い、再現可能なデプロイでは `.env` の `KIKOTO_IMAGE` をレビュー済みのタグまたは digest に固定してください。アップグレード前に `config/` と `data/` をバックアップします。既存データベースは起動時に Migration され、Fresh-install baseline から再構築されません。

## ユーザー文書

[ユーザーガイド](../user/index.md) にインストール、スキャン規則、ライブラリ、リモートソース、再生、ワークフロー、設定をまとめています。[運用文書](../operations/configuration.md) では Docker、設定、データベース、信頼性、トラブルシューティング、デプロイ時のセキュリティを説明します。

## ランタイムデータ

| ホストパス | コンテナパス | 用途 | バックアップ |
| --- | --- | --- | --- |
| `./config` | `/config` | SQLite 状態と初回ソース設定 | 必須 |
| `./data` | `/data` | 元のメディア、Fetch メディア、ロールバック状態 | 必須 |
| `./cache` | `/cache` | 再構築可能なカバーとメディア Cache | 通常不要 |

これらのディレクトリには個人メディア、アカウント状態、ソース URL、認証情報が含まれることがあるため、リポジトリへコミットしないでください。

## セキュリティとプライバシー

Production は既定でログインを要求します。スーパー管理者は読み取り専用の匿名 Library 閲覧と再生を意図的に有効化できますが、個人状態、設定、変更操作には認証が必要です。脆弱性は [SECURITY.md](../../SECURITY.md) の非公開手順で報告し、ログを共有する前に [PRIVACY.md](../../PRIVACY.md) を確認してください。

## 開発とコントリビューション

開発、テスト、Migration、リリース手順は[文書インデックス](../README.md)にあります。貢献する前に [CONTRIBUTING.md](../../CONTRIBUTING.md) と [AGENTS.md](../../AGENTS.md) を読んでください。

## ライセンス

Kikoto は [GNU Affero General Public License v3.0](../../LICENSE) の下で提供されます。
