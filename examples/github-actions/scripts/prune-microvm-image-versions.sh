#!/usr/bin/env bash
# MicroVM イメージの古いバージョンを消す（1 イメージあたり 50 バージョンまで）。
# 新しいほうから KEEP 個（既定 2）の成功したバージョンを残す。直前のバージョンは、hatch が終了させたばかりの
# MicroVM がまだ使っていることがあり、消すと "running microvms" で失敗するため残しておく。
#
# 必須の環境変数: IMAGE_ARN   任意: KEEP（既定 2）
set -euo pipefail
: "${IMAGE_ARN:?}"
KEEP="${KEEP:-2}"

versions="$(aws lambda-microvms list-microvm-image-versions --image-identifier "$IMAGE_ARN" \
  --query 'items[].[imageVersion,state]' --output text | sort -V)"
keep="$(awk '$2 == "SUCCESSFUL" { print $1 }' <<<"$versions" | tail -n "$KEEP")"

while read -r version state; do
  [ -z "$version" ] && continue
  grep -qxF "$version" <<<"$keep" && continue
  case "$state" in PENDING | IN_PROGRESS | DELETING | DELETED) continue ;; esac
  if aws lambda-microvms delete-microvm-image-version --image-identifier "$IMAGE_ARN" --image-version "$version" >/dev/null; then
    echo "deleted version ${version} (${state})"
  else
    # 消せなかったバージョンは次回の実行で消す（デプロイは失敗にしない）
    echo "::warning::could not delete version ${version} of ${IMAGE_ARN}; will retry next time"
  fi
done <<<"$versions"
