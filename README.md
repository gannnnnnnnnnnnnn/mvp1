# Personal Cashflow Agent (CommBank Phase 3.0-prep)

A Next.js App Router project that now supports a full CommBank PDF pipeline:
upload -> text extract -> segment -> parse -> quality gates -> UI review.

Phase 3 (current branch `feature/phase3-core`) adds:
- normalized transaction schema for analytics
- merchant normalization + rule/manual category assignment
- chart-ready analysis APIs
- dashboard + transactions pages for category-driven insights

## Tech Stack

- Next.js 16 (App Router)
- TypeScript
- Local filesystem storage (`uploads/` + `uploads/index.json`)

## Development Progress (Human-friendly)

这段给两类读者看：非工程背景同学，以及后续接手的工程同学。  
看法很简单：先看树状图（我们做到哪了），再看原则（为什么这样做），最后看下一步。  
目标不是“讲全技术细节”，而是快速理解路线和决策。

```text
MVP: Personal Cashflow App
├─ Goal
│  └─ 帮用户把银行 PDF 变成“可核对、可解释、可追溯”的现金流数据。
│
├─ Phase 1: File Handling
│  ├─ ✅ Upload / list / download PDFs
│  ├─ ✅ 本地存储 uploads/ + index.json
│  └─ ✅ 基础安全（路径检查、大小限制、简单鉴权）
│
├─ Phase 2: Text -> Segment -> Parse (CommBank)
│  ├─ ✅ Text extraction + cache (pdf-parse + text-cache)
│  ├─ ✅ Segment v1/v2（TransactionSummary 模板）
│  ├─ ✅ Parse v1/v2（结构化表格输出）
│  └─ ✅ UI 可追溯展示（rawLine / confidence / warnings）
│
├─ Phase 2.5: Quality Gate “上锁”
│  ├─ ✅ headerFound gate
│  ├─ ✅ balance continuity gate
│  │   └─ 采用 post-transaction 语义：prev.balance + curr.amount ~= curr.balance
│  └─ ✅ needsReview + reasons（失败可解释，不 silent fail）
│
├─ Phase 2.6: Regression Baseline
│  ├─ ✅ 单样本快照：generate / compare
│  ├─ 🔄 多样本回归跑批（最小脚本）已开始收口
│  └─ ✅ main 上已有可回滚的阶段提交链
│
├─ Phase 3.0.x: Template System (CommBank only)
│  ├─ ✅ template detect（summary vs debit/credit statement）
│  ├─ ✅ template-aware segment route
│  ├─ ✅ statement 模板 parse（多行聚合、年份推断、continuity gate）
│  └─ 🔄 templates/commbank/*.json 规则外置（下一步）
│
└─ Phase 3.0: Interpretation Layer (跨账户解释)
   ├─ ⏳ Household boundary（哪些账户算“家里账户”）
   ├─ ⏳ Internal transfer linking（转账不算消费）
   ├─ ⏳ Credit card semantics（刷卡与还款语义拆分）
   └─ ⏳ Summary / export（可读结论输出）
```

## Current Main Status (2026-02-13)

- Template detect is now CommBank-only and stable with header-area priority:
  - `commbank_manual_amount_balance`
  - `commbank_auto_debit_credit`
- Auto parser handles glued reference+amount lines (for example Direct Debit + long reference digits) and recovers correct amount via balance-window + continuity inference.
- Balance semantics are signed internally:
  - `CR` -> positive balance
  - `DR` -> negative balance
  - no suffix accepted only for `0.00`
- Quality gate behavior:
  - `AMOUNT_OUTLIER` is now a **non-blocking warning** when parsing still succeeds.
  - hard review is kept for real failures (`AUTO_AMOUNT_NOT_FOUND`, `AMOUNT_SIGN_UNCERTAIN`, `BALANCE_CONTINUITY_LOW`, etc.).
- UI shows template type, continuity summary, and review reasons; for auto rows it also shows `Debit/Credit` columns and raw debug context.

