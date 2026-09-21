/**
 * AgentConfig, mirroring guard_agent/models.py AgentConfig (lines 56-205)
 * and guard_agent/utils.py validate_config (lines 281-306).
 *
 * Field names are camelCase (TypeScript convention) but otherwise 1:1 with
 * the Python agent. Validation runs at construction time and raises
 * ConfigError, mirroring GuardAgentHandler.__init__ raising ValueError
 * (guard_agent/client.py:72-74).
 */
import { ConfigError } from "./errors.js";
import type { AgentLogger } from "./logger.js";
import { resolveLogger } from "./logger.js";

/** Overflow behavior when the in-memory buffer is full. */
export type BufferOverflowPolicy = "drop" | "block" | "raise";

/** Error hook stages, mirroring the Python on_error stages. */
export type ErrorHookStage =
  | "transport_send"
  | "flush_events"
  | "flush_metrics";

/**
 * Optional user callback invoked when a transport or flush step fails,
 * receiving (stage, error, context). A callback that raises is caught and
 * logged, never propagated (mirrors guard_agent/utils.py fire_error_hook).
 */
export type ErrorHook = (
  stage: ErrorHookStage,
  error: Error,
  context: Record<string, unknown>,
) => void;

/** Redis connection options for crash-recovery persistence. */
export interface RedisConfig {
  /** redis:// or rediss:// URL, e.g. redis://localhost:6379/0 */
  url: string;
  /** Key prefix for all agent keys. Default: "guard:agent". */
  keyPrefix?: string;
  password?: string;
  db?: number;
  /** Per-command timeout in milliseconds. Default: 5000. */
  commandTimeoutMs?: number;
}

/** Resolved, validated agent configuration. */
export interface AgentConfig {
  /** Guard Agent API key (sent as X-API-Key). */
  apiKey: string;
  /** Ingestion API base URL; versioned paths are appended by the transport. */
  endpoint: string;
  /** Project ID sent as X-Project-Id and in the batch payload. */
  projectId: string | null;
  /** Event/metric buffer capacity per kind. */
  bufferSize: number;
  /** Buffer flush interval in seconds. */
  flushInterval: number;
  /** Agent status report interval in seconds (minimum 60). */
  statusInterval: number;
  /** Buffer occupancy ratio that triggers an early flush. */
  highWatermarkRatio: number;
  /** Maximum concurrent early-flush operations. */
  maxConcurrentFlushes: number;
  /** Behavior when the in-memory buffer is full. */
  bufferOverflowPolicy: BufferOverflowPolicy;
  /** Send performance metrics. */
  enableMetrics: boolean;
  /** Send security events. */
  enableEvents: boolean;
  /** Number of retry attempts per batch (total tries = retryAttempts + 1). */
  retryAttempts: number;
  /** Request timeout in seconds. */
  timeout: number;
  /** Exponential backoff factor for transport retries. */
  backoffFactor: number;
  /** Header names excluded from telemetry metadata/tags. */
  sensitiveHeaders: string[];
  /** Maximum payload size to include in events (bytes), for truncatePayload. */
  maxPayloadSize: number;
  /** Version of the framework adapter hosting this agent. */
  guardVersion: string | null;
  /** Version of the guard-core(-ts) library backing the host adapter. */
  guardCoreVersion: string | null;
  /** Gzip-compress batch bodies above compressionThreshold bytes. */
  compressionEnabled: boolean;
  /** Minimum body size in bytes before gzip compression applies. */
  compressionThreshold: number;
  /** Override the auto-generated install ID (X-Agent-Install-Id). */
  installId: string | null;
  /** HMAC-SHA256 secret for the X-Payload-Signature header. */
  payloadSigningSecret: string | null;
  /** Optional best-effort failure callback. */
  onError: ErrorHook | null;
  /** Injected logger. */
  logger: AgentLogger;
  /** Redis options for crash-recovery persistence. */
  redis: RedisConfig | null;
}

/** User-supplied configuration; every field except apiKey is optional. */
export interface AgentConfigInput extends Partial<Omit<AgentConfig, "apiKey">> {
  apiKey: string;
}

const DEFAULT_SENSITIVE_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
];

let endpointSuffixWarned = false;

/**
 * Validate a resolved config and return a list of human-readable errors,
 * mirroring validate_config (guard_agent/utils.py:281-306) plus checks the
 * Python config gets from pydantic field constraints.
 */
