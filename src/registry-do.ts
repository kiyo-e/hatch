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
      revision: (existing?.revision ?? 0) + 1,
    });
  }

  async get(envId: string): Promise<RegistryEntry | undefined> {
    return this.ctx.storage.get<RegistryEntry>(KEY_PREFIX + envId);
  }

  /**
   * 台帳から外す。expectedRevision を渡したときは、その番号のまま（読んだあとに登録し直されていない）場合だけ外す。
   * 読み取りと削除の間に外部 I/O を挟まないので、同じ Durable Object への登録と交錯しない。
   */
  async remove(envId: string, expectedRevision?: number): Promise<boolean> {
    const key = KEY_PREFIX + envId;
    if (expectedRevision !== undefined) {
      const current = await this.ctx.storage.get<RegistryEntry>(key);
      if (!current || (current.revision ?? 0) !== expectedRevision) return false;
    }
    return this.ctx.storage.delete(key);
  }

  async list(): Promise<RegistryEntry[]> {
    const entries = await this.ctx.storage.list<RegistryEntry>({ prefix: KEY_PREFIX });
    return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
