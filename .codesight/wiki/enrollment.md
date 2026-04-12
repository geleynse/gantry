# Enrollment

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Enrollment subsystem handles **4 routes** and touches: auth, ai.

## Routes

- `GET` `/enrollment-options` [auth, ai] `[inferred]`
  `server/src/web/routes/enrollment.ts`
- `POST` `/enroll` [auth, ai] `[inferred]`
  `server/src/web/routes/enrollment.ts`
- `POST` `/:name/deploy-prompt` params(name) [auth, ai] `[inferred]`
  `server/src/web/routes/enrollment.ts`
- `GET` `/:name/prompt-preview` params(name) [auth, ai] `[inferred]`
  `server/src/web/routes/enrollment.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/enrollment.ts`

---
_Back to [overview.md](./overview.md)_