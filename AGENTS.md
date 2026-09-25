# AGENTS.md
Guidance for AI agents (including Claude Code) working in this repository.

## Project Overview

guard-agent-ts (npm package `guardagent`) is the TypeScript telemetry and monitoring agent for the Guard security ecosystem. It is a dependency-free (optional ioredis peer) Node.js >= 20 client that buffers security events from guard-core-ts adapters and ships them to the Guard Core App ingestion API with at-least-once delivery, crash-recovery persistence, and a hard guarantee: telemetry failures never propagate into the host request path.

Version 3.0.2. License MIT. ESM + CJS dual build via tsup; typed public API.

## Ecosystem Position

- Reports to the Guard Core App ingestion API (`guard-core-app/backend/guard-core-api`): POST /api/v1/events, POST /api/v1/metrics, POST /api/v1/status.
- Consumed by guard-core-ts adapters (Express, Fastify, Hono, NestJS) or any Node app that needs to ship Guard security events.
- Sibling agents: guard-agent (Python, the reference implementation), guard-agent-rs (Rust). All speak the same ingestion contract.
- The ingestion contract: X-API-Key + X-Project-Id + X-Agent-Install-Id headers, gzip body compression, HMAC X-Payload-Signature over the UNCOMPRESSED body (the server decompresses and verifies afterward), Retry-After honored on 429, 413 above 262144 decompressed bytes (split-or-drop), 400/404/422 treated as permanent rejection, and a 200 with success:false requeued as a partial failure.

## Architecture

- `src/config.ts`: AgentConfig with validation and endpoint normalization (mirrors Python AgentConfig.validate_endpoint / validate_config).
- `src/buffer.ts`: EventBuffer with drop/block/raise overflow policies, high-watermark early flush, maxConcurrentFlushes throttle, and the at-least-once flush/requeue/confirm handshake with Redis keys aligned to the Python agent.
- `src/transport.ts`: HttpTransport against the ingestion contract (gzip, HMAC signing, Retry-After, 413 split-or-drop, permanent-rejection classification).
- `src/agent.ts`: GuardAgent client with flush/status loops, per-kind failure streak backoff, degraded-state detection, health checks.
- `src/redis.ts` + `src/install-id.ts`: crash-recovery persistence under globally-unique keys with 3600s TTL and startup reload (ioredis optional peer).
- `src/errors.ts` / `src/logger.ts` / `src/signing.ts` / `src/models.ts` / `src/utils.ts`: typed errors, structured logging, HMAC payload signatures, event models, shared utilities.
- `examples/basic_usage/`: minimal wiring demo (env-driven config, start, sendEvent, final flush on SIGINT/SIGTERM) with its own README.
- `mkdocs.yml` + `docs/`: mkdocs-material site sources (index.md, usage.md, configuration.md) deployed by .github/workflows/docs.yml.

Key invariants an agent must preserve when editing:

1. The handshake is always drain, then send, then confirm (delete persisted records) or requeue in the original order.
2. The HMAC signature covers the UNCOMPRESSED JSON body even when the wire bytes are gzipped; the server verifies after decompression.
3. No exported method may panic out or block the host beyond the documented overflow policy; telemetry failures are logged and counted.
4. Per-kind state (queues, failure streaks, backoff gates) stays independent: one kind failing must never stall the other.
5. Redis failures are fail-open: log, count, keep going.
6. Community workflows (`issue-link`, `stale`, `sync-labels`) stay byte-identical in logic to the Go family's (guard-agent-go and siblings); `greetings`, `summary`, and `labeler`/`labels` carry repo-specific text (agent subsystems, not adapter middleware) and must not drift in structure.

## Quick Start

```ts
import { GuardAgent } from "guardagent";

const agent = new GuardAgent({
  endpoint: "https://api.guard-core.com",
  apiKey: process.env.GUARD_AGENT_API_KEY ?? "",
  projectId: "my-project",
});
await agent.start();

agent.sendEvent({
  eventType: "rate_limited",
  ipAddress: "203.0.113.7",
  actionTaken: "BLOCKED",
  reason: "endpoint rate limit exceeded",
});

// later, on shutdown:
await agent.stop();
```

## Configuration

