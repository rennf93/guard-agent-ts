import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GuardAgent } from "../src/agent.js";
import { MockIngestionServer } from "./helpers/mock-server.js";
import { collectingLogger, makeEvent, testAgentConfig } from "./helpers/test-utils.js";

const API_KEY = "test-api-key-1234";

let server: MockIngestionServer;
let baseUrl: string;

beforeAll(async () => {
  server = new MockIngestionServer({ apiKey: API_KEY });
  baseUrl = await server.start();
});

afterAll(async () => {
  await server.stop();
});

afterEach(() => {
  server.clear();
});

function newAgent(overrides: Record<string, unknown> = {}): GuardAgent {
  return new GuardAgent({
    ...testAgentConfig({ endpoint: baseUrl }),
    ...overrides,
  } as ConstructorParameters<typeof GuardAgent>[0]);
}

function event(n: number, extra: Record<string, unknown> = {}) {
  return { ...makeEvent(), eventType: `event_${n}`, ...extra };
}

describe("GuardAgent ingest path never throws", () => {
  it("buffers valid events and silently drops garbage", async () => {
    const agent = newAgent();
    await agent.sendEvent(event(1));
    expect(agent.buffer.getBufferSize()).toBe(1);

    await expect(agent.sendEvent(undefined)).resolves.toBeUndefined();
    await expect(agent.sendEvent(42)).resolves.toBeUndefined();
    await expect(agent.sendEvent({ nope: true })).resolves.toBeUndefined();
    await expect(
      agent.sendEvent({ eventType: "x", timestamp: "bogus" }),
    ).resolves.toBeUndefined();
    await expect(agent.sendMetric({ metricType: "bogus", value: 1 })).resolves.toBeUndefined();
    expect(agent.buffer.getBufferSize()).toBe(1);
  });

  it("redacts sensitive metadata at ingest time", async () => {
    const agent = newAgent();
    await agent.sendEvent(event(1, { metadata: { cookie: "session=steal", keep: 1 } }));
    const [events] = await agent.buffer.flushEventsWithKeys();
    const metadata = events[0]?.metadata as Record<string, unknown>;
    expect(metadata["cookie"]).toBe("[REDACTED]");
    expect(metadata["keep"]).toBe(1);
  });

  it("no-ops when events or metrics are disabled", async () => {
    const eventsOff = newAgent({ enableEvents: false });
    await eventsOff.sendEvent(event(1));
    expect(eventsOff.buffer.getBufferSize()).toBe(0);

    const metricsOff = newAgent({ enableMetrics: false });
    await metricsOff.sendMetric({ metricType: "request_count", value: 1 });
    expect(metricsOff.buffer.getBufferSize()).toBe(0);
  });

  it("sendEvent swallows BufferFullError under the raise policy", async () => {
    // Dead endpoint: the watermark flush fails and requeues, so the buffer
    // genuinely stays full and the next send hits the raise policy.
    const agent = newAgent({
      endpoint: "http://127.0.0.1:9",
      bufferSize: 1,
      bufferOverflowPolicy: "raise",
      highWatermarkRatio: 1,
      retryAttempts: 0,
    });
    await agent.sendEvent(event(1));
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the early flush fail and requeue
    await expect(agent.sendEvent(event(2))).resolves.toBeUndefined();
    expect(agent.buffer.getBufferSize()).toBe(1);
  });
});

