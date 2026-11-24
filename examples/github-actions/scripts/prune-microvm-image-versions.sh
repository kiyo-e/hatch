#!/usr/bin/env bash
# Prune old MicroVM image versions (AWS limit: 50 versions per image).
# Keeps the newest KEEP (default: 2) SUCCESSFUL versions; retaining the previous version
# avoids "running microvms" errors while older MicroVMs are still terminating.
#
# Required: IMAGE_ARN   Optional: KEEP (default: 2)
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
    # Non-fatal: remaining versions will be retried on the next run.
    echo "::warning::could not delete version ${version} of ${IMAGE_ARN}; will retry next time"
  fi
done <<<"$versions"
