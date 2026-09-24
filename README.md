# guardagent

Telemetry & Monitoring Agent for the [guard ecosystem](https://github.com/rennf93) (TypeScript / Node.js). Companion agent to [guard-core-ts](https://github.com/rennf93/guard-core-ts) and its thin adapters.

Docs: <https://rennf93.github.io/guard-agent-ts/>

**Status:** Released (v3.0.2 on npm). TypeScript port of the [guard-agent](https://github.com/rennf93/guard-agent) semantics, reporting to the Guard Core App ingestion API.

## Install

```bash
pnpm add guardagent
pnpm add ioredis   # optional: crash-recovery persistence
```

## Usage

```ts
import { GuardAgent, AgentConfig } from "guardagent";

const agent = new GuardAgent(AgentConfig.create({
  endpoint: "https://api.guard-core.com",
  apiKey: process.env.GUARD_API_KEY!,
  projectId: "my-project",
}));
await agent.start();

agent.sendEvent({ kind: "security_event", payload: { /* ... */ } });

await agent.stop(); // final flush + confirm
```

At-least-once delivery, 413 split-or-drop, Retry-After backoff, permanent-rejection handling, degraded-state detection, and optional Redis crash recovery. See [AGENTS.md](AGENTS.md) for the full reliability semantics.

## About

The guard ecosystem provides application-layer API security middleware across multiple languages and frameworks:

- **Python**: [fastapi-guard](https://github.com/rennf93/fastapi-guard), [flaskapi-guard](https://github.com/rennf93/flaskapi-guard), [djapi-guard](https://github.com/rennf93/djapi-guard), [tornadoapi-guard](https://github.com/rennf93/tornadoapi-guard), with [guard-agent](https://pypi.org/project/guard-agent/) for telemetry
- **TypeScript**: [guard-core-ts](https://github.com/rennf93/guard-core-ts) with adapters for Express, Fastify, Hono, NestJS
- **Rust**: [guard-core-rs](https://github.com/rennf93/guard-core-rs) with adapters for [tower](https://github.com/rennf93/tower-guard-rs), [axum](https://github.com/rennf93/axum-guard-rs), [actix-web](https://github.com/rennf93/actix-guard-rs), [rocket](https://github.com/rennf93/rocket-guard-rs), plus [guard-agent-rs](https://github.com/rennf93/guard-agent-rs) for telemetry

## License

MIT
