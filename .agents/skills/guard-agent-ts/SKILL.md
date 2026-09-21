---
name: guard-agent-ts
description: TypeScript telemetry agent for the Guard security ecosystem (npm package guardagent). Use when integrating guard-agent-ts with guard-core-ts adapters (Express, Fastify, Hono, NestJS), configuring AgentConfig (endpoint, buffer_size, flush_interval, retry_attempts, overflow policy, Redis persistence), diagnosing at-least-once flush/requeue/confirm behavior, 413 split-or-drop, permanent rejection on 400/404/422, Retry-After backoff on 429, degraded-state detection, or crash recovery from Redis-persisted events. Mirrors the Python guard-agent semantics against the Guard Core App ingestion API.
---

## Quick Reference

- Package: `guardagent` (ESM + CJS, Node >= 20, zero required deps, optional ioredis peer)
- Client: `GuardAgent` from `guardagent`; config via `AgentConfig.create({...})`
- Endpoints: POST /api/v1/events, /api/v1/metrics, /api/v1/status (Guard Core App)
- Headers: X-API-Key, X-Project-Id, X-Agent-Install-Id, X-Payload-Signature (HMAC)

## Installation

```bash
pnpm add guardagent
# optional crash-recovery persistence:
pnpm add ioredis
```

## Setup

```ts
import { GuardAgent, AgentConfig } from "guardagent";

const agent = new GuardAgent(AgentConfig.create({
  endpoint: "https://api.guard-core.com",
  apiKey: process.env.GUARD_API_KEY!,
  projectId: "my-project",
}));
await agent.start();
agent.sendEvent({ kind: "security_event", payload: { /* ... */ } });
await agent.stop(); // flush + confirm on shutdown
```

## Reliability Semantics

At-least-once delivery: events requeue on failure, confirm only on 2xx. Buffer overflow policy: drop (default) / block / raise. 413 splits the buffer and retries halves; drop threshold bounds it. 400/404/422 are permanent rejections (no retry). 429 honors Retry-After. Degraded mode after consecutive failure streaks; health checks restore. Redis persistence (optional): unconfirmed events survive crashes under globally-unique keys with 3600s TTL and reload at startup. No method ever throws into the host request path.

## Footguns

- Keep src/transport.ts and tests/helpers/mock-server.ts in lockstep - they mirror the ingestion contract.
- Redis keys are globally unique and TTL-bounded; do not invent new key shapes without checking the Python agent's grammar.
- buffer overflow "block" applies backpressure to the caller - do not use on a request path.

## Related Projects

guard-agent (Python reference), guard-agent-rs (Rust sibling), guard-core-ts (event source), guard-core-app (ingestion API + dashboard).
