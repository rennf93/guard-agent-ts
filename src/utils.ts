/**
 * Shared utilities, mirroring guard_agent/utils.py.
 *
 * Includes the redaction helper (sanitize_headers), exponential backoff,
 * RFC 7231 Retry-After parsing, the local rate limiter, and the transport
 * circuit breaker. Every helper is total: redaction falls back to a redacted
 * placeholder instead of raising, and the circuit breaker surfaces a typed
 * GuardAgentError rather than a bare Error.
 */
import { createHash, randomUUID } from "node:crypto";

import { GuardAgentError, PermanentClientError, SerializationError } from "./errors.js";
import type { AgentLogger } from "./logger.js";
import { errorMessage } from "./logger.js";
import type { ErrorHook, ErrorHookStage } from "./config.js";

export const REDACTED = "[REDACTED]";

const MAX_SANITIZE_DEPTH = 10;
const MAX_JSON_SCAN_LEN = 8192;

/** Current wall-clock time in seconds (mirrors time.time()). */
export function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Abortable sleep helper. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function normalizeKey(key: unknown): string {
  return String(key).trim().toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function hasModelDump(value: unknown): value is { model_dump: () => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { model_dump?: unknown }).model_dump === "function"
  );
}

function sanitizeValue(
  value: unknown,
  loweredSensitive: Set<string>,
  depth: number,
): unknown {
  try {
    return sanitizeValueUnsafe(value, loweredSensitive, depth);
  } catch {
    return REDACTED;
  }
}

function sanitizeValueUnsafe(
  value: unknown,
  loweredSensitive: Set<string>,
  depth: number,
): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return REDACTED;

  if (typeof value === "string") {
    return sanitizeStringValue(value, loweredSensitive, depth);
  }
  if (value === null || value === undefined) return value ?? null;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value instanceof Date
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, loweredSensitive, depth + 1));
  }
  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of value.entries()) {
      if (loweredSensitive.has(normalizeKey(key))) {
        result[String(key)] = REDACTED;
      } else {
        result[String(key)] = sanitizeValue(item, loweredSensitive, depth + 1);
      }
    }
    return result;
  }
  if (value instanceof Set) {
    return [...value].map((item) => sanitizeValue(item, loweredSensitive, depth + 1));
  }
  if (hasModelDump(value)) {
    return sanitizeValue(value.model_dump(), loweredSensitive, depth);
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (loweredSensitive.has(normalizeKey(key))) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeValue(item, loweredSensitive, depth + 1);
      }
    }
    return result;
  }
  if (typeof value === "function" || typeof value === "symbol") return REDACTED;
  return REDACTED;
}

function sanitizeStringValue(
  value: string,
  loweredSensitive: Set<string>,
  depth: number,
): string {
  const parsed = parseJsonLike(value);
  if (parsed === TOO_LARGE_TO_SCAN) return REDACTED;
  if (parsed === null) return value;
  const sanitized = sanitizeValue(parsed, loweredSensitive, depth + 1);
  try {
    return JSON.stringify(sanitized);
  } catch {
    return value;
  }
}

const TOO_LARGE_TO_SCAN = Symbol("too-large-to-scan");

function parseJsonLike(value: string): unknown | typeof TOO_LARGE_TO_SCAN | null {
  const stripped = value.trim();
  if (!stripped) return null;
  const first = stripped[0];
  if (first !== "{" && first !== "[" && first !== '"') return null;
  if (stripped.length > MAX_JSON_SCAN_LEN) return TOO_LARGE_TO_SCAN;
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    return null;
  }
}

/**
 * Remove sensitive headers from telemetry metadata/tags, mirroring
 * sanitize_headers (guard_agent/utils.py:62-198). Recurses into nested
 * objects, arrays, Maps/Sets and JSON-looking strings up to a bounded depth;
 * anything deeper or unclassifiable is redacted wholesale rather than raised.
 * Keys match case-insensitively after trimming.
 */
export function sanitizeHeaders(
  value: unknown,
  sensitiveHeaders: readonly string[],
): unknown {
  const lowered = new Set(sensitiveHeaders.map((header) => normalizeKey(header)));
  return sanitizeValue(value, lowered, 0);
}

/**
 * Exponential backoff delay, mirroring calculate_backoff_delay
 * (guard_agent/utils.py:248-253): base * 2^attempt capped at maxDelay.
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelay = 1.0,
  maxDelay = 60.0,
): number {
  const safeAttempt = Math.max(0, attempt);
  return Math.min(baseDelay * 2 ** safeAttempt, maxDelay);
}

/**
 * Parse an RFC 7231 Retry-After header (integer seconds) into a float,
 * mirroring parse_retry_after_seconds (guard_agent/utils.py:28-36).
 */
