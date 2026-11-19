# ADR 0001: Separate product, shared platform core

**Status:** accepted

## Context
The ecommerce platform already has multi-tenancy, roles, module switches and billing. The counselling product handles
sensitive student documents and money ledgers, has a different release cadence and a much larger compliance scope.

## Decision
Build counselling as its **own repository and deployable**. Share only the platform core
(identity, organisations, modules, billing, notifications) through an explicit contract.
Data is never shared; the superadmin sees aggregated numbers only.

## Consequences
+ Student-data compliance and audit scope is limited to this product
+ Independent deploys, scaling and failure domains
- Core must be extracted from (or adapted to) the ecommerce codebase; until then `src/core/` is a local implementation
