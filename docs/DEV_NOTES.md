# DEV_NOTES

## Current Branch Baselines

- `cursor-phase-1`: frozen baseline before hardening (`969ec31`)
- `main`: P0/P1 hardening applied (`d8580b6` and newer)

## What Changed in Hardening

1. `lib/fileStore.ts`
- Added in-process write queue for `appendMetadata()` to reduce concurrent overwrite risk.
- Added corrupted `uploads/index.json` fallback: isolate bad file and continue with empty list.

2. `app/api/upload/route.ts`
- Tightened type checks (extension + expected MIME handling).
- Added rollback cleanup when metadata write fails after file write.
- Normalized metadata `path` to POSIX style.

3. `app/api/files/route.ts`
- Added optional `API_TOKEN` auth (`x-api-token` header).
- Sanitized list response (no `storedName` / `path`).

4. `app/api/files/[id]/download/route.ts`
- Added optional `API_TOKEN` auth.
- Added safe path resolution to prevent path traversal via tainted metadata.
- Hardened `Content-Disposition` filename generation.

## Known Open Items

- Single-process queue only; not enough for multi-instance deployment.
- Download still loads file fully into memory.
- No content-signature sniffing for uploaded file types.
- No deletion/archive lifecycle for old uploads.
- No parser pipeline yet for PDF text extraction and transactions.

## Suggested Next Refactor (not rewrite)

1. Extract shared auth guard and error helpers into `lib/api/` to remove duplication.
2. Add typed API contracts in one place (shared TS types for frontend + backend).
3. Introduce streaming download (`createReadStream`) for large file memory safety.
4. Add lightweight file lifecycle ops: delete endpoint + orphan sweeper script.
5. Prepare Phase 2 metadata envelope in `FileMeta` using optional fields:
   - `schemaVersion`
   - `processing: { status, error? }`
   - `artifacts: { textPath?, transactionsPath? }`

## Useful Commands

```bash
npm run lint
npx tsc --noEmit
npm run dev
```

```bash
git branch -vv
git log --oneline --decorate -n 10
```
