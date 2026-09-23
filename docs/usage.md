# Usage

## Lifecycle

```ts
import { GuardAgent } from "guardagent";

const agent = new GuardAgent(config); // validates config, restores install id
await agent.start();                  // starts flush and status loops
agent.sendEvent(ev);                  // enqueue a security event
agent.sendMetric(m);                  // enqueue a security metric
await agent.flushBuffer();            // force a flush cycle
await agent.getStatus();              // current agent status snapshot
agent.getStats();                     // buffer occupancy, drops, retries
await agent.healthCheck();            // true when the ingestion API is reachable
await agent.stop();                   // final flush, stop loops, close Redis
await agent.close();                  // stop plus a final status report
await agent.initializeRedis(handler); // attach a Redis handler for persistence
```

`new GuardAgent(...)` validates the config up front and throws
`ConfigError` listing every problem. `start` is idempotent-guarded;
`stop` flushes what fits and confirms persisted records for everything
it successfully sends. No exported method throws into the host request
path: telemetry failures are logged, counted, and reported through the
optional `onError` hook.

## Events and metrics

`SecurityEvent` and `SecurityMetric` mirror the ingestion API's
`BatchTelemetryRequest` payload. The wire format is snake_case with
ISO-8601 timestamps and UUID idempotency keys; the agent accepts both
camelCase and snake_case input and converts at the transport boundary.
`timestamp` defaults to now and `idempotencyKey` to a fresh UUID (it
deduplicates retries server-side, so keep it stable when you retry
yourself). Field-by-field descriptions live on the classes in
`src/models.ts`.

Known `eventType` values are exported as `KNOWN_EVENT_TYPES`, and the
accepted metric types as `METRIC_TYPES`; the server accepts any
`eventType` string.

## Buffering and overflow

Each kind (events, metrics) has its own buffer (`bufferSize`, default
100). When a buffer fills, `bufferOverflowPolicy` decides:

| Policy | Behavior |
|---|---|
| `drop` (default) | evicts the oldest item of the same kind, counts a drop |
| `block` | waits for a flush to free a slot; durability over the new writer |
| `raise` | returns a `BufferFullError` without buffering |

A combined occupancy at or above `highWatermarkRatio` (default 0.8)
triggers an early flush; at most `maxConcurrentFlushes` early flushes run
at once.

## Delivery semantics

- Flushes run on `flushInterval` (default 30s), on watermark, and on
  demand
- A failed batch retries up to `retryAttempts` with exponential backoff
  (`backoffFactor`), honoring `Retry-After` on 429 (default 60s, capped
  at 300s)
- A 413 (decompressed body over 262144 bytes) splits the batch or drops
  its oldest item rather than retrying a permanently oversized payload
- 400, 404, and 422 are permanent: the batch is dropped, not retried
- A 200 with `success: false` (or a non-empty `errors` array) is a
  partial failure: the batch is requeued for retry, not acknowledged
- A per-kind failure streak backs off between attempts (base
  `flushInterval`, exponential, capped at 300s); the streaks of events
  and metrics are independent
- The circuit breaker opens after 5 consecutive failures and half-opens
  to probe recovery

## Signing

When `payloadSigningSecret` is set, every request carries
`X-Payload-Signature: v1=<hex hmac-sha256>`. The signature covers the
UNCOMPRESSED JSON body; the server decompresses and verifies afterward.
Gzip (`compressionEnabled`) only affects the wire bytes.

## Redis persistence

With a Redis handler attached (via `initializeRedis`, or `redis.url` in
config with the `ioredis` peer installed), every buffered item is
persisted under a globally-unique key before the send attempt and
confirmed (deleted) on success, so a crash between buffer and network
loses nothing. Persisted records carry a 3600s TTL and are reloaded at
startup. See [Configuration](configuration.md).
