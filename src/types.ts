import type { PreviewEnvironmentDO } from "./preview-do";
import type { EnvRegistryDO } from "./registry-do";

export interface Env {
  PREVIEW_DO: DurableObjectNamespace<PreviewEnvironmentDO>;
  /** Single-instance registry tracking registered environments for the Admin UI list. */
  ENV_REGISTRY: DurableObjectNamespace<EnvRegistryDO>;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  /** Optional: STS session token when using temporary AWS credentials. */
  AWS_SESSION_TOKEN?: string;
  APP_TARGET_PORT: string;
  CI_WEBHOOK_SECRET: string;
  PREVIEW_BASE_DOMAIN?: string;
  API_HOSTNAME?: string;
  /** When "true", returns an auto-reloading HTML page to browsers during cold start. */
  COLD_START_LOADING_PAGE?: string;
  /** Days before an idle environment is auto-destroyed by DO Alarm (default: 14). */
  ZOMBIE_TTL_DAYS?: string;
  /** Optional: IAM execution role ARN passed to RunMicrovm. */
  AWS_MICROVM_EXECUTION_ROLE_ARN?: string;
  /** Optional: comma-separated Egress Network Connector ARNs. */
  AWS_EGRESS_NETWORK_CONNECTORS?: string;
  /** Optional: Cloudflare Access team domain for JWT verification. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Optional: Cloudflare Access Application AUD tag for preview subdomains. */
  CF_ACCESS_AUD?: string;
  /** Cloudflare Access Application AUD tag protecting /admin on API_HOSTNAME. */
  CF_ACCESS_ADMIN_AUD?: string;
}

/** Registry entry (authoritative state lives in PreviewEnvironmentDO). */
export interface RegistryEntry {
  envId: string;
  imageIdentifier: string;
  registeredAt: number; // epoch ms
  updatedAt: number; // epoch ms
  /** Monotonically incremented per registration to guard against stale prunes. */
  revision?: number;
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
  /** Updated per registerImage call to detect concurrent re-registration or destroy during boot. */
  generation?: string;
  /** Timestamp after which an idle environment is eligible for Alarm cleanup (epoch ms). */
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

/** Resources that failed to terminate/delete during destroy and are queued for Alarm retry. */
export interface PendingCleanup {
  microvmIds: string[];
  imageIdentifiers: string[];
  retryAt: number; // epoch ms
  /** True if destroy failed before clearing state; Alarm retries full state deletion. */
  destroyState?: boolean;
}

export interface RegisterImagePayload {
  /** MicroVM image ARN or ID (`imageId` is accepted as a compatibility alias). */
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
  /** Resources pending cleanup retry via DO Alarm. */
  cleanupPending?: {
    microvmIds: string[];
    imageIdentifiers: string[];
  };
}
