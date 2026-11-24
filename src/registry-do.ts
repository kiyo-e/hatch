import { DurableObject } from "cloudflare:workers";
import type { Env, RegistryEntry } from "./types";

const KEY_PREFIX = "env:";

/**
 * Registry of preview environments for the Admin UI list.
 * Serves as an index only; authoritative state lives in each PreviewEnvironmentDO
 * (entries whose DOs were auto-destroyed by Alarms are pruned on list).
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
   * Remove an entry. When expectedRevision is provided, only remove if the revision
   * has not changed since the caller read it (no external I/O between get and delete).
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
