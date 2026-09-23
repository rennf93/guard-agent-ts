# guard-agent-ts

`guard-agent-ts` (npm package `guardagent`) is the TypeScript telemetry
agent of the Guard ecosystem. It buffers security events, metrics, and
agent status produced by your application (typically through
[guard-core-ts](https://github.com/rennf93/guard-core-ts) adapters) and
ships them to the
[guard-core-app](https://github.com/rennf93/guard-core-app) ingestion API
with at-least-once delivery.

It is a port of the normative [guard-agent](https://github.com/rennf93/guard-agent)
(Python) semantics: per-kind buffers, periodic and watermark-driven
flushes, overflow policies, retry with backoff, 413 batch split-or-drop,
Retry-After honoring, a circuit breaker, optional Redis-backed queue
persistence, and a persisted install id.

## Installation

```bash
pnpm add guardagent
```

Requires Node.js >= 20. The only dependency is an optional `ioredis`
peer for crash-recovery persistence.

## Quick start

```ts
import { GuardAgent } from "guardagent";

const agent = new GuardAgent({
  apiKey: process.env.GUARD_AGENT_API_KEY ?? "",
  endpoint: process.env.GUARD_AGENT_ENDPOINT ?? "https://api.guard-core.com",
  projectId: process.env.GUARD_AGENT_PROJECT_ID ?? undefined,
  payloadSigningSecret: process.env.GUARD_AGENT_SIGNING_SECRET ?? undefined,
  guardVersion: "example",
});

await agent.start();

agent.sendEvent({
  eventType: "rate_limited",
  ipAddress: "203.0.113.7",
  actionTaken: "BLOCKED",
  reason: "endpoint rate limit exceeded",
  endpoint: "/api",
  method: "GET",
});

// later, on shutdown:
await agent.stop();
```

Most applications do not call the agent directly: guard-core-ts adapters
expose an agent handler seam where the event construction belongs. See
[Usage](usage.md) for the full lifecycle and delivery semantics and
[Configuration](configuration.md) for every config field.

For a minimal runnable wiring demo, see
[examples/basic_usage](https://github.com/rennf93/guard-agent-ts/tree/master/examples/basic_usage).
