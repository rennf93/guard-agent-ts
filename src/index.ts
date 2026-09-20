/**
 * guardagent: telemetry and monitoring agent for the guard-core ecosystem
 * (TypeScript / Node.js).
 *
 * Public API:
 * - GuardAgent: the client (sendEvent / sendMetric / flushBuffer / start /
 *   stop / getStatus / getStats / healthCheck / initializeRedis).
 * - AgentConfig / resolveAgentConfig / validateAgentConfig: configuration.
 * - SecurityEvent / SecurityMetric / AgentStatus: telemetry models.
 * - EventBuffer: the durable buffer (usable standalone).
 * - HttpTransport: the ingestion API client (usable standalone).
 * - RedisHandler / createIoredisHandler: the persistence seam.
 * - Typed errors: GuardAgentError, ConfigError, BufferFullError,
 *   InvalidEventError, SerializationError, RateLimitedError,
 *   PermanentClientError, PayloadTooLargeError.
 */
import { GuardAgent } from "./agent.js";

export { AGENT_VERSION } from "./version.js";

export { GuardAgent };
export type { AgentStats } from "./agent.js";

export {
  type AgentConfig,
  type AgentConfigInput,
  type BufferOverflowPolicy,
  type ErrorHook,
  type ErrorHookStage,
  type RedisConfig,
  resolveAgentConfig,
  validateAgentConfig,
} from "./config.js";

export {
  BufferFullError,
  ConfigError,
  GuardAgentError,
  InvalidEventError,
  PermanentClientError,
  PayloadTooLargeError,
  RateLimitedError,
  SerializationError,
} from "./errors.js";

export {
  type AgentStatus,
  type MetricType,
  KNOWN_EVENT_TYPES,
  METRIC_TYPES,
  SecurityEvent,
  SecurityMetric,
  normalizeSecurityEvent,
  normalizeSecurityMetric,
} from "./models.js";

export { EventBuffer } from "./buffer.js";
export type { BufferStats } from "./buffer.js";

export { HttpTransport } from "./transport.js";
export type { TransportStats } from "./transport.js";

export { type RedisHandler, createIoredisHandler, IoredisHandler } from "./redis.js";

export type { AgentLogger } from "./logger.js";
export { DefaultAgentLogger, resolveLogger } from "./logger.js";

export {
  CircuitBreaker,
  RateLimiter,
  calculateBackoffDelay,
  generateBatchId,
  hashIp,
  parseRetryAfterSeconds,
  sanitizeHeaders,
  summarizeResponseBody,
  truncatePayload,
} from "./utils.js";

/** Default export for `import GuardAgent from "guardagent"`. */
export default GuardAgent;