# hatch

[![CI](https://github.com/kiyo-e/hatch/actions/workflows/ci.yml/badge.svg)](https://github.com/kiyo-e/hatch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | 日本語

**AWS Lambda MicroVMs** 上のオンデマンド PR プレビュー環境を、**Cloudflare Workers** と **Durable Objects** でオーケストレーションするプロキシ兼ライフサイクル管理基盤です。

MicroVM イメージの ARN を登録するだけで、プレビュー用サブドメイン（`https://pr-123.preview.example.com`）の払い出しから、コールドスタート起動、8 時間寿命のローテーション、JWE プロキシ認証、HTTP / WebSocket の透過プロキシ、PR クローズ時の自動掃除までを一貫して処理します。

## アーキテクチャ

```mermaid
flowchart LR
  CI["CI (GitHub Actions)"] -->|"POST /register\nDELETE /destroy"| Router["Cloudflare Worker\n(Hono Router)"]
  Browser["ブラウザ"] -->|"https://pr-123.preview.example.com"| Router
  Admin["管理者ブラウザ"] -->|"https://api.preview.example.com/admin"| Router

  Router -->|"Access JWT"| AdminUI["管理画面"]
  Router -->|"Access JWT (任意)"| DO["PreviewEnvironmentDO\n(envId ごとに 1 インスタンス)"]
  Router -->|"一覧・同期"| Registry["EnvRegistryDO"]

  DO -->|"RunMicrovm / AuthToken\nTerminate / DeleteImage"| AWS["AWS Lambda MicroVMs"]
  DO -->|"HTTP / WebSocket\n+ X-aws-proxy-auth"| AWS
```

## 主な機能

- **1 環境 = 1 Durable Object**: サブドメイン（例: `pr-123.preview.example.com`）を `idFromName("pr-123")` へ決定的にルーティングし、インメモリロックで同時アクセス時の `RunMicrovm` 多重起動を防止します。
- **8 時間寿命の透過ローテーション**: AWS Lambda MicroVMs の最大寿命（28,800 秒 = 8 時間）に対し **7 時間 45 分** を実効 TTL とし、期限超過時は旧 VM を終了しつつ新しい MicroVM を起動して切り替えます。
- **自己修復プロキシ**: 寿命内で AWS 側の VM が `TERMINATED` / `NOT_FOUND` になった場合や、プロキシ用 JWE トークンが失効（`403`）した場合は、状態確認・再発行・再起動のうえリクエストをリトライします。
- **HTTP / WebSocket 透過プロキシ**: `X-aws-proxy-auth`・`X-aws-proxy-port`・`X-Forwarded-Host`・`X-Forwarded-Proto` を自動付与し、ActionCable などの `Upgrade: websocket` 通信も同じパスで転送します。
- **コールドスタート時のローディング画面**: `COLD_START_LOADING_PAGE=true` の場合、起動中のブラウザアクセス（`Accept: text/html`）には 3 秒自動リロードの軽量 HTML（`503` + `Retry-After: 3`）を即返し、バックグラウンドで起動を完了させます。
- **DO Alarm によるゾンビ掃除**: `register` 時に `ZOMBIE_TTL_DAYS`（既定 14 日）後の Alarm を設定し、PR クローズ Webhook を取りこぼしても自動破棄します。終了・削除に失敗したリソースは削除待ちとして記録し、10 分ごとに Alarm で再試行します。
- **管理画面**: `https://<API_HOSTNAME>/admin` で環境の一覧・状態・削除待ちの確認や手動破棄ができます（Cloudflare Access で保護）。

## クイックスタート（ローカル）

Wrangler を使って手元ですぐに試せます（Node.js のバージョンは [`.nvmrc`](.nvmrc) を参照）。

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` により `API_HOSTNAME=api.localhost` / `PREVIEW_BASE_DOMAIN=localhost` が有効になり、`wrangler.jsonc` の設定より優先されます。

- **管理画面**: `http://api.localhost:8787/admin`（`localhost` では Access 認証をバイパスします）
- **管理 API**: `http://api.localhost:8787/api/envs` と `/api/envs/:envId/*`
- **プレビュー URL**: `http://<envId>.localhost:8787`

`.dev.vars.example` のダミー AWS 認証情報のままでも、イメージ登録・一覧・管理画面の動作を確認できます（MicroVM の実起動には本物の AWS 認証情報が必要です）。

型チェックとテストの実行:

```bash
npm run typecheck
npm test
```

## デプロイ手順

### 1. `wrangler.jsonc` の設定

ホスト名ベースでルーティングするため、`workers.dev` とプレビュー URL は無効化しています。[`wrangler.jsonc`](wrangler.jsonc) の `vars` をご自身の環境に合わせて変更し、`routes` のコメントを外して設定してください。

```jsonc
"routes": [
  { "pattern": "api.preview.example.com/*", "zone_name": "example.com" },
  { "pattern": "*.preview.example.com/*", "zone_name": "example.com" }
]
```

### 2. シークレットの登録

`wrangler secret put` で本番用のシークレットを登録します。

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put CI_WEBHOOK_SECRET

# 管理画面 (/admin) を使う場合
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_ADMIN_AUD

# 任意: プレビュー (*.preview.example.com) も Cloudflare Access で保護する場合
npx wrangler secret put CF_ACCESS_AUD
```

### 3. AWS IAM ポリシーの設定

Worker が使用する IAM ユーザーに、以下の最小権限ポリシーを付与してください。

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

### 4. デプロイ

```bash
npm run deploy
```

## 設定リファレンス

### 環境変数（`wrangler.jsonc` の `vars`）

| 変数名 | 必須 | 既定値 | 説明 |
| :--- | :--- | :--- | :--- |
| `AWS_REGION` | はい | `ap-northeast-1` | MicroVM を稼働させる AWS リージョン |
| `APP_TARGET_PORT` | はい | `8080` | MicroVM 内アプリの待受ポート |
| `PREVIEW_BASE_DOMAIN` | はい | `preview.example.com` | プレビュー用ベースドメイン（`<envId>.<PREVIEW_BASE_DOMAIN>`） |
| `API_HOSTNAME` | はい | `api.preview.example.com` | 管理 API（`/api/*`）および管理画面（`/admin`）用ホスト名 |
| `COLD_START_LOADING_PAGE` | いいえ | `true` | 起動中のブラウザアクセスに自動リロード画面（`503`）を返すか |
| `ZOMBIE_TTL_DAYS` | いいえ | `14` | 放置環境を DO Alarm で自動破棄するまでの日数 |
| `AWS_MICROVM_EXECUTION_ROLE_ARN` | いいえ | — | `RunMicrovm` に渡す IAM 実行ロール ARN |
| `AWS_EGRESS_NETWORK_CONNECTORS` | いいえ | — | カンマ区切りの Egress Network Connector ARN |

### シークレット（`wrangler secret put` / `.dev.vars`）

| シークレット名 | 必須 | 説明 |
| :--- | :--- | :--- |
| `AWS_ACCESS_KEY_ID` | はい | AWS IAM アクセスキー ID |
| `AWS_SECRET_ACCESS_KEY` | はい | AWS IAM シークレットアクセスキー |
| `AWS_SESSION_TOKEN` | いいえ | STS 一時認証情報のトークン（本番は長期アクセスキー推奨） |
| `CI_WEBHOOK_SECRET` | はい | `X-CI-Secret` ヘッダーで検証する共有シークレット |
| `CF_ACCESS_TEAM_DOMAIN` | Access 利用時 | Cloudflare Access のチームドメイン（例: `your-team.cloudflareaccess.com`） |
| `CF_ACCESS_ADMIN_AUD` | `/admin` 利用時 | `<API_HOSTNAME>/admin` 用 Access アプリの AUD（未設定時は `503` で拒否） |
| `CF_ACCESS_AUD` | いいえ | プレビュー用 Access アプリの AUD（`CF_ACCESS_TEAM_DOMAIN` も必須） |

> [!NOTE]
> `<API_HOSTNAME>/admin` に Cloudflare Access を設定する際、CI Webhook が `X-CI-Secret` でアクセスできるよう `/api/*` は Access の対象に含めないでください。

## 管理 API

`/api/envs` 以下はすべて `X-CI-Secret` ヘッダーが必須です。`:envId` は有効な DNS ラベル（英小文字・数字・ハイフン、63 文字以内）のみ受け付けます。

### 環境の一覧

```bash
curl "https://api.preview.example.com/api/envs" \
  -H "X-CI-Secret: $CI_WEBHOOK_SECRET"
```

登録中の環境を、最新の状態とあわせて更新が新しい順に返します。破棄済み・破棄中の環境は含みません。

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

`state` は `running`、`booting`、`idle`（登録済みで MicroVM 未起動）、`unavailable`（状態を取得できなかったもの。片付けの漏れを防ぐため一覧に残します）のいずれかです。AWS リソースの削除を再試行待ちのときは `cleanupPending` が付きます。

### イメージの登録

```bash
curl -X POST "https://api.preview.example.com/api/envs/pr-123/register" \
  -H "Content-Type: application/json" \
  -H "X-CI-Secret: $CI_WEBHOOK_SECRET" \
  -d '{"imageIdentifier":"arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-123"}'
```

互換エイリアスとして `imageId`、任意項目として `imageVersion` も指定できます。

`GET /api/envs` が使う環境の一覧を更新できなかったときは `503` を返します。そのまま再実行して構いません。

### 状態の確認

```bash
curl "https://api.preview.example.com/api/envs/pr-123/status" \
  -H "X-CI-Secret: $CI_WEBHOOK_SECRET"
```

### 環境の破棄

```bash
curl -X DELETE "https://api.preview.example.com/api/envs/pr-123/destroy" \
  -H "X-CI-Secret: $CI_WEBHOOK_SECRET"
```

稼働中の MicroVM を終了し、イメージと DO ストレージ・Alarm を削除します。AWS 側の削除に一部失敗した場合は `502` を返し、DO Alarm で自動再試行します。

## CI 連携の例（GitHub Actions）

[`examples/github-actions/`](examples/github-actions/) に、プレビューしたいアプリ側のリポジトリに置くワークフローの例があります。DB は、アプリとは別の外部 DB（PostgreSQL）に PR ごとのデータベースを作る前提です。

| ワークフロー | タイミング | やること |
| :--- | :--- | :--- |
| [`preview-deploy.yml`](examples/github-actions/preview-deploy.yml) | PR の作成・更新 | アプリのイメージを ECR に push → PR 用 DB の作成と seed → MicroVM イメージの作成 / 更新 → `hatch` に登録 → 古いバージョンの削除 → PR にプレビューの URL をコメント |
| [`preview-cleanup.yml`](examples/github-actions/preview-cleanup.yml) | PR のクローズ | `hatch` で破棄 → PR 用 DB の削除 → ECR のタグと S3 の成果物の削除 |
| [`preview-sweep.yml`](examples/github-actions/preview-sweep.yml) | 毎日 / 手動 | 閉じた PR の DB と MicroVM イメージの取り残しを片付ける |

### イメージの持ち方

- **コンテナイメージ（ECR）**: `pr-<番号>-<ブランチ名>` をタグにして push し（タグに使えない文字は `-` に置き換えます）、同じブランチは同じタグを上書きします。タグの外れた古いイメージは、ECR のライフサイクル（[`examples/aws/ecr-lifecycle-policy.json`](examples/aws/ecr-lifecycle-policy.json)）で消えます。プレビュー専用のリポジトリを使ってください。
- **MicroVM イメージ**: PR ごとに 1 つの名前（`preview-pr-<番号>`）で作り、push のたびに `update-microvm-image` で新しいバージョンを足します。イメージの数は PR の数で済み（1 リージョン 100 個まで）、バージョンは新しい 2 つだけを残して消します（1 イメージ 50 個まで）。直前のバージョンは、`hatch` が終了させたばかりの MicroVM がまだ使っていることがあるため残します。
- `hatch` には同じ ARN を登録し直します。`hatch` は古い MicroVM を終了し、次のアクセスで最新のバージョンから起動します。
- MicroVM は `arm64` なので、アプリのイメージは `arm64` でビルドします（例では arm64 のランナーを使います）。ベースのコンテナイメージは、公開イメージか同じアカウントの ECR から取得できるものに限られます。
- MicroVM イメージは、アプリのイメージを digest で指定した `FROM` に、どのイメージから作ったかを書いた小さなファイルを `COPY` する Dockerfile から作ります。`FROM` だけで新しいレイヤーが無いと、OCI 形式で push したイメージ（`docker buildx` の既定）のビルドが `An unknown error occurred.` で失敗するためです。ビルドロールには、ECR から pull する権限が必要です。

### DB のセットアップ

ビルドしたアプリのイメージで `PREVIEW_DB_SETUP_COMMAND`（既定 `bin/rails db:prepare`）を実行します。データベースが無ければ作ってスキーマと seed を流し、あればマイグレーションだけを流すように、何度実行しても同じ結果になるコマンドにしてください。GitHub のランナーから DB に届く必要があります。届かない場合は、VPC 内のセルフホストランナーや ECS の one-off タスクで実行してください。

MicroVM から VPC 内の DB に接続するには、egress の Network Connector を作り、`PREVIEW_EGRESS_CONNECTOR`（イメージのビルド時）と `hatch` の `AWS_EGRESS_NETWORK_CONNECTORS`（実行時）に設定します。

### 片付け

PR のクローズ時に片付けます。ただし、このジョブの失敗、`hatch` の自動破棄（放置 `ZOMBIE_TTL_DAYS` 日）、管理画面からの破棄では DB が残るため、`preview-sweep.yml` が毎日、開いていない PR の DB と MicroVM イメージを消します。AWS の `terminate` フックは、7 時間 45 分ごとの入れ替えや再登録でも呼ばれるため、片付けには使いません。

### 設定

1. 3 つのワークフローをアプリ側リポジトリの `.github/workflows/` に、`examples/github-actions/scripts/*.sh` を `.github/hatch/` にコピーします。
2. AWS に次のものを用意します（ポリシーの例は [`examples/aws/`](examples/aws/)）。
   - プレビュー専用の ECR リポジトリ（ライフサイクルは `ecr-lifecycle-policy.json`）
   - コード成果物用の S3 バケット（ライフサイクルは `s3-lifecycle-configuration.json`。成果物はイメージのビルドが終われば不要なので、PR を閉じたときに消し損ねても 7 日で消えます）
   - イメージのビルドロール（`build-role-policy.json`、信頼ポリシーは `build-role-trust-policy.json`）
   - GitHub の OIDC プロバイダー（`token.actions.githubusercontent.com`、対象者 `sts.amazonaws.com`）と、それを信頼する CI 用ロール（`ci-role-policy.json`、信頼ポリシーは `ci-role-trust-policy.json`。`sub` はアプリのリポジトリに合わせます。`pull_request` は PR のワークフロー、`ref:refs/heads/main` は既定のブランチで動く sweep 用です）
3. リポジトリの変数（`vars`）とシークレットを登録します。

| 名前 | 種類 | 例 |
| :--- | :--- | :--- |
| `AWS_REGION` | vars | `ap-northeast-1` |
| `PREVIEW_CI_ROLE_ARN` | vars | `arn:aws:iam::123456789012:role/app-preview-ci` |
| `PREVIEW_ECR_REPOSITORY` | vars | `app-preview` |
| `PREVIEW_ARTIFACT_BUCKET` | vars | `app-preview-artifacts` |
| `PREVIEW_BUILD_ROLE_ARN` | vars | `arn:aws:iam::123456789012:role/app-preview-microvm-build` |
| `HATCH_API_BASE_URL` | vars | `https://api.preview.example.com` |
| `PREVIEW_BASE_DOMAIN` | vars | `preview.example.com` |
| `PREVIEW_DB_SETUP_COMMAND` | vars（任意） | `bin/rails db:prepare` |
| `PREVIEW_EGRESS_CONNECTOR` | vars（任意） | egress の Network Connector の ARN |
| `CI_WEBHOOK_SECRET` | secrets | `hatch` の `CI_WEBHOOK_SECRET` と同じ値 |
| `PREVIEW_DATABASE_URL_BASE` | secrets | `postgres://user:pass@db.example.internal:5432`（データベース名なし） |

> [!NOTE]
> `DATABASE_URL` は MicroVM イメージの環境変数として渡すため、イメージの設定を読める IAM の権限を持つ人には見えます。プレビュー用の DB ユーザーは、プレビュー用のデータベースだけを操作できる権限にしてください。

## リバースプロキシとフレームワークの注意点

プロキシ時、`hatch` は `X-Forwarded-Host: <envId>.<PREVIEW_BASE_DOMAIN>` と `X-Forwarded-Proto: https` を付与します。一方、アプリ側が受け取る `Host` ヘッダーは MicroVM のエンドポイント（`*.lambda-microvm.<region>.on.aws`）になります。

### Rails の場合

Host authorization と ActionCable の両方で許可が通るよう、`config/environments/production.rb`（または `staging.rb`）に以下を設定してください。

```ruby
# Rails が \A...(:port)?\z で囲むため、正規表現に \A / \z は書かない
config.hosts << /[a-z0-9-]+\.preview\.example\.com/
config.hosts << /[a-z0-9-]+\.lambda-microvm\.[a-z0-9-]+\.on\.aws/

config.action_cable.allowed_request_origins = [%r{\Ahttps://[a-z0-9-]+\.preview\.example\.com\z}]
```

なお、[`wrangler.jsonc`](wrangler.jsonc) では `dev.upstream_protocol` を `https` に設定しており、`wrangler dev` 時に `Origin` / `Referer` が `http://` に書き換えられて CSRF や ActionCable の検証が失敗するのを防いでいます。

## コントリビュート

コントリビューションを歓迎します。開発手順や PR ガイドラインは [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

## ライセンス

[MIT](LICENSE)
