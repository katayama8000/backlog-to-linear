# backlog-to-linear

Backlog の課題を **Linear CSV 形式**で書き出す CLI。取り込みは Linear 公式の `npx @linear/import`
に任せます。

```
Backlog API ──[b2l export]──> issues.csv ──[npx @linear/import]──> Linear
                                                                     │
                                     親子課題だけ後追いで復元 ──[b2l enrich]──┘
```

設計の詳細と判断の記録は [DESIGN.md](./DESIGN.md) にあります。

## 必要なもの

|                    |                                                  |
| ------------------ | ------------------------------------------------ |
| Backlog のスペース | `xxx.backlog.jp` または `xxx.backlog.com`        |
| プロジェクトキー   | `PROJ`                                           |
| Backlog API キー   | 読み取りのみ使用。Backlog には一切書き込みません |

CSV の取り込み自体に Linear の API キーは不要です（`npx @linear/import` が対話で聞いてきます）。
`b2l enrich` を使うときだけ `LINEAR_API_KEY` を設定してください。

## セットアップ

```bash
echo 'BACKLOG_SPACE=xxx.backlog.jp' >> .env
echo 'BACKLOG_API_KEY=xxxxxxxx' >> .env   # .env は .gitignore 済み
deno task b2l doctor --project PROJ
```

## 使い方

```bash
# 1. 下調べ（ステータス・種別・カテゴリー・担当者・課題数を一覧）
deno task b2l inspect --project PROJ

# 2. 書き出し
deno task b2l export --project PROJ --open-only

# 3. 取り込み（Linear 公式 CLI）
LINEAR_API_KEY=lin_api_xxx npx @linear/import --importer linearCsv
#   → "Linear (CSV)" を選択
#   → out/PROJ.csv を指定
#   → 取り込み先 Team を選択
#   → "Assign to user:" で [Provided assignee] を選ぶ（CSV の Assignee 列を使う）

# 4. 親子課題を張り直す（CSV では運べないので後追いで復元）
deno task b2l enrich --project PROJ --team ENG --dry-run
deno task b2l enrich --project PROJ --team ENG
```

### 取り込み前に Linear 側でやっておくこと

- 取り込み先の **Team** を作る（Project 単位では取り込めません）
- 移行対象の担当者を Workspace に招待する（未招待だと Assignee が空になります）
- `Estimate` を使うなら Team 設定で estimate を有効化する（無効だと列が無視されます）

### importer の担当者・ステータスの扱い（対話マッピングはありません）

`@linear/import` のソースを読んで確認した挙動です。**ユーザーごと・ステータスごとの
マッピング画面は出ません。**

**担当者**: 聞かれるのは1回だけです。

1. `Do you want to assign these issues to yourself?` → Yes だと**全件が自分に**割り当たります
2. No なら `Assign to user:` で `[Unassigned]` / `[Provided assignee]` / Team メンバー から1つ選ぶ

CSV の値を使いたいなら **`[Provided assignee]`** を選んでください。突合は
**小文字化したメールアドレス → 小文字化した表示名** の順で、一致しなければ黙って
未割り当てになります。この CLI が既定でメールアドレスを出しているのはこのためです。

**ステータス**: 小文字化した名前で Linear の既存ワークフロー状態と突合し、
**無ければ自動作成**されます。作成時の種別は CSV の `Completed` / `Started` から
推測されます（`Completed` あり → Completed、`Started` あり → Started、どちらも無ければ
**Backlog**）。この CLI は `Started` を出さないので、「対応中」に相当する独自ステータスは Backlog
種別として作られます。取り込み後に Linear 側で種別を直すか、 先に同名の状態を作っておいてください。

### export の主なオプション

| オプション                         | 説明                                               |
| ---------------------------------- | -------------------------------------------------- |
| `--out PATH`                       | 出力先（既定: `./out/<PROJ>.csv`）                 |
| `--open-only`                      | 完了以外の課題のみ。カスタムステータスも対象に含む |
| `--status 未対応,処理中`           | ステータス名で絞る                                 |
| `--updated-since 2025-01-01`       | 更新日で絞る                                       |
| `--split 500`                      | N 行ごとにファイル分割（大量課題を分けて取り込む） |
| `--include-comments`               | コメントを Description に折りたたみで埋め込む      |
| `--comments-max N`                 | 埋め込むコメント数の上限（既定 20、0 で無制限）    |
| `--no-estimate` / `--no-completed` | 該当列を空にする                                   |
| `--no-issue-links`                 | 本文中の課題キーを Backlog リンクに書き換えない    |
| `--label-prefix type=種別:`        | ラベル接頭辞を上書き                               |
| `--dry-run`                        | 件数と警告だけ出して書き出さない                   |

## マッピング

| Backlog                                   | Linear CSV         | 備考                                                     |
| ----------------------------------------- | ------------------ | -------------------------------------------------------- |
| 件名                                      | `Title`            |                                                          |
| 詳細                                      | `Description`      | Markdown をそのまま。課題キーは Backlog へのリンクに変換 |
| 状態                                      | `Status`           | Backlog の名前をそのまま出し、取り込み時に対話マッピング |
| 担当者                                    | `Assignee`         | 同上                                                     |
| 優先度 高/中/低                           | `Priority`         | `High` / `Medium` / `Low`（未設定は `No priority`）      |
| 種別                                      | `Labels`           | `type/バグ`                                              |
| カテゴリー                                | `Labels`           | `category/フロントエンド`                                |
| マイルストーン                            | `Labels`           | `milestone/v1.0`                                         |
| 予定時間                                  | `Estimate`         | 整数に丸め                                               |
| 登録日                                    | `Created`          | 作成日は保持されます                                     |
| 更新日（完了時）                          | `Completed`        | Backlog に完了日時がないため近似                         |
| 登録者 / 予定・実績時間 / 親課題 / 添付名 | Description の脚注 |                                                          |

## 親子課題（sub-issue）の復元

Linear CSV importer には親を指定する列がないため、取り込んだ直後は**すべてフラット**です。
`b2l export` は CSV と一緒に `out/<PROJ>.relations.json` を書き出しておき、 `b2l enrich`
がそれを使って後から本物の sub-issue に張り直します。

突合キーは Description の脚注 `Migrated from Backlog [PROJ-123]` です。 この行の書式を変えると
enrich が既存の課題を追えなくなるので、変更しないでください。

```bash
deno task b2l enrich --project PROJ --team ENG --dry-run   # 何を張るか確認
deno task b2l enrich --project PROJ --team ENG
```

- 既に親が設定されている課題は既定でスキップします（`--overwrite` で上書き）
- 何度実行しても同じ結果になります（冪等）
- 絞り込みで親課題が CSV に含まれていない場合は「未解決」として報告します

## CSV で移行できないもの

- **コメント** → `--include-comments` で Description に折りたたんで埋め込みます
- **添付ファイル** → ファイル名を脚注に残すだけ。実ファイルは Backlog に残ります
- **課題の関連** → 移行しません（必要なら enrich と同じ仕組みで足せます）
- **登録者** → 本文の脚注のみ（API 上、作成者を偽装できません）

Backlog を消さずに残す前提の設計です。脚注のリンクから元課題を辿れます。

## 開発

```bash
deno task test    # 単体テスト + Linear importer 互換の往復テスト
deno task check   # 型チェック + lint + fmt
```

`src/transform/` と `src/csv/` は I/O を持たない純関数で、テストはここに集中しています。
`tests/roundtrip_test.ts` は `@linear/import` の `LinearCsvImporter` の変換処理を
写したもので、生成した CSV が意図どおり解釈されることを確認します。
