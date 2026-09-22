/**
 * HTTP transport, mirroring guard_agent/transport.py and its mixin split:
 * _transport_lifecycle.py (client lifecycle, headers, stats),
 * _transport_dispatch.py (request building, compression, signing, response
 * classification), _transport_send.py (retry loops, 413 split-or-drop,
 * permanent-rejection drops).
 *
 * Wire contract (discovered in guard-core-app/backend/guard-core-api):
 * - POST {endpoint}/api/v1/events   -> BatchTelemetryRequest  (telemetry_router.py:223)
 * - POST {endpoint}/api/v1/metrics  -> BatchTelemetryRequest  (telemetry_router.py:311)
 * - POST {endpoint}/api/v1/status   -> AgentStatusRequest     (telemetry_router.py:290)
 * - Auth: X-API-Key required; X-Project-Id optional
 *   (telemetry_router.py:210-217); X-Agent-Install-Id for install tracking
 *   (telemetry_router.py:194); optional X-Payload-Signature HMAC
 *   (telemetry_router.py:110-126).
 * - 413 when the (decompressed) body exceeds 262144 bytes
 *   (services/payload_size_guard.py:8-31).
 *
 * Status classification, mirrored from _transport_dispatch.py:21-102:
 * - 200: JSON dict is returned for evaluation (success=false or non-empty
 *   errors means partial failure); unparseable body -> False.
 * - 201: accepted.
 * - 429: RateLimitedError carrying Retry-After (default 60s, capped at 300s).
 * - 401/403: generic error -> retried like any transient failure (the
 *   Python agent classifies auth failures this way; mirrored).
 * - 400/404/413/422: 413 -> PayloadTooLargeError (split-or-drop); other
 *   4xx -> PermanentClientError (batch dropped, not retried). Neither
 *   counts toward the circuit breaker.
 * - 5xx: error -> retried with exponential backoff.
 * - any other 4xx: logged, treated as a transient failure (no throw).
 */
import { gzipSync } from "node:zlib";

import type { AgentConfig } from "./config.js";
import { errorMessage } from "./logger.js";
import type { AgentLogger } from "./logger.js";
import {
  PermanentClientError,
  PayloadTooLargeError,
  RateLimitedError,
  SerializationError,
} from "./errors.js";
import type { AgentStatus, SecurityEvent, SecurityMetric } from "./models.js";
import { eventToWire, metricToWire, statusToWire } from "./models.js";
import { signPayload } from "./signing.js";
import { resolveInstallId } from "./install-id.js";
import { AGENT_VERSION } from "./version.js";
import {
  CircuitBreaker,
  RateLimiter,
  calculateBackoffDelay,
  fireErrorHook,
  generateBatchId,
  nowSeconds,
  parseRetryAfterSeconds,
  safeJsonParse,
  safeJsonStringify,
  sanitizeHeaders,
  sleep,
  summarizeResponseBody,
} from "./utils.js";

const NON_RETRYABLE_STATUS_CODES = [400, 404, 413, 422] as const;

/** Upper bound on honoring a server Retry-After (Python: 300s). */
const MAX_RETRY_AFTER_SECONDS = 300.0;

/** Backoff ceiling for transport retries (Python calculate_backoff default). */
const MAX_RETRY_BACKOFF_SECONDS = 60.0;

export interface TransportStats {
  requestsSent: number;
  requestsFailed: number;
  bytesSent: number;
  circuitBreakerState: string;
  failureCount: number;
  sessionClosed: boolean;
}

interface BatchWire {
  [key: string]: unknown;
}

export class HttpTransport {
  readonly config: AgentConfig;
  private readonly logger: AgentLogger;
  private readonly installId: string;

  circuitBreaker = new CircuitBreaker(5, 60.0);
  rateLimiter = new RateLimiter(100, 60.0);

  requestsSent = 0;
  requestsFailed = 0;
  bytesSent = 0;

  private initialized = false;
  private defaultHeaders: Record<string, string> = {};

  constructor(config: AgentConfig) {
    this.config = config;
    this.logger = config.logger;
    this.installId = resolveInstallId({
      override: config.installId,
      logger: this.logger,
    });
  }

  /** Build default headers (mirrors HTTPTransport.initialize). Idempotent. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const headers: Record<string, string> = {
      "User-Agent": `guardagent/${AGENT_VERSION}`,
      "Content-Type": "application/json",
      "X-API-Key": this.config.apiKey,
      "X-Agent-Install-Id": this.installId,
    };
    if (this.config.projectId) {
      headers["X-Project-Id"] = this.config.projectId;
    }
    this.defaultHeaders = headers;
    this.initialized = true;
    this.logger.info("HTTP transport initialized successfully");
  }

  /** Release the transport (mirrors close). */
  async close(): Promise<void> {
    this.initialized = false;
  }

