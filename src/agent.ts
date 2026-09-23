/**
 * GuardAgent, the top-level telemetry client, mirroring guard_agent/client.py
 * (GuardAgentHandler) plus its mixin split: _client_ingest.py (send_event/
 * send_metric), _client_flush.py (flush_buffer with failure streaks and
 * backoff), _client_loops.py (flush/status loops), _client_status.py
 * (get_status/get_stats/health_check).
 *
 * Failure policy (mirrored from Python, documented in README):
 * - sendEvent/sendMetric NEVER throw and never block the request path for
 *   more than one buffer-write (the "block" overflow policy being the one
 *   deliberate, opt-in exception).
 * - flushBuffer NEVER throws: transport failures requeue the batch in
 *   memory, retain its Redis keys for crash recovery, and back off per-kind
 *   (flush_interval * 2^streak, capped at 300s) before the next attempt.
 * - start() may reject (bad config, failed transport init); stop() is
 *   idempotent and flushes what is buffered.
 */
import type {
  AgentConfig,
  AgentConfigInput,
  ErrorHookStage,
} from "./config.js";
import { resolveAgentConfig } from "./config.js";
import { EventBuffer } from "./buffer.js";
import type { BufferStats } from "./buffer.js";
import { errorMessage } from "./logger.js";
import type { AgentLogger } from "./logger.js";
import type { RedisHandler } from "./redis.js";
import { createIoredisHandler } from "./redis.js";
import { HttpTransport } from "./transport.js";
import type { TransportStats } from "./transport.js";
import type { AgentStatus, SecurityEvent, SecurityMetric } from "./models.js";
import { normalizeSecurityEvent, normalizeSecurityMetric } from "./models.js";
import {
  calculateBackoffDelay,
  fireErrorHook,
  nowSeconds,
  sanitizeHeaders,
  sleep,
} from "./utils.js";

/** Backoff ceiling between flush attempts after failures (Python: 300s). */
const PARTIAL_FAILURE_MAX_BACKOFF_SECONDS = 300.0;

/** After this many consecutive loop failures, log at error level (Python: 3). */
const LOOP_ERROR_LOG_THRESHOLD = 3;

export interface AgentStats {
  running: boolean;
  uptime: number;
  eventsSent: number;
  metricsSent: number;
  eventsFailed: number;
  metricsFailed: number;
  bufferStats: BufferStats;
  transportStats: TransportStats;
  loopFailures: { flush: number; status: number };
  lastStatusPushOk: boolean | null;
}

export class GuardAgent {
  readonly config: AgentConfig;
  readonly buffer: EventBuffer;
  readonly transport: HttpTransport;

  redisHandler: RedisHandler | null = null;

  private readonly logger: AgentLogger;

  private running = false;
  private readonly startTime: number;
  private loopsAbort: AbortController | null = null;
  private loops: Promise<void>[] = [];
  private ownsRedisHandler = false;

  eventsSent = 0;
  metricsSent = 0;
  eventsFailed = 0;
  metricsFailed = 0;

  private flushConsecutiveFailures = 0;
  private statusConsecutiveFailures = 0;
  private lastStatusPushOk: boolean | null = null;

  private eventsFailureStreak = 0;
  private metricsFailureStreak = 0;
  private eventsRetryAfter = 0;
  private metricsRetryAfter = 0;

  constructor(input: AgentConfigInput) {
    this.config = resolveAgentConfig(input);
    this.logger = this.config.logger;
    this.buffer = new EventBuffer(this.config, () => this.flushBuffer());
    this.transport = new HttpTransport(this.config);
    this.startTime = nowSeconds();
    this.logger.info("Guard Agent initialized");
  }

  // ------------------------------------------------------------------
  // Redis integration
  // ------------------------------------------------------------------

  /**
   * Attach a Redis handler used for durable buffering and load any pending
   * items persisted by a previous process (mirrors initialize_redis).
   */
  async initializeRedis(redisHandler: RedisHandler): Promise<void> {
    this.redisHandler = redisHandler;
    this.ownsRedisHandler = false;
    await this.buffer.initializeRedis(redisHandler);
    this.logger.info("Redis integration initialized");
  }

