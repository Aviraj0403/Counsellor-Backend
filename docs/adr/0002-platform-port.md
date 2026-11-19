# ADR 0002: Everything from the core goes through one port

**Status:** accepted (updated for the module structure, see ADR 0003)

## Decision
`src/contracts/port.ts` defines `PlatformPort` (verify token, enabled modules, list team, list organisations) plus the shared
vocabulary (permissions, module keys). The product finds the platform through `contracts/registry.ts` (`getPlatform()`), and the
composition root `src/app/platform.ts` wires it once. `src/core/` implements the port locally (`core/localPort.ts`).
`PLATFORM_MODE=remote` is reserved for an HTTP client to the real core service.

## Enforcement
`tests/architecture.test.ts` fails CI if `product/` imports `core/` (or the reverse), or if `shared/`/`contracts/` import upward.
Only `app/` may import both sides.

## Why not build the core service first?
It would delay the product by weeks and the contract is still tiny. The port lets us ship now and extract later at no cost to product code.
