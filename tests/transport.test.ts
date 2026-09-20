/**
 * Transport contract tests against a mock ingestion server that mirrors the
 * discovered guard-core-api behavior: routes, auth headers, gzip handling,
 * 413 cap, 429 Retry-After, and the TelemetryResponse shape.
 */
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resolveAgentConfig, type AgentConfigInput } from "../src/config.js";
import { normalizeSecurityEvent, normalizeSecurityMetric, type AgentStatus } from "../src/models.js";
import { HttpTransport } from "../src/transport.js";
import { MockIngestionServer } from "./helpers/mock-server.js";
import { collectingLogger, makeEvent } from "./helpers/test-utils.js";

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

function transport(overrides: Partial<AgentConfigInput> = {}): HttpTransport {
  const config = resolveAgentConfig({
    apiKey: API_KEY,
    endpoint: baseUrl,
    projectId: "proj_7",
    retryAttempts: 0,
    backoffFactor: 0.01,
    timeout: 2,
    logger: collectingLogger(),
    ...overrides,
  });
  return new HttpTransport(config);
}

function events(count: number, padLength = 0) {
  return Array.from({ length: count }, (_, index) =>
    normalizeSecurityEvent({
      ...makeEvent(padLength),
      eventType: `event_${index}`,
      idempotencyKey: `123e4567-e89b-12d3-a456-4266141740${String(index).padStart(2, "0")}`,
    }),
  );
}

/** Run a test against a dedicated mock server (e.g. with a custom 413 cap). */
async function withServer(
  options: ConstructorParameters<typeof MockIngestionServer>[0],
  fn: (server: MockIngestionServer, baseUrl: string) => Promise<void>,
): Promise<void> {
  const scoped = new MockIngestionServer(options);
  const url = await scoped.start();
  try {
    await fn(scoped, url);
  } finally {
    await scoped.stop();
  }
}

describe("HttpTransport request contract", () => {
  it("posts batches to /api/v1/events with the ingestion headers and snake_case body", async () => {
    const client = transport();
    const ok = await client.sendEvents(events(2));
    expect(ok).toBe(true);

    const [request] = server.requestsFor("/api/v1/events");
    expect(request).toBeDefined();
    expect(request?.method).toBe("POST");
    expect(request?.headers["x-api-key"]).toBe(API_KEY);
    expect(request?.headers["x-project-id"]).toBe("proj_7");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["user-agent"]).toMatch(/^guardagent\/\d+\.\d+\.\d+$/);
    expect(request?.headers["x-agent-install-id"]).toBeTruthy();

    const body = request?.body as Record<string, unknown>;
    expect(body["project_id"]).toBe("proj_7");
    expect(body["batch_id"]).toMatch(/^\d+-[0-9a-f]{8}$/);
    expect(body["compressed"]).toBe(false);
    expect(body["agent_version"]).toBeTruthy();
    expect(typeof body["created_at"]).toBe("string");
    expect(body["metrics"]).toEqual([]);
    const wireEvents = body["events"] as Record<string, unknown>[];
    expect(wireEvents).toHaveLength(2);
    expect(wireEvents[0]?.["event_type"]).toBe("event_0");
    expect(wireEvents[0]?.["idempotency_key"]).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(wireEvents[0]?.["ip_address"]).toBe("203.0.113.7");
  });

  it("falls back to project_id 'default' when no project is configured", async () => {
    const client = transport({ projectId: null });
    await client.sendEvents(events(1));
    const [request] = server.requestsFor("/api/v1/events");
    expect((request?.body as Record<string, unknown>)["project_id"]).toBe("default");
    expect(request?.headers["x-project-id"]).toBeUndefined();
  });

  it("posts metrics to /api/v1/metrics and status to /api/v1/status", async () => {
    const client = transport();
    await client.sendMetrics([
      normalizeSecurityMetric({ metricType: "request_count", value: 42, timestamp: new Date() }),
    ]);
    const [metricsRequest] = server.requestsFor("/api/v1/metrics");
    const metricsBody = metricsRequest?.body as Record<string, unknown>;
    expect((metricsBody["metrics"] as Record<string, unknown>[])[0]?.["metric_type"]).toBe(
      "request_count",
    );
    expect(metricsBody["events"]).toEqual([]);

    const status: AgentStatus = {
      timestamp: new Date(),
      status: "healthy",
      uptime: 12.5,
      eventsSent: 3,
      eventsFailed: 0,
      bufferSize: 0,
      lastFlush: null,
      errors: [],
    };
    expect(await client.sendStatus(status)).toBe(true);
    const [statusRequest] = server.requestsFor("/api/v1/status");
    const statusBody = statusRequest?.body as Record<string, unknown>;
    expect(statusBody["status"]).toBe("healthy");
    expect(statusBody["events_sent"]).toBe(3);
    expect(statusBody["last_flush"]).toBeNull();
  });

  it("gzip-compresses bodies at or above the threshold and signs them", async () => {
    const client = transport({
      payloadSigningSecret: "signing-secret",
      compressionThreshold: 256,
    });
    await client.sendEvents(events(3, 200));
    const [request] = server.requestsFor("/api/v1/events");
    expect(request?.contentEncoding).toBe("gzip");
    const expected = `v1=${
      createHmac("sha256", "signing-secret").update(request?.rawBody ?? Buffer.alloc(0)).digest("hex")
    }`;
    expect(request?.headers["x-payload-signature"]).toBe(expected);
    expect((request?.body as Record<string, unknown>)["events"]).toHaveLength(3);
  });

  it("omits compression and the signature header by default", async () => {
    const client = transport({ compressionThreshold: 4096 });
    await client.sendEvents(events(1));
    const [request] = server.requestsFor("/api/v1/events");
    expect(request?.contentEncoding).toBeNull();
    expect(request?.headers["x-payload-signature"]).toBeUndefined();
  });

  it("redacts sensitive headers from event metadata at the transport boundary", async () => {
    const client = transport();
    const event = normalizeSecurityEvent({
      eventType: "rate_limited",
      timestamp: new Date(),
      metadata: { authorization: "Bearer leak-me", keep: "ok" },
    });
    await client.sendEvents([event]);
    const [request] = server.requestsFor("/api/v1/events");
    const wire = (request?.body as { events: Record<string, unknown>[] }).events[0];
    expect((wire?.["metadata"] as Record<string, unknown>)["authorization"]).toBe("[REDACTED]");
    expect((wire?.["metadata"] as Record<string, unknown>)["keep"]).toBe("ok");
  });
});

