# backlog-to-linear 設計書

Backlog の課題を **Linear CSV 形式**で書き出す CLI。取り込みは Linear 公式の `npx @linear/import`
に任せる。ランタイムは Deno。コマンド名は `b2l`。

```
Backlog API ──[b2l export]──> issues.csv ──[npx @linear/import]──> Linear
                (作るのはここだけ)          (公式 CLI。自作しない)
```

## 1. 前提調査の結果

- Linear の Web UI の Import は Jira / GitHub / Asana / Shortcut / Linear のみ。 **汎用 CSV
  の取り込み口はない** → 公式 CLI `@linear/import` を使う
- CLI が対応する形式: GitHub, Jira CSV(deprecated), Asana CSV, Pivotal CSV, Shortcut CSV, Trello
  JSON, **Linear CSV**, GitLab CSV
- このうち **Linear CSV が最も情報量が多い**ので、これを出力形式に選ぶ

### Linear CSV で実際に読まれる列（importer 実装より）

| 列            | Linear 側   | 備考                                                      |
| ------------- | ----------- | --------------------------------------------------------- |
| `Title`       | title       |                                                           |
| `Description` | description | Markdown がそのまま入る                                   |
| `Status`      | status      | 取込時に既存ワークフロー状態へ対話マッピング              |
| `Assignee`    | assignee    | 文字列キー。取込時に Linear ユーザーへ対話マッピング      |
| `Labels`      | labels      | **`,`（カンマ+空白）区切り**。無いラベルは自動作成        |
| `Priority`    | priority    | `Urgent`/`High`/`Medium`/`Low`/`No priority` の文字列のみ |
| `Estimate`    | estimate    | 整数のみ。Team で estimate 有効化が必要                   |
| `Created`     | createdAt   | **作成日を保持できる**（Date パース可能な文字列）         |
| `Started`     | startedAt   |                                                           |
| `Completed`   | completedAt |                                                           |
| `Archived`    | —           | **値があるとその行はスキップされる。必ず空にする**        |

`Id` / `Team` / `Project` / `Creator` / `Updated` / `Canceled` / `Cycle *` は ヘッダとして存在するが
importer は読まない。互換のため空で出力する。

### CSV では移行できないもの

コメント / 添付ファイル / 親子課題 / 課題の関連 / 登録者。 → すべて **Description
に埋め込む**（後述）。API 版が必要になったらそこで対応する。

## 2. マッピング

| Backlog                   | Linear CSV       | 変換                                                      |
| ------------------------- | ---------------- | --------------------------------------------------------- |
| summary                   | `Title`          | そのまま                                                  |
| description               | `Description`    | Backlog 記法 → Markdown + 脚注付与                        |
| status.name               | `Status`         | 変換せず Backlog の名前を出す（取込時に対話マッピング）   |
| assignee.name             | `Assignee`       | 同上。未割当は空                                          |
| priority 高/中/低         | `Priority`       | `High`/`Medium`/`Low`、未設定は `No priority`             |
| issueType.name            | `Labels`         | `type/バグ`                                               |
| category[].name           | `Labels`         | `category/フロントエンド`                                 |
| milestone[].name          | `Labels`         | `milestone/v1.0`（Linear Project にはできないため）       |
| estimatedHours            | `Estimate`       | 四捨五入した整数。`--no-estimate` で抑止                  |
| created                   | `Created`        | ISO8601                                                   |
| updated（完了状態のとき） | `Completed`      | Backlog に完了日時が無いため近似。`--no-completed` で抑止 |
| createdUser               | Description 脚注 |                                                           |
| 親課題 / 関連課題         | Description 脚注 | 課題キーと Backlog URL                                    |
| コメント                  | Description 末尾 | `--include-comments` 時のみ                               |
| 添付ファイル              | Description 脚注 | Backlog の URL リンクとして残す（DL はしない）            |

### Description の形（例）

```markdown
（本文を Markdown 化したもの）

<details><summary>コメント (3)</summary>

**山田太郎** 2024-01-05 実装方針を変更します。

**佐藤花子** 2024-01-06 了解です。

</details>

---

Migrated from Backlog [PROJ-123](https://xxx.backlog.jp/view/PROJ-123) 登録者: 山田太郎 / 予定 3h /
実績 5h 親課題: [PROJ-100](...) / 関連: [PROJ-140](...) 添付: [design.pdf](...),
[screenshot.png](...)
```

