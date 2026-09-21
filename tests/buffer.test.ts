import { describe, expect, it, vi } from "vitest";

import { EventBuffer } from "../src/buffer.js";
import { resolveAgentConfig } from "../src/config.js";
import { BufferFullError } from "../src/errors.js";
import { normalizeSecurityEvent, normalizeSecurityMetric } from "../src/models.js";
import { FakeRedisHandler } from "./helpers/fake-redis.js";
import { collectingLogger, makeEvent } from "./helpers/test-utils.js";

function newBuffer(
  overrides: Record<string, unknown> = {},
  flushCallback: (() => Promise<void>) | null = null,
): { buffer: EventBuffer; config: ReturnType<typeof resolveAgentConfig> } {
  const config = resolveAgentConfig({
    apiKey: "test-api-key-1234",
    bufferSize: 3,
    flushInterval: 0.05,
    logger: collectingLogger(),
    ...overrides,
  } as Parameters<typeof resolveAgentConfig>[0]);
  return { buffer: new EventBuffer(config, flushCallback), config };
}

function event(n: number) {
  return normalizeSecurityEvent({ ...makeEvent(), eventType: `event_${n}` });
}

describe("EventBuffer overflow policies", () => {
  it("drop policy (default) evicts the oldest entry and counts drops", async () => {
    const { buffer } = newBuffer();
    for (let i = 1; i <= 5; i++) await buffer.addEvent(event(i));

    const [events] = await buffer.flushEventsWithKeys();
    expect(events.map((e) => e.eventType)).toEqual(["event_3", "event_4", "event_5"]);
    expect(buffer.eventsDropped).toBe(2);
    expect(buffer.eventsBuffered).toBe(5);
  });

  it("raise policy throws BufferFullError", async () => {
    const { buffer } = newBuffer({ bufferOverflowPolicy: "raise" });
    await buffer.addEvent(event(1));
    await buffer.addEvent(event(2));
    await buffer.addEvent(event(3));
    await expect(buffer.addEvent(event(4))).rejects.toThrow(BufferFullError);
    const [events] = await buffer.flushEventsWithKeys();
    expect(events).toHaveLength(3);
  });

  it("block policy waits for space and requeued items keep their slot", async () => {
    const { buffer } = newBuffer({ bufferSize: 2, bufferOverflowPolicy: "block" });
    await buffer.addEvent(event(1));
    await buffer.addEvent(event(2));

    const pending = buffer.addEvent(event(3));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Still blocked while the buffer is full.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    await buffer.flushEventsWithKeys(); // frees space and notifies waiters
    await pending;
    const [events] = await buffer.flushEventsWithKeys();
    expect(events.map((e) => e.eventType)).toEqual(["event_3"]);
  });

  it("metrics overflow independently of events", async () => {
    const { buffer } = newBuffer({ bufferSize: 2 });
    await buffer.addMetric(
      normalizeSecurityMetric({ metricType: "request_count", value: 1, timestamp: new Date() }),
    );
    await buffer.addMetric(
      normalizeSecurityMetric({ metricType: "request_count", value: 2, timestamp: new Date() }),
    );
    await buffer.addMetric(
      normalizeSecurityMetric({ metricType: "request_count", value: 3, timestamp: new Date() }),
    );
    const [metrics] = await buffer.flushMetricsWithKeys();
    expect(metrics.map((m) => m.value)).toEqual([2, 3]);
    expect(buffer.metricsDropped).toBe(1);
  });
});

describe("EventBuffer requeue semantics", () => {
  it("pushes unsent items back at the front in original order", async () => {
    const { buffer } = newBuffer();
    await buffer.addEvent(event(1));
    await buffer.addEvent(event(2));
    const [events, keys] = await buffer.flushEventsWithKeys();
    expect(keys).toEqual(["", ""]);

    await buffer.requeueEventsInMemory(events, keys);
    const [requeued] = await buffer.flushEventsWithKeys();
    expect(requeued.map((e) => e.eventType)).toEqual(["event_1", "event_2"]);
  });

  it("evicts from the tail when full and returns those keys for confirmation", async () => {
    const redis = new FakeRedisHandler();
    const { buffer } = newBuffer({ bufferSize: 3 });
    buffer.redisHandler = redis;
    await buffer.initializeRedis(redis);

    await buffer.addEvent(event(1));
    await buffer.flushEventsWithKeys();

    // Requeue 4 items into a capacity-3 buffer: the tail (r4) is evicted and
    // its key returned so the caller can confirm (delete) it.
    const items = [event(10), event(11), event(12), event(13)];
    const keys = items.map(() => "requeued-key");
    const evicted = await buffer.requeueEventsInMemory(items, keys);
    expect(evicted).toEqual(["requeued-key"]);

    const [events, eventKeys] = await buffer.flushEventsWithKeys();
    expect(events.map((e) => e.eventType)).toEqual(["event_10", "event_11", "event_12"]);
    expect(eventKeys).toEqual(["requeued-key", "requeued-key", "requeued-key"]);
    expect(buffer.eventsDropped).toBe(1);
  });
});

