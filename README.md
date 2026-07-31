# WorkShield MM — Employment Verification & Risk Intelligence Platform

Subscription platform for verified employers in Myanmar / SEA to (Tier A) verify
employment history and business legitimacy, and — once legally cleared — (Tier B)
submit evidence-gated conduct reports shared between subscribing companies. The
web client (`apps/web`) is a modern sidebar dashboard branded **WorkShield MM**.

> **Tier B model:** reports are accepted on strong, admin-verified evidence and
> published directly to other verified employers. There is no pre-publication
> subject notice, no dispute stage, and no review board; accuracy is safeguarded
> by the admin evidence gate plus an **admin correction path** (a published
> report can be corrected or withdrawn, audited with a reason).
>
> This is a deliberate product decision (July 2026) that **diverges from both
> governing documents**, which describe the notice and right of reply as
> structural — Revised Concept §3.2 steps 4-5 and Technical Doc §5. See
> `db/migrations/0011_remove_notice_and_dispute.sql`. The documents have not
> been updated to match.

> **Build posture:** Tier A ships first as the MVP. Tier B's data model and
> compliance controls exist from day one, but its API endpoints stay behind
> `FEATURE_TIER_B_ENABLED` (off by default in **every** environment) until the
> Phase 0 legal opinion is complete. This
> is a deliberate requirement from the concept and technical documents, not an
> implementation shortcut.

## Architecture

| Layer          | Choice                                                        |
| -------------- | ------------------------------------------------------------- |
| Frontend       | React + Material UI (`apps/web`)                              |
| Backend        | Node.js + Express + **TypeScript** (`apps/api`)              |
| Database       | PostgreSQL 16 — row-level security + append-only audit schema |
| File storage   | S3-compatible object storage (MinIO locally) — evidence only  |
| Jobs           | Redis + BullMQ (expiry, notifications, retention purges)       |
| Shared types   | `packages/shared` (roles, statuses, category policy)          |

```
apps/
  api/            Express + TS API (this is where Tier A lives)
  web/            React + MUI frontend (scaffolded next)
packages/
  shared/         Enums/types shared by api + web
db/
  migrations/     Raw SQL — schema, RLS policies, audit grants
  seeds/          Policy-as-data (report_categories)
infra/
  docker-compose.yml   Postgres + Redis + MinIO for local dev
```

## Compliance controls (where they live)

These are structural, not optional — see the technical doc §5.

- **Access control (defense in depth):** RBAC at the API layer **and** Postgres
  row-level security (`db/migrations/0004_rls.sql`). The app connects as the
  limited `hyper_app` role so a query bug can't leak cross-company data.
- **Audit immutability:** `audit.audit_logs` in a dedicated schema with
  INSERT/SELECT-only grants and UPDATE/DELETE-rejecting triggers
  (`0003_audit.sql`). Written in the same transaction as the change it records.
- **Excluded categories:** protected-activity categories are `eligible = false`
  and blocked by a data-layer trigger, not just the UI (`0002_tier_b.sql`,
  `seeds/report_categories.sql`).
