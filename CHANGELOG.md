Release Notes
=============

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
