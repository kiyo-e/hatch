# Preview Orchestrator (Cloudflare Workers + Durable Objects × AWS Lambda MicroVMs)

[Hono](https://hono.dev/) で書いた Cloudflare Workers と SQLite バックエンドの [Durable Objects](https://developers.cloudflare.com/durable-objects/get-started/) を使い、[AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) の起動・8時間寿命管理・JWE 認証トークン発行・HTTP/WebSocket 透過プロキシを隠蔽する PR プレビュー環境オーケストレーターです。

## 主な機能

- **1 PR = 1 Durable Object インスタンス**: サブドメイン（例: `pr-123.preview.example.com`）から `env.PREVIEW_DO.idFromName("pr-123")` へルーティングし、インメモリ Promise ロックで `RunMicrovm` の多重起動を防止します。
- **8時間寿命の透明なローテーション**: MicroVM の最大寿命 28,800 秒（8時間）から安全マージン 15 分を引いた **7時間45分（27,900秒）** を実効 TTL とし、超過時に旧インスタンスを終了しつつ新しい MicroVM を起動します。
- **自己修復リトライ**: 寿命内でも AWS 側で `TERMINATED` / `NOT_FOUND` になっていた場合は `GetMicrovm` で状態確認のうえ 1 回だけ再起動リトライします。トークン失効（403）時は JWE トークンを再発行してリトライします。
- **HTTP / WebSocket 透過プロキシ**: `X-aws-proxy-auth`（JWE）と `X-aws-proxy-port` を自動付与し、ActionCable 等の `Upgrade: websocket` リクエストも同じコードパスで転送します。
- **コールドスタート UX 改善**: `COLD_START_LOADING_PAGE=true` の場合、起動中のブラウザリクエスト（`Accept: text/html`）には 3 秒自動リロードの軽量 HTML（HTTP 503 + `Retry-After: 3`）を即返し、バックグラウンドで起動を完了させます。
- **管理画面**: `API_HOSTNAME` の `/admin` で、環境の一覧・状態・削除待ちを確認し、ブラウザから破棄できます（Cloudflare Access で保護）。
- **DO Alarm によるゾンビイメージ掃除**: `registerImage` 時に `ZOMBIE_TTL_DAYS`（既定 14 日）後の Alarm を設定し、PR クローズ Webhook が取りこぼされても `destroy()` で自動削除します。`destroy` で MicroVM の終了やイメージの削除に失敗した分は削除待ちとして記録し、10 分後の Alarm で再試行します。

## 公式 API 仕様への準拠ポイント

実装は AWS Lambda MicroVMs API (`/2025-09-09/`) の公式仕様に合わせています。

| 項目 | 公式 API 仕様 | リファレンス |
| :--- | :--- | :--- |
| MicroVM 起動 | `POST /2025-09-09/microvms`（`imageIdentifier` 指定、レスポンスは `endpoint`） | [RunMicrovm](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html) |
| JWE トークン発行 | `POST /2025-09-09/microvms/{id}/auth-token`（`allowedPorts`・`expirationInMinutes` 必須、レスポンス `authToken["X-aws-proxy-auth"]`） | [CreateMicrovmAuthToken](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmAuthToken.html) |
| 状態確認 | `GET /2025-09-09/microvms/{id}`（レスポンス `state`） | [GetMicrovm](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_GetMicrovm.html) |
| MicroVM 終了 | `DELETE /2025-09-09/microvms/{id}` | [TerminateMicrovm](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_TerminateMicrovm.html) |
| イメージ削除 | `DELETE /2025-09-09/microvm-images/{id}` | [DeleteMicrovmImage](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_DeleteMicrovmImage.html) |
| プロキシ認証ヘッダー | `X-aws-proxy-auth: <JWE>` + `X-aws-proxy-port: <port>` | [Networking - AWS Lambda](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html) |

## ディレクトリ構成

```text
.
├── src/
│   ├── index.ts          # Hono のエッジルーター（CI 管理 API / 管理画面 / プレビューサブドメイン転送）
│   ├── admin.ts          # 管理画面（一覧・詳細・破棄）
│   ├── registry-do.ts    # Durable Object（管理画面の一覧用に、登録された環境を記録する台帳）
│   ├── preview-do.ts     # Durable Object（寿命管理・多重起動ロック・JWE キャッシュ・プロキシ・Alarm）
│   ├── aws-microvm.ts    # AWS Lambda MicroVMs SigV4 クライアント (aws4fetch)
│   ├── auth.ts           # CI Webhook 定数時間シークレット検証 & Cloudflare Access JWT 検証
│   ├── loading-page.ts   # コールドスタート用 3 秒自動リロード HTML
│   └── types.ts          # 共通型定義
├── test/                 # Node.js 標準テストランナーによるテスト
│   ├── helpers/register-ts-hooks.mjs  # src/*.ts を直接読み込むためのフック
│   ├── preview-do.test.mjs            # Durable Object の振る舞い
│   ├── auth.test.mjs                  # Cloudflare Access JWT 検証
│   ├── aws-microvm.test.mjs           # AWS クライアントの認証情報
│   ├── router.test.mjs                # 管理 API の入力検証
│   ├── admin.test.mjs                 # 管理画面・台帳
│   └── preview-orchestrator.test.mjs  # 設定・ソースの契約
├── examples/                 # アプリ側に置く例（このリポジトリでは実行されない）
│   ├── github-actions/
│   │   ├── preview-deploy.yml   # PR の作成・更新: イメージのビルド・DB のセットアップ・登録
│   │   ├── preview-cleanup.yml  # PR のクローズ: 破棄と DB などの片付け
│   │   ├── preview-sweep.yml    # 毎日: 閉じた PR の取り残しを片付ける
│   │   └── scripts/             # MicroVM イメージの作成・更新と、古いバージョンの削除
│   └── aws/                     # ECR と S3 のライフサイクル、CI 用ロール・ビルドロールのポリシーと信頼ポリシー
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── .dev.vars.example
```

## セットアップ & デプロイ

### 1. 依存関係のインストールと型チェック

```bash
nvm install && nvm use
npm install -g "$(node -p 'require("./package.json").packageManager')"
npm ci
npm run typecheck
npm test
```

### 2. ローカルで動かす

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` のホスト名（`api.localhost` / `localhost`）が `wrangler.jsonc` の `vars` より優先されるため、管理 API と管理画面は `http://api.localhost:8787`、プレビューは `http://<envId>.localhost:8787` で開けます。AWS の認証情報がダミーのままでも、登録・一覧・管理画面は試せます（MicroVM の起動には本物が必要です）。

### 3. ドメインと設定の調整

`wrangler.jsonc` の `vars` をご自身のドメインに合わせて変更してください。

- `PREVIEW_BASE_DOMAIN`: プレビュー用ベースドメイン（例: `preview.example.com`）
- `API_HOSTNAME`: CI 管理 API 用ホスト名（例: `api.preview.example.com`）
- `AWS_REGION`: MicroVM を稼働させるリージョン（例: `ap-northeast-1`）
- `APP_TARGET_PORT`: MicroVM 内アプリの待受ポート（例: `8080`）

### 4. シークレットの登録

本番環境では `wrangler secret put` で登録してください（ローカルでは `.dev.vars`）。

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
# 任意: 一時的な認証情報（STS）を使う場合のみ。期限が切れると AWS API が失敗するため、本番では長期のアクセスキーを推奨します
# npx wrangler secret put AWS_SESSION_TOKEN
npx wrangler secret put CI_WEBHOOK_SECRET

# 任意: Cloudflare Access JWT 検証を有効化する場合（2 つとも設定してください。片方だけの場合はプレビューへのアクセスを 500 で拒否します）
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD

# 管理画面を使う場合: 管理画面用の Access アプリの AUD（CF_ACCESS_TEAM_DOMAIN も必要）
npx wrangler secret put CF_ACCESS_ADMIN_AUD
```

### 5. デプロイ

ホスト名で振り分けるため、`workers.dev` とプレビュー URL は無効にしています（`workers_dev: false` / `preview_urls: false`）。`wrangler.jsonc` の `routes` のコメントを外してドメインを書き換えるか、Cloudflare ダッシュボードで、`api.preview.example.com/*` と `*.preview.example.com/*` を本 Worker に紐付けてください。

```bash
npm run deploy
```

## 必要な AWS IAM ポリシー（最小権限の例）

Worker に渡す IAM ユーザーには以下のアクションを許可してください（[Security and permissions](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)）。

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

## 管理 API エンドポイント

すべてのエンドポイントで `X-CI-Secret` ヘッダーが必要です。

- `POST /api/envs/:envId/register`
  - Body: `{ "imageIdentifier": "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:pr-123" }`（`imageId` も互換エイリアスとして受理、`imageVersion` は任意）
- `GET /api/envs/:envId/status`
  - 登録済みイメージ・稼働中 MicroVM・TTL 期限・Alarm 予定時刻を返却（削除待ちのリソースがあれば `cleanupPending` に含める）
- `DELETE /api/envs/:envId/destroy`
  - 稼働中 MicroVM 終了・イメージ削除・DO ストレージと Alarm を全削除
  - 終了・削除に失敗したリソースがある場合は `502`（`{"ok": false, ...}`）を返し、Alarm で自動再試行する

`:envId` はプレビューのサブドメインとして有効な DNS ラベル（英小文字・数字・ハイフン、先頭と末尾は英数字、63 文字以内）に限ります。

## 管理画面

`https://<API_HOSTNAME>/admin` で次の操作ができます。

- 環境の一覧（状態・イメージ・MicroVM の期限・削除待ちの件数・プレビューを開くリンク）
- 環境ごとの詳細（MicroVM ID・次の Alarm・削除待ちのリソース）
- 破棄（MicroVM の終了とイメージの削除。削除しきれなかった分は Alarm で自動再試行）

一覧は、管理 API の `register` / `destroy` で更新される台帳（`EnvRegistryDO`）から作ります。台帳を追加する前に登録した環境は、もう一度 `register` すると一覧に載ります。Alarm で自動破棄された環境は、一覧を開いたときに台帳から外れます。

### 認証

管理画面は CI シークレットでは開けません。Cloudflare Zero Trust で `<API_HOSTNAME>/admin` を対象にした Access アプリを作り、その AUD を `CF_ACCESS_ADMIN_AUD` に設定してください（`CF_ACCESS_TEAM_DOMAIN` はプレビューと共通）。CI が使う `/api/*` は Access の対象に含めないでください。

`CF_ACCESS_ADMIN_AUD` が無い場合、管理画面は 503 を返します（fail closed）。ただし `localhost` / `*.localhost` へのアクセスだけは、`wrangler dev` で試せるよう認証なしで開けます。

## アプリ側の CI 例（GitHub Actions）

[`examples/github-actions/`](examples/github-actions/) に、プレビューしたいアプリ側のリポジトリに置くワークフローの例があります。DB は、アプリとは別の外部 DB（PostgreSQL）に PR ごとのデータベースを作る前提です。

| ワークフロー | タイミング | やること |
| :--- | :--- | :--- |
| `preview-deploy.yml` | PR の作成・更新 | アプリのイメージを ECR に push → PR 用 DB の作成と seed → MicroVM イメージの作成 / 更新 → hatch に登録 → 古いバージョンの削除 → PR にプレビューの URL をコメント |
| `preview-cleanup.yml` | PR のクローズ | hatch で破棄 → PR 用 DB の削除 → ECR のタグと S3 の成果物の削除 |
| `preview-sweep.yml` | 毎日 / 手動 | 閉じた PR の DB と MicroVM イメージの取り残しを片付ける |

### イメージの持ち方

- **コンテナイメージ（ECR）**: `pr-<番号>-<ブランチ名>` をタグにして push し（タグに使えない文字は `-` に置き換えます）、同じブランチは同じタグを上書きします。タグの外れた古いイメージは、ECR のライフサイクル（[`examples/aws/ecr-lifecycle-policy.json`](examples/aws/ecr-lifecycle-policy.json)）で消えます。プレビュー専用のリポジトリを使ってください。
- **MicroVM イメージ**: PR ごとに 1 つの名前（`preview-pr-<番号>`）で作り、push のたびに `update-microvm-image` で新しいバージョンを足します。イメージの数は PR の数で済み（1 リージョン 100 個まで）、バージョンは新しい 2 つだけを残して消します（1 イメージ 50 個まで）。直前のバージョンは、hatch が終了させたばかりの MicroVM がまだ使っていることがあるため残します。
- hatch には同じ ARN を登録し直します。hatch は古い MicroVM を終了し、次のアクセスで最新のバージョンから起動します。
- MicroVM は arm64 なので、アプリのイメージは arm64 でビルドします（例では arm64 のランナーを使います）。ベースのコンテナイメージは、公開イメージか同じアカウントの ECR から取得できるものに限られます。
- MicroVM イメージは、アプリのイメージを digest で指定した `FROM` に、どのイメージから作ったかを書いた小さなファイルを `COPY` する Dockerfile から作ります。`FROM` だけで新しいレイヤーが無いと、OCI 形式で push したイメージ（`docker buildx` の既定）のビルドが `An unknown error occurred.` で失敗するためです。ビルドロールには、ECR から pull する権限が必要です。

この流れ（作成 → 同じ名前での更新 → 再登録で最新のバージョンに切り替わる → 古いバージョンの削除 → バージョンが複数あるイメージの hatch での破棄）は、実際の AWS で確認しています。

### DB のセットアップ

ビルドしたアプリのイメージで `PREVIEW_DB_SETUP_COMMAND`（既定 `bin/rails db:prepare`）を実行します。データベースが無ければ作ってスキーマと seed を流し、あればマイグレーションだけを流すように、何度実行しても同じ結果になるコマンドにしてください。GitHub のランナーから DB に届く必要があります。届かない場合は、VPC 内のセルフホストランナーや ECS の one-off タスクで実行してください。

MicroVM から VPC 内の DB に接続するには、egress の Network Connector を作り、`PREVIEW_EGRESS_CONNECTOR`（イメージのビルド時）と hatch の `AWS_EGRESS_NETWORK_CONNECTORS`（実行時）に設定します。

### 片付け

PR のクローズ時に片付けます。ただし、このジョブの失敗、hatch の自動破棄（放置 `ZOMBIE_TTL_DAYS` 日）、管理画面からの破棄では DB が残るため、`preview-sweep.yml` が毎日、開いていない PR の DB と MicroVM イメージを消します。AWS の `terminate` フックは、7 時間 45 分ごとの入れ替えや再登録でも呼ばれるため、片付けには使いません。

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
| `CI_WEBHOOK_SECRET` | secrets | hatch の `CI_WEBHOOK_SECRET` と同じ値 |
| `PREVIEW_DATABASE_URL_BASE` | secrets | `postgres://user:pass@db.example.internal:5432`（データベース名なし） |

`DATABASE_URL` は MicroVM イメージの環境変数として渡すため、イメージの設定を読める IAM の権限を持つ人には見えます。プレビュー用の DB ユーザーは、プレビュー用のデータベースだけを操作できる権限にしてください。

## Rails 側の注意点

プロキシ時に `X-Forwarded-Host: pr-123.preview.example.com` および `X-Forwarded-Proto: https` を付与します。一方、MicroVM のエンドポイントへ接続するため、アプリに届く `Host` ヘッダーは MicroVM のエンドポイント（例: `xxxx.lambda-microvm.ap-northeast-1.on.aws`）になります。Rails はこの 2 つを次のように使うため、`config/environments/production.rb`（または `staging.rb`）に以下を設定してください。

```ruby
# Host authorization は Host と X-Forwarded-Host の両方を検査する。両方を許可しないと Blocked host (403) になる
# Rails が \A...(:port)?\z で自動的に囲むので、正規表現に \A / \z は書かない
config.hosts << /[a-z0-9-]+\.preview\.example\.com/
config.hosts << /[a-z0-9-]+\.lambda-microvm\.[a-z0-9-]+\.on\.aws/

# ActionCable の「同じホストからの接続」判定は Origin と Host ヘッダーを比べるため、プレビューの Origin を明示的に許可する
config.action_cable.allowed_request_origins = [%r{\Ahttps://[a-z0-9-]+\.preview\.example\.com\z}]
```

フォームの CSRF 検証（Origin と `request.base_url` の比較）は、`X-Forwarded-Host` / `X-Forwarded-Proto` から組み立てた `https://pr-123.preview.example.com` と一致するため、追加の設定は不要です。最小構成の Rails 8.1 アプリで、POST（CSRF トークン・Origin 検証）、セッション Cookie、リダイレクト、ActionCable が実際の AWS Lambda MicroVMs 上で動くことを確認しています。

### `wrangler dev` で試す場合

`wrangler dev` はリクエストの `Origin` / `Referer` などのヘッダーに含まれる URL を、内部の URL（既定では `http://`）に書き換えます。そのままでは Rails に `Origin: http://...` が届き、`base_url`（`https://...`）と一致しないため、CSRF 検証と ActionCable が失敗します。このため `wrangler.jsonc` で `dev.upstream_protocol` を `https` にしています（レスポンスの `Location` は `http://` に書き換えられますが、本番では起きません）。
