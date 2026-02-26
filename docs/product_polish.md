# Product Polish Plan (v0.6.x Scope Cut)

## Purpose
This document defines a scope cut so the product feels simple and reliable for end users.
Goal is to reduce surface area, keep core value obvious, and defer developer-heavy workflows.

## Current User Journeys
1. Onboarding to first report:
   - `/onboarding` -> upload + auto parse
   - boundary selection
   - continue to `/phase3`
2. Ongoing analysis:
   - `/phase3` for dataset KPIs and trend
   - drill into period/compare as needed
3. Review loop:
   - `/inbox` for unknown merchants, uncertain transfers, parse issues
   - actions: Confirm / Change / Always do this
4. Data export:
   - `/phase3` -> Export dropdown
   - Transactions CSV and Annual summary CSV

## Feature Inventory

### Product-facing routes
- `/` Home (upload-first + returning user actions)
- `/onboarding` 3-step setup
- `/phase3` dataset home
- `/phase3/period` period detail
- `/phase3/compare` compare view
- `/inbox` review queue
- `/transactions` workspace/legacy transaction table

### Analysis and workflow APIs
- `/api/upload`
- `/api/pipeline/run`
- `/api/analysis/overview`
- `/api/analysis/period` (through page usage pattern)
- `/api/analysis/compare`
- `/api/analysis/transactions`
- `/api/analysis/inbox`
- `/api/analysis/inbox/resolve`
- `/api/analysis/overrides/applyOnce`
- `/api/analysis/overrides/addRule`
- `/api/analysis/export`
- `/api/analysis/boundary`

### Developer-only routes (must stay hidden in prod)
- `/dev/playground`
- `/dev/transfers`
- `/dev/accounts`

## Scope Decision: KEEP / HIDE / REMOVE

| Area | Decision | Rationale |
|---|---|---|
| Onboarding (`/onboarding`) | KEEP | Fast path to first report is core product value. |
| Dataset home (`/phase3`) | KEEP | Primary landing after setup. |
| Inbox (`/inbox`) | KEEP | Mandatory trust and correction workflow. |
| Export CSV (`/api/analysis/export`) | KEEP | Required portability for MVP users. |
| Compare (`/phase3/compare`) | HIDE (advanced) | Useful but secondary; should not distract first-time users. |
| Transactions legacy page (`/transactions`) | HIDE (advanced) | Power-user tool; keep reachable but not top-nav primary. |
| Legacy dashboard/month routes | REMOVE from nav | Avoid duplicate concepts and confusion. |
| Dev routes (`/dev/*`) | KEEP dev-only | Needed for template/debug iteration; not product surface. |
| Parse debug controls on home | HIDE (advanced) | Preserve for support/debug but not default UX. |

## v0.6.x Usable Definition
For v0.6.x, product is "usable" when navigation is reduced to:

Top-level nav items (exactly 3):
1. Home
2. Dataset
3. Inbox

Plus:
- Export is available from Dataset view actions (not as top-level nav item).
- Settings exists as a lightweight page/panel for:
  - boundary accounts
  - data management shortcuts
  - local environment status

Notes:
- Compare and Workspace remain available as advanced entry points, but not top-level.
- Dev links remain gated by `NODE_ENV !== 'production'`.

## Acceptance Checklist
- Navigation:
  - only 3 top-level nav items visible by default: Home, Dataset, Inbox
  - Compare/Workspace moved to advanced/secondary entry
- Onboarding:
  - new user can finish onboarding and reach `/phase3` without seeing dev controls
- Inbox:
  - inbox count and entry visible from dataset flow
  - all 3 inbox actions operate and persist as expected
- Export:
  - Transactions CSV and Annual summary CSV download from dataset action menu
- Production safety:
  - `/dev/*` routes return 404 in production
- Documentation:
  - quickstart and core user flow are reflected in README and this plan

## Out of Scope for this Cut
- New parser templates or parser rule refactors
- Major chart redesign
- Transfer matching algorithm redesign
- Auth overhaul / multi-tenant architecture work
