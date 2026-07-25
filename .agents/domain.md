# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`.agents/CONTEXT.md`** — the glossary (ubiquitous language). This repo keeps it here, not at the repo root.
- **`.agents/adr/`** — ADRs for decisions made after the definition phase. Read the ones that touch the area you're about to work in. (The wayfinder tickets under `.agents/wayfinder/tickets/` are the ADRs of the definition phase — consult them for the _why_ behind the product definition.)

This is a **single-context** repo: one glossary, one ADR directory, no `CONTEXT-MAP.md`. If `.agents/adr/` doesn't exist yet, proceed silently — the `/domain-modeling` skill creates it lazily when the first decision actually gets recorded.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `.agents/CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR (or a wayfinder ticket resolution), surface it explicitly rather than silently overriding:

> _Contradicts ADR-0006 (event-sourced orders) — but worth reopening because…_
