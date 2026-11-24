import { AwsClient } from "aws4fetch";
import type { Env, MicroVmLifecycleState } from "./types";

const API_VERSION = "2025-09-09";

export interface RunMicroVmParams {
  imageIdentifier: string;
  imageVersion?: string;
  maxIdleDurationSeconds: number;
  autoResumeEnabled: boolean;
  suspendedDurationSeconds: number;
  maximumDurationInSeconds?: number;
  executionRoleArn?: string;
  egressNetworkConnectors?: string[];
  clientToken?: string;
}

export interface RunMicroVmResult {
  microvmId: string;
  endpointUrl: string;
  state: MicroVmLifecycleState;
}

export interface CreateAuthTokenParams {
  microvmId: string;
  expirationInMinutes: number;
  allowedPort: number;
}

export interface CreateAuthTokenResult {
  token: string;
  expirationInMinutes: number;
}

export interface MicroVmClient {
  runMicroVm(params: RunMicroVmParams): Promise<RunMicroVmResult>;
  createMicroVmAuthToken(params: CreateAuthTokenParams): Promise<CreateAuthTokenResult>;
  getMicroVmState(microvmId: string): Promise<MicroVmLifecycleState>;
  terminateMicroVm(microvmId: string): Promise<void>;
  deleteMicroVmImage(imageIdentifier: string): Promise<void>;
}

/**
 * Normalize RunMicrovm `endpoint` to a URL (AWS docs describe an HTTPS URL, while examples show bare hostnames).
 */
export function normalizeEndpointUrl(endpoint: string): string {
  const trimmed = endpoint.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * SigV4 client for AWS Lambda MicroVMs API (/2025-09-09/) backed by aws4fetch.
 */
export class AwsMicroVmClient implements MicroVmClient {
  private readonly signer: AwsClient;
  private readonly baseUrl: string;

  constructor(
    env: Pick<Env, "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY" | "AWS_SESSION_TOKEN" | "AWS_REGION">
  ) {
    this.signer = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN || undefined,
      region: env.AWS_REGION,
      service: "lambda",
    });
    this.baseUrl = `https://lambda.${env.AWS_REGION}.amazonaws.com`;
  }

  /**
   * POST /2025-09-09/microvms (RunMicrovm)
   */
  async runMicroVm(params: RunMicroVmParams): Promise<RunMicroVmResult> {
    const body: Record<string, unknown> = {
      imageIdentifier: params.imageIdentifier,
      idlePolicy: {
        maxIdleDurationSeconds: params.maxIdleDurationSeconds,
        autoResumeEnabled: params.autoResumeEnabled,
        suspendedDurationSeconds: params.suspendedDurationSeconds,
      },
      maximumDurationInSeconds: params.maximumDurationInSeconds ?? 28800,
    };

    if (params.imageVersion) {
      body.imageVersion = params.imageVersion;
    }
    if (params.executionRoleArn) {
      body.executionRoleArn = params.executionRoleArn;
    }
    if (params.egressNetworkConnectors && params.egressNetworkConnectors.length > 0) {
      body.egressNetworkConnectors = params.egressNetworkConnectors;
    }
    if (params.clientToken) {
      body.clientToken = params.clientToken;
    }

    const res = await this.signer.fetch(`${this.baseUrl}/${API_VERSION}/microvms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`RunMicrovm failed (${res.status}): ${await res.text()}`);
    }

    const data = await res.json<{
      microvmId: string;
      endpoint: string;
      state: MicroVmLifecycleState;
    }>();

    if (!data.microvmId || !data.endpoint) {
      throw new Error("RunMicrovm returned incomplete response (missing microvmId or endpoint)");
    }

    return {
      microvmId: data.microvmId,
      endpointUrl: normalizeEndpointUrl(data.endpoint),
      state: data.state,
    };
  }

  /**
   * POST /2025-09-09/microvms/{microvmIdentifier}/auth-token (CreateMicrovmAuthToken)
   */
  async createMicroVmAuthToken(params: CreateAuthTokenParams): Promise<CreateAuthTokenResult> {
    const expirationInMinutes = Math.min(60, Math.max(1, Math.floor(params.expirationInMinutes)));

    const res = await this.signer.fetch(
      `${this.baseUrl}/${API_VERSION}/microvms/${encodeURIComponent(params.microvmId)}/auth-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowedPorts: [{ port: params.allowedPort }],
          expirationInMinutes,
        }),
      }
    );

    if (!res.ok) {
      throw new Error(`CreateMicrovmAuthToken failed (${res.status}): ${await res.text()}`);
    }

    const data = await res.json<{ authToken: Record<string, string> }>();
    const token =
      data.authToken?.["X-aws-proxy-auth"] ?? data.authToken?.["x-aws-proxy-auth"];

    if (!token) {
      throw new Error("CreateMicrovmAuthToken response missing X-aws-proxy-auth token");
    }

    return { token, expirationInMinutes };
  }

  /**
   * GET /2025-09-09/microvms/{microvmIdentifier} (GetMicrovm)
   */
  async getMicroVmState(microvmId: string): Promise<MicroVmLifecycleState> {
    const res = await this.signer.fetch(
      `${this.baseUrl}/${API_VERSION}/microvms/${encodeURIComponent(microvmId)}`,
      { method: "GET" }
    );

    if (res.status === 404) return "NOT_FOUND";
    if (!res.ok) return "UNKNOWN";

    const data = await res.json<{ state?: MicroVmLifecycleState }>();
    return data.state ?? "UNKNOWN";
  }

  /**
   * DELETE /2025-09-09/microvms/{microvmIdentifier} (TerminateMicrovm)
   */
  async terminateMicroVm(microvmId: string): Promise<void> {
    const res = await this.signer.fetch(
      `${this.baseUrl}/${API_VERSION}/microvms/${encodeURIComponent(microvmId)}`,
      { method: "DELETE" }
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`TerminateMicrovm failed (${res.status}): ${await res.text()}`);
    }
  }

  /**
   * DELETE /2025-09-09/microvm-images/{imageIdentifier} (DeleteMicrovmImage)
   */
  async deleteMicroVmImage(imageIdentifier: string): Promise<void> {
    const res = await this.signer.fetch(
      `${this.baseUrl}/${API_VERSION}/microvm-images/${encodeURIComponent(imageIdentifier)}`,
      { method: "DELETE" }
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`DeleteMicrovmImage failed (${res.status}): ${await res.text()}`);
    }
  }
}
