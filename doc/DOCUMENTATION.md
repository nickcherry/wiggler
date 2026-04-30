# Documentation

## Purpose

Documentation should let a future reader recover intent without the original
conversation.

Document:

- runtime contracts
- external API assumptions
- trading invariants
- non-obvious failure behavior
- operational commands
- decisions that would otherwise look arbitrary

Do not document obvious control flow.

## Inline Comments

Use comments sparingly. Prefer names and types first.

Add a short comment when:

- an external API shape is surprising
- a trading safety invariant is easy to break
- a future edit must preserve a non-local constraint

## Repo Docs

Docs broadly useful to future work should live under `doc/` and be linked from
the README.

Add or update docs when changing:

- CLI behavior
- Polymarket endpoint contracts
- rollover behavior
- notification behavior
- future trading or decision logic
- numeric units or precision rules

## External Sources

When an implementation relies on Polymarket behavior, link the relevant
official docs in `doc/POLYMARKET.md` or the doc for that subsystem.

If the observed live payload differs from official docs, record the observed
shape and date.
