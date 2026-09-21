/**
 * Shared factories for tests: a fast agent config pointed at a base URL and
 * a collecting logger for asserting on log output.
 */
import type { AgentConfigInput } from "../../src/config.js";
import type { AgentLogger } from "../../src/logger.js";

export interface CollectingLogger extends AgentLogger {
  messages: { level: string; message: string }[];
  warnings(): string[];
  errors(): string[];
}

export function collectingLogger(): CollectingLogger {
  const messages: { level: string; message: string }[] = [];
  return {
    messages,
    debug: (message: string) => messages.push({ level: "debug", message }),
    info: (message: string) => messages.push({ level: "info", message }),
    warn: (message: string) => messages.push({ level: "warn", message }),
    error: (message: string) => messages.push({ level: "error", message }),
    warnings: () => messages.filter((entry) => entry.level === "warn").map((entry) => entry.message),
    errors: () => messages.filter((entry) => entry.level === "error").map((entry) => entry.message),
  };
}

/** Fast, deterministic config for tests (tiny intervals, minimal retries). */
export function testAgentConfig(
  overrides: Partial<AgentConfigInput> = {},
): AgentConfigInput {
  return {
    apiKey: "test-api-key-1234",
    endpoint: "http://127.0.0.1:1", // replaced per-test with the mock URL
    projectId: "proj_test",
    flushInterval: 0.05,
    statusInterval: 60,
    retryAttempts: 2,
    backoffFactor: 0.01,
    timeout: 2,
    bufferSize: 100,
    logger: collectingLogger(),
    ...overrides,
  };
}

/** A padded security event with a deterministic wire size. */
export function makeEvent(padLength = 0, eventType = "rate_limited"): {
  timestamp: Date;
  eventType: string;
  ipAddress: string;
  actionTaken: string;
  reason: string;
  statusCode: number;
  metadata: Record<string, unknown>;
} {
  return {
    timestamp: new Date(),
    eventType,
    ipAddress: "203.0.113.7",
    actionTaken: "blocked",
    reason: "test",
    statusCode: 403,
    metadata: padLength > 0 ? { pad: "x".repeat(padLength) } : {},
  };
}
