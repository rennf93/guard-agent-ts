/**
 * In-memory RedisHandler double for unit tests, mirroring the interface
 * semantics of guard_core Redis handlers (get returns null on miss, TTL in
 * seconds, keys(pattern) glob-ish by prefix).
 */
import type { RedisHandler } from "../../src/redis.js";

interface Entry {
  value: string;
  expiresAt: number | null;
}

function matchesGlob(key: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (match) => (match === "*" ? ".*" : `\\${match}`))}$`,
  );
  return regex.test(key);
}

export class FakeRedisHandler implements RedisHandler {
  readonly store = new Map<string, Entry>();
  setCount = 0;
  deleteCount = 0;
  failWrites = false;

  async getKey(namespace: string, key: string): Promise<string | null> {
    const entry = this.store.get(`${namespace}:${key}`);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(`${namespace}:${key}`);
      return null;
    }
    return entry.value;
  }

  async setKey(
    namespace: string,
    key: string,
    value: string,
    ttlSeconds?: number | null,
  ): Promise<boolean | null> {
    if (this.failWrites) throw new Error("simulated redis write failure");
    this.setCount += 1;
    this.store.set(`${namespace}:${key}`, {
      value,
      expiresAt:
        ttlSeconds === null || ttlSeconds === undefined
          ? null
          : Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async delete(namespace: string, key: string): Promise<number | null> {
    this.deleteCount += 1;
    return this.store.delete(`${namespace}:${key}`) ? 1 : 0;
  }

  async keys(pattern: string): Promise<string[] | null> {
    return [...this.store.keys()].filter((key) => matchesGlob(key, pattern));
  }
}
