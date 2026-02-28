# Personal Cashflow MVP

Personal Cashflow is a local-first statement analysis app for turning bank PDFs into a usable cashflow report. It focuses on a simple flow: upload statements, confirm your boundary, review uncertain items, and trust the report without hiding questionable transfers.

## Trial

Use this when a friend is trying the beta locally.

Prerequisites:
- Node.js 20+
- npm

Start in one command:

```bash
./scripts/run_local.sh
```

Main URLs:
- `http://localhost:3000/onboarding`
- `http://localhost:3000/phase3`
- `http://localhost:3000/inbox`
- `http://localhost:3000/files`
- `http://localhost:3000/settings`

Trial checklist:
1. Upload one or more PDFs in `/onboarding`.
2. Confirm boundary accounts and continue to `/phase3`.
3. Review Report Overview, then open a month in Period view.
4. Switch Offset Mode between Conservative and Raw.
5. Review uncertain items in `/inbox`.
6. Export CSV from Report.
7. Open `/files` and try listing / deleting uploads.
8. Use `docs/feedback_template.md` to collect feedback.

## What It Does

- Onboarding flow for first report setup
- Report Overview with monthly cashflow, category summary, and offset status
- Period view with timeline, filters drawer, drilldown, and transfer offset controls
- Offset Mode:
  - Conservative: exclude matched internal transfers
  - Raw: show all cashflow including internal transfers
- Inbox for unknown merchants, uncertain transfers, and parse issues
- Files manager for uploaded PDFs and notes/checks
- Settings for local reset and overrides backup/import
- CSV export for transactions and annual summary

## Quickstart

```bash
./scripts/run_local.sh
```

Useful reset commands:

```bash
# reset review state, overrides, and caches only
./scripts/reset_local_state.sh analysis

# delete all uploads and runtime state
./scripts/reset_local_state.sh uploads --yes
```

## Current Product Flow

1. `/onboarding`
   - Upload PDFs
   - Confirm boundary accounts
   - Continue into Report
2. `/phase3`
   - Review spending, income, net
   - Open a month from the chart or switch to Period view
   - Change Offset Mode if needed
3. `/inbox`
   - Confirm, change once, or always apply a rule
4. `/files`
   - Review uploaded files, notes, and delete safely
5. `/settings`
   - Reset local analysis state
   - Export/import overrides

## Data & Privacy

This project is local-first.

- Uploaded PDFs and generated state live under `uploads/*`
- Local runtime files are ignored by git and should not be committed
- Dev-only tools exist under `/dev/*`, but production builds must return `404`
- There is no cloud sync, remote account connection, or hosted storage in this beta

Typical local files include:
- `uploads/index.json`
- `uploads/manifest.json`
- `uploads/review_state.json`
- `uploads/overrides.json`
- cached parse / analysis artifacts under `uploads/`

## Known Limitations

- Uncertain transfers are never offset automatically; they stay included for safety until reviewed.
- Account identity can still be incomplete for some statement formats; the UI will show `Account details incomplete` when identity is weak.
- Warning / note codes are deterministic parser checks, not AI explanations.
- Bank template coverage is still narrow and evolving.
- Local packaging is not finished yet; this is still a developer-run beta.

## Roadmap

Near-term priorities:
- Inbox undo for recent actions
- Better contact / counterparty enrichment for transfer trust
- More bank templates beyond current supported formats
- Better explanations layer for why a transaction was categorized or offset
- Packaged local distribution for non-developer testers

## Developer Notes

Common commands:

```bash
npm ci
npm run lint
npm run build
npm run test
node scripts/parser_smoke.mjs
```

Production guard check:

```bash
npm run build
npm run start
# verify:
# /phase3 => 200
# /files => 200
# /settings => 200
# /dev/accounts => 404
# /dev/transfers => 404
```

Feedback collection template:
- `docs/feedback_template.md`