describe("EventBuffer redis persistence", () => {
  it("persists each item under a unique key and confirms on success", async () => {
    const redis = new FakeRedisHandler();
    const { buffer } = newBuffer();
    await buffer.initializeRedis(redis);

    await buffer.addEvent(event(1));
    await buffer.addMetric(
      normalizeSecurityMetric({ metricType: "block_rate", value: 5, timestamp: new Date() }),
    );
    expect(redis.store.size).toBe(2);

    const [events, eventKeys] = await buffer.flushEventsWithKeys();
    const [metrics, metricKeys] = await buffer.flushMetricsWithKeys();
    expect(eventKeys).toHaveLength(1);
    expect(metricKeys).toHaveLength(1);
    expect(eventKeys[0]).not.toBe("");
    await buffer.confirmEventRedisKeys(eventKeys);
    await buffer.confirmMetricRedisKeys(metricKeys);
    expect(redis.store.size).toBe(0);
    expect(events).toHaveLength(1);
    expect(metrics).toHaveLength(1);
  });

  it("retains redis keys across a failed send (requeue keeps them)", async () => {
    const redis = new FakeRedisHandler();
    const { buffer } = newBuffer();
    await buffer.initializeRedis(redis);

    await buffer.addEvent(event(1));
    const [, keys] = await buffer.flushEventsWithKeys();
    await buffer.requeueEventsInMemory(await Promise.resolve([event(1)]), keys);
    // Key must still exist after requeue; only confirm deletes it.
    expect(redis.store.size).toBe(1);
    const [events, requeuedKeys] = await buffer.flushEventsWithKeys();
    await buffer.confirmEventRedisKeys(requeuedKeys);
    expect(redis.store.size).toBe(0);
    expect(events).toHaveLength(1);
  });

  it("degrades gracefully when redis writes fail", async () => {
    const redis = new FakeRedisHandler();
    redis.failWrites = true;
    const { buffer } = newBuffer();
    await buffer.initializeRedis(redis);

    await buffer.addEvent(event(1));
    expect(buffer.redisPersistFailures).toBe(1);
    expect(buffer.getStats().durabilityDegraded).toBe(true);
    const [events, keys] = await buffer.flushEventsWithKeys();
    expect(events).toHaveLength(1);
    expect(keys).toEqual([""]);
  });

  it("recovers pending items from redis in a fresh buffer (crash recovery)", async () => {
    const redis = new FakeRedisHandler();
    const first = newBuffer();
    await first.buffer.initializeRedis(redis);
    await first.buffer.addEvent(event(1));
    await first.buffer.addEvent(event(2));

    const second = newBuffer();
    await second.buffer.initializeRedis(redis);
    expect(second.buffer.getBufferSize()).toBe(2);
    const [events, keys] = await second.buffer.flushEventsWithKeys();
    expect(events.map((e) => e.eventType)).toEqual(["event_1", "event_2"]);
    expect(keys.every((key) => key !== "")).toBe(true);

    await second.buffer.confirmEventRedisKeys(keys);
    expect(redis.store.size).toBe(0);
  });

  it("clears both queues and wipes redis namespaces", async () => {
    const redis = new FakeRedisHandler();
    const { buffer } = newBuffer();
    await buffer.initializeRedis(redis);
    await buffer.addEvent(event(1));
    await buffer.addMetric(
      normalizeSecurityMetric({ metricType: "request_count", value: 1, timestamp: new Date() }),
    );
    await buffer.clearBuffer();
    expect(buffer.getBufferSize()).toBe(0);
    expect(redis.store.size).toBe(0);
  });
});

describe("EventBuffer flush triggers", () => {
  it("high watermark triggers an early flush", async () => {
    const flushCallback = vi.fn(async () => {});
    const config = resolveAgentConfig({
      apiKey: "test-api-key-1234",
      bufferSize: 4,
      highWatermarkRatio: 0.5,
      flushInterval: 30,
      logger: collectingLogger(),
    });
    const buffer = new EventBuffer(config, flushCallback);
    await buffer.addEvent(event(1));
    await buffer.addEvent(event(2)); // 2 >= 4 * 0.5

    await vi.waitFor(() => expect(flushCallback).toHaveBeenCalledTimes(1));
  });

  it("below the watermark and before the interval, no flush fires", async () => {
    const flushCallback = vi.fn(async () => {});
    const config = resolveAgentConfig({
      apiKey: "test-api-key-1234",
      bufferSize: 100,
      highWatermarkRatio: 0.8,
      flushInterval: 30,
      logger: collectingLogger(),
    });
    const buffer = new EventBuffer(config, flushCallback);
    await buffer.addEvent(event(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flushCallback).not.toHaveBeenCalled();
  });

  it("the auto flush loop fires after the interval and stops cleanly", async () => {
    const flushCallback = vi.fn(async () => {});
    const config = resolveAgentConfig({
      apiKey: "test-api-key-1234",
      bufferSize: 100,
      flushInterval: 0.05,
      logger: collectingLogger(),
    });
    const buffer = new EventBuffer(config, flushCallback);
    await buffer.addEvent(event(1));
    buffer.startAutoFlush();
    await vi.waitFor(() => expect(flushCallback.mock.calls.length).toBeGreaterThanOrEqual(1));
    await buffer.stopAutoFlush();
    const calls = flushCallback.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(flushCallback.mock.calls.length).toBe(calls);
  });

  it("respects maxConcurrentFlushes", async () => {
    let active = 0;
    let maxObserved = 0;
    const flushCallback = vi.fn(async () => {
      active += 1;
      maxObserved = Math.max(maxObserved, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
    });
    const config = resolveAgentConfig({
      apiKey: "test-api-key-1234",
      bufferSize: 4,
      highWatermarkRatio: 0.25,
      maxConcurrentFlushes: 1,
      flushInterval: 30,
      logger: collectingLogger(),
    });
    const buffer = new EventBuffer(config, flushCallback);
    await buffer.addEvent(event(1));
    await buffer.addEvent(event(2));
    await vi.waitFor(() => expect(flushCallback).toHaveBeenCalled());
    // A second trigger while one flush is in flight must be throttled.
    await buffer.flushIfNeeded();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maxObserved).toBe(1);
  });
});
