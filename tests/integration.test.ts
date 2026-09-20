/**
 * Integration smoke test: a full GuardAgent against a local mock ingestion
 * server implementing the discovered guard-core-api contract end to end:
 * buffering, auto-flush timing, wire format, auth headers, and shutdown
 * flush.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GuardAgent } from "../src/agent.js";
import { MockIngestionServer } from "./helpers/mock-server.js";
import { collectingLogger, makeEvent, testAgentConfig } from "./helpers/test-utils.js";
import { vi } from "vitest";

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

describe("GuardAgent end-to-end against the ingestion contract", () => {
  it("delivers events and metrics with correct auth, wire shape, and shutdown flush", async () => {
    const logs = collectingLogger();
    const agent = new GuardAgent({
      ...testAgentConfig({
        endpoint: baseUrl,
        flushInterval: 0.1,
        retryAttempts: 2,
        projectId: "proj_integration",
      }),
      installId: `install-${randomUUID()}`,
      logger: logs,
    } as ConstructorParameters<typeof GuardAgent>[0]);

    await agent.start();

    for (let i = 0; i < 5; i++) {
      await agent.sendEvent({
        ...makeEvent(),
        eventType: "suspicious_request",
        ipAddress: `192.0.2.${i + 1}`,
        endpoint: `/api/resource-${i}`,
        method: "POST",
        statusCode: 403,
        metadata: { authorization: "Bearer sensitive", attempt: i },
      });
    }
    await agent.sendMetric({ metricType: "request_count", value: 5, tags: { route: "/api" }, timestamp: new Date() });
    await agent.sendMetric({ metricType: "block_rate", value: 0.8, timestamp: new Date() });

    await vi.waitFor(
      () => {
        expect(server.requestsFor("/api/v1/events").length).toBeGreaterThanOrEqual(1);
        expect(server.requestsFor("/api/v1/metrics").length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 5000 },
    );

    const eventsRequest = server.requestsFor("/api/v1/events")[0];
    expect(eventsRequest?.headers["x-api-key"]).toBe(API_KEY);
    expect(eventsRequest?.headers["x-project-id"]).toBe("proj_integration");
    expect(eventsRequest?.headers["x-agent-install-id"]).toMatch(/^install-/);
    const eventsBody = eventsRequest?.body as {
      project_id: string;
      batch_id: string;
      created_at: string;
      compressed: boolean;
      agent_version: string;
      events: Record<string, unknown>[];
    };
    expect(eventsBody.project_id).toBe("proj_integration");
    expect(eventsBody.compressed).toBe(false);
    expect(eventsBody.events).toHaveLength(5);
    expect(eventsBody.events[0]?.["event_type"]).toBe("suspicious_request");
    const metadata = eventsBody.events[0]?.["metadata"] as Record<string, unknown>;
    expect(metadata["authorization"]).toBe("[REDACTED]");
    expect(metadata["attempt"]).toBe(0);

    const metricsBody = server.requestsFor("/api/v1/metrics")[0]?.body as {
      metrics: { metric_type: string; value: number }[];
    };
    expect(metricsBody.metrics.map((metric) => metric.metric_type).sort()).toEqual([
      "block_rate",
      "request_count",
    ]);

    await agent.stop();

    const stats = agent.getStats();
    expect(stats.running).toBe(false);
    expect(stats.eventsSent).toBe(5);
    expect(stats.metricsSent).toBe(2);
    expect(stats.eventsFailed).toBe(0);
    expect(await agent.healthCheck()).toBe(false);

    // The agent reported no errors on this happy path.
    expect(logs.errors()).toEqual([]);
  });

  it("survives a total ingestion outage without losing buffered events", async () => {
    const agent = new GuardAgent({
      ...testAgentConfig({ endpoint: "http://127.0.0.1:9", flushInterval: 300, retryAttempts: 0 }),
    } as ConstructorParameters<typeof GuardAgent>[0]);
    await agent.start();

    for (let i = 0; i < 3; i++) {
      await agent.sendEvent({ ...makeEvent(), eventType: `outage_${i}` });
    }
    await agent.flushBuffer(); // fails against the dead endpoint
    const status = await agent.getStatus();
    expect(status.status).toBe("degraded");

    // Nothing is lost: the events stay queued for the next successful flush.
    expect(agent.buffer.getBufferSize()).toBe(3);
    expect(agent.getStats().eventsSent).toBe(0);

    await agent.stop();
    // stop() attempted a final flush against the dead endpoint and kept the
    // events buffered (still deliverable by a future run with Redis).
    expect(agent.buffer.getBufferSize()).toBe(3);
  });
});
