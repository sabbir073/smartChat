# Contributing to SmartChat

## Before you push

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

CI runs exactly this, plus integration, tenant-isolation and Docker build jobs.

## Rules that are not negotiable

1. **No placeholder functionality.** A control that ships does what it says. Features not built yet
   are absent from the UI, not stubbed with a dead button or a "coming soon" label.
2. **No unscoped tenant queries.** Every query against a tenant-owned model goes through a
   `@smartchat/core` repository that takes a `TenantContext`. Direct Prisma access to those models
   from `apps/*` is rejected in review.
3. **Every new tenant-owned model gets an isolation test.** No exceptions.
4. **Errors are diagnosed, not silenced.** No empty `catch`, no `// @ts-ignore`, no `any` to make a
   type error disappear.
5. **Migrations are forward-only and additive.** Expand → backfill → contract across releases, so a
   rollback is always an image rollback.
6. **Docs change in the same commit as the code they describe.** Architectural decisions go in
   `docs/DECISIONS.md` the day they are made.

## Commit messages

Conventional Commits: `feat(inbox): …`, `fix(widget): …`, `docs(architecture): …`,
`refactor(core): …`, `test(isolation): …`, `chore(deps): …`.
