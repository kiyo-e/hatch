# Preview Orchestrator (Cloudflare Workers + Durable Objects × AWS Lambda MicroVMs)

Cloudflare Workers と SQLite バックエンドの [Durable Objects](https://developers.cloudflare.com/durable-objects/get-started/) を使い、[AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) の起動・8時間寿命管理・JWE 認証トークン発行・HTTP/WebSocket 透過プロキシを隠蔽する PR プレビュー環境オーケストレーターです。

## 主な機能

- **1 PR = 1 Durable Object インスタンス**: サブドメイン（例: `pr-123.preview.example.com`）から `env.PREVIEW_DO.idFromName("pr-123")` へルーティングし、インメモリ Promise ロックで `RunMicrovm` の多重起動を防止します。
- **8時間寿命の透明なローテーション**: MicroVM の最大寿命 28,800 秒（8時間）から安全マージン 15 分を引いた **7時間45分（27,900秒）** を実効 TTL とし、超過時に旧インスタンスを終了しつつ新しい MicroVM を起動します。
- **自己修復リトライ**: 寿命内でも AWS 側で `TERMINATED` / `NOT_FOUND` になっていた場合は `GetMicrovm` で状態確認のうえ 1 回だけ再起動リトライします。トークン失効（403）時は JWE トークンを再発行してリトライします。
- **HTTP / WebSocket 透過プロキシ**: `X-aws-proxy-auth`（JWE）と `X-aws-proxy-port` を自動付与し、ActionCable 等の `Upgrade: websocket` リクエストも同じコードパスで転送します。
- **コールドスタート UX 改善**: `COLD_START_LOADING_PAGE=true` の場合、起動中のブラウザリクエスト（`Accept: text/html`）には 3 秒自動リロードの軽量 HTML（HTTP 503 + `Retry-After: 3`）を即返し、バックグラウンドで起動を完了させます。
- **DO Alarm によるゾンビイメージ掃除**: `registerImage` 時に `ZOMBIE_TTL_DAYS`（既定 14 日）後の Alarm を設定し、PR クローズ Webhook が取りこぼされても `destroy()` で自動削除します。

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
│   ├── index.ts          # エッジルーター（CI 管理 API / プレビューサブドメイン転送）
│   ├── preview-do.ts     # Durable Object（寿命管理・多重起動ロック・JWE キャッシュ・プロキシ・Alarm）
│   ├── aws-microvm.ts    # AWS Lambda MicroVMs SigV4 クライアント (aws4fetch)
│   ├── auth.ts           # CI Webhook 定数時間シークレット検証 & Cloudflare Access JWT 検証
│   ├── loading-page.ts   # コールドスタート用 3 秒自動リロード HTML
│   └── types.ts          # 共通型定義
├── test/
│   └── preview-orchestrator.test.mjs  # Node.js 標準テストランナーによる単体テスト
├── .github/workflows/
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
npm install
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
npx wrangler secret put CI_WEBHOOK_SECRET

# 任意: Cloudflare Access JWT 検証を有効化する場合
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
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
  - 登録済みイメージ・稼働中 MicroVM・TTL 期限・Alarm 予定時刻を返却
- `DELETE /api/envs/:envId/destroy`
  - 稼働中 MicroVM 終了・イメージ削除・DO ストレージと Alarm を全削除

## Rails 側の注意点

プロキシ時に `X-Forwarded-Host: pr-123.preview.example.com` および `X-Forwarded-Proto: https` を付与します。Rails で `Blocked host` エラーを防ぐため、`config/environments/production.rb`（または `staging.rb`）に以下を追加してください。

```ruby
config.hosts << /\A[a-z0-9-]+\.preview\.example\.com\z/
```
