#!/usr/bin/env bash
# Build or update a per-PR MicroVM image (subsequent runs add a new version under the same image name).
#
# Required env vars:
#   AWS_REGION          e.g. ap-northeast-1
#   IMAGE_NAME          Per-PR MicroVM image name (e.g. preview-pr-123)
#   CONTAINER_IMAGE     Base container image in the same account's ECR (pinned by digest)
#                       e.g. 123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/app-preview@sha256:...
#   ARTIFACT_BUCKET     S3 bucket for the zipped Dockerfile artifact
#   BUILD_ROLE_ARN      IAM role used by Lambda MicroVMs builder (S3 read, ECR pull, CloudWatch Logs)
# Optional:
#   ENVIRONMENT_JSON    JSON env vars for the image (e.g. {"DATABASE_URL":"..."})
#   EGRESS_CONNECTOR    Egress network connector ARN for VPC database access
#
# Outputs: writes image_arn and image_version to GITHUB_OUTPUT (or stdout outside GitHub Actions).
set -euo pipefail

: "${AWS_REGION:?}" "${IMAGE_NAME:?}" "${CONTAINER_IMAGE:?}" "${ARTIFACT_BUCKET:?}" "${BUILD_ROLE_ARN:?}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
IMAGE_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT}:microvm-image:${IMAGE_NAME}"
BASE_IMAGE_ARN="arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1"
OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"

# Add a small metadata file via COPY so OCI images pushed by docker buildx always have a new layer
# (a Dockerfile with only FROM can fail with "An unknown error occurred.").
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
  # update-microvm-image replaces all fields (PUT semantics) and builds a new version.
  aws lambda-microvms update-microvm-image --image-identifier "$IMAGE_ARN" "${args[@]}" >/dev/null
  echo "updating ${IMAGE_NAME}"
else
  aws lambda-microvms create-microvm-image --name "$IMAGE_NAME" "${args[@]}" >/dev/null
  echo "creating ${IMAGE_NAME}"
fi
echo "image_arn=${IMAGE_ARN}" >> "$OUTPUT"

# Wait up to 30 minutes for the image build to finish.
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
echo "image_version=${version}" >> "$OUTPUT"
