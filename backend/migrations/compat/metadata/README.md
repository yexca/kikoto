# Historical metadata migrations

These immutable SQL files preserve the metadata development branch's deployed
051/052 identities. Its new 053 appends favorite-list icons, bringing that path
to the same schema as the root 051 (icons), 052 (queue), 053 (titles) chain.

The migration manager selects this path from recorded migration filenames and
baseline checksums. It preserves the existing ledger and uses the root chain
again from 054 onward. Fresh databases and the baseline generator use only the
root chain. Do not apply these files manually or edit their SQL.

See [Migration compatibility](../../../../docs/development/migrations.md#metadata-development-branch-compatibility).