describe("HttpTransport response classification", () => {
  it("treats 200 success=false as a partial failure (requeue)", async () => {
    const client = transport();
    server.behavior = () => ({
      status: 200,
      body: { success: false, errors: ["Event quota exceeded. Upgrade your plan."] },
    });
    expect(await client.sendEvents(events(1))).toBe(false);
    expect(server.requestsFor("/api/v1/events")).toHaveLength(1); // no retry
  });

  it("treats 200 with errors[] as a partial failure", async () => {
    const client = transport();
    server.behavior = () => ({ status: 200, body: { success: true, errors: ["dropped 1"] } });
    expect(await client.sendMetrics([
      normalizeSecurityMetric({ metricType: "error_rate", value: 1, timestamp: new Date() }),
    ])).toBe(false);
  });

  it("accepts 201 and rejects unparseable 200 bodies", async () => {
    const client = transport();
    server.behavior = () => ({ status: 201, body: "" });
    expect(await client.sendEvents(events(1))).toBe(true);

    server.clear();
    server.behavior = () => ({ status: 200, body: "<html>gateway</html>" });
    expect(await client.sendEvents(events(1))).toBe(false);
  });

  it("honors 429 Retry-After and succeeds on the retry", async () => {
    const client = transport({ retryAttempts: 2 });
    let calls = 0;
    server.behavior = () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 429,
          body: { detail: "Project burst limit exceeded" },
          headers: { "Retry-After": "0" },
        };
      }
      return null; // fall through to the default 200
    };
    expect(await client.sendEvents(events(1))).toBe(true);
    expect(server.requestsFor("/api/v1/events")).toHaveLength(2);
  });

  it("drops the batch on permanent 4xx without retrying", async () => {
    for (const status of [400, 404, 422]) {
      server.clear();
      const client = transport({ retryAttempts: 3 });
      server.behavior = () => ({ status, body: { detail: `rejected ${status}` } });
      // A permanently rejected batch is intentionally dropped: the transport
      // reports success so the caller confirms the keys and stops retrying.
      expect(await client.sendEvents(events(2))).toBe(true);
      expect(server.requestsFor("/api/v1/events")).toHaveLength(1);
      expect(client.requestsFailed).toBe(1);
    }
  });

  it("retries 401/403 like the Python agent, then requeues", async () => {
    const client = transport({ retryAttempts: 1 });
    server.behavior = () => ({
      status: 401,
      body: { detail: "Invalid API key or project ID" },
    });
    expect(await client.sendEvents(events(1))).toBe(false);
    // 1 initial attempt + 1 retry, mirroring the Python generic-error path.
    expect(server.requestsFor("/api/v1/events")).toHaveLength(2);
  });

  it("retries 5xx with backoff and succeeds when the server recovers", async () => {
    const client = transport({ retryAttempts: 3, backoffFactor: 0.001 });
    let calls = 0;
    server.behavior = () => {
      calls += 1;
      if (calls <= 2) return { status: 503, body: { detail: "transient" } };
      return null;
    };
    expect(await client.sendEvents(events(1))).toBe(true);
    expect(server.requestsFor("/api/v1/events")).toHaveLength(3);
  });

  it("returns false when the server never recovers", async () => {
    const client = transport({ retryAttempts: 1, backoffFactor: 0.001 });
    server.behavior = () => ({ status: 500, body: { detail: "boom" } });
    expect(await client.sendEvents(events(1))).toBe(false);
    expect(server.requestsFor("/api/v1/events")).toHaveLength(2);
  });

  it("counts a hard-down network target as a transient failure", async () => {
    // Port 9 (discard) is closed: fetch fails at the connection layer.
    const client = transport({ endpoint: "http://127.0.0.1:9", retryAttempts: 0 });
    expect(await client.sendEvents(events(1))).toBe(false);
    expect(client.requestsFailed).toBe(1);
  });
});

