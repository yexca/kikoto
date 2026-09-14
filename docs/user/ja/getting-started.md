# はじめに

[English](../en/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [日本語](getting-started.md) · [한국어](../ko/getting-started.md)


## 必要条件

- Docker と Docker Compose。
- ローカル開発では任意:
  - Go 1.26.6。
  - Node.js 24.19.0（npm 11.17.0 を含む）。

## Docker で実行

空のディレクトリに `docker-compose.yml` をダウンロードし、Docker Hub の最新公開イメージを取得して起動します。

起動前に、そのディレクトリへ `.env` ファイルを作成します。

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
```

```sh
docker compose up -d --pull always
```

既定のイメージは `yexca/kikoto:latest` で、公開リリースごとにリリースワークフローが更新します。`docker compose up -d` は未取得のイメージを取得し、`latest` は毎回取得します。`docker compose restart` は現在のコンテナイメージを再利用します。固定タグの更新にも `--pull always` を使用してください。再現可能なデプロイでは、`.env` の `KIKOTO_IMAGE` を確認済みのバージョンまたはダイジェストに固定します。

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d --pull always
```

開く:

- フロントエンド: `http://127.0.0.1:7655`

本番の Compose スタックでは、Web アプリケーションと API をポート `7655` でまとめて公開します。`7659` はコンテナ内部のバックエンドポートで、開発用 Compose スタックでのみ個別に公開されます。

既定のランタイムマウントは次のとおりです。

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

公開読み取り専用インスタンスには `docker-compose.demo.yaml` を使用します。公開イメージを取得し、`./demo` 以下の分離されたマウントを使用します。候補作品のフォルダーを `./demo/data` 以下に置くと、専用の起動ワークフローが全年齢かつ恒久的に無料の作品だけを検証してインデックス化します。[Docker](../../operations/docker.md#demo-stack) を参照してください。

## Android クライアント

署名済み Android APK はプロジェクトの GitHub Releases に添付されています。クライアントは接続先サーバーとバージョンを比較します。クライアントが古い場合は対応する Release を提示し、新しい場合は更新対象をサーバーとして示します。ネットワーク障害が発生しても、Reconnect 操作は別に残ります。

Kikoto は Android パッケージを自動でインストールしません。Release を開いて APK をインストールする操作は、ユーザーが明示的に確認する Android システムの手順です。

## 最初のライブラリスキャン

1. 対応する音声作品フォルダーを `data/` 以下に置きます。
2. Docker スタックを起動します。
3. フロントエンドを開きます。
4. Workflows からローカルライブラリスキャンを実行します。プロバイダーのメタデータを待たずにローカル作品を検出し、ローカルソースの利用状況を更新します。
5. 検出した作品を補完するため、Metadata sync を独立したワークフローとして実行できます。または、既定で無効なスキャンの `Follow-up run` オプションを有効にすると、スキャン完了後にキューへ追加されます。

## ビルドの検証

以下のコマンドはソースチェックアウトを検証します。リポジトリ全体を一貫して検証するには、対応する [Makefile](../../../Makefile) ターゲットを使用してください。

バックエンド（ソースチェックアウトのみ）:

```sh
cd backend
go test ./...
```

フロントエンド（ソースチェックアウトのみ）:

```sh
cd frontend
npm ci --strict-allow-scripts
npm run build
```

## 次に読む

- [設定](../../operations/configuration.md)
- [Docker](../../operations/docker.md)
- [ライブラリ](library.md)
- [ソース](sources.md)
