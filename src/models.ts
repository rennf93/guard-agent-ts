/**
 * Wire models, mirroring guard_agent/models.py (SecurityEvent,
 * SecurityMetric, AgentStatus, EventBatch).
 *
 * The ingestion API defines its request schema with the Python agent's
 * pydantic models directly:
 *   guard-core-app/backend/guard-core-api/guard_core_api/api/schemas/telemetry_models.py:4-5
 *     from guard_agent.models import SecurityEvent, SecurityMetric
 * so the wire format is snake_case with ISO-8601 timestamps and UUID
 * idempotency keys. This module keeps camelCase internally (idiomatic
 * TypeScript) and converts at the transport boundary.
 */
import { randomUUID } from "node:crypto";

import { InvalidEventError } from "./errors.js";

/**
 * Advisory list of event types the SaaS understands, mirroring
 * KNOWN_EVENT_TYPES (guard_agent/models.py:13-53). Not validated: the server
 * accepts any `event_type` string.
 */
export const KNOWN_EVENT_TYPES: readonly string[] = [
  "ip_banned",
  "ip_unbanned",
  "ip_blocked",
  "ip_ban_failed",
  "rate_limited",
  "rate_limit_script_reloaded",
  "suspicious_request",
  "cloud_blocked",
  "country_blocked",
  "penetration_attempt",
  "behavioral_violation",
  "user_agent_blocked",
  "custom_request_check",
  "decorator_violation",
  "decoding_error",
  "detection_engine_callback_error",
  "geo_lookup_failed",
  "https_enforced",
  "pattern_anomaly_slow_execution",
  "pattern_anomaly_timeout",
  "pattern_anomaly_statistical_anomaly",
  "redis_connection",
  "redis_error",
  "dynamic_rule_applied",
  "dynamic_rule_updated",
  "path_excluded",
  "route_unresolved",
  "pattern_detected",
  "pattern_added",
  "pattern_removed",
  "access_denied",
  "authentication_failed",
  "content_filtered",
  "emergency_mode_activated",
  "emergency_mode_block",
  "dynamic_rule_violation",
  "security_bypass",
  "security_headers_applied",
  "csp_violation",
];

/**
 * Metric types accepted by the server, mirroring the
 * SecurityMetric.metric_type Literal (guard_agent/models.py:236-244).
 */
export const METRIC_TYPES = [
  "request_count",
  "response_time",
  "error_rate",
  "bandwidth_usage",
  "threat_level",
  "block_rate",
  "cache_hit_rate",
] as const;

export type MetricType = (typeof METRIC_TYPES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a field from an input object, accepting both camelCase (this port's
 * convention) and snake_case (the Python/wire convention).
 */
function pick(source: Record<string, unknown>, camel: string, snake: string): unknown {
  if (camel in source) return source[camel];
  return source[snake];
}

function optionalString(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new InvalidEventError(`${field} must be a string or null`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidEventError(`${field} is required and must be a string`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new InvalidEventError(`${field} must be a finite number or null`);
}

function optionalInt(value: unknown, field: string): number | null {
  const parsed = optionalNumber(value, field);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed)) {
    throw new InvalidEventError(`${field} must be an integer or null`);
  }
  return parsed;
}

function parseTimestamp(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvalidEventError(`${field} is not a valid Date`);
    }
    return value;
  }
  if (typeof value === "number") {
    const fromEpoch = new Date(value);
    if (Number.isNaN(fromEpoch.getTime())) {
      throw new InvalidEventError(`${field} is not a valid epoch timestamp`);
    }
    return fromEpoch;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidEventError(`${field} is not a valid ISO-8601 timestamp`);
    }
    return parsed;
  }
  throw new InvalidEventError(`${field} is required (Date, epoch ms or ISO string)`);
}

