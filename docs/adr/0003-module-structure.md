# ADR 0003: Module-based structure with a shared kernel

**Status:** accepted

## Context
The first cut grouped code by technical kind inside two folders (`platform-core/`, `product/`). `platform-core/services.ts`
had grown to hold identity, organisations, modules and team in one file. That does not scale to many features, many
developers, or extraction of parts into services.

## Decision
- Two bounded contexts, `core/` and `product/`, each a set of **modules** under `modules/<name>/`.
- Every module has the same four layers (`domain`, `application`, `infrastructure`, `http`) and one public door, `index.ts`.
- A `shared/` kernel (errors, request context, money, validation schemas, logger, tenant connection) importable by everyone and
  importing nothing else. Business rules never go in `shared/`.
- A `contracts/` seam between the two contexts, and an `app/` composition root that is the only place allowed to know both.
- Cross-module wiring is done by composition (`core/routes.ts`), not by modules importing each other in circles. Use cases that
  span two modules live in a module above both (`onboarding`).
- The rules are executable: `tests/architecture.test.ts` checks contexts, public APIs, layers, cycles and a pinned dependency graph.
  The admin app has the same idea in `scripts/check-architecture.mjs`.

## Consequences
+ A new feature is one folder plus one line in a composition file; reviewers can see exactly which module it touches.
+ Any module can be extracted into a service later: its public API is already the seam.
+ Tests show which rule broke and where, instead of relying on code review memory.
- More files and a little ceremony (index.ts, layers) for small modules. Accepted: consistency beats cleverness at team scale.
- Cross-module reads go through functions rather than shared models. Accepted: it is what keeps `insights` from ever touching student data.