describe("HttpTransport 413 split-or-drop", () => {
  it("splits the batch in half and retries the halves until they fit", async () => {
    await withServer({ apiKey: API_KEY, maxPayloadBytes: 3000 }, async (scoped, url) => {
      const client = transport({ endpoint: url, retryAttempts: 0 });
      const batch = events(8, 400);
      // ~740 bytes per event wire entry: the 8-item and 4-item batches exceed
      // the 3000-byte cap, the 2-item halves fit.
      expect(await client.sendEvents(batch)).toBe(true);

      const acceptedSizes = scoped.requests
        .filter((request) => request.url === "/api/v1/events")
        .map((request) => (request.body as { events?: unknown[] } | null)?.events?.length ?? 0)
        .filter((size) => size > 0);
      expect(acceptedSizes).toEqual([2, 2, 2, 2]);
      expect(acceptedSizes.reduce((sum, size) => sum + size, 0)).toBe(8);
    });
  });

  it("drops a singleton that still exceeds the cap and reports success", async () => {
    await withServer({ apiKey: API_KEY, maxPayloadBytes: 300 }, async (scoped, url) => {
      const errors: { stage: string; context: Record<string, unknown> }[] = [];
      const client = transport({
        endpoint: url,
        retryAttempts: 0,
        onError: (stage, _error, context) => errors.push({ stage, context }),
      });
      expect(await client.sendEvents(events(1, 600))).toBe(true);
      expect(scoped.requestsFor("/api/v1/events")).toHaveLength(1);
      expect(client.requestsFailed).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.stage).toBe("transport_send");
      expect(errors[0]?.context["itemCount"]).toBe(1);
    });
  });
});

describe("HttpTransport circuit breaker", () => {
  it("opens after 5 transport failures and short-circuits local sends", async () => {
    await withServer({ apiKey: API_KEY }, async (scoped, url) => {
      const client = transport({ endpoint: url, retryAttempts: 0 });
      scoped.behavior = () => ({ status: 500, body: { detail: "down" } });
      for (let i = 0; i < 5; i++) {
        expect(await client.sendEvents(events(1))).toBe(false);
      }
      expect(client.circuitBreaker.state).toBe("OPEN");
      expect(scoped.requestsFor("/api/v1/events")).toHaveLength(5);

      // While OPEN the breaker rejects before any HTTP call is made.
      expect(await client.sendEvents(events(1))).toBe(false);
      expect(scoped.requestsFor("/api/v1/events")).toHaveLength(5);
      expect(client.requestsFailed).toBe(6);
    });
  });
});