describe("GuardAgent flush semantics", () => {
  it("flushes buffered events and metrics to the ingestion API", async () => {
    const agent = newAgent();
    for (let i = 0; i < 3; i++) await agent.sendEvent(event(i));
    await agent.sendMetric({ metricType: "request_count", value: 7, timestamp: new Date() });

    await agent.flushBuffer();
    expect(agent.eventsSent).toBe(3);
    expect(agent.metricsSent).toBe(1);
    expect(agent.buffer.getBufferSize()).toBe(0);
    expect(server.requestsFor("/api/v1/events")[0]?.headers["x-api-key"]).toBe(API_KEY);
    const metricsRequest = server.requestsFor("/api/v1/metrics")[0];
    expect(
      (metricsRequest?.body as { metrics: { metric_type: string }[] }).metrics[0]?.metric_type,
    ).toBe("request_count");
  });

  it("requeues in memory on failure and backs off before the next attempt", async () => {
    const agent = newAgent({ flushInterval: 300, retryAttempts: 0 });
    let failing = true;
    server.behavior = () => (failing ? { status: 500, body: { detail: "down" } } : null);

    await agent.sendEvent(event(1));
    await agent.flushBuffer();
    expect(agent.eventsSent).toBe(0);
    expect(agent.eventsFailed).toBe(1);
    expect(agent.buffer.getBufferSize()).toBe(1); // requeued
    expect(server.requestsFor("/api/v1/events")).toHaveLength(1);

    // The per-kind retry-after window (flushInterval * 2^streak) suppresses
    // an immediate second attempt.
    await agent.flushBuffer();
    expect(server.requestsFor("/api/v1/events")).toHaveLength(1);

    // Clearing the backoff window lets the flush recover.
    failing = false;
    (agent as unknown as { eventsRetryAfter: number }).eventsRetryAfter = 0;
    await agent.flushBuffer();
    expect(agent.eventsSent).toBe(1);
    expect(agent.buffer.getBufferSize()).toBe(0);
    expect(server.requestsFor("/api/v1/events")).toHaveLength(2);
  });

  it("requeues on HTTP 200 partial failure (success=false)", async () => {
    const agent = newAgent();
    server.behavior = () => ({
      status: 200,
      body: { success: false, errors: ["Event quota exceeded. Upgrade your plan."] },
    });
    await agent.sendEvent(event(1));
    await agent.flushBuffer();
    expect(agent.eventsFailed).toBe(1);
    expect(agent.buffer.getBufferSize()).toBe(1);
  });

  it("counts a permanent 4xx drop as accounted (sent, not retried)", async () => {
    const agent = newAgent();
    server.behavior = () => ({ status: 422, body: { detail: "invalid payload" } });
    await agent.sendEvent(event(1));
    await agent.flushBuffer();
    // The batch is intentionally dropped, not requeued forever. Mirroring
    // Python, the transport reports success for the drop, so the flush
    // counts the items as sent while the transport logs the failure.
    expect(agent.buffer.getBufferSize()).toBe(0);
    expect(agent.eventsSent).toBe(1);
    expect(agent.eventsFailed).toBe(0);
    expect(agent.transport.requestsFailed).toBe(1);
  });

  it("flushes everything pending on stop()", async () => {
    const agent = newAgent();
    await agent.sendEvent(event(1));
    await agent.sendEvent(event(2));
    await agent.stop();
    expect(server.requestsFor("/api/v1/events")).toHaveLength(1);
    const body = server.requestsFor("/api/v1/events")[0]?.body as {
      events: { event_type: string }[];
    };
    expect(body.events.map((e) => e.event_type)).toEqual(["event_1", "event_2"]);
    expect(agent.getStats().running).toBe(false);
  });

  it("preserves idempotency keys across a requeue", async () => {
    const agent = newAgent({ flushInterval: 300, retryAttempts: 0 });
    let failing = true;
    server.behavior = () => (failing ? { status: 503, body: { detail: "transient" } } : null);
    await agent.sendEvent(event(9, { ipAddress: "198.51.100.42" }));
    await agent.flushBuffer();
    failing = false;
    (agent as unknown as { eventsRetryAfter: number }).eventsRetryAfter = 0;
    await agent.flushBuffer();

    const bodies = server.requestsFor("/api/v1/events").map(
      (request) => request.body as { events: { idempotency_key: string }[] },
    );
    const keys = bodies.map((body) => body.events[0]?.idempotency_key);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });

  it("describes memory-only retention in the partial-failure warning without Redis", async () => {
    // The warning must not claim Redis retention when no Redis handler is
    // attached: without Redis the requeued items live solely in memory.
    const logger = collectingLogger();
    const agent = newAgent({ flushInterval: 300, retryAttempts: 0, logger });
    server.behavior = () => ({ status: 503, body: { detail: "transient" } });
    await agent.sendEvent(event(1));
    await agent.flushBuffer();

    const warning = logger
      .warnings()
      .find((message) => message.includes("Failed to send 1 events"));
    expect(warning).toBeDefined();
    expect(warning).toContain("requeued in memory (events) for retry");
    expect(warning).not.toContain("retained in Redis");
  });
});