  /** Get transport statistics. */
  getStats(): TransportStats {
    return {
      requestsSent: this.requestsSent,
      requestsFailed: this.requestsFailed,
      bytesSent: this.bytesSent,
      circuitBreakerState: this.circuitBreaker.state,
      failureCount: this.circuitBreaker.failureCount,
      sessionClosed: !this.initialized,
    };
  }

  // ------------------------------------------------------------------
  // Request dispatch
  // ------------------------------------------------------------------

  private endpointBase(): string {
    return this.config.endpoint.replace(/\/+$/, "");
  }

  /**
   * Redact sensitive headers inside event metadata and metric tags one more
   * time at the transport boundary (mirrors _redact_sensitive_headers).
   */
  private redactSensitiveHeaders(
    data: BatchWire,
  ): BatchWire {
    const events = data["events"];
    if (Array.isArray(events)) {
      for (const event of events) {
        if (
          typeof event === "object" &&
          event !== null &&
          !Array.isArray(event)
        ) {
          const record = event as Record<string, unknown>;
          const metadata = record["metadata"];
          if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
            record["metadata"] = sanitizeHeaders(
              metadata,
              this.config.sensitiveHeaders,
            );
          }
        }
      }
    }
    const metrics = data["metrics"];
    if (Array.isArray(metrics)) {
      for (const metric of metrics) {
        if (
          typeof metric === "object" &&
          metric !== null &&
          !Array.isArray(metric)
        ) {
          const record = metric as Record<string, unknown>;
          const tags = record["tags"];
          if (typeof tags === "object" && tags !== null && !Array.isArray(tags)) {
            record["tags"] = sanitizeHeaders(tags, this.config.sensitiveHeaders);
          }
        }
      }
    }
    return data;
  }

  /**
   * Make an HTTP request against the ingestion API. Never returns a
   * non-2xx-shaped error: failures are raised as typed errors for the retry
   * loop to classify. Mirrors _make_request + _handle_response.
   */
  private async makeRequest(
    method: "POST" | "GET",
    endpoint: string,
    data: BatchWire | null,
  ): Promise<Record<string, unknown> | boolean> {
    if (!this.initialized) await this.initialize();

    let payload = data;
    if (payload) payload = this.redactSensitiveHeaders(payload);

    const url = `${this.endpointBase()}${endpoint}`;

    try {
      if (method === "POST" && payload) {
        return await this.postJson(url, payload);
      }
      if (method === "GET") {
        const response = await fetch(url, {
          method: "GET",
          headers: { ...this.defaultHeaders },
          signal: AbortSignal.timeout(this.config.timeout * 1000),
        });
        return await this.handleResponse(response, url);
      }
      throw new Error(`Unsupported method: ${method}`);
    } catch (error) {
      if (
        error instanceof PayloadTooLargeError ||
        error instanceof PermanentClientError ||
        error instanceof RateLimitedError
      ) {
        throw error;
      }
      const label =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
          ? "Timeout error"
          : "HTTP client error";
      this.logger.error(
        `${label} for ${method} ${url}: ${errorMessage(error)}`,
      );
      throw error;
    }
  }

  private async postJson(
    url: string,
    data: BatchWire,
  ): Promise<Record<string, unknown> | boolean> {
    let json: string;
    try {
      json = safeJsonStringify(data);
    } catch (error) {
      if (error instanceof SerializationError) {
        this.logger.error(
          `Aborting POST to ${url}; payload serialization failed and batch retained: ` +
            `${error.message}`,
        );
        fireErrorHook(
          this.config.onError,
          this.logger,
          "transport_send",
          error,
          { endpoint: url },
        );
        return false;
      }
      throw error;
    }

    let body: Buffer = Buffer.from(json, "utf8");
    const headers: Record<string, string> = { ...this.defaultHeaders };
    // The server verifies the HMAC over the UNCOMPRESSED body (it
    // decompresses before verification, mirroring guard-core-api
    // telemetry_router.py:113-125), so sign the raw JSON bytes
    // regardless of whether the wire body gets compressed.
    const signature = signPayload(body, this.config.payloadSigningSecret);
    if (signature !== null) {
      headers["X-Payload-Signature"] = signature;
    }
    if (this.config.compressionEnabled && body.length >= this.config.compressionThreshold) {
      body = gzipSync(body);
      headers["Content-Encoding"] = "gzip";
    }
    this.bytesSent += body.length;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(this.config.timeout * 1000),
    });
    return await this.handleResponse(response, url);
  }

  /** Classify an HTTP response (mirrors _handle_response). */
  private async handleResponse(
    response: Response,
    url: string,
  ): Promise<Record<string, unknown> | boolean> {
    const status = response.status;
    this.logger.debug(`Response: ${status} for ${url}`);

    if (status === 200) {
      return await this.handle200(response, url);
    }
    if (status === 201) return true;
    if (status === 429) {
      throw new RateLimitedError(
        parseRetryAfterSeconds(response.headers.get("retry-after"), 60.0),
      );
    }
    if (status === 401 || status === 403) {
      throw new Error(`Authentication failed: ${status}`);
    }
    if ((NON_RETRYABLE_STATUS_CODES as readonly number[]).includes(status)) {
      const errorText = summarizeResponseBody(await safeText(response));
      this.logger.error(
        `Permanent client error ${status} for ${url}: ${errorText}`,
      );
      if (status === 413) {
        throw new PayloadTooLargeError(errorText);
      }
      throw new PermanentClientError(status, errorText);
    }
    if (status >= 500) {
      const errorText = summarizeResponseBody(await safeText(response));
      throw new Error(`Server error ${status} for ${url}: ${errorText}`);
    }

    const errorText = summarizeResponseBody(await safeText(response));
    this.logger.error(`Client error ${status} for ${url}: ${errorText}`);
    return false;
  }

  /** 200 with JSON body evaluation (mirrors _handle_200). */
  private async handle200(
    response: Response,
    url: string,
  ): Promise<Record<string, unknown> | boolean> {
    const text = await safeText(response);
    const json = safeJsonParse(text);
    if (json === null) {
      this.logger.warn(
        `200 response with unparseable JSON body for ${url}: ResponseNotJSON`,
      );
      return false;
    }
    const success = json["success"];
    const errors = json["errors"];
    if (success === false || (Array.isArray(errors) && errors.length > 0)) {
      this.logger.warn(
        `200 response reported partial failure for ${url}: ` +
          `success=${JSON.stringify(success)} errors=${JSON.stringify(errors)}`,
      );
    }
    return json;
  }

  // ------------------------------------------------------------------
  // Retry loops
  // ------------------------------------------------------------------

  /**
   * Evaluate a send result: true (accepted), false (partial failure), or
   * null (retry). Mirrors _evaluate_send_result.
   */
  private evaluateSendResult(
    result: Record<string, unknown> | boolean,
    dataType: string,
  ): boolean | null {
    if (typeof result === "object") {
      const success = result["success"];
      const errors = result["errors"];
      if (success === false || (Array.isArray(errors) && errors.length > 0)) {
        this.logger.warn(
          `Server acknowledged ${dataType} batch with partial failure: ` +
            `success=${JSON.stringify(result["success"])} errors=${JSON.stringify(result["errors"])}`,
        );
        this.requestsFailed += 1;
        return false;
      }
    }
    if (result) {
      this.requestsSent += 1;
      this.logger.debug(`Successfully sent ${dataType} batch`);
      return true;
    }
    this.requestsFailed += 1;
    return null;
  }

  /**
   * Sleep to retry (true) or record a final failure (false), mirroring
   * _sleep_or_record_giveup.
   */
  private async sleepOrRecordGiveup(attempt: number, delay: number): Promise<boolean> {
    if (attempt < this.config.retryAttempts) {
      await sleep(delay * 1000);
      return true;
    }
    this.requestsFailed += 1;
    return false;
  }

  /**
   * POST data with retry logic, local rate limiting, and the circuit
   * breaker (mirrors _send_with_retry). Returns true only when the batch
   * was accepted or reported a partial failure that the caller must requeue.
   */
  private async sendWithRetry(
    endpoint: string,
    data: BatchWire,
    dataType: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      try {
        if (!this.rateLimiter.acquire()) {
          const retryAfter = this.rateLimiter.getRetryAfter();
          this.logger.warn(
            `Rate limit exceeded, waiting ${retryAfter.toFixed(1)}s`,
          );
          await sleep(retryAfter * 1000);
          continue;
        }

        const result = await this.circuitBreaker.call(() =>
          this.makeRequest("POST", endpoint, data),
        );

        const outcome = this.evaluateSendResult(result, dataType);
        if (outcome !== null) return outcome;
      } catch (error) {
        if (error instanceof RateLimitedError) {
          const delay = Math.min(error.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
          this.logger.warn(
            `Server rate-limited ${dataType}; sleeping ${delay.toFixed(1)}s per Retry-After`,
          );
          await this.sleepOrRecordGiveup(attempt, delay);
          continue;
        }
        if (error instanceof PermanentClientError) throw error;

        this.logger.warn(
          `Attempt ${attempt + 1} failed for ${dataType}: ${errorMessage(error)}`,
        );
        const delay = calculateBackoffDelay(
          attempt,
          this.config.backoffFactor,
          MAX_RETRY_BACKOFF_SECONDS,
        );
        if (!(await this.sleepOrRecordGiveup(attempt, delay))) {
          this.logger.error(`All retry attempts failed for ${dataType}`);
          if (error instanceof Error) {
            fireErrorHook(
              this.config.onError,
              this.logger,
              "transport_send",
              error,
              { endpoint, dataType },
            );
          }
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Public send API
  // ------------------------------------------------------------------

  private buildBatchWire(items: {
    events?: SecurityEvent[];
    metrics?: SecurityMetric[];
  }): BatchWire {
    return {
      project_id: this.config.projectId ?? "default",
      events: (items.events ?? []).map((event) => eventToWire(event)),
      metrics: (items.metrics ?? []).map((metric) => metricToWire(metric)),
      batch_id: generateBatchId(),
      created_at: new Date().toISOString(),
      compressed: false,
      agent_version: AGENT_VERSION,
      guard_version: this.config.guardVersion,
      guard_core_version: this.config.guardCoreVersion,
    };
  }

  /**
   * Send security events to the ingestion API.
   *
   * Returns true when the batch was durably accepted OR intentionally
   * dropped because it is permanently un-sendable (non-retryable 4xx, or a
   * 413 that persists down to a single item); the caller deletes Redis keys
   * and does not requeue in both cases. Returns false only on transient
   * failure, so the caller requeues and retains the Redis keys for retry.
   */
  async sendEvents(events: SecurityEvent[]): Promise<boolean> {
    if (events.length === 0) return true;

    try {
      return await this.sendWithRetry(
        "/api/v1/events",
        this.buildBatchWire({ events }),
        "events",
      );
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return await this.splitOrDropOnPayloadTooLarge(
          events,
          error,
          "events",
          (half) => this.sendEvents(half),
        );
      }
      if (error instanceof PermanentClientError) {
        this.dropPermanentRejection(events, error, "events");
        return true;
      }
      this.logger.error(`Failed to send events: ${errorMessage(error)}`);
      this.requestsFailed += 1;
      return false;
    }
  }

  /** Send metrics to the ingestion API; see sendEvents for the contract. */
  async sendMetrics(metrics: SecurityMetric[]): Promise<boolean> {
    if (metrics.length === 0) return true;

    try {
      return await this.sendWithRetry(
        "/api/v1/metrics",
        this.buildBatchWire({ metrics }),
        "metrics",
      );
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return await this.splitOrDropOnPayloadTooLarge(
          metrics,
          error,
          "metrics",
          (half) => this.sendMetrics(half),
        );
      }
      if (error instanceof PermanentClientError) {
        this.dropPermanentRejection(metrics, error, "metrics");
        return true;
      }
      this.logger.error(`Failed to send metrics: ${errorMessage(error)}`);
      this.requestsFailed += 1;
      return false;
    }
  }

  /**
   * 413 split-or-drop (mirrors _split_or_drop_on_payload_too_large): split
   * the batch in half and retry each half; drop with a warning once a batch
   * of a single item still exceeds the cap.
   */
  private async splitOrDropOnPayloadTooLarge<T>(
    items: T[],
    error: PayloadTooLargeError,
    dataType: string,
    sendHalf: (half: T[]) => Promise<boolean>,
  ): Promise<boolean> {
    if (items.length <= 1) {
      this.logger.warn(
        `Dropping ${dataType} batch of ${items.length} item; payload exceeds size cap ` +
          `even as a single item: ${error.detail}`,
      );
      this.requestsFailed += 1;
      if (error instanceof Error) {
        fireErrorHook(
          this.config.onError,
          this.logger,
          "transport_send",
          error,
          { dataType, itemCount: items.length },
        );
      }
      return true;
    }
    const midpoint = Math.floor(items.length / 2);
    const left = await sendHalf(items.slice(0, midpoint));
    const right = await sendHalf(items.slice(midpoint));
    return left && right;
  }

  /** Drop a permanently rejected batch (mirrors _drop_permanent_rejection). */
  private dropPermanentRejection<T>(
    items: T[],
    error: PermanentClientError,
    dataType: string,
  ): void {
    this.logger.warn(
      `Dropping ${dataType} batch of ${items.length} item(s); permanently rejected ` +
        `(${error.statusCode}): ${error.detail}`,
    );
    this.requestsFailed += 1;
    if (error instanceof Error) {
      fireErrorHook(
        this.config.onError,
        this.logger,
        "transport_send",
        error,
        { dataType, itemCount: items.length },
      );
    }
  }

  /** Send agent status/health information (mirrors send_status). */
  async sendStatus(status: AgentStatus): Promise<boolean> {
    try {
      return await this.sendWithRetry(
        "/api/v1/status",
        statusToWire(status),
        "status",
      );
    } catch (error) {
      this.logger.error(`Failed to send status: ${errorMessage(error)}`);
      return false;
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