  /**
   * Build a Redis handler from config.redis when no handler was injected.
   * Failure to connect degrades to memory-only buffering with a warning;
   * telemetry must never keep the host app from serving traffic.
   */
  private async ensureRedisPersistence(): Promise<void> {
    const redisConfig = this.config.redis;
    if (!redisConfig || this.redisHandler) return;
    try {
      const handler = await createIoredisHandler({
        url: redisConfig.url,
        keyPrefix: redisConfig.keyPrefix,
        password: redisConfig.password,
        db: redisConfig.db,
        commandTimeoutMs: redisConfig.commandTimeoutMs,
        logger: this.logger,
      });
      await this.initializeRedis(handler);
      this.ownsRedisHandler = true;
    } catch (error) {
      this.logger.warn(
        `Redis persistence disabled (connection failed): ${errorMessage(error)}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Start background flush and status loops (mirrors start). */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn("Agent is already running");
      return;
    }

    try {
      await this.ensureRedisPersistence();
      await this.transport.initialize();
      this.buffer.startAutoFlush();

      this.running = true;
      this.loopsAbort = new AbortController();
      const signal = this.loopsAbort.signal;
      this.loops = [this.runFlushLoop(signal), this.runStatusLoop(signal)];

      this.logger.info("Guard Agent started successfully");
    } catch (error) {
      this.logger.error(`Failed to start agent: ${errorMessage(error)}`);
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop background loops, flush what is buffered, and release resources.
   * Idempotent (mirrors stop/close).
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.loopsAbort) {
      this.loopsAbort.abort();
      this.loopsAbort = null;
    }
    const loops = this.loops;
    this.loops = [];
    await Promise.allSettled(loops);

    await this.buffer.stopAutoFlush();
    await this.flushBuffer();
    await this.transport.close();

    if (this.ownsRedisHandler && this.redisHandler) {
      const handler: RedisHandler = this.redisHandler;
      this.redisHandler = null;
      this.ownsRedisHandler = false;
      if (handler.close) await handler.close();
    }

    this.logger.info("Guard Agent stopped");
  }

  /** Alias for stop() (mirrors close). */
  async close(): Promise<void> {
    await this.stop();
  }

  private async runFlushLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        await sleep(this.config.flushInterval * 1000, signal);
        if (!this.running || signal.aborted) break;
        await this.flushBuffer();
        this.flushConsecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted) break;
        this.flushConsecutiveFailures += 1;
        this.logLoopFailure("flush loop", this.flushConsecutiveFailures, error);
      }
    }
  }

  private async runStatusLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        await sleep(this.config.statusInterval * 1000, signal);
        if (!this.running || signal.aborted) break;
        const status = await this.getStatus();
        const ok = await this.transport.sendStatus(status);
        this.lastStatusPushOk = ok;
        if (ok) {
          this.statusConsecutiveFailures = 0;
        } else {
          this.statusConsecutiveFailures += 1;
          this.logLoopFailure(
            "status loop",
            this.statusConsecutiveFailures,
            new Error("send_status returned False"),
          );
        }
      } catch (error) {
        if (signal.aborted) break;
        this.lastStatusPushOk = false;
        this.statusConsecutiveFailures += 1;
        this.logLoopFailure("status loop", this.statusConsecutiveFailures, error);
      }
    }
  }

  private logLoopFailure(loopName: string, count: number, error: unknown): void {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const message =
      `${loopName} failed ${count} consecutive time(s); ` +
      `cause: ${errorObj.name}: ${errorObj.message}`;
    if (count >= LOOP_ERROR_LOG_THRESHOLD) {
      this.logger.error(message);
    } else {
      this.logger.warn(message);
    }
  }

  // ------------------------------------------------------------------
  // Ingest path (never throws)
  // ------------------------------------------------------------------

  /**
   * Enqueue a security event for delivery. Accepts a SecurityEvent instance
   * or any object carrying the known fields (camelCase or snake_case).
   * Must not block or raise: failures are logged and dropped.
   */
  async sendEvent(input: unknown): Promise<void> {
    if (!this.config.enableEvents) return;
    try {
      const event = normalizeSecurityEvent(input);
      const redacted = event.withMetadata(
        asMetadataRecord(
          sanitizeHeaders(event.metadata, this.config.sensitiveHeaders),
        ),
      );
      await this.buffer.addEvent(redacted);
      this.logger.debug(
        `Event buffered: ${redacted.eventType} from ${redacted.ipAddress}`,
      );
    } catch (error) {
      this.logger.error(`Failed to buffer event: ${errorMessage(error)}`);
    }
  }

  /**
   * Enqueue a metric for delivery. Accepts a SecurityMetric instance or any
   * object carrying the known fields. Must not block or raise.
   */
  async sendMetric(input: unknown): Promise<void> {
    if (!this.config.enableMetrics) return;
    try {
      const metric = normalizeSecurityMetric(input);
      const redacted = metric.withTags(
        asStringRecord(sanitizeHeaders(metric.tags, this.config.sensitiveHeaders)),
      );
      await this.buffer.addMetric(redacted);
      this.logger.debug(`Metric buffered: ${redacted.metricType} = ${redacted.value}`);
    } catch (error) {
      this.logger.error(`Failed to buffer metric: ${errorMessage(error)}`);
    }
  }

  // ------------------------------------------------------------------
  // Flush path
  // ------------------------------------------------------------------

  /** Force an immediate send of any buffered events and metrics. Never throws. */
  async flushBuffer(): Promise<void> {
    try {
      await this.flushEvents();
      await this.flushMetrics();
    } catch (error) {
      this.logger.error(`Error during buffer flush: ${errorMessage(error)}`);
    }
  }

  /**
   * Describe where unsent items wait for retry, based on whether a Redis
   * handler is attached to the buffer. Without Redis the items live only in
   * the in-memory buffer, so claiming Redis retention would be misleading
   * (mirrors Python _client_flush.FlushMixin._retention_description).
   */
  private retentionDescription(kind: string): string {
    const hasRedis = this.buffer.redisHandler !== null;
    const memoryPart = "requeued in memory";
    const redisPart = hasRedis ? " and retained in Redis" : "";
    return `${memoryPart}${redisPart} (${kind})`;
  }

  /**
   * Flush events with per-kind failure streaks and backoff, mirroring
   * _flush_events. On failure the batch is requeued in memory, its Redis
   * keys retained when a Redis handler is attached, and a per-kind
   * retry-after enforced before the next attempt. A transport exception is
   * re-raised (caught by flushBuffer) after the requeue, mirroring the
   * Python control flow.
   */
  private async flushEvents(): Promise<void> {
    if (nowSeconds() < this.eventsRetryAfter) return;

    const [events, keys] = await this.buffer.flushEventsWithKeys();
    if (events.length === 0) return;

    let success = false;
    let exc: Error | null = null;
    try {
      success = await this.transport.sendEvents(events);
    } catch (caught) {
      success = false;
      exc = caught instanceof Error ? caught : new Error(String(caught));
    }

    if (success) {
      await this.buffer.confirmEventRedisKeys(keys);
      this.eventsSent += events.length;
      this.logger.debug(`Flushed ${events.length} events`);
      if (this.eventsFailureStreak > 0) {
        this.logger.warn(
          `Events flush recovered after ` +
            `${this.eventsFailureStreak} consecutive partial failure(s)`,
        );
      }
      this.eventsFailureStreak = 0;
      this.eventsRetryAfter = 0;
      return;
    }

    await this.requeueAndConfirmEvents(events, keys);
    this.eventsFailed += events.length;
    this.eventsFailureStreak += 1;
    const delay = calculateBackoffDelay(
      this.eventsFailureStreak - 1,
      this.config.flushInterval,
      PARTIAL_FAILURE_MAX_BACKOFF_SECONDS,
    );
    this.eventsRetryAfter = nowSeconds() + delay;
    if (this.eventsFailureStreak === 1) {
      this.logger.warn(
        `Failed to send ${events.length} events; ` +
          `${this.retentionDescription("events")} for retry; ` +
          `backing off up to ${delay.toFixed(0)}s between attempts`,
      );
    }
    if (exc !== null) {
      this.logger.error(`Transport raised sending events: ${errorMessage(exc)}`);
      fireErrorHook(this.config.onError, this.logger, "flush_events", exc, {
        batchSize: events.length,
      });
      throw exc;
    }
  }

  /** Flush metrics; see flushEvents for the failure semantics. */
  private async flushMetrics(): Promise<void> {
    if (nowSeconds() < this.metricsRetryAfter) return;

    const [metrics, keys] = await this.buffer.flushMetricsWithKeys();
    if (metrics.length === 0) return;

    let success = false;
    let exc: Error | null = null;
    try {
      success = await this.transport.sendMetrics(metrics);
    } catch (caught) {
      success = false;
      exc = caught instanceof Error ? caught : new Error(String(caught));
    }

    if (success) {
      await this.buffer.confirmMetricRedisKeys(keys);
      this.metricsSent += metrics.length;
      this.logger.debug(`Flushed ${metrics.length} metrics`);
      if (this.metricsFailureStreak > 0) {
        this.logger.warn(
          `Metrics flush recovered after ` +
            `${this.metricsFailureStreak} consecutive partial failure(s)`,
        );
      }
      this.metricsFailureStreak = 0;
      this.metricsRetryAfter = 0;
      return;
    }

    await this.requeueAndConfirmMetrics(metrics, keys);
    this.metricsFailed += metrics.length;
    this.metricsFailureStreak += 1;
    const delay = calculateBackoffDelay(
      this.metricsFailureStreak - 1,
      this.config.flushInterval,
      PARTIAL_FAILURE_MAX_BACKOFF_SECONDS,
    );
    this.metricsRetryAfter = nowSeconds() + delay;
    if (this.metricsFailureStreak === 1) {
      this.logger.warn(
        `Failed to send ${metrics.length} metrics; ` +
          `${this.retentionDescription("metrics")} for retry; ` +
          `backing off up to ${delay.toFixed(0)}s between attempts`,
      );
    }
    if (exc !== null) {
      this.logger.error(`Transport raised sending metrics: ${errorMessage(exc)}`);
      fireErrorHook(this.config.onError, this.logger, "flush_metrics", exc, {
        batchSize: metrics.length,
      });
      throw exc;
    }
  }

  private async requeueAndConfirmEvents(
    events: SecurityEvent[],
    keys: string[],
  ): Promise<void> {
    const evictedKeys = await this.buffer.requeueEventsInMemory(events, keys);
    if (evictedKeys.length > 0) {
      await this.buffer.confirmEventRedisKeys(evictedKeys);
    }
  }

  private async requeueAndConfirmMetrics(
    metrics: SecurityMetric[],
    keys: string[],
  ): Promise<void> {
    const evictedKeys = await this.buffer.requeueMetricsInMemory(metrics, keys);
    if (evictedKeys.length > 0) {
      await this.buffer.confirmMetricRedisKeys(evictedKeys);
    }
  }

  // ------------------------------------------------------------------
  // Status / stats
  // ------------------------------------------------------------------

  /** Return a snapshot of the agent's current health (mirrors get_status). */
  async getStatus(): Promise<AgentStatus> {
    const timestamp = new Date();
    const uptime = nowSeconds() - this.startTime;
    const bufferSize = this.buffer.getBufferSize();

    const transportStats = this.transport.getStats();
    const bufferStats = this.buffer.getStats();

    let status: AgentStatus["status"] = "healthy";
    const errors: string[] = [];

    if (transportStats.circuitBreakerState === "OPEN") {
      status = "degraded";
      errors.push("Transport circuit breaker is open");
    }

    if (bufferSize >= this.config.bufferSize * 0.9) {
      status = "degraded";
      errors.push("Buffer nearly full");
    }

    if (this.eventsFailed + this.metricsFailed > 0) {
      const failureRate =
        (this.eventsFailed + this.metricsFailed) /
        Math.max(
          1,
          this.eventsSent +
            this.metricsSent +
            this.eventsFailed +
            this.metricsFailed,
        );
      if (failureRate > 0.1) {
        status = "degraded";
        errors.push(`High failure rate: ${(failureRate * 100).toFixed(1)}%`);
      }
    }

    return {
      timestamp,
      status,
      uptime,
      eventsSent: this.eventsSent,
      eventsFailed: this.eventsFailed,
      bufferSize,
      lastFlush:
        bufferStats.lastFlushTime === null
          ? null
          : new Date(bufferStats.lastFlushTime * 1000),
      errors,
    };
  }

  /** Get aggregate agent statistics (mirrors get_stats). */
  getStats(): AgentStats {
    return {
      running: this.running,
      uptime: nowSeconds() - this.startTime,
      eventsSent: this.eventsSent,
      metricsSent: this.metricsSent,
      eventsFailed: this.eventsFailed,
      metricsFailed: this.metricsFailed,
      bufferStats: this.buffer.getStats(),
      transportStats: this.transport.getStats(),
      loopFailures: {
        flush: this.flushConsecutiveFailures,
        status: this.statusConsecutiveFailures,
      },
      lastStatusPushOk: this.lastStatusPushOk,
    };
  }

  /**
   * True when the agent is running, the circuit breaker is closed, the
   * buffer is not nearly full, and the failure rate is acceptable
   * (mirrors health_check).
   */
  async healthCheck(): Promise<boolean> {
    if (!this.running) return false;

    try {
      const transportStats = this.transport.getStats();
      if (transportStats.circuitBreakerState === "OPEN") return false;

      const bufferSize = this.buffer.getBufferSize();
      if (bufferSize >= this.config.bufferSize * 0.95) return false;

      const totalSent = this.eventsSent + this.metricsSent;
      const totalFailed = this.eventsFailed + this.metricsFailed;
      const totalAttempts = totalSent + totalFailed;

      if (totalAttempts > 0 && totalFailed / totalAttempts > 0.5) {
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Error during health check: ${errorMessage(error)}`);
      return false;
    }
  }
}

function asMetadataRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = typeof item === "string" ? item : String(item);
    }
    return result;
  }
  return {};
}

/** Stage type re-export for onError callbacks (from config). */
export type { ErrorHookStage, AgentConfig, AgentConfigInput };