describe("GuardAgent lifecycle and health", () => {
  it("starts background loops, delivers telemetry, and stops cleanly", async () => {
    const agent = newAgent();
    await agent.start();
    expect(agent.getStats().running).toBe(true);
    expect(await agent.healthCheck()).toBe(true);

    await agent.sendEvent(event(1));
    await agent.sendMetric({ metricType: "cache_hit_rate", value: 0.5, timestamp: new Date() });
    await vi.waitFor(() => {
      expect(agent.eventsSent).toBe(1);
      expect(agent.metricsSent).toBe(1);
    });

    await agent.stop();
    expect(agent.getStats().running).toBe(false);
    expect(await agent.healthCheck()).toBe(false);
  });

  it("start() is idempotent and stop() is safe to call twice", async () => {
    const agent = newAgent();
    await agent.start();
    await agent.start(); // logs a warning, keeps running
    await agent.stop();
    await agent.stop();
    expect(agent.getStats().running).toBe(false);
  });

  it("getStatus degrades when the buffer is nearly full", async () => {
    // Dead endpoint: the watermark flush fails and requeues, so the buffer
    // genuinely climbs toward capacity (mirrors real degraded conditions).
    const agent = newAgent({
      endpoint: "http://127.0.0.1:9",
      bufferSize: 10,
      retryAttempts: 0,
    });
    for (let i = 0; i < 9; i++) await agent.sendEvent(event(i));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await agent.getStatus();
    expect(status.status).toBe("degraded");
    expect(status.errors).toContain("Buffer nearly full");
    expect(status.bufferSize).toBe(9);
  });

  it("pushes status on the status loop and tracks consecutive failures", async () => {
    // Fake only the timer primitives the loops sleep on; leave real I/O
    // (fetch) running and pump the event loop until each send settles.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pumpUntil = async (condition: () => boolean, maxTurns = 1000): Promise<void> => {
      for (let i = 0; i < maxTurns; i++) {
        if (condition()) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    try {
      const agent = newAgent({ statusInterval: 60 });
      await agent.start();
      server.behavior = () => ({ status: 500, body: { detail: "status rejected" } });

      await vi.advanceTimersByTimeAsync(61_000);
      await pumpUntil(() => agent.getStats().lastStatusPushOk === false);
      // retryAttempts 2: one initial push + two retries before giving up.
      expect(server.requestsFor("/api/v1/status")).toHaveLength(3);
      expect(agent.getStats().loopFailures.status).toBe(1);

      server.clear();
      await vi.advanceTimersByTimeAsync(61_000);
      await pumpUntil(() => agent.getStats().lastStatusPushOk === true);
      expect(server.requestsFor("/api/v1/status")).toHaveLength(1);
      expect(agent.getStats().loopFailures.status).toBe(0);

      await agent.stop();
      vi.useRealTimers();
    } catch (error) {
      vi.useRealTimers();
      throw error;
    }
  });

  it("getStats exposes buffer and transport counters", async () => {
    const agent = newAgent();
    await agent.sendEvent(event(1));
    const stats = agent.getStats();
    expect(stats.bufferStats.currentEventBufferSize).toBe(1);
    expect(stats.transportStats.circuitBreakerState).toBe("CLOSED");
    expect(stats.loopFailures).toEqual({ flush: 0, status: 0 });
    expect(stats.lastStatusPushOk).toBeNull();
  });

  it("routes failures through the onError hook with stage context", async () => {
    const hookErrors: { stage: string; message: string }[] = [];
    const agent = newAgent({
      endpoint: "http://127.0.0.1:9",
      retryAttempts: 0,
      onError: (stage: string, error: Error) =>
        hookErrors.push({ stage, message: error.message }),
    });
    await agent.sendEvent(event(1));
    await agent.flushBuffer();
    expect(hookErrors.some((entry) => entry.stage === "transport_send")).toBe(true);
  });

  it("rejects invalid configs at construction with a clear error", () => {
    expect(() => new GuardAgent({ apiKey: "short" })).toThrow(/Invalid agent configuration/);
    expect(() => new GuardAgent({ ...testAgentConfig(), bufferSize: 0 })).toThrow(
      /bufferSize must be greater than 0/,
    );
  });
});
