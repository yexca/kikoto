# はじめに

[English](../en/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [日本語](getting-started.md) · [한국어](../ko/getting-started.md)


## 必要条件

- Docker と Docker Compose。
- ローカル開発では任意:
  - Go 1.26.6。
  - Node.js 24.19.0（npm 11.17.0 を含む）。

## Docker で実行

空のディレクトリに `docker-compose.yml` をダウンロードし、Docker Hub の最新公開イメージを取得して起動します。

起動前にパスワードを設定する必要はありません。

```sh
docker compose up -d --pull always
```

既定のイメージは `yexca/kikoto:latest` で、公開リリースごとにリリースワークフローが更新します。`docker compose up -d` は未取得のイメージを取得し、`latest` は毎回取得します。`docker compose restart` は現在のコンテナイメージを再利用します。固定タグの更新にも `--pull always` を使用してください。再現可能なデプロイでは、`.env` の `KIKOTO_IMAGE` を確認済みのバージョンまたはダイジェストに固定します。

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d --pull always
```

開く:

- フロントエンド: `http://127.0.0.1:7655`

初回起動時は「Kikoto のセットアップ」画面が表示されます。`docker compose logs kikoto` または `config/setup-token` の一回限りのセットアップトークンを入力し、管理者のユーザー名とパスワードを設定してください。パスワードを忘れた場合は[管理者のセットアップと復旧](../../operations/security.md#administrator-setup-and-recovery)を参照してください。

本番の Compose スタックでは、Web アプリケーションと API をポート `7655` でまとめて公開します。`7659` はコンテナ内部のバックエンドポートで、開発用 Compose スタックでのみ個別に公開されます。

既定のランタイムマウントは次のとおりです。

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

公開読み取り専用インスタンスには `deploy/compose/demo.yml` を使用します。公開イメージを取得し、`./demo` 以下の分離されたマウントを使用します。候補作品のフォルダーを `./demo/data` 以下に置くと、専用の起動ワークフローが全年齢かつ恒久的に無料の作品だけを検証してインデックス化します。[Docker](../../operations/docker.md#demo-stack) を参照してください。

## Android クライアント

署名済み Android APK はプロジェクトの GitHub Releases に添付されています。クライアントは接続先サーバーとバージョンを比較します。クライアントが古い場合は対応する Release を提示し、新しい場合は更新対象をサーバーとして示します。ネットワーク障害が発生しても、Reconnect 操作は別に残ります。

Kikoto は Android パッケージを自動でインストールしません。Release を開いて APK をインストールする操作は、ユーザーが明示的に確認する Android システムの手順です。

## 最初のライブラリ設定

1. 対応する音声作品フォルダーを `data/` 以下に置くか、各ストレージディスクを `data/` 直下のフォルダーとしてマウントします（下記参照）。
2. Docker スタックを起動し、フロントエンドを開きます。
3. 管理者アカウントを作成すると **ライブラリを設定** が開きます。
   - **標準**（`data/` 全体が 1 つのライブラリ）か **ストレージプール**（`data/` 直下で選択した各フォルダーが独立したディスクやクラウドドライブ）を選びます。プールモードでは新しい Fetch を受け取る **Fetch プール** も選びます。ローカル作品が見つかるとモードは固定されます。
   - ライブラリをスキャンします。プロバイダーのメタデータを待たずにローカル作品を検出します。
   - 必要に応じてメタデータ同期を開始します。バックグラウンドで実行されます。
   - 起動時とフォルダー変更時に自動スキャンするかを決めます。新規インストールではどちらもオフで、後でワークフローから有効にできます。

**後で** を選ぶと次回の訪問まで設定を閉じます。以前のリリースからアップグレードしたインスタンスは標準レイアウトと既存のスキャントリガーを保ち、この設定は表示されません。

### ストレージプール

各ディスクやクラウドドライブをデータディレクトリ直下のフォルダーとしてマウントします。例：

```yaml
volumes:
  - ./config:/config
  - ./cache:/cache
  - ./data:/data
  - /mnt/disk1:/data/disk1
  - /mnt/cloud:/data/cloud
```

Kikoto は選択した各フォルダーに `.kikoto-pool` マーカーを書き込みます。ディスクがマウントされていないとフォルダーは空でマーカーもないため、そのプールはオフラインと表示され、スキャンは作品を欠落扱いにせずそのまま残します。Fetch はファイルを受け取るプール内でステージングと公開を行うため、公開は常に同じディスク上の名前変更です。作品を取得する前に 設定 -> ライブラリ で Fetch プールを選んでください。未設定の場合、Fetch は設定すべき項目を案内します。

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
