# Configuration

Start from the defaults and override. Every field except `apiKey` is
optional; validation runs at construction and every problem is reported
at once.

| Field | Default | Notes |
| --- | --- | --- |
| `apiKey` | required | Ingestion credential, min 10 chars (`X-API-Key`) |
| `endpoint` | `https://api.guard-core.com` | Trailing slashes and a legacy `/api/v1` suffix are stripped with a one-time warning |
| `projectId` | `null` | Sent as `X-Project-Id` and in the batch payload when set |
| `bufferSize` | `100` | Per-kind queue capacity |
| `flushInterval` | `30` | Periodic flush cadence (seconds) and backoff base |
| `statusInterval` | `300` | Status report cadence (seconds), minimum 60 |
| `highWatermarkRatio` | `0.8` | Early flush when combined occupancy reaches this share, range (0, 1] |
| `maxConcurrentFlushes` | `1` | Concurrent early-flush cap, minimum 1 |
| `bufferOverflowPolicy` | `drop` | `drop`, `block`, or `raise` |
| `enableEvents` / `enableMetrics` | `true` / `true` | Kind switches for the telemetry you send |
| `retryAttempts` | `3` | Retries per batch (total tries = retryAttempts + 1) |
| `timeout` | `30` | Per-request HTTP timeout (seconds) |
| `backoffFactor` | `1.0` | Base of the transport retry backoff |
| `sensitiveHeaders` | `authorization`, `proxy-authorization`, `cookie`, `x-api-key` | Header names redacted from event metadata and metric tags |
| `maxPayloadSize` | `1024` | Payload bytes included in events (truncatePayload) |
| `guardVersion` / `guardCoreVersion` | `null` | Versions of the hosting adapter and its guard-core library, reported to the ingestion API |
| `compressionEnabled` / `compressionThreshold` | `true` / `1024` | gzip bodies at or above the threshold (bytes) |
| `installId` | auto | Override the auto-generated install id (`X-Agent-Install-Id`) |
| `payloadSigningSecret` | `null` | Enables `X-Payload-Signature` (HMAC-SHA256 over the uncompressed body) |
| `onError` | `null` | Best-effort failure callback; never throws into the host |
| `logger` | built-in default | Injected `AgentLogger` |
| `redis` | `null` | `{ url, keyPrefix?, password?, db?, commandTimeoutMs? }`; `url` must be `redis://` or `rediss://`, `keyPrefix` defaults to `guard:agent`, `commandTimeoutMs` defaults to 5000. Requires the optional `ioredis` peer |

## Validation rules

- `apiKey` must be at least 10 characters
- `endpoint` must be a valid http/https URL
- `bufferSize` and `maxConcurrentFlushes` must be positive
- `flushInterval`, `timeout`, `backoffFactor` must be positive;
  `retryAttempts` cannot be negative
- `statusInterval` must be at least 60 seconds
- `highWatermarkRatio` must be in the range (0, 1]
- `compressionThreshold` cannot be negative
- `redis.url` must start with `redis://` or `rediss://` and
  `redis.commandTimeoutMs` must be positive when set

## Environment conventions

The agent itself only reads the environment through your code, but the
examples and docs use these names:

| Variable | Feeds |
| --- | --- |
| `GUARD_AGENT_API_KEY` | `apiKey` |
| `GUARD_AGENT_ENDPOINT` | `endpoint` |
| `GUARD_AGENT_PROJECT_ID` | `projectId` |
| `GUARD_AGENT_SIGNING_SECRET` | `payloadSigningSecret` |
| `GUARD_AGENT_REDIS_URL` | `redis.url` |
| `GUARD_AGENT_DEBUG` | verbose built-in logger when truthy |
