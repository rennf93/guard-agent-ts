/**
 * Redis persistence seam, mirroring guard_agent/protocols.py
 * RedisHandlerProtocol (lines 6-46) with a default ioredis adapter.
 *
 * The agent persists every buffered event/metric under a globally-unique key
 * so a crash loses nothing that was already accepted from the host app. Keys
 * are namespaced `{keyPrefix}:{namespace}:{key}`; the buffer passes short
 * keys and the `agent_events` / `agent_metrics` namespaces.
 */
import type { AgentLogger } from "./logger.js";
import { errorMessage } from "./logger.js";

/**
 * Namespaced async key-value store the agent uses for durable buffering.
 * Reads return null on a miss (never throw for absent keys); TTLs are in
 * seconds. Mirrors RedisHandlerProtocol.
 */
export interface RedisHandler {
  getKey(namespace: string, key: string): Promise<string | null>;
  setKey(
    namespace: string,
    key: string,
    value: string,
    ttlSeconds?: number | null,
  ): Promise<boolean | null>;
  delete(namespace: string, key: string): Promise<number | null>;
  /** Return keys matching `pattern` (namespace relative), or null. */
  keys(pattern: string): Promise<string[] | null>;
  /** Open the connection/pool. Called once before any access. */
  initialize?(): Promise<void>;
  /** Release the connection. Called on agent stop. */
  close?(): Promise<void>;
}

export interface RedisHandlerOptions {
  url: string;
  keyPrefix?: string;
  password?: string;
  db?: number;
  commandTimeoutMs?: number;
  logger: AgentLogger;
}

/** Minimal structural type for the ioredis client surface we use. */
interface IoredisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  ping(): Promise<string>;
  quit(): Promise<string>;
  disconnect(): void;
  on?(event: string, listener: (error: Error) => void): unknown;
}

/**
 * RedisHandler over an ioredis client. ioredis is an optional peer
 * dependency: this adapter is only instantiated when the host app has it
 * installed (directly or through createIoredisHandler).
 */
export class IoredisHandler implements RedisHandler {
  private readonly client: IoredisClient;
  private readonly keyPrefix: string;
  private readonly commandTimeoutMs: number;
  private readonly logger: AgentLogger;

  constructor(client: IoredisClient, options: Omit<RedisHandlerOptions, "url">) {
    this.client = client;
    this.keyPrefix = options.keyPrefix ?? "guard:agent";
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.logger = options.logger;
    // Route connection errors through the agent logger instead of letting
    // ioredis emit unhandled 'error' events into the host process.
    this.client.on?.("error", (error: Error) => {
      this.logger.warn(`redis connection error: ${errorMessage(error)}`);
    });
  }

  static async fromOptions(options: RedisHandlerOptions): Promise<IoredisHandler> {
    const client = await connectIoredis(options);
    return new IoredisHandler(client, options);
  }

  private fullKey(namespace: string, key: string): string {
    return `${this.keyPrefix}:${namespace}:${key}`;
  }

  async getKey(namespace: string, key: string): Promise<string | null> {
    return await this.client.get(this.fullKey(namespace, key));
  }

  async setKey(
    namespace: string,
    key: string,
    value: string,
    ttlSeconds?: number | null,
  ): Promise<boolean | null> {
    const fullKey = this.fullKey(namespace, key);
    if (ttlSeconds !== null && ttlSeconds !== undefined) {
      await this.client.set(fullKey, value, "EX", ttlSeconds);
    } else {
      await this.client.set(fullKey, value);
    }
    return true;
  }

  async delete(namespace: string, key: string): Promise<number | null> {
    return await this.client.del(this.fullKey(namespace, key));
  }

  async keys(pattern: string): Promise<string[] | null> {
    return await this.client.keys(`${this.keyPrefix}:${pattern}`);
  }

  async initialize(): Promise<void> {
    await this.client.ping();
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch (error) {
      this.logger.warn(`redis.close failed: ${errorMessage(error)}`);
      this.client.disconnect();
    }
  }
}

/** Options accepted by the ioredis constructor we care about. */
interface IoredisConstructorOptions {
  password?: string;
  db?: number;
  maxRetriesPerRequest: number;
  commandTimeout: number;
  lazyConnect: boolean;
  enableOfflineQueue: boolean;
}

type IoredisCtor = new (
  url: string,
  opts: IoredisConstructorOptions,
) => IoredisClient;

/**
 * Pick the ioredis constructor out of a dynamically imported module,
 * tolerating the namespace, default, and double-wrapped interop shapes.
 */
function pickIoredisConstructor(mod: unknown): IoredisCtor | null {
  if (typeof mod === "function") return mod as IoredisCtor;
  if (typeof mod !== "object" || mod === null) return null;
  const record = mod as Record<string, unknown>;
  const nested = record["default"];
  if (typeof nested === "function") return nested as IoredisCtor;
  if (typeof nested === "object" && nested !== null) {
    const nestedDefault = (nested as Record<string, unknown>)["default"];
    if (typeof nestedDefault === "function") return nestedDefault as IoredisCtor;
  }
  return null;
}

async function connectIoredis(options: RedisHandlerOptions): Promise<IoredisClient> {
  let ctor: IoredisCtor | null = null;
  try {
    // Dynamic import keeps ioredis optional at runtime and works in both the
    // ESM and CJS builds (tsup rewrites it to require() in the CJS bundle).
    // A missing module lands in the catch below and surfaces as a clear
    // configuration error.
    ctor = pickIoredisConstructor(await import("ioredis"));
  } catch {
    ctor = null;
  }

  if (!ctor) {
    throw new Error(
      "Redis persistence requested but ioredis is not installed. " +
        "Add ioredis to your dependencies to enable it.",
    );
  }

  const clientOptions: IoredisConstructorOptions = {
    password: options.password,
    db: options.db,
    maxRetriesPerRequest: 1,
    commandTimeout: options.commandTimeoutMs ?? 5000,
    lazyConnect: false,
    enableOfflineQueue: true,
  };
  return new ctor(options.url, clientOptions);
}

/**
 * Build a RedisHandler from config options. Throws when ioredis is not
 * installed; callers decide whether that is fatal (explicit initializeRedis)
 * or degradable (config-driven persistence at start()).
 */
export async function createIoredisHandler(
  options: RedisHandlerOptions,
): Promise<IoredisHandler> {
  return await IoredisHandler.fromOptions(options);
}
