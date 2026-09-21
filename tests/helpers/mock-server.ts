/**
 * Mock ingestion server implementing the guard-core-api telemetry contract,
 * discovered at:
 *   guard-core-app/backend/guard-core-api/guard_core_api/api/routers/telemetry_router.py
 *
 * Routes: POST /api/v1/events, POST /api/v1/metrics, POST /api/v1/status.
 * Auth: X-API-Key required (telemetry_router.py:210-217). Gzip request bodies
 * are decompressed (core/gzip_request_middleware.py:19-49). 413 when the
 * decompressed body exceeds maxPayloadBytes
 * (services/payload_size_guard.py:8-31, default 262144).
 */
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { gunzipSync } from "node:zlib";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  rawBody: Buffer;
  body: unknown;
  contentEncoding: string | null;
}

export interface BehaviorResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type BehaviorFn = (request: RecordedRequest) => BehaviorResult | null;

export interface MockServerOptions {
  /** When set, requests without this X-API-Key receive 401. */
  apiKey?: string;
  /** 413 cap on the decompressed body, mirroring INGEST_MAX_PAYLOAD_BYTES. */
  maxPayloadBytes?: number;
  /** Required X-Payload-Signature secret; mismatched signatures get 401. */
  signingSecret?: string;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 262144;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export class MockIngestionServer {
  readonly options: MockServerOptions;
  readonly requests: RecordedRequest[] = [];

  /**
   * Optional per-request override. Return null to fall through to the
   * built-in contract behavior.
   */
  behavior: BehaviorFn | null = null;

  private server: Server | null = null;

  constructor(options: MockServerOptions = {}) {
    this.options = options;
  }

  clear(): void {
    this.requests.length = 0;
    this.behavior = null;
  }

  /** URLs seen for a given path (e.g. "/api/v1/events"). */
  requestsFor(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.url === path);
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const rawBody = await readBody(request);
    const contentEncoding = request.headers["content-encoding"] ?? null;
    let bodyBuffer = rawBody;
    if (contentEncoding === "gzip") {
      try {
        bodyBuffer = gunzipSync(rawBody);
      } catch {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ detail: "Malformed gzip request body" }));
        return;
      }
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers[key.toLowerCase()] = value;
    }

    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers,
      rawBody,
      body: null,
      contentEncoding,
    };

    const maxPayloadBytes = this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (bodyBuffer.length > maxPayloadBytes) {
      this.requests.push({ ...recorded, body: null });
      response.writeHead(413, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ detail: `Payload exceeds ${maxPayloadBytes} bytes` }),
      );
      return;
    }

    if (this.options.apiKey !== undefined && headers["x-api-key"] !== this.options.apiKey) {
      this.requests.push({ ...recorded, body: null });
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "Invalid API key or project ID" }));
      return;
    }

    if (this.options.signingSecret !== undefined) {
      const provided = headers["x-payload-signature"];
      const expected = `v1=${
        createHmac("sha256", this.options.signingSecret).update(rawBody).digest("hex")
      }`;
      if (provided !== expected) {
        this.requests.push({ ...recorded, body: null });
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ detail: "Invalid payload signature" }));
        return;
      }
    }

    let parsedBody: unknown = null;
    if (bodyBuffer.length > 0) {
      try {
        parsedBody = JSON.parse(bodyBuffer.toString("utf8"));
      } catch {
        parsedBody = null;
      }
    }
    recorded.body = parsedBody;
    this.requests.push(recorded);

    const custom = this.behavior?.(recorded) ?? null;
    if (custom) {
      response.writeHead(custom.status, {
        "Content-Type": "application/json",
        ...custom.headers,
      });
      response.end(typeof custom.body === "string" ? custom.body : JSON.stringify(custom.body));
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    const payload = parsedBody as {
      events?: unknown[];
      metrics?: unknown[];
    } | null;
    response.end(
      JSON.stringify({
        success: true,
        events_received: Array.isArray(payload?.events) ? payload.events.length : 0,
        events_dropped_invalid_timestamp: 0,
        metrics_received: Array.isArray(payload?.metrics) ? payload.metrics.length : 0,
        events_processed: Array.isArray(payload?.events) ? payload.events.length : 0,
        metrics_processed: Array.isArray(payload?.metrics) ? payload.metrics.length : 0,
        errors: null,
      }),
    );
  }
}
