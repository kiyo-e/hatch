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
├── examples/github-actions/   # アプリ側リポジトリに置く CI の例（このリポジトリでは実行されない）
│   ├── preview-deploy.yml   # PR 更新時のイメージ登録例
│   └── preview-cleanup.yml  # PR クローズ時の削除例
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

### 2. ドメインと設定の調整

`wrangler.jsonc` の `vars` をご自身のドメインに合わせて変更してください。

- `PREVIEW_BASE_DOMAIN`: プレビュー用ベースドメイン（例: `preview.example.com`）
- `API_HOSTNAME`: CI 管理 API 用ホスト名（例: `api.preview.example.com`）
- `AWS_REGION`: MicroVM を稼働させるリージョン（例: `ap-northeast-1`）
- `APP_TARGET_PORT`: MicroVM 内アプリの待受ポート（例: `8080`）

### 3. シークレットの登録

ローカル開発時は `.dev.vars.example` を `.dev.vars` にコピーして値を設定します。本番環境では `wrangler secret put` で登録してください。

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

### 4. デプロイ

```bash
npm run deploy
```

Cloudflare ダッシュボードまたは `wrangler.jsonc` の `routes` で、`*.preview.example.com/*` と `api.preview.example.com/*` を本 Worker に紐付けてください。

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

[`examples/github-actions/`](examples/github-actions/) に、プレビューしたいアプリ側のリポジトリに置く GitHub Actions の例があります。PR の作成・更新時にイメージを登録し、PR のクローズ時に破棄します。

1. 2 つのファイルをアプリ側リポジトリの `.github/workflows/` にコピーします。
2. `API_BASE_URL` を本 Worker の管理 API のホスト（`API_HOSTNAME`）に合わせます。
3. アプリ側リポジトリのシークレットに `CI_WEBHOOK_SECRET` を登録します。
4. `preview-deploy.yml` のイメージビルド手順（`TODO`）を、実際に MicroVM イメージを作成して ARN を出力する処理に置き換えます。

フォークからの PR ではシークレットが渡らないため、必要に応じてジョブに `if: github.event.pull_request.head.repo.full_name == github.repository` を追加してください。

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

`wrangler dev` はリクエストの `Origin` / `Referer` などのヘッダーに含まれる URL を、内部の URL（既定では `http://`）に書き換えます。そのままでは Rails に `Origin: http://...` が届き、`base_url`（`https://...`）と一致しないため、CSRF 検証と ActionCable が失敗します。ローカルで試すときは `--upstream-protocol https` を付けてください（レスポンスの `Location` は `http://` に書き換えられますが、本番では起きません）。

```bash
npx wrangler dev --upstream-protocol https
```