コメントを畳むのは、CSV 1 セルが巨大化して Linear 上で読みづらくなるのを避けるため。
`--comments-max N` で最新 N 件に制限、`--no-comments`（既定）で完全に省く。

### 本文の変換

移行対象プロジェクトは `textFormattingRule: "markdown"`。**記法コンバータは作らない。** 本文は
Markdown として素通しし、以下だけ手を入れる。

- 課題キー `PROJ-123` の言及を Backlog へのリンクに書き換える（`--no-issue-links` で抑止）
- 相対の添付リンクを絶対 URL に直す
- 末尾に脚注を追加

起動時に `textFormattingRule` を検証し、`backlog`（独自記法）だったら
**警告して中断**する（黙って壊れた Markdown を吐かない）。`--force` で続行可。

## 3. コマンド

```
b2l doctor                       Backlog API の疎通と権限を確認
b2l export --project PROJ        課題を Linear CSV として書き出す（主機能）
b2l inspect --project PROJ       状態・種別・カテゴリー・担当者の一覧を表示（下準備用）
b2l enrich --team ENG            取込後に親子課題（sub-issue）を張り直す
```

`export` のフラグ:

```
--project PROJ           対象プロジェクトキー（必須）
--out issues.csv         出力先（既定 ./out/<PROJ>.csv）
--open-only              未完了の課題のみ（Linear 公式も推奨）
--status 未対応,処理中    状態で絞る
--updated-since 2025-01-01
--split 500              N 行ごとにファイル分割（大量課題のとき取込を分ける）
--include-comments       コメントを Description に埋め込む
--comments-max 20
--no-estimate            Estimate 列を空にする
--assignee email|name    Assignee 列に出す値（既定: email）
--no-issue-links         本文中の課題キーを Backlog リンクに書き換えない
--label-prefix type=種別: カスタムのラベル接頭辞
--no-relations           親子関係のサイドカーを出さない
--dry-run                件数と警告だけ出して書き出さない
```

## 4.5 親子課題の復元（b2l enrich）

Linear CSV importer には親を指定する列がない（`LinearIssueType` に Parent 相当が存在せず、 importer
が組み立てる Issue にも `parentId` がない）。よって取込直後は必ずフラットになる。

`export` は CSV と並べて `out/<PROJ>.relations.json` を書き出す。

```json
{
  "projectKey": "PROJ",
  "generatedAt": "...",
  "parents": [{ "child": "PROJ-2", "parent": "PROJ-1" }]
}
```

`enrich` の処理:

1. `relations.json` を読む
2. Linear GraphQL で対象 Team の課題を全件取得（カーソルページング）
3. 各課題の Description から脚注 `Migrated from Backlog [PROJ-123]` を読み、 **Backlog 課題キー →
   Linear 課題 ID** の対応表を作る
4. 組ごとに `issueUpdate(id, { parentId })` を投げる

設計上の要点:

- 突合キーは脚注の1行だけ。書式（`MIGRATION_MARKER`）を変えると既存の取込分を追えなくなるため、
  定数として1箇所に置き、テストで固定している
- 既に親が設定済みの課題はスキップするので**何度実行しても同じ結果**になる（`--overwrite` で上書き）
- 脚注がない課題（Linear で手作りされたもの）は対応表に入らないので巻き込まない
- 同じ課題キーに複数の Linear 課題が対応したら重複取込として警告する
- 親が CSV に含まれていない組は「未解決」として報告し、失敗にはしない

同じ仕組みで課題の関連も張れるが、Backlog の関連課題エンドポイントの確認が必要なので v1
では扱わない。

## 4. 取り込み手順（README に載せる運用）

```bash
# 1. 下調べ
b2l inspect --project PROJ

# 2. 書き出し
b2l export --project PROJ --open-only --out out/PROJ.csv

# 3. 取り込み（Linear 公式 CLI。ここは自作しない）
npx @linear/import
#   → "Linear (CSV)" を選択
#   → out/PROJ.csv を指定
#   → 取込先 Team を選択
#   → Status と Assignee のマッピングを対話で指定
```