AgentConfig fields (all validated at construction, problems reported together as ConfigError): apiKey (required, min 10 chars), endpoint (default https://api.guard-core.com, trailing slashes and a legacy /api/v1 suffix stripped), projectId, bufferSize (100), flushInterval (30s), statusInterval (300s, min 60), highWatermarkRatio (0.8), maxConcurrentFlushes (1), bufferOverflowPolicy (drop/block/raise), enableEvents/enableMetrics, retryAttempts (3), timeout (30s), backoffFactor, sensitiveHeaders, maxPayloadSize, guardVersion/guardCoreVersion, compressionEnabled/compressionThreshold (true/1024), installId, payloadSigningSecret, onError, logger, and redis ({url, keyPrefix, password, db, commandTimeoutMs}, optional). See src/config.ts for the full typed surface and docs/configuration.md for the table form.

## Reliability Semantics

- Buffering: in-memory ring with size + time flush triggers; high-watermark triggers early flush; overflow policy is drop (default), block, or raise.
- Delivery: at-least-once. Events are requeued on transport failure and confirmed only after a 2xx.
- Retry: per-kind failure streak backoff with Retry-After honoring on 429.
- 413: the decompressed body exceeded 262144 bytes; the batch is split-or-dropped rather than retried as-is.
- Partial failure: a 200 with success:false or a non-empty errors array is requeued for retry, not acknowledged.
- Permanent rejection: 400/404/422 drop the event (retrying cannot succeed) and increment the rejection counter.
- Degraded state: consecutive failures flip the agent into degraded mode; health checks probe the API and restore.
- Persistence: when Redis is configured, unconfirmed events persist under globally-unique keys (3600s TTL) and reload at startup for crash recovery.
- Failure isolation: no GuardAgent method throws into the host request path; telemetry failures are logged and counted, never propagated. This mirrors the Python agent's policy and is covered by tests.

## Development Commands

- `pnpm install` - install dependencies
- `pnpm test` (or `npx vitest run`) - run the test suite (100 tests); set REDIS_URL for the Redis-backed tests
- `pnpm test:coverage` - vitest run with v8 coverage
- `npx tsup` (or `pnpm build`) - build ESM + CJS + types into dist/
- `npx tsc --noEmit` (or `pnpm lint`) - typecheck
- `pnpm audit --audit-level=low` - dependency audit (runs weekly via scheduled-lint.yml)
- `pnpm build && npx tsx examples/basic_usage/main.ts` - run the example (GUARD_AGENT_API_KEY required)
- `mkdocs build --strict` / `mkdocs serve` - build/preview the docs site (pip install mkdocs-material)

## Testing Guidelines

Vitest. Unit tests per module (buffer, transport, config, models, utils, logger, install-id, redis-persistence), plus an integration suite against tests/helpers/mock-server.ts, which mirrors the ingestion contract. tests/helpers/fake-redis.ts emulates the Redis surface without a server. Redis-backed tests degrade gracefully when no Redis is present (covered: "degrades to per-operation failures (never crashes) when redis is down").

CI (.github/workflows/ci.yml): lint + build on node 22, plus pnpm test:coverage on a node 20/22 matrix with a redis:7-alpine service. .github/workflows/release.yml gates v* tags (test matrix, tarball pack + install smoke; npm publishing stays manual and owner-gated), .github/workflows/scheduled-lint.yml reruns typecheck + build + pnpm audit weekly, codeql.yml scans javascript-typescript, docs.yml deploys the mkdocs site, and issue-link.yml enforces a "Closes #N" link (or the no-issue label) on PRs.

## Best Practices

- Never let agent code throw into host request paths; add failures to the counters instead.
- Keep the ingestion contract in src/transport.ts and tests/helpers/mock-server.ts in lockstep; change both or neither.
- Redis keys must stay globally unique and TTL-bounded; mirror the Python agent's key grammar.
- Any semantic change needs a matching Python-side check: the Python guard-agent is the reference implementation.

## Related Projects

- guard-agent (Python): the reference implementation whose semantics this port mirrors.
- guard-agent-rs (Rust): the Rust sibling agent.
- guard-core-ts: the TS core engine and adapters that emit the events.
- Guard Core App (guard-core-app): the SaaS ingestion API and dashboard.
