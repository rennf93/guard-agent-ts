Release Notes
=============

___

Unreleased
----------

### Fixed

- **The wire version stamp now reports the release version (3.0.2) instead of the initial implementation stub.** `AGENT_VERSION` in `src/version.ts` was still hardcoded to `0.1.0` from before the 3.0.2 release train, so the `guardagent/0.1.0` User-Agent header and the `agent_version` batch envelope field lagged the package version (and every other family agent ships 3.0.2). The constant is now derived from `package.json` (inlined by tsup/vitest), so `make bump-version` cannot leave the stamp behind; a derivation test pins the equality.

___

v3.0.2 (2026-09-24)
-------------------

First tagged release: parity with guard-agent 3.0.2 (v3.0.2)
------------------------------------------------------------

### Added

- **Payload-signature contract parity with the reference guard-agent 3.0.2 (Python).** The signature is an HMAC over the uncompressed body; the server verifies after decompression, so the signature always covers the uncompressed bytes on both the encrypted and unencrypted POST paths.

### Fixed

- **The flush loop's partial-failure warning no longer claims Redis retention without Redis.** When a batch was partially rejected and Redis persistence was disabled, the warning said items were "retained in Redis for retry" even though the true disposition is the in-memory buffer only. The warning now names the backend that actually holds the requeued items, and regression tests cover both the Redis-disabled and Redis-enabled warnings.

___
