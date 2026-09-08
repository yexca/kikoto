# ソース

[English](../en/sources.md) · [简体中文](../zh-Hans/sources.md) · [繁體中文](../zh-Hant/sources.md) · [日本語](sources.md) · [한국어](../ko/sources.md)


ソースはファイルの取得元を表します。

## ソースの種類

- ローカルフォルダーソース。
- Kikoeru 互換のリモートソース。
- 既存の移行済みレコード専用の旧 Number178 互換リモートソース。

## 現在の動作

- ローカルスキャンは、設定されたデータルート以下で対応する作品コードのフォルダーを検出します。
- リモートソースタブでは、すべての結果をインポートせずに設定済みソースを閲覧できます。
- 作品詳細では、バックエンドの集約利用状況チェックを使用します。
- リモート Sync はメタデータとソースのファイルツリーを統合データベースへ取り込みます。
- リモート Cache は選択したリモートファイルをキャッシュルートに実体化します。
- リモート Fetch は選択したファイルをローカルデータツリーへ移します。既定の配置は `/data/<source_code>/<code_prefix>_<code_group>/<work_code>` です。旧 `<source_name>` テンプレートトークンは、安定したソースコードの別名として引き続き使用できます。
- ソース分離保存テンプレートを使う互換ソースは、機械用マーカーと多言語の `README.md` で Fetch ルートを所有します。Fetch は公開場所を直接登録するため、ファイル変更によってローカルフォルダー監視が起動することはありません。一致するマーカーがない既存の空でないルートは、Fetch のレビューを阻止する競合として表示され、自動的に採用されません。
- 古い Kikoto バージョンが作成したマーカーなしのルートは、同じ Origin ソースの有効な `managed_fetch` フォルダー場所、または同じソースと対象ルートを記録した成功済み `remote_work_fetch` 実行から認識できます。Kikoto は、実証済みの作品サブツリーを走査せず、これらの過去の対象とその祖先に対してルート全体を検証します。ルート直下の通常の `README.md` は許可されますが、説明のないエントリ、リンク、再解析ポイント、対象が存在しない古いレコードがある場合はレビューを阻止します。認識は読み取り専用です。次回の Fetch でマーカーを書き込み、まだ存在しない場合にのみ多言語 README を追加します。
- Cache とローカルの削除対象は統合作品ではなく、具体的なファイル場所です。異なる対象の選択は復旧可能な 1 つのワークフローとして送信され、ローカル削除後も作品の進捗とリスニングマークは保持されます。
- リモートソースの一覧と詳細ページはソース単位のビューであり、統合されたローカル作品詳細モデルを置き換えません。
- Compatible remote work responses map the source's current `price`. The value
  is not persisted as price history or treated as an authoritative regular
  price. In Demo mode, Remote Source paging always adds `$age:general$` and
  `$-price:1$` to the upstream search. Detail and media access repeat the same
  filtered search with an exact work code; returned age and price fields are not
  interpreted locally as policy inputs.
- `kikoeru_compatible_number178` retains its adapter for migrated sources but is
  rejected by new source and configuration-seed inputs. The historical
  `kikoeru_compilable_number178` spelling is migrated automatically.

## 利用状況のチェック

起動時およびソース変更時の一括チェックでは、最初に関連ソースの状態を検証します。プローブは `/api/health` を優先し、ヘルスエンドポイントを公開しない互換ソースでは 1 件の一覧リクエストにフォールバックします。

管理者は Maintenance から `POST /api/file-sources/{id}/health-check` を使って、同じ上限付きプローブを手動実行できます。レスポンスには状態、チェック時刻、所要時間が含まれますが、設定されたアップストリームアドレスや生のエラーは返しません。

ソースに到達できない場合、Kikoto はその一括処理でソースを利用不可とし、作品ごとのチェックを省略します。候補作品をすべて missing として扱うことはありません。

## ダウンロード速度制御

リモートダウンロードは設定された遅延時間を待ち、一時的なエラーをバックオフ付きで再試行します。Maintenance ではファイルごとのメディアダウンロードサイズにも上限を設定できます。既定値は 100 GB、指定可能範囲は 1〜2048 GB です。ソースがレスポンスサイズを宣言しない場合でも、この上限は Fetch と再生用 Cache の実体化に適用されます。リモートおよび DLsite のカバーには固定 20 MiB の別上限があります。DLsite メタデータ Sync も、プロバイダーの商品・カバーリクエストに設定済みの基本遅延とバックオフを使用します。

Fetch の計画では、保存済みで完全なメタデータとキャッシュされたソース利用状況を使用します。要求されたコードに DLsite スナップショットまたはエディション関係がない場合、レビューを作成する前に対象ファミリーを限定的に Sync します。キューに入った Fetch は、同じツリーを再要求せず、送信時に受け入れたリモートツリーを再利用します。Local の登録が成功すると、その Fetch によって昇格されたキャッシュオブジェクトは削除され、未選択のキャッシュオブジェクトは利用可能なまま残ります。

## 関連ドキュメント

- [作品詳細](work-detail.md)
- [設定](settings.md)
- [ソースの利用状況](../../architecture/source-presence.md)
- [信頼性](../../operations/reliability.md)
