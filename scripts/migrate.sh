#!/usr/bin/env bash
#
# Backlog → Linear の移行を一通り実行する。
#   1. b2l doctor    接続・権限・記法の確認
#   2. b2l export    Linear CSV の書き出し
#   3. npx @linear/import   Linear への取り込み（対話）
#   4. b2l enrich    親子課題（と --comments 指定時はコメント）の復元
#
set -euo pipefail

cd "$(dirname "$0")/.."

usage() {
  cat <<'USAGE'
使い方: scripts/migrate.sh --project PROJ [options] [-- <b2l export の追加引数>]

  --project PROJ    Backlog のプロジェクトキー（必須）
  --team ENG        復元先の Team キー。省略した場合は取り込み後に聞きます
  --comments        コメントを本物の Linear コメントとして投入する
                    （投稿日時は再現されますが、投稿者は API キーの持ち主になります）
  --yes             取り込み前の確認を省略する
  --export-only     CSV の書き出しまでで止める
  -h, --help        このヘルプ

環境変数（.env からも読みます）:
  BACKLOG_SPACE, BACKLOG_API_KEY   必須
  LINEAR_API_KEY                   取り込みと enrich に必要

例:
  scripts/migrate.sh --project PROJ
  scripts/migrate.sh --project PROJ --comments
  scripts/migrate.sh --project PROJ -- --open-only
  scripts/migrate.sh --project PROJ --export-only -- --started-status "対応中"
USAGE
}

PROJECT=""
TEAM=""
ASSUME_YES=0
EXPORT_ONLY=0
WITH_COMMENTS=0
EXPORT_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2-}"; shift 2 ;;
    --team) TEAM="${2-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --export-only) EXPORT_ONLY=1; shift ;;
    --comments) WITH_COMMENTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; EXPORT_ARGS=("$@"); break ;;
    *) echo "不明な引数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# `-- --comments` のように、スクリプト用のフラグを export 側へ渡してしまう事故を防ぐ
for arg in ${EXPORT_ARGS+"${EXPORT_ARGS[@]}"}; do
  case "$arg" in
    --comments|--team|--yes|--export-only|--project)
      echo "error: $arg は -- より前に置いてください（-- 以降は b2l export に渡されます）" >&2
      echo "  例: scripts/migrate.sh --project PROJ $arg -- --open-only" >&2
      exit 2
      ;;
  esac
done

if [ -z "$PROJECT" ]; then
  echo "error: --project PROJ を指定してください" >&2
  usage >&2
  exit 2
fi

# .env を読む（既存の環境変数は上書きしない）
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      ''|'#'*) continue ;;
    esac
    key="${key#export }"
    if [ -z "${!key-}" ]; then
      export "$key=${value%\"}"
    fi
  done < .env
fi

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: $1 が見つかりません" >&2; exit 1; }
}
require deno

b2l() {
  deno run --allow-net --allow-env --allow-read --allow-write main.ts "$@"
}

echo "==> 1/4 接続と権限を確認します"
b2l doctor --project "$PROJECT"

echo
echo "==> 2/4 Linear CSV を書き出します"
# コメントを投入するなら、CSV と一緒にサイドカーも出しておく
[ "$WITH_COMMENTS" -eq 1 ] && EXPORT_ARGS+=(--comments-sidecar)
b2l export --project "$PROJECT" ${EXPORT_ARGS+"${EXPORT_ARGS[@]}"}

CSV="out/${PROJECT}.csv"
RELATIONS="out/sidecars/${PROJECT}.relations.json"
if [ ! -f "$CSV" ]; then
  echo "error: $CSV が生成されていません（--out で出力先を変えた場合は手動で取り込んでください）" >&2
  exit 1
fi

if [ "$EXPORT_ONLY" -eq 1 ]; then
  echo
  echo "書き出しまで完了しました: $CSV"
  exit 0
fi

require npx
if [ -z "${LINEAR_API_KEY-}" ]; then
  cat >&2 <<'MSG'
error: LINEAR_API_KEY が未設定です。
  Linear の Settings → Security & access → Personal API keys で発行し、
  export LINEAR_API_KEY=lin_api_xxx を実行してから再度お試しください。
  （CSV の書き出しまでは完了しています）
MSG
  exit 2
fi

echo
echo "==> 3/4 Linear に取り込みます"
echo "    ファイル: $CSV ($(du -h "$CSV" | cut -f1))"
echo "    取り込み先: 対話で選択します"
echo
cat <<'NOTE'
    Linear への書き込みは元に戻すのが手間です。取り込み先の Team を確認してください。
    importer は重複チェックをしません。途中で中断してもそこまでの課題は残るため、
    やり直すときは先にその Team の課題を消してください。
NOTE
if [ "$ASSUME_YES" -ne 1 ]; then
  printf "    続行しますか? [y/N] "
  read -r answer
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "中止しました。CSV は $CSV に残っています。"; exit 0 ;;
  esac
fi
echo
echo "    プロンプトにはこう答えてください:"
echo "      Select your exported CSV file  → $CSV  ← .json ではなく .csv です"
echo "      Do you want to create a new team?  → No"
echo "      Import into team:  → ${TEAM:-取り込み先の Team}"
echo "      Do you want to assign these issues to yourself?  → No"
echo "      Assign to user:  → [Provided assignee]   ← これを選ばないと全件が未割り当てになります"
echo

# --team は npx に渡さないこと。渡すと importer が対話ブロックを丸ごとスキップし、
# targetAssignee が未設定のまま「全件未割り当て」で取り込まれてしまう。
npx @linear/import --importer linearCsv

echo
if [ ! -f "$RELATIONS" ] && [ "$WITH_COMMENTS" -eq 0 ]; then
  echo "==> 4/4 親子課題はありません。完了しました。"
  exit 0
fi

if [ "$WITH_COMMENTS" -eq 1 ]; then
  echo "==> 4/4 親子課題とコメントを復元します"
else
  echo "==> 4/4 親子課題を復元します"
fi
if [ -z "$TEAM" ]; then
  # 取り込み先の Team は対話で選ばれるのでスクリプトからは分からない。ここで聞く。
  printf "    いま取り込んだ Team のキー（例 ENG）を入力してください（空でスキップ）: "
  read -r TEAM
fi
if [ -z "$TEAM" ]; then
  echo "    スキップしました。あとで実行できます:"
  if [ "$WITH_COMMENTS" -eq 1 ]; then
    echo "      deno task b2l enrich --project $PROJECT --team <TEAM> --comments"
  else
    echo "      deno task b2l enrich --project $PROJECT --team <TEAM>"
  fi
  exit 0
fi
ENRICH_ARGS=(--project "$PROJECT" --team "$TEAM")
[ "$WITH_COMMENTS" -eq 1 ] && ENRICH_ARGS+=(--comments)
[ -f "$RELATIONS" ] || ENRICH_ARGS+=(--no-parents)
b2l enrich "${ENRICH_ARGS[@]}"

echo
echo "完了しました。"
