# AGENTS.md
Guidance for AI agents (including Claude Code) working in this repository.

## Project Overview

guard-agent-ts (npm package `guardagent`) is the TypeScript telemetry and monitoring agent for the Guard security ecosystem. It is a dependency-free (optional ioredis peer) Node.js >= 20 client that buffers security events from guard-core-ts adapters and ships them to the Guard Core App ingestion API with at-least-once delivery, crash-recovery persistence, and a hard guarantee: telemetry failures never propagate into the host request path.

Version 0.1.0. License MIT. ESM + CJS dual build via tsup; typed public API.

## Ecosystem Position

- Reports to the Guard Core App ingestion API (`guard-core-app/backend/guard-core-api`): POST /api/v1/events, POST /api/v1/metrics, POST /api/v1/status.
- Consumed by guard-core-ts adapters (Express, Fastify, Hono, NestJS) or any Node app that needs to ship Guard security events.
- Sibling agents: guard-agent (Python, the reference implementation), guard-agent-rs (Rust). All speak the same ingestion contract.
- The ingestion contract: X-API-Key + X-Project-Id + X-Agent-Install-Id headers, gzip body compression, HMAC X-Payload-Signature, Retry-After honored on 429, 413 split-or-drop, 400/404/422 treated as permanent rejection.

## Architecture

- `src/config.ts`: AgentConfig with validation and endpoint normalization (mirrors Python AgentConfig.validate_endpoint / validate_config).
- `src/buffer.ts`: EventBuffer with drop/block/raise overflow policies, high-watermark early flush, maxConcurrentFlushes throttle, and the at-least-once flush/requeue/confirm handshake with Redis keys aligned to the Python agent.
- `src/transport.ts`: HttpTransport against the ingestion contract (gzip, HMAC signing, Retry-After, 413 split-or-drop, permanent-rejection classification).
- `src/agent.ts`: GuardAgent client with flush/status loops, per-kind failure streak backoff, degraded-state detection, health checks.
- `src/redis.ts` + `src/install-id.ts`: crash-recovery persistence under globally-unique keys with 3600s TTL and startup reload (ioredis optional peer).
- `src/errors.ts` / `src/logger.ts` / `src/signing.ts` / `src/models.ts` / `src/utils.ts`: typed errors, structured logging, HMAC payload signatures, event models, shared utilities.

## Quick Start

```ts
import { GuardAgent, AgentConfig } from "guardagent";

const config = AgentConfig.create({
  endpoint: "https://api.guard-core.com",
  apiKey: process.env.GUARD_API_KEY!,
  projectId: "my-project",
});
const agent = new GuardAgent(config);
await agent.start();

agent.sendEvent({ kind: "security_event", payload: { /* ... */ } });

// later, on shutdown:
await agent.stop();
```

## Configuration

AgentConfig fields (all validated at construction): endpoint, apiKey, projectId, buffer_size, flush_interval, retry_attempts, overflow policy (drop/block/raise), Redis options (optional), TLS options. See src/config.ts for the full typed surface and defaults, which mirror the Python guard-agent's AgentConfig.

## Reliability Semantics

- Buffering: in-memory ring with size + time flush triggers; high-watermark triggers early flush; overflow policy is drop (default), block, or raise.
- Delivery: at-least-once. Events are requeued on transport failure and confirmed only after a 2xx.
- Retry: per-kind failure streak backoff with Retry-After honoring on 429.
- 413: split-or-drop - the buffer is split and each half retried; after the drop threshold, events are dropped and counted.
- Permanent rejection: 400/404/422 drop the event (retrying cannot succeed) and increment the rejection counter.
- Degraded state: consecutive failures flip the agent into degraded mode; health checks probe the API and restore.
- Persistence: when Redis is configured, unconfirmed events persist under globally-unique keys (3600s TTL) and reload at startup for crash recovery.
- Failure isolation: no GuardAgent method throws into the host request path; telemetry failures are logged and counted, never propagated. This mirrors the Python agent's policy and is covered by tests.

## Development Commands

- `pnpm install` - install dependencies
- `pnpm test` (or `npx vitest run`) - run the test suite (100 tests)
- `npx tsup` - build ESM + CJS + types into dist/
- `npx tsc --noEmit` - typecheck

## Testing Guidelines

Vitest. Unit tests per module (buffer, transport, config, models, utils, logger, install-id, redis-persistence), plus an integration suite against tests/helpers/mock-server.ts, which mirrors the ingestion contract. tests/helpers/fake-redis.ts emulates the Redis surface without a server. Redis-backed tests degrade gracefully when no Redis is present (covered: "degrades to per-operation failures (never crashes) when redis is down").

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
