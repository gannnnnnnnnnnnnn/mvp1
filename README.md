# Personal Cashflow Agent (Phase 1)

A minimal Next.js App Router project for uploading PDF/CSV files to local disk, listing uploaded files, and downloading by ID.

## Tech Stack

- Next.js 16 (App Router)
- TypeScript
- Local filesystem storage (`uploads/` + `uploads/index.json`)

## What Exists Today (Phase 0/1)

- `POST /api/upload`: upload one file (PDF/CSV, <=20MB)
- `GET /api/files`: list uploaded files (newest first)
- `GET /api/files/:id/download`: download file by metadata ID
- Persistent metadata index in `uploads/index.json`
- Basic hardening already added:
  - in-process write queue for index append
  - upload rollback if metadata write fails
  - safe download path resolution
  - optional token auth for list/download

## Quick Start

### 1) Install and run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### 2) Optional auth setup

If you want to protect list/download APIs, create `.env.local`:

```bash
cp .env.example .env.local
```

Then set:

```bash
API_TOKEN=replace-with-a-long-random-string
```

When `API_TOKEN` is set:
- `GET /api/files`
- `GET /api/files/:id/download`

must include request header:

```http
x-api-token: <API_TOKEN>
```

## API Testing (curl)

### Upload

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "file=@/absolute/path/to/sample.pdf"
```

Expected success shape:

```json
{
  "ok": true,
  "file": {
    "id": "...",
    "originalName": "sample.pdf",
    "storedName": "<uuid>.pdf",
    "size": 12345,
    "mimeType": "application/pdf",
    "uploadedAt": "2026-02-08T00:00:00.000Z",
    "path": "uploads/<uuid>.pdf"
  }
}
```

### List files (without token)

```bash
curl http://localhost:3000/api/files
```

### List files (with token enabled)

```bash
curl http://localhost:3000/api/files \
  -H "x-api-token: $API_TOKEN"
```

Expected success shape:

```json
{
  "ok": true,
  "files": [
    {
      "id": "...",
      "originalName": "sample.pdf",
      "size": 12345,
      "mimeType": "application/pdf",
      "uploadedAt": "2026-02-08T00:00:00.000Z"
    }
  ]
}
```

### Download by id

```bash
curl -L "http://localhost:3000/api/files/<id>/download" -o downloaded-file
```

With token enabled:

```bash
curl -L "http://localhost:3000/api/files/<id>/download" \
  -H "x-api-token: $API_TOKEN" \
  -o downloaded-file
```

## Project Structure

```text
app/
  api/
    upload/route.ts                  # upload endpoint
    files/route.ts                   # list endpoint
    files/[id]/download/route.ts     # download endpoint
  page.tsx                           # upload/list UI
  layout.tsx                         # root layout
lib/
  fileStore.ts                       # uploads/index.json read/write helpers
uploads/                             # runtime files (gitignored)
```

## Known Boundaries and Risks (still open)

- No user/session auth model yet (only optional shared token header).
- `GET /api/files/:id/download` still reads full file into memory before returning.
- Upload MIME check is stronger than before, but still not content-signature validation.
- In-process write queue protects one Node process only (not multi-instance/distributed).
- No delete/cleanup lifecycle for old files yet.

## Commands

```bash
npm run lint
npm run build
npm run start
```

Note: in offline/blocked-network environments, `npm run build` may fail to fetch Google Fonts used in `app/layout.tsx`.