export function validateAgentConfig(config: AgentConfig): string[] {
  const errors: string[] = [];

  if (!config.apiKey || config.apiKey.length < 10) {
    errors.push("apiKey must be at least 10 characters long");
  }

  if (!/^https?:\/\//.test(config.endpoint)) {
    errors.push("endpoint must be a valid HTTP/HTTPS URL");
  }

  if (config.bufferSize <= 0) {
    errors.push("bufferSize must be greater than 0");
  }

  if (config.flushInterval <= 0) {
    errors.push("flushInterval must be greater than 0");
  }

  if (config.timeout <= 0) {
    errors.push("timeout must be greater than 0");
  }

  if (config.retryAttempts < 0) {
    errors.push("retryAttempts cannot be negative");
  }

  if (config.backoffFactor <= 0) {
    errors.push("backoffFactor must be greater than 0");
  }

  if (config.statusInterval < 60) {
    errors.push("statusInterval must be at least 60 seconds");
  }

  if (
    config.highWatermarkRatio <= 0 ||
    config.highWatermarkRatio > 1
  ) {
    errors.push("highWatermarkRatio must be in the range (0, 1]");
  }

  if (config.maxConcurrentFlushes < 1) {
    errors.push("maxConcurrentFlushes must be at least 1");
  }

  if (config.compressionThreshold < 0) {
    errors.push("compressionThreshold cannot be negative");
  }

  if (config.redis !== null) {
    if (!/^rediss?:\/\//.test(config.redis.url)) {
      errors.push("redis.url must be a redis:// or rediss:// URL");
    }
    if (config.redis.commandTimeoutMs !== undefined && config.redis.commandTimeoutMs <= 0) {
      errors.push("redis.commandTimeoutMs must be greater than 0");
    }
  }

  return errors;
}

/**
 * Normalize the endpoint: require http/https, strip trailing slashes, and
 * strip a legacy "/api/v1" suffix with a one-time warning, mirroring
 * AgentConfig.validate_endpoint (guard_agent/models.py:176-205). The
 * transport already appends versioned paths.
 */
export function normalizeEndpoint(
  endpoint: string,
  logger: AgentLogger,
): string {
  if (!endpoint) {
    throw new ConfigError("Endpoint URL cannot be empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ConfigError("Endpoint must be a valid URL with scheme and domain");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("Endpoint URL must use http or https scheme");
  }

  const normalized = endpoint.replace(/\/+$/, "");
  if (normalized.endsWith("/api/v1")) {
    const stripped = normalized.slice(0, -"/api/v1".length).replace(/\/+$/, "");
    if (!endpointSuffixWarned) {
      logger.warn(
        `Endpoint '${endpoint}' ends with '/api/v1'; transport already appends ` +
          `versioned paths. Stripping suffix to '${stripped}'. Update your config to ` +
          `set the bare host (e.g. 'https://api.guard-core.com').`,
      );
      endpointSuffixWarned = true;
    }
    return stripped;
  }

  return normalized;
}

/**
 * Resolve user input into a full AgentConfig with defaults, then validate.
 * Throws ConfigError listing every problem, mirroring
 * `ValueError(f"Invalid agent configuration: {'; '.join(errors)}")`.
 */
export function resolveAgentConfig(input: AgentConfigInput): AgentConfig {
  const logger = resolveLogger(input.logger);

  const config: AgentConfig = {
    apiKey: input.apiKey,
    endpoint: normalizeEndpoint(input.endpoint ?? "https://api.guard-core.com", logger),
    projectId: input.projectId ?? null,
    bufferSize: input.bufferSize ?? 100,
    flushInterval: input.flushInterval ?? 30,
    statusInterval: input.statusInterval ?? 300,
    highWatermarkRatio: input.highWatermarkRatio ?? 0.8,
    maxConcurrentFlushes: input.maxConcurrentFlushes ?? 1,
    bufferOverflowPolicy: input.bufferOverflowPolicy ?? "drop",
    enableMetrics: input.enableMetrics ?? true,
    enableEvents: input.enableEvents ?? true,
    retryAttempts: input.retryAttempts ?? 3,
    timeout: input.timeout ?? 30,
    backoffFactor: input.backoffFactor ?? 1.0,
    sensitiveHeaders:
      input.sensitiveHeaders === undefined
        ? [...DEFAULT_SENSITIVE_HEADERS]
        : [...input.sensitiveHeaders],
    maxPayloadSize: input.maxPayloadSize ?? 1024,
    guardVersion: input.guardVersion ?? null,
    guardCoreVersion: input.guardCoreVersion ?? null,
    compressionEnabled: input.compressionEnabled ?? true,
    compressionThreshold: input.compressionThreshold ?? 1024,
    installId: input.installId ?? null,
    payloadSigningSecret: input.payloadSigningSecret ?? null,
    onError: input.onError ?? null,
    logger,
    redis: input.redis
      ? {
          url: input.redis.url,
          keyPrefix: input.redis.keyPrefix ?? "guard:agent",
          password: input.redis.password,
          db: input.redis.db,
          commandTimeoutMs: input.redis.commandTimeoutMs ?? 5000,
        }
      : null,
  };

  const errors = validateAgentConfig(config);
  if (errors.length > 0) {
    throw new ConfigError(`Invalid agent configuration: ${errors.join("; ")}`);
  }

  return config;
}
