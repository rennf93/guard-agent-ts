/**
 * Crash-recovery persistence tests against a real Redis (docker redis on
 * localhost:6379, or REDIS_URL). Each test returns early when Redis is
 * unreachable so the suite still passes in environments without the service.
 */
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GuardAgent } from "../src/agent.js";
import { MockIngestionServer } from "./helpers/mock-server.js";
import { makeEvent, testAgentConfig } from "./helpers/test-utils.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const API_KEY = "test-api-key-1234";

let server: MockIngestionServer;
let baseUrl: string;
let redisAvailable = false;

beforeAll(async () => {
  server = new MockIngestionServer({ apiKey: API_KEY });
  baseUrl = await server.start();
  try {
    const probe = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      commandTimeout: 2000,
    });
    await probe.ping();
    await probe.quit();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
    console.warn(`Skipping redis persistence tests: ${REDIS_URL} unreachable`);
  }
});

afterAll(async () => {
  await server.stop();
  // Wipe any keys this suite created (crash simulations may abandon them).
  if (redisAvailable) {
    const cleaner = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
    const stale = await cleaner.keys("guard:agent:test-*");
    for (const key of stale) await cleaner.del(key);
    await cleaner.quit();
  }
});

describe("GuardAgent Redis crash recovery", () => {
  it("persists pending events with a TTL and reloads them in a fresh agent", async () => {
    if (!redisAvailable) return;
    const keyPrefix = `guard:agent:test-${randomUUID()}`;
    const redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      commandTimeout: 2000,
    });

    // Agent "A" accepts events then "crashes" (never flushes, never stops).
    const agentA = new GuardAgent({
      ...testAgentConfig({ endpoint: baseUrl, flushInterval: 300, retryAttempts: 0 }),
      redis: { url: REDIS_URL, keyPrefix },
    } as ConstructorParameters<typeof GuardAgent>[0]);
    await agentA.start();

    await agentA.sendEvent({ ...makeEvent(), eventType: "crash_recovery_a" });
    await agentA.sendEvent({ ...makeEvent(), eventType: "crash_recovery_b" });

    await vi.waitFor(async () => {
      const keys = await redis.keys(`${keyPrefix}:agent_events:*`);
      expect(keys).toHaveLength(2);
    });

    // Entries carry the Python-mirrored 3600s TTL.
    const keys = await redis.keys(`${keyPrefix}:agent_events:*`);
    const ttl = await redis.ttl(keys[0] as string);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);

    // Agent "B" starts from the same Redis: it must recover both events and
    // flush them to the ingestion API.
    const agentB = new GuardAgent({
      ...testAgentConfig({ endpoint: baseUrl, flushInterval: 300, retryAttempts: 0 }),
      redis: { url: REDIS_URL, keyPrefix },
    } as ConstructorParameters<typeof GuardAgent>[0]);
    await agentB.start();
    expect(agentB.buffer.getBufferSize()).toBe(2);

    await agentB.flushBuffer();
    expect(agentB.eventsSent).toBe(2);
    const received = server.requestsFor("/api/v1/events");
    expect(received).toHaveLength(1);
    const wireEvents = (received[0]?.body as { events: { event_type: string }[] }).events;
    expect(wireEvents.map((e) => e.event_type).sort()).toEqual([
      "crash_recovery_a",
      "crash_recovery_b",
    ]);

    // Successful delivery confirms (deletes) the persisted keys.
    await vi.waitFor(async () => {
      const remaining = await redis.keys(`${keyPrefix}:agent_events:*`);
      expect(remaining).toHaveLength(0);
    });

    await agentB.stop();
    await redis.quit();

    // Clean up agent A's abandoned resources without flushing its buffer
    // (the point of the crash simulation).
    const leakedHandler = (
      agentA as unknown as { redisHandler: { close(): Promise<void> } | null }
    ).redisHandler;
    if (leakedHandler?.close) await leakedHandler.close();
    await (agentA as unknown as { buffer: { stopAutoFlush(): Promise<void> } }).buffer.stopAutoFlush();
  });

  it("degrades to per-operation failures (never crashes) when redis is down", async () => {
    if (!redisAvailable) return;
    const agent = new GuardAgent({
      ...testAgentConfig({ endpoint: baseUrl }),
      redis: {
        url: "redis://127.0.0.1:6390",
        keyPrefix: "guard:agent:unreachable",
        commandTimeoutMs: 300,
      },
      flushInterval: 300,
    } as ConstructorParameters<typeof GuardAgent>[0]);

    // start() must not throw even though redis refuses connections: the
    // handler is attached (mirroring initialize_redis) and every failed
    // operation degrades to a warning.
    await agent.start();
    expect(agent.redisHandler).not.toBeNull();

    await agent.sendEvent({ ...makeEvent(), eventType: "still_buffered" });
    expect(agent.buffer.getBufferSize()).toBe(1);
    expect(agent.buffer.getStats().redisPersistFailures).toBeGreaterThanOrEqual(1);
    expect(agent.buffer.getStats().durabilityDegraded).toBe(true);

    await agent.stop();
    // stop() flushed the buffered event to the ingestion API despite no redis.
    expect(agent.eventsSent).toBe(1);
  });
});
