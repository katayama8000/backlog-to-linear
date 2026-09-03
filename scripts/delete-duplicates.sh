#!/usr/bin/env bash
#
# 中断した取り込みで残った重複課題を Linear から削除する（ゴミ箱へ移動。復元可能）。
# 対象は scripts/delete-duplicates.txt に固定されている（id と identifier の対）。
#
set -euo pipefail
cd "$(dirname "$0")/.."

LIST="scripts/delete-duplicates.txt"
[ -f "$LIST" ] || { echo "error: $LIST がありません" >&2; exit 1; }
[ -n "${LINEAR_API_KEY-}" ] || { echo "error: LINEAR_API_KEY を設定してください" >&2; exit 2; }

COUNT=$(wc -l < "$LIST" | tr -d ' ')
echo "削除対象: $COUNT 件"
head -3 "$LIST" | while read -r _ ident; do echo "  $ident"; done
echo "  …"
tail -1 "$LIST" | while read -r _ ident; do echo "  $ident"; done
echo
echo "Linear の削除はゴミ箱への移動なので、UI から復元できます。"
printf "続行しますか? [y/N] "
read -r answer
case "$answer" in [yY]|[yY][eE][sS]) ;; *) echo "中止しました。"; exit 0 ;; esac

ok=0; fail=0
while read -r id ident; do
  res=$(curl -s https://api.linear.app/graphql \
    -H "Authorization: $LINEAR_API_KEY" -H 'content-type: application/json' \
    -d "{\"query\":\"mutation{issueDelete(id:\\\"$id\\\"){success}}\"}")
  if printf '%s' "$res" | grep -q '"success":true'; then
    ok=$((ok+1))
    printf "\r  削除中… %d/%d" "$((ok+fail))" "$COUNT"
  else
    fail=$((fail+1))
    echo
    echo "  失敗: $ident $res" >&2
  fi
done < "$LIST"

echo
echo "削除成功: $ok 件 / 失敗: $fail 件"