事前に Linear 側で必要なこと（README に明記）:

- 取込先 Team を作成し、Estimate を使うなら Team 設定で有効化
- 移行対象の担当者を Workspace に招待しておく（未招待だと割り当てられない）

## 5. ディレクトリ構成

```
main.ts                  サブコマンドのディスパッチのみ
src/
  cli/
    doctor.ts
    export.ts
    inspect.ts
    enrich.ts
  backlog/
    client.ts            REST v2（ページング・429 リトライ内包）
    types.ts
  linear/
    client.ts            GraphQL（enrich でのみ使用。カーソルページング・リトライ）
  transform/
    issue.ts             Backlog Issue → CSV 行（純関数）
    description.ts       本文 + コメント + 脚注の組み立て、リンク書換（純関数）
    relations.ts         親子関係のサイドカー生成（純関数）
  csv/writer.ts          RFC4180 準拠の書き出し
  config.ts
  log.ts
out/                     .gitignore
```

中核の `transform` / `csv` は I/O を持たない純関数に寄せる。 テストしたいのはここだけで、API
クライアントは薄く保つ。

## 6. CSV 書き出しの注意点

- 改行・カンマ・ダブルクォートを含むフィールドは `"` で囲み `""` でエスケープ
- BOM は付けない（`csvtojson` が読むだけなので不要）
- CSV インジェクション: 先頭が `= + - @` 等のフィールドは `'` を前置する。 Linear の importer は
  `stripLeadingSingleQuote` でこれを剥がすので安全に往復する
- `Labels` の区切りは `,` 固定。ラベル名自身にカンマを含めない（`_` に置換）
- ヘッダ順は Linear のエクスポートと同じ順に揃える

## 7. Backlog API

- `GET /api/v2/projects/:key` → `textFormattingRule` が `markdown` であることの検証
- `GET /api/v2/issues?projectId[]=&count=100&offset=` → 100 件ずつページング
- `GET /api/v2/issues/count` → 進捗表示用の総数
- `GET /api/v2/issues/:key/comments?count=100` → `--include-comments` 時のみ
- `GET /api/v2/projects/:key/statuses`, `/issueTypes`, `/categories`, `/versions`, `/users` →
  `inspect` 用
- 認証は `apiKey` クエリ。`BACKLOG_API_KEY` 環境変数（または `.env`）から読む
- 429 / 5xx は指数バックオフ（最大5回、jitter 付き）

権限は読み取りのみ。Backlog には一切書き込まない。

## 8. 出力とエラー

- 終了コード: 0 成功 / 1 実行時エラー / 2 入力・設定不備
- 標準出力に集計: 出力行数、スキップ件数、警告（欠損担当者・長すぎる本文・解決できない課題キー参照）
- `out/report.md` に課題キー単位の警告一覧

## 9. テスト

- `transform/issue.ts`: Backlog 課題 JSON のフィクスチャ → 期待 CSV 行（最重要）
- `transform/description.ts`: 脚注・コメント折りたたみ・リンク書換
- `csv/writer.ts`: 改行・引用符・インジェクションのケース
- 往復テスト: 生成した CSV を `csvtojson` で読み、`@linear/import` の `LinearIssueType`
  と同じ解釈になるか検証

## 10. 実装順

1. `backlog/client.ts` + `inspect`（読み取りだけで動く。API の形をここで確定させる）
2. `transform` + `csv/writer.ts` + `export`（最小の列だけ埋めて往復を通す）
3. ラベル・Estimate・日付列・絞り込みフラグ
4. コメント埋め込み・リンク書換・`--split`
5. `report.md` と `doctor`

## 11. 将来の拡張（v1 ではやらない）

CSV で落ちる情報（コメント本体・添付の実ファイル・親子関係）をどうしても Linear
上で構造として持ちたくなったら、CSV 取込後に Linear GraphQL で 後追い更新する `b2l enrich`
を足す。Description 脚注に残した課題キーを
突合キーに使えるよう、脚注は機械可読な形（`Migrated from Backlog PROJ-123`）を保つ。
