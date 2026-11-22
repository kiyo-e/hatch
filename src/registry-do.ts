import { DurableObject } from "cloudflare:workers";
import type { Env, RegistryEntry } from "./types";

const KEY_PREFIX = "env:";

/**
 * 登録されたプレビュー環境の台帳（管理画面の一覧用）。
 * Durable Object は名前を知らないと参照できないため、登録・破棄のたびに管理 API がここへ記録する。
 * 台帳は一覧のための索引で、環境の実際の状態は各 PreviewEnvironmentDO が持つ
 * （Alarm による自動破棄などで実体が消えた環境は、一覧の表示時に prune で取り除く）。
 */
export class EnvRegistryDO extends DurableObject<Env> {
  async upsert(envId: string, imageIdentifier: string): Promise<void> {
    const key = KEY_PREFIX + envId;
    const now = Date.now();
    const existing = await this.ctx.storage.get<RegistryEntry>(key);
    await this.ctx.storage.put<RegistryEntry>(key, {
      envId,
      imageIdentifier,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    });
  }

  async get(envId: string): Promise<RegistryEntry | undefined> {
    return this.ctx.storage.get<RegistryEntry>(KEY_PREFIX + envId);
  }

  async remove(envId: string): Promise<void> {
    await this.ctx.storage.delete(KEY_PREFIX + envId);
  }

  async list(): Promise<RegistryEntry[]> {
    const entries = await this.ctx.storage.list<RegistryEntry>({ prefix: KEY_PREFIX });
    return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
