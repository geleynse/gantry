# Notes

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Notes subsystem handles **6 routes**.

## Routes

- `GET` `/:name/diary` params(name) `[inferred]`
  `server/src/web/routes/notes.ts`
- `POST` `/:name/diary` params(name) `[inferred]`
  `server/src/web/routes/notes.ts`
- `GET` `/fleet/search` `[inferred]`
  `server/src/web/routes/notes.ts`
- `GET` `/:name/search` params(name) `[inferred]`
  `server/src/web/routes/notes.ts`
- `GET` `/:name/:type` params(name, type) `[inferred]`
  `server/src/web/routes/notes.ts`
- `PUT` `/:name/:type` params(name, type) `[inferred]`
  `server/src/web/routes/notes.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/notes.ts`

---
_Back to [overview.md](./overview.md)_