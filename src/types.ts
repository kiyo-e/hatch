import type { PreviewEnvironmentDO } from "./preview-do";

export interface Env {
  PREVIEW_DO: DurableObjectNamespace<PreviewEnvironmentDO>;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  APP_TARGET_PORT: string;
  CI_WEBHOOK_SECRET: string;
  PREVIEW_BASE_DOMAIN?: string;
  API_HOSTNAME?: string;
  /** "true" の場合、コールドスタート中の HTML リクエストに自動リロード画面を即返す */
  COLD_START_LOADING_PAGE?: string;
  /** 放置 PR の自動掃除までの日数（デフォルト: 14） */
  ZOMBIE_TTL_DAYS?: string;
  /** 任意: RunMicrovm に渡す IAM 実行ロール ARN */
  AWS_MICROVM_EXECUTION_ROLE_ARN?: string;
  /** 任意: カンマ区切りの Egress Network Connector ARN */
  AWS_EGRESS_NETWORK_CONNECTORS?: string;
  /** 任意: Cloudflare Access 検証を有効化する場合のチームドメイン */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** 任意: Cloudflare Access アプリケーションの AUD タグ */
  CF_ACCESS_AUD?: string;
}

export type MicroVmLifecycleState =
  | "PENDING"
  | "RUNNING"
  | "SUSPENDING"
  | "SUSPENDED"
  | "TERMINATING"
  | "TERMINATED"
  | "NOT_FOUND"
  | "UNKNOWN";

export interface PersistedVmState {
  imageIdentifier: string;
  imageVersion?: string;
  /** registerImage ごとに更新される世代 ID（起動中の再登録・破棄の検出に使用） */
  generation?: string;
  /** この時刻を過ぎたら放置 PR とみなして Alarm で破棄する（epoch ms） */
  zombieAt?: number;
  microvmId?: string;
  endpointUrl?: string;
  createdAt?: number; // epoch ms
  updatedAt: number; // epoch ms
}

export interface ActiveVmState {
  imageIdentifier: string;
  imageVersion?: string;
  generation?: string;
  zombieAt?: number;
  microvmId: string;
  endpointUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface CachedJweToken {
  microvmId: string;
  token: string;
  expiresAt: number; // epoch ms
}

/** destroy で終了・削除に失敗し、Alarm で再試行する対象 */
export interface PendingCleanup {
  microvmIds: string[];
  imageIdentifiers: string[];
  retryAt: number; // epoch ms
  /** 破棄の途中で状態の削除が終わっていない（有効な登録として扱わず、Alarm で状態の削除から再試行する） */
  destroyState?: boolean;
}

export interface RegisterImagePayload {
  /** MicroVM イメージの ARN または ID（互換性のため imageId も受理） */
  imageIdentifier?: string;
  imageId?: string;
  imageVersion?: string;
}

export interface PreviewStatusResponse {
  registered: boolean;
  imageIdentifier?: string;
  imageVersion?: string;
  microvmId?: string;
  booting: boolean;
  createdAt?: string;
  expiresAt?: string;
  alarmAt?: string;
  /** destroy で削除しきれず、Alarm で再試行待ちのリソース */
  cleanupPending?: {
    microvmIds: string[];
    imageIdentifiers: string[];
  };
}