function timestampOrDefault(value: unknown): Date {
  if (value === undefined || value === null) return new Date();
  return parseTimestamp(value, "timestamp");
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new InvalidEventError(`${field} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = typeof item === "string" ? item : String(item);
  }
  return result;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new InvalidEventError("metadata must be an object");
  }
  return { ...value };
}

/** Security event, mirroring SecurityEvent (guard_agent/models.py:208-229). */
export class SecurityEvent {
  readonly idempotencyKey: string;
  readonly timestamp: Date;
  readonly eventType: string;
  readonly ipAddress: string;
  readonly country: string | null;
  readonly userAgent: string | null;
  readonly actionTaken: string;
  readonly reason: string;
  readonly endpoint: string | null;
  readonly method: string | null;
  readonly statusCode: number | null;
  readonly responseTime: number | null;
  readonly decoratorType: string | null;
  readonly ruleType: string | null;
  readonly patternMatched: string | null;
  readonly handlerName: string | null;
  readonly metadata: Record<string, unknown>;

  constructor(fields: {
    idempotencyKey: string;
    timestamp: Date;
    eventType: string;
    ipAddress?: string;
    country?: string | null;
    userAgent?: string | null;
    actionTaken?: string;
    reason?: string;
    endpoint?: string | null;
    method?: string | null;
    statusCode?: number | null;
    responseTime?: number | null;
    decoratorType?: string | null;
    ruleType?: string | null;
    patternMatched?: string | null;
    handlerName?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    this.idempotencyKey = fields.idempotencyKey;
    this.timestamp = fields.timestamp;
    this.eventType = fields.eventType;
    this.ipAddress = fields.ipAddress ?? "";
    this.country = fields.country ?? null;
    this.userAgent = fields.userAgent ?? null;
    this.actionTaken = fields.actionTaken ?? "";
    this.reason = fields.reason ?? "";
    this.endpoint = fields.endpoint ?? null;
    this.method = fields.method ?? null;
    this.statusCode = fields.statusCode ?? null;
    this.responseTime = fields.responseTime ?? null;
    this.decoratorType = fields.decoratorType ?? null;
    this.ruleType = fields.ruleType ?? null;
    this.patternMatched = fields.patternMatched ?? null;
    this.handlerName = fields.handlerName ?? null;
    this.metadata = fields.metadata ?? {};
  }

  /** Copy with a replaced metadata bag (used for redaction). */
  withMetadata(metadata: Record<string, unknown>): SecurityEvent {
    return new SecurityEvent({ ...this.toFields(), metadata });
  }

  toFields(): {
    idempotencyKey: string;
    timestamp: Date;
    eventType: string;
    ipAddress: string;
    country: string | null;
    userAgent: string | null;
    actionTaken: string;
    reason: string;
    endpoint: string | null;
    method: string | null;
    statusCode: number | null;
    responseTime: number | null;
    decoratorType: string | null;
    ruleType: string | null;
    patternMatched: string | null;
    handlerName: string | null;
    metadata: Record<string, unknown>;
  } {
    return {
      idempotencyKey: this.idempotencyKey,
      timestamp: this.timestamp,
      eventType: this.eventType,
      ipAddress: this.ipAddress,
      country: this.country,
      userAgent: this.userAgent,
      actionTaken: this.actionTaken,
      reason: this.reason,
      endpoint: this.endpoint,
      method: this.method,
      statusCode: this.statusCode,
      responseTime: this.responseTime,
      decoratorType: this.decoratorType,
      ruleType: this.ruleType,
      patternMatched: this.patternMatched,
      handlerName: this.handlerName,
      metadata: this.metadata,
    };
  }
}

/**
 * Normalize arbitrary input into a SecurityEvent, mirroring
 * IngestMixin._normalize_event (guard_agent/_client_ingest.py:49-54): only
 * known fields are read, and anything missing or invalid raises
 * InvalidEventError, which `sendEvent` catches and logs.
 *
 * Accepts both camelCase and snake_case keys so adapter code that already
 * speaks the Python field names works unchanged.
 */
export function normalizeSecurityEvent(input: unknown): SecurityEvent {
  if (input instanceof SecurityEvent) return input;
  if (!isRecord(input)) {
    throw new InvalidEventError("Event must be an object");
  }
  const rawIdempotencyKey = pick(input, "idempotencyKey", "idempotency_key");
  let idempotencyKey: string;
  if (rawIdempotencyKey === undefined || rawIdempotencyKey === null) {
    idempotencyKey = randomUUID();
  } else if (
    typeof rawIdempotencyKey === "string" &&
    UUID_PATTERN.test(rawIdempotencyKey)
  ) {
    idempotencyKey = rawIdempotencyKey;
  } else {
    throw new InvalidEventError("idempotency_key must be a UUID string");
  }

  const rawIp = pick(input, "ipAddress", "ip_address");
  const ipAddress = rawIp === undefined || rawIp === null
    ? ""
    : requiredString(rawIp, "ip_address");

  return new SecurityEvent({
    idempotencyKey,
    timestamp: parseTimestamp(pick(input, "timestamp", "timestamp"), "timestamp"),
    eventType: requiredString(pick(input, "eventType", "event_type"), "event_type"),
    ipAddress,
    country: optionalString(pick(input, "country", "country"), "country"),
    userAgent: optionalString(pick(input, "userAgent", "user_agent"), "user_agent"),
    actionTaken:
      pick(input, "actionTaken", "action_taken") === undefined ||
      pick(input, "actionTaken", "action_taken") === null
        ? ""
        : requiredString(pick(input, "actionTaken", "action_taken"), "action_taken"),
    reason:
      pick(input, "reason", "reason") === undefined || pick(input, "reason", "reason") === null
        ? ""
        : requiredString(pick(input, "reason", "reason"), "reason"),
    endpoint: optionalString(pick(input, "endpoint", "endpoint"), "endpoint"),
    method: optionalString(pick(input, "method", "method"), "method"),
    statusCode: optionalInt(pick(input, "statusCode", "status_code"), "status_code"),
    responseTime: optionalNumber(
      pick(input, "responseTime", "response_time"),
      "response_time",
    ),
    decoratorType: optionalString(
      pick(input, "decoratorType", "decorator_type"),
      "decorator_type",
    ),
    ruleType: optionalString(pick(input, "ruleType", "rule_type"), "rule_type"),
    patternMatched: optionalString(
      pick(input, "patternMatched", "pattern_matched"),
      "pattern_matched",
    ),
    handlerName: optionalString(
      pick(input, "handlerName", "handler_name"),
      "handler_name",
    ),
    metadata: metadataRecord(pick(input, "metadata", "metadata")),
  });
}

/** Performance metric, mirroring SecurityMetric (guard_agent/models.py:232-247). */
export class SecurityMetric {
  readonly timestamp: Date;
  readonly metricType: MetricType;
  readonly value: number;
  readonly endpoint: string | null;
  readonly tags: Record<string, string>;

  constructor(fields: {
    timestamp: Date;
    metricType: MetricType;
    value: number;
    endpoint?: string | null;
    tags?: Record<string, string>;
  }) {
    this.timestamp = fields.timestamp;
    this.metricType = fields.metricType;
    this.value = fields.value;
    this.endpoint = fields.endpoint ?? null;
    this.tags = fields.tags ?? {};
  }

  /** Copy with replaced tags (used for redaction). */
  withTags(tags: Record<string, string>): SecurityMetric {
    return new SecurityMetric({
      timestamp: this.timestamp,
      metricType: this.metricType,
      value: this.value,
      endpoint: this.endpoint,
      tags,
    });
  }
}

/** Normalize arbitrary input into a SecurityMetric. */
export function normalizeSecurityMetric(input: unknown): SecurityMetric {
  if (input instanceof SecurityMetric) return input;
  if (!isRecord(input)) {
    throw new InvalidEventError("Metric must be an object");
  }
  const rawType = pick(input, "metricType", "metric_type");
  if (typeof rawType !== "string" || !(METRIC_TYPES as readonly string[]).includes(rawType)) {
    throw new InvalidEventError(
      `metric_type must be one of: ${METRIC_TYPES.join(", ")}`,
    );
  }
  const value = optionalNumber(pick(input, "value", "value"), "value");
  if (value === null) {
    throw new InvalidEventError("value is required and must be a number");
  }
  return new SecurityMetric({
    timestamp: parseTimestamp(pick(input, "timestamp", "timestamp"), "timestamp"),
    metricType: rawType as MetricType,
    value,
    endpoint: optionalString(pick(input, "endpoint", "endpoint"), "endpoint"),
    tags: stringRecord(pick(input, "tags", "tags"), "tags"),
  });
}

/** Agent health snapshot, mirroring AgentStatus (guard_agent/models.py:327-337). */
export interface AgentStatus {
  timestamp: Date;
  status: "healthy" | "degraded" | "failed";
  uptime: number;
  eventsSent: number;
  eventsFailed: number;
  bufferSize: number;
  lastFlush: Date | null;
  errors: string[];
}

/** ISO-8601 rendering used on the wire (mirrors Python's datetime str()). */
export function isoUtc(value: Date): string {
  return value.toISOString();
}

/** SecurityEvent -> wire dict (snake_case, mirroring model_dump()). */
export function eventToWire(event: SecurityEvent): Record<string, unknown> {
  return {
    idempotency_key: event.idempotencyKey,
    timestamp: isoUtc(event.timestamp),
    event_type: event.eventType,
    ip_address: event.ipAddress,
    country: event.country,
    user_agent: event.userAgent,
    action_taken: event.actionTaken,
    reason: event.reason,
    endpoint: event.endpoint,
    method: event.method,
    status_code: event.statusCode,
    response_time: event.responseTime,
    decorator_type: event.decoratorType,
    rule_type: event.ruleType,
    pattern_matched: event.patternMatched,
    handler_name: event.handlerName,
    metadata: event.metadata,
  };
}

/** SecurityMetric -> wire dict (snake_case, mirroring model_dump()). */
export function metricToWire(metric: SecurityMetric): Record<string, unknown> {
  return {
    timestamp: isoUtc(metric.timestamp),
    metric_type: metric.metricType,
    value: metric.value,
    endpoint: metric.endpoint,
    tags: metric.tags,
  };
}

/** AgentStatus -> wire dict (snake_case, mirroring model_dump()). */
export function statusToWire(status: AgentStatus): Record<string, unknown> {
  return {
    timestamp: isoUtc(status.timestamp),
    status: status.status,
    uptime: status.uptime,
    events_sent: status.eventsSent,
    events_failed: status.eventsFailed,
    buffer_size: status.bufferSize,
    last_flush: status.lastFlush === null ? null : isoUtc(status.lastFlush),
    errors: status.errors,
  };
}

/** timestampOrDefault is exported for tests and adapters building events. */
export { timestampOrDefault };