### Why We Designed It This Way

- 先规则后 AI：先把可解释规则跑通，LLM 不做第一步 parser。  
- 可解释失败：任何失败都要有 `needsReview + reasons`，不让用户猜。  
- 模板化优先：按模板分流，比把所有情况塞进一个大正则更稳。  
- 单银行闭环优先：先把 CommBank 跑稳，再考虑扩银行。  
- 小步可回滚：每个里程碑独立 commit，方便定位回归点。

### Next 3-5 Steps

1. 落地 `templates/commbank`（detect / segment / parse 规则配置化）。  
2. 继续收紧 statement 模板（噪音行过滤、block 边界、warning 降噪）。  
3. 开始 Phase 3 解释层（家庭边界 + 内部转账 linking + 信用卡语义）。  
4. 增加最小多样本回归跑批输出（指标表，不引入复杂测试框架）。  
5. 导出与 summary（给非技术用户的可读结论）。

## What Exists Today (Phase 0/1)

- `POST /api/upload`: upload one file (PDF/CSV, <=20MB)
- `GET /api/files`: list uploaded files (newest first)
- `GET /api/files/:id/download`: download file by metadata ID
- `POST /api/parse/pdf-text`: extract text from PDF with local cache
- Persistent metadata index in `uploads/index.json`
- Basic hardening already added:
  - in-process write queue for index append
  - upload rollback if metadata write fails
  - safe download path resolution
  - optional token auth for list/download

## Quick Start

### Local quickstart

Prerequisites:
- Node.js 20+
- npm

Run in one command:

```bash
./scripts/run_local.sh
```

What it does:
- Installs dependencies via `npm ci` if `node_modules` is missing.
- Starts local dev server (`npm run dev`).
- Prints direct links:
  - `/onboarding`
  - `/phase3`
  - `/inbox`

Local data:
- Uploaded files and local state are stored under `uploads/*`.
- These files are local-only and not tracked by git.

Flow:
- Start at `/onboarding` for first-time setup.
- Use `/inbox` to review unknown merchants, uncertain transfers, and parse issues.
- Use `/phase3` for analysis and export CSV from the `Export` menu.

### 1) Install and run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Dev Playground (Developer-only)

Use this for parser inspection without touching the product flow.

- Route: `/dev/playground`
- Works only in development (`next dev`)
- Blocked in production (`next build && next start` returns 404 for dev APIs and page not found)

What you can do:
- Select one uploaded file by `fileHash`
- Inspect normalized index entry + debug summary
- Inspect transaction sample / warning groups / text preview
- Re-run parse for this file in dev mode and save outputs under:
  - `uploads/dev-runs/<fileHash>/<runId>/rerun-output.json`

#### ANZ Template (dev-only)

- ANZ parsing is available only in `/dev/playground` rerun flow.
- It does **not** write back to main store/index by default.
- Detected ANZ runs are persisted only under:
  - `uploads/dev-runs/<fileHash>/<runId>/...`

Manual validation for ANZ dev runs:

```bash
node scripts/parser_smoke_anz.mjs
```

This smoke script checks latest ANZ dev-run outputs and validates:
- `detected.templateId === "anz_v1"`
- `accountId` extracted
- transactions exist
- continuity is high
- no standalone `Effective Date` rows as transactions

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

### Extract PDF text (Phase 2.1)

```bash
curl -X POST http://localhost:3000/api/parse/pdf-text \
  -H "Content-Type: application/json" \
  -d "{\"fileId\":\"<id>\",\"force\":false}"
```

Expected success shape:

```json
{
  "ok": true,
  "fileId": "...",
  "text": "....",
  "meta": {
    "extractor": "pdf-parse",
    "length": 12345,
    "cached": true,
    "truncated": false
  }
}
```

### Analysis overview (Phase 3)

```bash
curl "http://localhost:3000/api/analysis/overview?fileId=<id>&granularity=month"
```