- **Acceptance + correction:** publication requires an admin's
  evidence-sufficient decision (the employer can't self-publish); a published
  report can be corrected or withdrawn afterward, audited with a reason. This
  is the only accuracy safeguard now that the notice window is gone.
- **Data minimization:** `subjects` stores a peppered `national_id_hash`, never
  the raw ID, and no contact details. This is why the NRC number cannot be
  displayed anywhere in the UI — it is not stored. No freeform allegation
  fields either, just a short factual summary tied to a fixed category.
- **Rate limiting:** per-company limits on submissions and searches
  (`middleware/rateLimit.ts`) to prevent bulk blacklisting/scraping.
- **Encryption at rest:** `S3_SSE` for evidence and identity documents; the API
  refuses to boot in production with it unset (`config/env.ts`).
- **Secrets:** validated at boot (`config/env.ts`); real values come from a
  vault in production, never from committed files.

## Local development

Prerequisites: Node 20+, Docker.

```bash
# 1. Install workspaces
npm install

# 2. Start Postgres + Redis + MinIO
npm run infra:up

# 3. Configure env
cp .env.example .env

# 4. Apply schema + policies, then seed the category policy
npm run migrate
npm run seed

# 5. Run the API (http://localhost:4000/ready)
npm run dev
```

## Status

- [x] Monorepo, infra, shared types
- [x] Database schema: Tier A, Tier B, RLS, append-only audit
- [x] API skeleton: config, DB context/RLS wiring, health, rate limiting
- [x] Auth: login/refresh (rotating)/logout, argon2, TOTP MFA, platform-user bootstrap
- [x] Tier A: company registration → DICA verify → verification checks, transactional audit
- [x] Tests: full Tier A flow, MFA gate, RLS cross-company isolation, audit write
- [x] `apps/web` React + MUI frontend: login (+MFA), registration, Tier A submit/list, Super Admin verification queue
- [x] Verification documents: DICA cert / shop license + NRC upload to object storage, audited review, verify blocked until required docs present
- [x] Verification completion flow: reviewer queue, pending → completed/not_found with factual result, single-shot decisions
- [x] Audit-log viewer: Super Admin only, filterable, paginated — and reading it is itself logged
- [x] Tier B modules (behind the flag): reports, evidence, admin accept/reject, correction path (withdraw/correct), access requests, Super Admin oversight
- [x] Company lifecycle: Super Admin suspend / reactivate (reason audited) and a full company detail view (users, subscriptions, documents, activity)
- [x] BullMQ worker: retention expiry/anonymization sweep
- [x] Tier B frontend: employer report submission + evidence (with the attached-file list), admin evidence review, oversight + correction, access request/grant — all gated on the flag
- [ ] Object-storage retention tooling (delete evidence objects on expiry)
- [ ] Third-party security audit / penetration test — a hard gate before Tier B
      goes live in production (tech doc §6)

### Tier B — conduct reports (feature-flagged OFF)

Everything below is mounted behind `FEATURE_TIER_B_ENABLED` (default **false**
in every environment) and additionally requires a verified company with an
active Tier B subscription. Do not enable before the Phase 0 legal opinion.

Lifecycle: `draft → pending_review → approved | rejected → expired` · `approved → withdrawn`

| Method & path | Access | Purpose |
| --- | --- | --- |
| `GET /report-categories` | Tier B company user | Eligible categories + evidence requirements |
| `POST /reports` | Tier B company user (rate-limited) | Create a draft report |
| `POST /reports/:id/evidence` | Owner, draft only | Attach evidence (→ encrypted object storage) |
| `POST /reports/:id/submit` | Owner | Submit — refused without evidence |
| `GET /admin/reports/pending` | Admin Reviewer / Super Admin | Evidence review queue |
| `GET /admin/reports?status=` | Super Admin | Oversight: all reports, metadata only, status-filtered (list read audited) |
| `GET /admin/reports/:id/detail` | Reviewer | Report + evidence list (open is audited) |
| `GET /admin/reports/:id/evidence/:fileId/download` | Reviewer | Presigned evidence URL (audited) |
| `POST /admin/reports/:id/decision` | Reviewer | `evidence_sufficient` → **published** · `evidence_insufficient` → rejected |
| `POST /admin/reports/:id/withdraw` | Reviewer | Correction path: withdraw a published report (reason audited) |
| `POST /admin/reports/:id/correct` | Reviewer | Correction path: correct a published report's summary (reason audited) |
| `POST /access-requests` | Tier B company (rate-limited) | Discover + request access to published reports |
| `POST /access-requests/:id/decision` | Reviewer | Approve/deny access |
| `GET /reports/:id` | Owner, or approved requester | Read a report (cross-company reads audited) |
| `POST /admin/companies/:id/subscriptions` | Super Admin | Grant a subscription tier (not flag-gated) |

Key structural behaviors:
- Publication happens on **admin acceptance** of sufficient evidence — no
  pre-publication notice, no dispute stage, no review board. The submitting
  employer can never self-publish; only a reviewer/super-admin can accept.
- Accuracy safeguard is the **correction path**: a published report can be
  withdrawn (leaves `approved`, so it's no longer discoverable/readable) or
  corrected in place, both audited with a reason.
- Cross-company reads require an approved access request and are individually
  audited; report search/submission are per-company rate-limited (anti-scraping).
- Expiry is automatic: the sweep anonymizes the narrative and purges evidence
  rows once `expiry_date` passes (`REPORT_EXPIRY_YEARS`, default 5).

Run the background worker (retention sweep):

```bash
npm run worker -w @hyper/api
```

### Frontend (`apps/web`)

Vite + React + MUI, talking to the API at `VITE_API_URL` (default `http://localhost:4000`).

```bash
npm run dev -w @hyper/web    # http://localhost:5173
```

Modern sidebar dashboard (navy rail, stat cards, soft status chips) — theme
tokens in `src/theme.ts`, shared primitives in `src/components/ui.tsx`. The
sidebar and routes adapt to role and to whether Tier B is enabled (probed from
`/ready`).

Pages:
- **Everyone:** `/login` (MFA-aware), `/register`, `/` dashboard (role-aware
  stat cards; document upload while a company is pending)
- **Employer:** `/verifications` (submit + history), `/reports` (Tier B: draft →
  evidence → submit), `/report-access` (Tier B: search + view granted reports)
- **Reviewer:** `/admin/verifications` (check completion), `/admin/reports`
  (Tier B evidence accept/reject), `/admin/access-requests` (Tier B grants)
- **Super Admin:** `/admin/oversight` (all-reports oversight — metadata list +
  audited per-report open, with withdraw/correct), `/admin/companies`,
  `/admin/audit`

### API endpoints (live)

| Method & path | Access | Purpose |
| --- | --- | --- |
| `POST /companies` | Public | Register employer (+ first admin) → `pending` |
| `POST /companies/:id/verify` | Super Admin (MFA) | Confirm DICA registration → `verified` (requires docs on file) |
| `POST /companies/:id/status` | Super Admin | Suspend / reactivate an employer (reason audited) |
| `GET /companies/:id/detail` | Super Admin | Company record: users, subscriptions, documents, activity counts |
| `GET /companies/:id` | Auth (RLS) | Read a company |
| `POST /companies/:id/documents` | Company user (own) | Upload DICA cert / shop license / NRC (→ object storage) |
| `GET /companies/:id/documents` | Auth (RLS) | List a company's documents |
| `GET /companies/:id/documents/:docId/download` | Auth (RLS) | Presigned URL for one doc (audited access) |
| `POST /auth/login` | Public | Login (MFA required for platform roles) |
| `POST /auth/refresh` | Public | Rotate refresh token |
| `POST /auth/logout` | Public | Revoke refresh token |
| `POST /auth/mfa/setup` · `POST /auth/mfa/verify` | Auth | Enable MFA on own account |
| `POST /verifications` | Verified employer | Submit a Tier A check (rate-limited) |
| `GET /verifications/:id` | Auth (RLS, own only) | Read a check result |
| `GET /admin/verifications?status=` | Admin Reviewer / Super Admin | Review queue of checks |
| `POST /admin/verifications/:id/decision` | Admin Reviewer / Super Admin | Complete a check → `completed` / `not_found` |
| `GET /admin/audit-logs` | Super Admin only | Read audit trail (the read is itself logged) |

Bootstrap a platform admin:

```bash
npm run create:platform-user -w @hyper/api -- --email admin@hyper.local --name "Admin" --role super_admin --password 'Str0ngPass!'
```
