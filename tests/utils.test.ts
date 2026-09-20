import { describe, expect, it, vi } from "vitest";

import { GuardAgentError, PermanentClientError } from "../src/errors.js";
import { collectingLogger } from "./helpers/test-utils.js";
import {
  CircuitBreaker,
  RateLimiter,
  calculateBackoffDelay,
  fireErrorHook,
  generateBatchId,
  hashIp,
  parseRetryAfterSeconds,
  safeJsonParse,
  safeJsonStringify,
  sanitizeHeaders,
  summarizeResponseBody,
  truncatePayload,
} from "../src/utils.js";

describe("calculateBackoffDelay", () => {
  it("doubles per attempt and caps at maxDelay (mirrors Python)", () => {
    expect(calculateBackoffDelay(0, 1.0)).toBe(1);
    expect(calculateBackoffDelay(1, 1.0)).toBe(2);
    expect(calculateBackoffDelay(3, 1.0)).toBe(8);
    expect(calculateBackoffDelay(10, 1.0)).toBe(60);
    expect(calculateBackoffDelay(0, 30, 300)).toBe(30);
    expect(calculateBackoffDelay(1, 30, 300)).toBe(60);
    expect(calculateBackoffDelay(5, 30, 300)).toBe(300);
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses integer seconds, defaults on absence, clamps negatives", () => {
    expect(parseRetryAfterSeconds("5")).toBe(5);
    expect(parseRetryAfterSeconds("2.5")).toBe(2.5);
    expect(parseRetryAfterSeconds(null)).toBe(60);
    expect(parseRetryAfterSeconds("garbage")).toBe(60);
    expect(parseRetryAfterSeconds("garbage", 7)).toBe(7);
    expect(parseRetryAfterSeconds("-3")).toBe(0);
  });
});

describe("generateBatchId", () => {
  it("returns epoch-millis plus 8 hex characters, unique per call", () => {
    const first = generateBatchId();
    const second = generateBatchId();
    expect(first).toMatch(/^\d+-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });
});

describe("sanitizeHeaders", () => {
  const sensitive = ["authorization", "cookie", "x-api-key"];

  it("redacts matching keys case-insensitively and trims whitespace", () => {
    const sanitized = sanitizeHeaders(
      { Authorization: "Bearer secret", Cookie: "session=1", "x-api-key": "k", Safe: "ok" },
      sensitive,
    ) as Record<string, unknown>;
    expect(sanitized["Authorization"]).toBe("[REDACTED]");
    expect(sanitized["Cookie"]).toBe("[REDACTED]");
    expect(sanitized["x-api-key"]).toBe("[REDACTED]");
    expect(sanitized["Safe"]).toBe("ok");
  });

  it("recurses into nested objects and arrays", () => {
    const sanitized = sanitizeHeaders(
      { outer: { authorization: "x", keep: [1, { cookie: "y" }] } },
      sensitive,
    ) as { outer: { authorization: string; keep: unknown[] } };
    expect(sanitized.outer.authorization).toBe("[REDACTED]");
    expect((sanitized.outer.keep[1] as Record<string, unknown>)["cookie"]).toBe(
      "[REDACTED]",
    );
  });

  it("sanitizes JSON-looking strings and redacts oversized ones", () => {
    const sanitized = sanitizeHeaders(
      { header_blob: '{"authorization":"Bearer abc"}' },
      sensitive,
    ) as Record<string, string>;
    expect(sanitized["header_blob"]).toBe('{"authorization":"[REDACTED]"}');

    const huge = `{"authorization":"${"x".repeat(9000)}"}`;
    const oversized = sanitizeHeaders({ blob: huge }, sensitive) as Record<string, string>;
    expect(oversized["blob"]).toBe("[REDACTED]");
  });

  it("redacts beyond the depth limit instead of throwing", () => {
    let nested: Record<string, unknown> = { authorization: "x" };
    for (let i = 0; i < 15; i++) nested = { level: nested };
    const sanitized = sanitizeHeaders(nested, sensitive);
    expect(JSON.stringify(sanitized)).toContain("[REDACTED]");
    expect(JSON.stringify(sanitized)).not.toContain("Bearer");
  });

  it("passes scalars and dates through and redacts unclassifiable values", () => {
    const sanitized = sanitizeHeaders(
      { n: 1, b: true, nil: null, when: new Date("2026-01-01T00:00:00Z"), fn: () => 1 },
      sensitive,
    ) as Record<string, unknown>;
    expect(sanitized["n"]).toBe(1);
    expect(sanitized["b"]).toBe(true);
    expect(sanitized["nil"]).toBeNull();
    expect(sanitized["when"]).toBeInstanceOf(Date);
    expect(sanitized["fn"]).toBe("[REDACTED]");
  });
});

describe("safe JSON helpers", () => {
  it("serializes compactly and rejects unserializable values", () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => safeJsonStringify(circular)).toThrow(/circular/i);
  });

  it("parses only JSON objects", () => {
    expect(safeJsonParse('{"success":true}')).toEqual({ success: true });
    expect(safeJsonParse("[1,2]")).toBeNull();
    expect(safeJsonParse("not json")).toBeNull();
  });
});