Expected response includes:
- `totals` (income/spend/net)
- `periods` (chart-ready)
- `spendByCategory` (+ `transactionIds` traceability)
- `topMerchants` (+ `transactionIds`)
- `balanceSeries` (date,balance)
- `appliedFilters` (file/account/date/granularity actually used by backend)

### Analysis compare (Phase 3)

```bash
curl "http://localhost:3000/api/analysis/compare?fileId=<id>&mode=month"
```

Expected response includes:
- `current` vs `previous`
- `deltas` for income/spend/net
- `categoryDeltas`

### Analysis transactions (Phase 3)

```bash
curl "http://localhost:3000/api/analysis/transactions?fileId=<id>&q=transfer&category=Transfers"
```

Expected response includes:
- normalized `transactions` with `merchantNorm`, `category`, `categorySource`
- parser quality info (`templateType`, `needsReview`, continuity fields)
- `accountId` + `appliedFilters` for future multi-account integration

### Category override (Phase 3)

Set single transaction:

```bash
curl -X POST "http://localhost:3000/api/analysis/category-override" \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"<txId>","category":"Groceries"}'
```

Apply to merchant:

```bash
curl -X POST "http://localhost:3000/api/analysis/category-override" \
  -H "Content-Type: application/json" \
  -d '{"merchantNorm":"WOOLWORTHS","category":"Groceries","applyToMerchant":true}'
```

## Project Structure

```text
app/
  api/
    upload/route.ts                  # upload endpoint
    files/route.ts                   # list endpoint
    files/[id]/download/route.ts     # download endpoint
    parse/pdf-text/route.ts          # PDF text extract + cache endpoint
    analysis/overview/route.ts       # chart overview dataset
    analysis/compare/route.ts        # current vs previous month comparison
    analysis/transactions/route.ts   # normalized/categorized rows endpoint
    analysis/category-override/route.ts # manual category override endpoint
  page.tsx                           # upload/list UI
  dashboard/page.tsx                 # analytics dashboard UI
  transactions/page.tsx              # transactions table + category override UI
  layout.tsx                         # root layout
lib/
  fileStore.ts                       # uploads/index.json read/write helpers
  analysis/                          # normalization, categories, analytics builders
uploads/                             # runtime files (gitignored)
```

## Known Boundaries and Risks (still open)

- CommBank-only rules. No multi-bank abstraction yet.
- Category rules are deterministic and local; no learning model is applied.
- Override storage is local JSON (`uploads/category-overrides.json`) and in-process queued; not distributed-safe.
- Charts are range/file scoped. Cross-file account portfolio merge is not implemented.
- Parser smoke test currently validates snapshot schema and baseline fields; it is not a full regression matrix.

## Commands

```bash
npm run lint
npm run build
npm run test
npm run start
```

## Git Workflow (Phase 3)

- Keep `main` always demoable (only merged, validated work).
- Stable parser baseline tag: `v0.2.0-parser-stable`.
- Phase 3 integration branch: `feature/phase3-core`.
- Optional short-lived feature branches:
  - `feature/phase3-<scope>`
  - `fix/phase3-<scope>`

Suggested commit prefixes:
- `feat(<scope>): ...`
- `fix(<scope>): ...`
- `chore(<scope>): ...`
- `docs(<scope>): ...`

Sample privacy:
- keep sensitive statement PDFs outside git-tracked folders
- private samples path is ignored: `samples/private/`

## CommBank Snapshot (Quick)

1. Place sample PDF at `fixtures/TransactionSummary.pdf`.
2. Start server: `npm run dev` (use `cmd`, not PowerShell, if script policy blocks npm).
3. Generate baseline: `npm run snapshot:generate` -> writes `expected/TransactionSummary.parsed.json`.
4. Compare current parser: `npm run snapshot:compare` -> writes `tmp/actual.json`.

Note: in offline/blocked-network environments, `npm run build` may fail to fetch Google Fonts used in `app/layout.tsx`.
