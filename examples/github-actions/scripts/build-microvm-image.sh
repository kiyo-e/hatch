#!/usr/bin/env bash
# PR ごとの MicroVM イメージを作る（2 回目以降は同じ名前のまま新しいバージョンを足す）。
#
# 必須の環境変数:
#   AWS_REGION          例: ap-northeast-1
#   IMAGE_NAME          MicroVM イメージ名（PR ごとに 1 つ）。例: preview-pr-123
#   CONTAINER_IMAGE     ベースにするコンテナイメージ（同じアカウントの ECR。digest で固定する）
#                       例: 123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/app-preview@sha256:...
#   ARTIFACT_BUCKET     コード成果物（Dockerfile の zip）を置く S3 バケット
#   BUILD_ROLE_ARN      イメージのビルドで使う IAM ロール（S3 の読み取り・ECR の pull・ログ）
# 任意:
#   ENVIRONMENT_JSON    イメージに渡す環境変数の JSON（例: {"DATABASE_URL":"..."}）
#   EGRESS_CONNECTOR    VPC 内の DB などへ出るための egress network connector の ARN
#
# 出力: GITHUB_OUTPUT に image_arn と image_version を書く（GitHub Actions 外では標準出力）
set -euo pipefail

: "${AWS_REGION:?}" "${IMAGE_NAME:?}" "${CONTAINER_IMAGE:?}" "${ARTIFACT_BUCKET:?}" "${BUILD_ROLE_ARN:?}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
IMAGE_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT}:microvm-image:${IMAGE_NAME}"
BASE_IMAGE_ARN="arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1"
OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"

# コード成果物: アプリのコンテナイメージをベースにする Dockerfile と、どのイメージから作ったかの目印のファイル
# （CMD / ENTRYPOINT はアプリのイメージのものを使う。アプリは APP_TARGET_PORT で待ち受けること）
# FROM だけで新しいレイヤーが無いと、OCI 形式で push したイメージ（buildx の既定）のビルドが
# "An unknown error occurred." で失敗するため、目印のファイルを COPY して必ずレイヤーを 1 つ足す
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf 'image=%s\ncommit=%s\n' "$CONTAINER_IMAGE" "${GITHUB_SHA:-}" > "$WORK/hatch-image.txt"
printf 'FROM %s\nCOPY hatch-image.txt /etc/hatch-image.txt\n' "$CONTAINER_IMAGE" > "$WORK/Dockerfile"
(cd "$WORK" && zip -q artifact.zip Dockerfile hatch-image.txt)
KEY="${IMAGE_NAME}/${GITHUB_SHA:-$(date +%s)}.zip"
aws s3 cp "$WORK/artifact.zip" "s3://${ARTIFACT_BUCKET}/${KEY}" >/dev/null

args=(
  --code-artifact "uri=s3://${ARTIFACT_BUCKET}/${KEY}"
  --base-image-arn "$BASE_IMAGE_ARN"
  --build-role-arn "$BUILD_ROLE_ARN"
  --description "preview ${IMAGE_NAME} ${GITHUB_SHA:-}"
)
[ -n "${ENVIRONMENT_JSON:-}" ] && args+=(--environment-variables "$ENVIRONMENT_JSON")
[ -n "${EGRESS_CONNECTOR:-}" ] && args+=(--egress-network-connectors "$EGRESS_CONNECTOR")

if aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" >/dev/null 2>&1; then
  # 更新は PUT と同じ扱いで、毎回すべての項目を渡す。新しいバージョンのビルドが始まる
  aws lambda-microvms update-microvm-image --image-identifier "$IMAGE_ARN" "${args[@]}" >/dev/null
  echo "updating ${IMAGE_NAME}"
else
  aws lambda-microvms create-microvm-image --name "$IMAGE_NAME" "${args[@]}" >/dev/null
  echo "creating ${IMAGE_NAME}"
fi

# ビルド中のバージョンが無くなるまで待つ（最大 30 分）
for _ in $(seq 1 120); do
  sleep 15
  versions="$(aws lambda-microvms list-microvm-image-versions --image-identifier "$IMAGE_ARN" \
    --query 'items[].[imageVersion,state,status]' --output text | sort -V)"
  echo "$(date +%H:%M:%S) ${versions//$'\n'/ | }"
  grep -qE 'PENDING|IN_PROGRESS' <<<"$versions" || break
done

latest="$(tail -n 1 <<<"$versions")"
read -r version state status <<<"$latest"
if [ "$state" != "SUCCESSFUL" ]; then
  echo "::error::MicroVM image build ${IMAGE_NAME} ${version} ended in ${state}. See CloudWatch Logs /aws/lambda-microvms/${IMAGE_NAME}" >&2
  exit 1
fi
echo "built ${IMAGE_NAME} ${version} (${status})"
{
  echo "image_arn=${IMAGE_ARN}"
  echo "image_version=${version}"
} >> "$OUTPUT"
