# hatch

[![CI](https://github.com/kiyo-e/hatch/actions/workflows/ci.yml/badge.svg)](https://github.com/kiyo-e/hatch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [日本語](README.ja.md)

On-demand PR preview environments on **AWS Lambda MicroVMs**, orchestrated at the edge with **Cloudflare Workers** and **Durable Objects**.

`hatch` turns a MicroVM image ARN into a live preview URL (`https://pr-123.preview.example.com`)—handling cold-start provisioning, 8-hour lifetime rotation, JWE proxy authentication, HTTP/WebSocket proxying, and automatic cleanup.

## Architecture

```mermaid
flowchart LR
  CI["CI (GitHub Actions)"] -->|"POST /register\nDELETE /destroy"| Router["Cloudflare Worker\n(Hono Router)"]
  Browser["Reviewer Browser"] -->|"https://pr-123.preview.example.com"| Router
  Admin["Operator Browser"] -->|"https://api.preview.example.com/admin"| Router

  Router -->|"Access JWT"| AdminUI["Admin UI"]
  Router -->|"Access JWT (optional)"| DO["PreviewEnvironmentDO\n(1 instance per envId)"]
  Router -->|"List / Sync"| Registry["EnvRegistryDO"]

  DO -->|"RunMicrovm / AuthToken\nTerminate / DeleteImage"| AWS["AWS Lambda MicroVMs"]
  DO -->|"HTTP / WebSocket\n+ X-aws-proxy-auth"| AWS
```

## Features

- **1 Environment = 1 Durable Object**: Subdomains (e.g. `pr-123.preview.example.com`) map deterministically to `PreviewEnvironmentDO` via `idFromName("pr-123")`, with an in-memory boot lock to prevent duplicate `RunMicrovm` calls under concurrent traffic.
- **Transparent 8-Hour Rotation**: AWS Lambda MicroVMs have an 8-hour (28,800s) maximum lifetime. `hatch` enforces a **7h 45m** effective TTL and transparently provisions a replacement MicroVM while terminating the old one.
- **Self-Healing Proxy**: If a MicroVM terminates unexpectedly (`TERMINATED` / `NOT_FOUND`) or a proxy JWE token expires (`403`), `hatch` verifies state, re-issues tokens or re-provisions, and retries the request.
- **HTTP & WebSocket Support**: Injects `X-aws-proxy-auth`, `X-aws-proxy-port`, `X-Forwarded-Host`, and `X-Forwarded-Proto`, forwarding both HTTP and `Upgrade: websocket` (e.g. ActionCable) connections.
- **Cold-Start Loading Page**: When `COLD_START_LOADING_PAGE=true`, browser navigations (`Accept: text/html`) arriving during cold start receive a lightweight auto-reloading `503` page (`Retry-After: 3`) while the MicroVM boots in the background.
- **Zombie Cleanup via Alarms**: `register` schedules a Durable Object Alarm after `ZOMBIE_TTL_DAYS` (default: `14`) to clean up environments even if a PR close webhook is missed. Failed terminations/deletions are queued and retried every 10 minutes.
- **Built-in Admin UI**: Inspect registered environments, MicroVM status, and pending cleanups, or destroy environments manually at `https://<API_HOSTNAME>/admin` (protected by Cloudflare Access).

## Quick Start (Local)

Try `hatch` locally with Wrangler (Node.js version is specified in [`.nvmrc`](.nvmrc)):

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` sets `API_HOSTNAME=api.localhost` and `PREVIEW_BASE_DOMAIN=localhost`, overriding `wrangler.jsonc`:

- **Admin UI**: `http://api.localhost:8787/admin` (Access verification is bypassed on `localhost`)
- **Management API**: `http://api.localhost:8787/api/envs` and `/api/envs/:envId/*`
- **Preview URL**: `http://<envId>.localhost:8787`

You can test image registration, status inspection, and the Admin UI with the dummy AWS credentials in `.dev.vars.example`. Real AWS credentials are required to actually boot MicroVMs.

Run type checks and tests:

```bash
npm run typecheck
npm test
```

## Deployment

### 1. Configure `wrangler.jsonc`

Update `vars` and uncomment `routes` in [`wrangler.jsonc`](wrangler.jsonc) for your domain (`workers.dev` and preview URLs are disabled because routing is hostname-based):

```jsonc
"routes": [
  { "pattern": "api.preview.example.com/*", "zone_name": "example.com" },
  { "pattern": "*.preview.example.com/*", "zone_name": "example.com" }
]
```

### 2. Set Secrets

Register secrets with `wrangler secret put`:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put CI_WEBHOOK_SECRET

# Required for Admin UI (/admin)
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_ADMIN_AUD

# Optional: protect preview subdomains (*.preview.example.com) with Cloudflare Access
npx wrangler secret put CF_ACCESS_AUD
```

### 3. AWS IAM Permissions

Attach the following least-privilege IAM policy to the IAM user used by `hatch`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:TerminateMicrovm",
        "lambda:CreateMicrovmAuthToken",
        "lambda:DeleteMicrovmImage"
      ],
      "Resource": "*"
    }
  ]
}
```

### 4. Deploy

```bash
npm run deploy
```

## Configuration

### Environment Variables (`wrangler.jsonc` `vars`)

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `AWS_REGION` | Yes | `ap-northeast-1` | AWS region where Lambda MicroVMs run |
| `APP_TARGET_PORT` | Yes | `8080` | Listening port inside the MicroVM |
| `PREVIEW_BASE_DOMAIN` | Yes | `preview.example.com` | Base domain for previews (`<envId>.<PREVIEW_BASE_DOMAIN>`) |
| `API_HOSTNAME` | Yes | `api.preview.example.com` | Hostname for `/api/*` and `/admin` |
| `COLD_START_LOADING_PAGE` | No | `true` | Return auto-reloading HTML (`503`) to browsers while booting |
| `ZOMBIE_TTL_DAYS` | No | `14` | Days before an idle environment is auto-destroyed by DO Alarm |
| `AWS_MICROVM_EXECUTION_ROLE_ARN` | No | — | IAM execution role ARN passed to `RunMicrovm` |
| `AWS_EGRESS_NETWORK_CONNECTORS` | No | — | Comma-separated Egress Network Connector ARNs |

### Secrets (`wrangler secret put` / `.dev.vars`)

| Secret | Required | Description |
| :--- | :--- | :--- |
| `AWS_ACCESS_KEY_ID` | Yes | AWS IAM access key ID |
| `AWS_SECRET_ACCESS_KEY` | Yes | AWS IAM secret access key |
| `AWS_SESSION_TOKEN` | No | STS session token (long-lived IAM user keys recommended in production) |
| `CI_WEBHOOK_SECRET` | Yes | Shared secret checked against the `X-CI-Secret` header |
| `CF_ACCESS_TEAM_DOMAIN` | For Access | Cloudflare Access team domain (e.g. `your-team.cloudflareaccess.com`) |
| `CF_ACCESS_ADMIN_AUD` | For `/admin` | Access Application AUD protecting `<API_HOSTNAME>/admin` (fails closed with `503` if unset) |
| `CF_ACCESS_AUD` | No | Access Application AUD protecting preview subdomains (requires `CF_ACCESS_TEAM_DOMAIN`) |

> [!NOTE]
> When configuring Cloudflare Access for `<API_HOSTNAME>/admin`, make sure `/api/*` is **not** included in the Access policy so CI webhooks can authenticate with `X-CI-Secret`.

## Management API

All `/api/envs` endpoints require the `X-CI-Secret` header. `:envId` must be a valid DNS label (lowercase alphanumeric and hyphens, 1–63 characters).

### List Environments

```bash
curl "https://api.preview.example.com/api/envs" \
  -H "X-CI-Secret: $CI_WEBHOOK_SECRET"
```

Returns registered environments with live status, most recently updated first. Destroyed and destroying environments are excluded.

```json
{
  "envs": [
    {
      "envId": "pr-123",
      "state": "running",
      "url": "https://pr-123.preview.example.com/",
      "imageIdentifier": "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-123",
      "imageVersion": "3",
      "microvmId": "...",
      "registeredAt": "2026-11-20T01:23:45.000Z",
      "updatedAt": "2026-11-24T05:00:00.000Z",
      "createdAt": "2026-11-24T05:01:10.000Z",
      "expiresAt": "2026-11-24T12:46:10.000Z"
    }
  ]
}
```

`state` is one of `running`, `booting`, `idle` (registered, no MicroVM yet) or `unavailable` (status could not be read; kept so cleanup jobs don't miss it). `cleanupPending` appears when AWS resources are queued for retry.

### Register an Image

```bash
curl -X POST "https://api.preview.example.com/api/envs/pr-123/register" \
  -H "Content-Type: application/json" \
  -H "X-CI-Secret: $CI_WEBHOOK_SECRET" \
  -d '{"imageIdentifier":"arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-123"}'
```

`imageId` (alias for `imageIdentifier`) and `imageVersion` (optional) are also accepted. Returns `503` if the environment index used by `GET /api/envs` could not be updated; retrying is safe.

### Check Status

```bash
curl "https://api.preview.example.com/api/envs/pr-123/status" \
  -H "X-CI-Secret: $CI_WEBHOOK_SECRET"
```

### Destroy an Environment

```bash
curl -X DELETE "https://api.preview.example.com/api/envs/pr-123/destroy" \
  -H "X-CI-Secret: $CI_WEBHOOK_SECRET"
```

Terminates the running MicroVM, deletes the image, and clears DO storage and Alarms. Returns `502` if any AWS cleanup call fails (failed resources are retried automatically via DO Alarms).

## CI Integration (GitHub Actions)

Example workflows for your application repository are provided in [`examples/github-actions/`](examples/github-actions/). They assume an external database (PostgreSQL) where each PR gets its own isolated database.

| Workflow | Trigger | Purpose |
| :--- | :--- | :--- |
| [`preview-deploy.yml`](examples/github-actions/preview-deploy.yml) | PR open / update | Push app image to ECR → create & seed PR DB → build/update MicroVM image → register with `hatch` → prune old versions → comment preview URL on PR |
| [`preview-cleanup.yml`](examples/github-actions/preview-cleanup.yml) | PR close | Destroy environment via `hatch` → drop PR DB → delete ECR tag & S3 build artifacts |
| [`preview-sweep.yml`](examples/github-actions/preview-sweep.yml) | Daily / manual | Clean up leftover DBs and MicroVM images for closed PRs |

### Image Strategy

- **Container images (ECR)**: Pushed with tag `pr-<number>-<branch>` (invalid characters replaced with `-`), overwriting the same tag on subsequent pushes. Untagged images are expired by the ECR lifecycle policy ([`examples/aws/ecr-lifecycle-policy.json`](examples/aws/ecr-lifecycle-policy.json)). Use a dedicated ECR repository for previews.
- **MicroVM images**: One image per PR (`preview-pr-<number>`), adding a new version via `update-microvm-image` on each push. This keeps image count proportional to open PRs (limit: 100/region) while keeping only the latest 2 versions (limit: 50/image; the previous version is retained briefly in case a terminating MicroVM still references it).
- Re-registering the same ARN in `hatch` terminates the old MicroVM so the next request boots the newest version.
- MicroVMs run on `arm64`, so container images are built for `arm64`. The MicroVM Dockerfile pins the app image by digest (`FROM`) and adds a small metadata file via `COPY` (adding a layer avoids `An unknown error occurred.` on OCI-format images pushed by `docker buildx`).

### Database Setup & Cleanup

- `PREVIEW_DB_SETUP_COMMAND` (default: `bin/rails db:prepare`) runs against the built container image and must be idempotent. The GitHub runner must be able to reach the database (use a self-hosted runner or an ECS one-off task if the DB is in a private VPC).
- To let MicroVMs reach a VPC database, create an egress Network Connector and set `PREVIEW_EGRESS_CONNECTOR` (at image build time) and `AWS_EGRESS_NETWORK_CONNECTORS` in `hatch` (at runtime).
- `preview-sweep.yml` runs daily to clean up databases and MicroVM images that remain if `preview-cleanup.yml` fails or an environment is destroyed via `ZOMBIE_TTL_DAYS` / the Admin UI.

### Setup

1. Copy the 3 workflows into `.github/workflows/` and `examples/github-actions/scripts/*.sh` into `.github/hatch/` in your application repository.
2. Provision the required AWS resources using the example policies in [`examples/aws/`](examples/aws/):
   - Dedicated ECR repository (`ecr-lifecycle-policy.json`)
   - S3 bucket for build artifacts (`s3-lifecycle-configuration.json`, expires artifacts after 7 days)
   - MicroVM build IAM role (`build-role-policy.json`, `build-role-trust-policy.json`)
   - GitHub OIDC provider (`token.actions.githubusercontent.com`) and CI IAM role (`ci-role-policy.json`, `ci-role-trust-policy.json` — scope `sub` to your repo for `pull_request` and `ref:refs/heads/main` for daily sweep)
3. Configure repository variables (`vars`) and secrets:

| Name | Type | Example |
| :--- | :--- | :--- |
| `AWS_REGION` | vars | `ap-northeast-1` |
| `PREVIEW_CI_ROLE_ARN` | vars | `arn:aws:iam::123456789012:role/app-preview-ci` |
| `PREVIEW_ECR_REPOSITORY` | vars | `app-preview` |
| `PREVIEW_ARTIFACT_BUCKET` | vars | `app-preview-artifacts` |
| `PREVIEW_BUILD_ROLE_ARN` | vars | `arn:aws:iam::123456789012:role/app-preview-microvm-build` |
| `HATCH_API_BASE_URL` | vars | `https://api.preview.example.com` |
| `PREVIEW_BASE_DOMAIN` | vars | `preview.example.com` |
| `PREVIEW_DB_SETUP_COMMAND` | vars (optional) | `bin/rails db:prepare` |
| `PREVIEW_EGRESS_CONNECTOR` | vars (optional) | ARN of your egress Network Connector |
| `CI_WEBHOOK_SECRET` | secrets | Same value as `CI_WEBHOOK_SECRET` in `hatch` |
| `PREVIEW_DATABASE_URL_BASE` | secrets | `postgres://user:pass@db.example.internal:5432` (without DB name) |

> [!NOTE]
> `DATABASE_URL` is passed as a MicroVM image environment variable and is visible to IAM principals with permission to describe the image. Use a dedicated DB user scoped strictly to preview databases.

## Reverse Proxy & Framework Notes

When proxying requests, `hatch` sets `X-Forwarded-Host: <envId>.<PREVIEW_BASE_DOMAIN>` and `X-Forwarded-Proto: https`, while the `Host` header seen by the app is the MicroVM endpoint (`*.lambda-microvm.<region>.on.aws`).

### Rails

Configure `config/environments/production.rb` (or `staging.rb`) so Host Authorization and ActionCable accept both headers:

```ruby
# Rails wraps patterns in \A...(:port)?\z automatically; omit \A / \z here.
config.hosts << /[a-z0-9-]+\.preview\.example\.com/
config.hosts << /[a-z0-9-]+\.lambda-microvm\.[a-z0-9-]+\.on\.aws/

config.action_cable.allowed_request_origins = [%r{\Ahttps://[a-z0-9-]+\.preview\.example\.com\z}]
```

`wrangler.jsonc` sets `dev.upstream_protocol` to `https` so `Origin` / `Referer` headers are not downgraded to `http://` during `wrangler dev`, keeping CSRF Origin checks and ActionCable working locally.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

## License

[MIT](LICENSE)