describe("small helpers", () => {
  it("summarizeResponseBody collapses whitespace and truncates", () => {
    expect(summarizeResponseBody("a\n b   c")).toBe("a b c");
    const long = "x".repeat(400);
    const summary = summarizeResponseBody(long);
    expect(summary).toContain("... [truncated, 400 chars total]");
    expect(summary.length).toBeLessThan(400);
  });

  it("truncatePayload appends an indicator only when needed", () => {
    expect(truncatePayload("abc", 5)).toBe("abc");
    expect(truncatePayload("abcdef", 3)).toBe("abc...[TRUNCATED]");
  });

  it("hashIp is deterministic and 16 chars", () => {
    expect(hashIp("203.0.113.7")).toHaveLength(16);
    expect(hashIp("203.0.113.7")).toBe(hashIp("203.0.113.7"));
    expect(hashIp("203.0.113.7", "salt")).not.toBe(hashIp("203.0.113.7"));
  });

  it("fireErrorHook swallows hook exceptions", () => {
    const logger = collectingLogger();
    const hook = vi.fn(() => {
      throw new Error("hook boom");
    });
    expect(() =>
      fireErrorHook(hook, logger, "transport_send", new Error("x"), {}),
    ).not.toThrow();
    expect(hook).toHaveBeenCalledOnce();
    expect(logger.errors()[0]).toContain("onError hook raised");

    const okHook = vi.fn();
    fireErrorHook(okHook, logger, "flush_events", new Error("y"), { batchSize: 1 });
    expect(okHook).toHaveBeenCalledWith("flush_events", expect.any(Error), {
      batchSize: 1,
    });
    // A null hook is a no-op.
    expect(() => fireErrorHook(null, logger, "flush_metrics", new Error("z"), {})).not.toThrow();
  });
});

describe("RateLimiter", () => {
  it("allows maxCalls per window and reports retry-after", () => {
    const limiter = new RateLimiter(2, 60);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(false);
    const retryAfter = limiter.getRetryAfter();
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("frees slots once the window passes", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(1, 1);
      expect(limiter.acquire()).toBe(true);
      expect(limiter.acquire()).toBe(false);
      vi.advanceTimersByTime(1500);
      expect(limiter.acquire()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 0 retry-after when idle", () => {
    expect(new RateLimiter(1, 60).getRetryAfter()).toBe(0);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the failure threshold and rejects without calling", async () => {
    const breaker = new CircuitBreaker(2, 60);
    const failing = async (): Promise<void> => {
      throw new Error("boom");
    };
    await expect(breaker.call(failing)).rejects.toThrow("boom");
    await expect(breaker.call(failing)).rejects.toThrow("boom");
    expect(breaker.state).toBe("OPEN");
    const spy = vi.fn(async () => "ok");
    await expect(breaker.call(spy)).rejects.toThrow(GuardAgentError);
    await expect(breaker.call(spy)).rejects.toThrow("Circuit breaker is OPEN");
    expect(spy).not.toHaveBeenCalled();
  });

  it("half-opens after the recovery timeout and closes on success", async () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker(1, 1);
      await expect(
        breaker.call(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(breaker.state).toBe("OPEN");
      vi.advanceTimersByTime(1500);
      await expect(breaker.call(async () => "recovered")).resolves.toBe("recovered");
      expect(breaker.state).toBe("CLOSED");
      expect(breaker.failureCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets PermanentClientError through without counting it", async () => {
    const breaker = new CircuitBreaker(1, 60);
    await expect(
      breaker.call(async () => {
        throw new PermanentClientError(422, "validation");
      }),
    ).rejects.toThrow(PermanentClientError);
    expect(breaker.state).toBe("CLOSED");
    expect(breaker.failureCount).toBe(0);
  });
});
