# Domain Docs

This repository uses a single-context domain documentation layout.

## Before exploring, read these

- `CONTEXT.md` at the repository root, when present.
- Relevant ADRs under `docs/adr/`, when present.

If either is absent, proceed silently. Domain-modeling skills create them lazily when terms or decisions are resolved.

## File structure

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

Use terms as defined in `CONTEXT.md` in issues, proposals, hypotheses, and test names. Do not drift to synonyms that the glossary explicitly avoids.

If a needed concept is missing, reconsider the terminology or note the gap for domain modeling.

## Flag ADR conflicts

Surface any contradiction with an existing ADR explicitly rather than silently overriding it.