export function parseRetryAfterSeconds(
  headerValue: string | null | undefined,
  defaultSeconds = 60.0,
): number {
  if (headerValue === null || headerValue === undefined) return defaultSeconds;
  const parsed = Number.parseFloat(headerValue);
  if (!Number.isFinite(parsed)) return defaultSeconds;
  return Math.max(0, parsed);
}

/**
 * Generate a unique batch ID, mirroring generate_batch_id
 * (guard_agent/utils.py:39-43): epoch-millis + 8 hex characters.
 */
export function generateBatchId(): string {
  const timestamp = String(Date.now());
  const randomPart = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${timestamp}-${randomPart}`;
}

/**
 * Collapse an HTTP response body into a bounded single-line summary,
 * mirroring summarize_response_body (guard_agent/utils.py:207-218).
 */
export function summarizeResponseBody(text: string, maxLength = 300): string {
  const collapsed = text.split(/\s+/).filter((part) => part.length > 0).join(" ");
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}... [truncated, ${text.length} chars total]`;
}

/** Truncate a payload with an indicator, mirroring truncate_payload. */
export function truncatePayload(payload: string, maxSize: number): string {
  if (payload.length <= maxSize) return payload;
  return `${payload.slice(0, maxSize)}...[TRUNCATED]`;
}

/** Hash an IP for privacy-conscious telemetry, mirroring hash_ip. */
export function hashIp(ip: string, salt = ""): string {
  return createHash("sha256")
    .update(`${ip}${salt}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Invoke the user's onError callback without ever raising, mirroring
 * fire_error_hook (guard_agent/utils.py:232-245).
 */
export function fireErrorHook(
  onError: ErrorHook | null | undefined,
  logger: AgentLogger,
  stage: ErrorHookStage,
  error: Error,
  context: Record<string, unknown>,
): void {
  if (!onError) return;
  try {
    onError(stage, error, context);
  } catch (hookError) {
    logger.error(
      `onError hook raised while handling '${stage}': ${errorMessage(hookError)}`,
    );
  }
}

/**
 * Serialize to compact JSON, raising SerializationError on failure,
 * mirroring safe_json_serialize (guard_agent/utils.py:260-266).
 */
export function safeJsonStringify(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new SerializationError("Value is not JSON-serializable");
    }
    return encoded;
  } catch (error) {
    if (error instanceof SerializationError) throw error;
    throw new SerializationError(errorMessage(error));
  }
}

/**
 * Parse a JSON object, returning null on any failure, mirroring
 * safe_json_deserialize (guard_agent/utils.py:269-278).
 */
export function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Local send rate limiter, mirroring RateLimiter
 * (guard_agent/utils.py:309-337). Defaults in the transport are
 * 100 calls / 60s.
 */
export class RateLimiter {
  private readonly maxCalls: number;
  private readonly timeWindow: number;
  private calls: number[] = [];

  constructor(maxCalls: number, timeWindow: number) {
    this.maxCalls = maxCalls;
    this.timeWindow = timeWindow;
  }

  acquire(): boolean {
    const now = nowSeconds();
    this.calls = this.calls.filter((callTime) => now - callTime < this.timeWindow);
    if (this.calls.length < this.maxCalls) {
      this.calls.push(now);
      return true;
    }
    return false;
  }

  getRetryAfter(): number {
    if (this.calls.length === 0) return 0;
    const oldestCall = Math.min(...this.calls);
    return Math.max(0, this.timeWindow - (nowSeconds() - oldestCall));
  }
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Transport circuit breaker, mirroring CircuitBreaker
 * (guard_agent/utils.py:340-382). Defaults: 5 consecutive failures open the
 * circuit for 60s. PermanentClientError (400/404/413/422) is re-raised
 * without counting as a failure, because those are batch-level rejections,
 * not transport health signals.
 */
export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly recoveryTimeout: number;
  failureCount = 0;
  lastFailureTime: number | null = null;
  state: CircuitState = "CLOSED";

  constructor(failureThreshold = 5, recoveryTimeout = 60.0) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (
        this.lastFailureTime !== null &&
        nowSeconds() - this.lastFailureTime > this.recoveryTimeout
      ) {
        this.state = "HALF_OPEN";
      } else {
        throw new GuardAgentError("Circuit breaker is OPEN");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (error instanceof PermanentClientError) throw error;
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  private onFailure(): void {
    this.failureCount += 1;
    this.lastFailureTime = nowSeconds();
    if (this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }
}
