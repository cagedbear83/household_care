# Project state: Household Care (IP support app)

Snapshot taken 2026-10-04. Built against `IP-App-Specification.md` (the source of truth for rules). `README.md` documents each feature in more detail; this file is the "where are we" summary for picking the work back up.

## Branches

`development` (local building, current working branch), `staging` (pre-production, fake data only), `main` (production). Work flows development, then staging, then main; feature work happens on short-lived `feature/*` and `fix/*` branches. Full rules, promotion checklist, migration and hotfix process are in `BRANCHING.md`. The repository is local only (no remote yet), so branch protection is by agreement until one is added.

## What this is

A full-stack app for an Individual Provider (IP) caring for one client who is blind or has low vision in a household: attendance with a geofenced check-in, a task checklist with photo evidence, client review, family visibility, chat, alerts, spoken summaries, reports, corrections and retention. Core rules: strict 36-hour weekly authorization cap, append-only hash-chained audit log, server-side enforcement of roles and household scope, and nothing original is ever edited or deleted.

Roles: **CLIENT**, **ADMIN** (also the case manager; same powers as the client except client-only decisions), **IP**, **FAMILY** (read-only; times and photos only if the client approved).

## Status in one line

Backend and app are feature-complete for the scope below and verified (265 backend tests, mobile type-check/lint clean, Android bundle builds, browser walkthroughs). **Not yet run on a real phone or emulator**, **not deployed**, and **recent work is not committed**: the first commit is on `main` and the later changes (fixed retention, program rules) are uncommitted on `development`. The repository is on GitHub (`cagedbear83/household_care`, public as of this writing).

## Stack

- **Backend** (`backend/`): Node 24, TypeScript, Express 4, Prisma 5.22, PostgreSQL 18, zod, luxon, node-cron (every minute), bcryptjs, jsonwebtoken, sharp, nodemailer (SMTP, untested live), Twilio over fetch (untested live), vitest.
- **Mobile/web** (`mobile/`): Expo SDK 57, React Native 0.86, Expo Router (routes in `mobile/src/app`), react-native-web (browser preview), expo-camera, expo-location, expo-secure-store, expo-speech, expo-print. `.npmrc` has `legacy-peer-deps=true`.
- **Dev database:** embedded Postgres via `npm run dev:db` (port **55432**, db `household_care`). Chocolatey Postgres was not usable (no admin).

## How to run

Three terminals:

1. `cd backend && npm run dev:db`
2. `cd backend && npm run dev` (API on **4000**)
3. `cd mobile && npx expo start --web` (web on **8081**); Android emulator: `npx expo start --android --port 8082` (reaches the API at `10.0.2.2:4000`)

Tests: `cd backend && npm test` (runs against the dev DB using throwaway households; 11 files, 200 tests). Mobile checks: `npx tsc --noEmit`, `npx expo lint`, `npm run check:voice`, `npx expo export -p android`.

Demo accounts (all `ChangeMe123!`): `client@example.com`, `admin@example.com`, `ip@example.com`. Family: `sam.sister@example.com` / `fresh-start-2026` (approved for photos and times). Helpers: `backend/scripts/demo-today.ts` (a checked-in visit for today with tasks done), `demo-alerts.ts` (sample alerts), `verify-chain.ts`.

With no SMTP/Twilio configured, messages print to the backend console and are stored in `OutboundMessage`; invite links and 6-digit codes also show in the UI (dev only). Config is in `backend/.env` (see `.env.example`: `APP_BASE_URL`, `ENABLE_DEV_OUTBOX`, `SMTP_URL`/`EMAIL_FROM`, `TWILIO_*`, `FOOD_RESPONSE_MINUTES`, `COMPLETION_BURST_THRESHOLD`).

## Layout

- `backend/src/services/`: one file per domain (authorization, schedule, task, evidence, review, comment, invite, chat, food, shopping, alert + alert-feed, summary, report, correction, retention, profile, password-reset, notify, event, time, geofence...). `routes/` mounts them; `index.ts` wires routers and the per-minute cron (close expired authorizations, escalate unanswered food requests, deliver pending alert messages).
- `backend/prisma/`: `schema.prisma` and 12 migrations (latest `20261006150000_wellbeing_checkins`). Models include Household, User, ScheduledShift, WeekAllowance, Event (hash chain), TaskTemplate/TaskInstance, Evidence, Invite, Comment, Conversation/Message, FoodDisposalRequest, ShoppingItem, Alert/AlertRead, AwayPeriod, Preservation, WeeklyHoursNotice, PayPeriodReminder, CheckInPlan/CheckInResponse, ContactChange, CorrectionRequest/Correction.
- `mobile/src/app/`: `home` (hub), `today` (IP shift), `alerts`, `review`, `corrections`, `food`, `shopping`, `schedule`, `templates`, `family`, `hear`, `reports`, `settings`, `messages/*`, `supplies` (IP), `capture` (camera), `login`, `forgot-password`, `invite`.
- `mobile/src/lib/`: `api.ts` (all calls and types), auth, dates, location, storage, speech, badges, voice parser/input, report formatting/HTML, print.

## What is built

- **Auth:** email or phone sign-in, bcrypt + JWT, active/revoked check on every request, session revocation (`tokensValidAfter`), password reset by 6-digit code, rate limiting (in memory).
- **Scheduling:** shifts with edit/cancel history, recurring weekly rules, vacation/sick days, 36-hour cap enforced under row locks, DST-safe times, task templates (changes apply to future shifts only).
- **Attendance:** geofenced check-in/out, periodic pings while the app is open, server sweep that closes authorization at scheduled end or cap; observed and authorized time kept separate; forgotten checkout stays missing.
- **Tasks and evidence:** every-visit checklist snapshotted at check-in; complete / not needed / unable / decline reporting; one-use capture challenge, in-app camera only, hashing, write-once storage, metadata-stripped viewer copy, location check on photos.
- **Client review:** approve, dispute (reason required), corrective work while the shift is open, confirm or deny reported declines; each step its own event.
- **Family:** invite by email or phone, name confirmation, second-contact verification, per-person photo/time approval, revoke; comments on any task or photo; read-only Review.
- **Chat:** household group plus private direct messages (polling).
- **Food and shopping:** disposal requests that need the client's approval, hazard reports, escalation if unanswered; shopping list with merging, IP low-supply reports, auto-add after approved disposal.
- **Alerts:** own records with per-person read state, dedupe, "handled" auto-resolution, urgent labelled in words, text/email delivery queue with 3 retries; triggers include IP-reported decline, early check-in/checkout, tasks undone at checkout, completion bursts ("may need a look"), completion-error reports. Alerts clear only when the client taps into them.
- **Spoken summaries:** server-written text (`/summaries`), Hear screen with Stop, speed, ask-first for "done today", optional auto-read of new urgent alerts, web voice commands.
- **Home hub:** everyone lands on Home; a button per place by role; every other screen has a Home button.
- **Settings:** name, email/phone change by code sent to the new contact, password change (other devices signed out).
- **Reports:** day/week/month/custom, task outcome counts and the spec's percentage formulas, authorized vs observed time, weekly cap table, exceptions, family without approval gets task counts only, print or save as PDF from the device, nothing stored (only a "report generated" audit event).
- **Corrections:** IP reports a mistake; client/admin appends a correction linked to the original event (completion error, attendance note, other note) or answers without one; originals untouched; corrected task stops counting as done and reopens for the IP.
- **Retention:** a fixed rule in `backend/src/services/retention.ts`: every record is kept at least ten years from the event date; nothing can change it (no screen, endpoint, role or setting; a test pins that). Disputed material is kept regardless of age. The app never deletes anything.

## Decisions made

- **Program rules decided (from the user's answers and the HSP forms and SEIU agreement):** workweek Sunday to Saturday; weekly limit = Service Plan hours (36/week); at most 8 scheduled hours per day for everyone (no override); a warning at 14+ hours recorded in 24 (program limit 16 without counselor approval); **photos kept one year, fixed**, and an approval never deletes (disputed, corrected or preserved ones are kept); the **primary family member** (first to activate) has the client's access and notifications, the client cannot remove them, only an administrator can change it; **away mode** may be set by the client, an administrator or the primary family member; the IP gets a weekly hours email (Sunday morning) and the client side gets pay-period reminders (15th and last day). No write-ups, supervision log or three-strikes feature (the client may terminate without cause or notice and it is not grievable; the "occurrences" in the union agreement are the State's, for unauthorized overtime). The app never stores SSNs, dates of birth or case numbers. The household uses the state's EVV (Sandata); the app stays supplementary and is not connected to it.
- **Wellbeing check-ins decided (the user's answers):** administrator sets which check-in (PHQ-2, GAD-2) and how often (every 1, 2 or 3 days), with the client's agreement recorded; **only administrators see answers and scores** (not the client, not family, never the IP); a score of 3 or more raises an administrator alert and texts the primary family member (no score or topic in any message), and the client gets a gentle message with 988/911; the client answers on Home with large buttons and read-aloud; "Not today" and pause/resume are allowed for the client side. Not built: reminders for missed check-ins, answering on the client's behalf, other instruments (PHQ-9 etc.). The standard wording ("over the last 2 weeks") is kept unchanged even when asked daily, so frequent use is outside how the tools were validated; they are a screening aid only.
- **Not decided / ask the counselor:** whether the state treats app photos or logs as required service records (which could argue for keeping photos longer than a year); whether any approved integration with the state's EVV exists.

- **Retention is fixed at ten years and is not configurable by anyone.** It is a built-in product rule (and a selling point), not a setting. Reason: the Illinois wage-claim window is ten years; payroll, pay-stub and leave records are three years; federal employment-tax records are about four to five. Not legal advice; confirm with the authorizing program. Research notes: Illinois Wage Payment and Collection Act, Minimum Wage Law and Paid Leave for All Workers Act (3 years), FLSA 29 CFR 516 (3 years payroll, 2 years time cards), IRS employment tax recordkeeping (4 years after the 4th-quarter filing), and the Home Services Program rule 89 Ill. Adm. Code 686.10 (the customer is the employer; no retention period stated there; a possible six-year program rule is unconfirmed).
- At ten years records are archived and compressed, not deleted by the app. Evidence photos get a shorter schedule (to be defined).

## Key invariants to keep

- `appendEvent` (per-household advisory lock, chain head found by "no successor") is the only writer of the audit log; nothing updates or deletes events.
- State changes use atomic `updateMany ... where state in [...]`; cap and shopping merges use row locks.
- IP responses go through allow-lists (`ip-dto.ts`); the IP never gets audit timestamps. A test pins the exact fields.
- Family sees status without times or photos unless `canViewTimestamps`; the server omits them, it does not just hide them.
- Corrections and attendance notes never change observed times or original events.
- Nothing is flagged as proven wrong; patterns say "may need a look".
- SMS/email text is kept free of personal details.

## Not built / next steps

1. **Deployment.** Plan: free tier for demos (Render + Neon + Cloudflare R2, with a `/internal/tick` endpoint for the cron), and **AWS with a signed BAA for real client data** (EC2/Fargate, RDS, S3 with Object Lock, SES, Secrets Manager). Needs an S3 evidence adapter (the one file to swap is `evidence-store.ts`), container setup, CORS locked to the real web address, HTTPS. Free hosts generally offer no HIPAA agreement. Confirm with compliance whether HIPAA applies.
2. **Real devices.** Camera, GPS and print/PDF have not been run on a phone or emulator; reading aloud has only been checked in a browser; no screen-reader (TalkBack/VoiceOver) pass.
3. **Push notifications** (everything polls today; urgent items are texted or emailed). Voice input and voice approvals on phones. True background location needs a native build with `expo-task-manager`.
4. **Retention follow-through:** the **archive-and-compress job** for records past ten years (move them to cheaper storage; never delete them in the app). Photos already have their fixed one-year removal. Also still open: step-up auth (PIN/biometric) and idle lock/session expiry for admin actions (spec asks for 5-minute lock, 30-minute session).
5. **Reports:** IP's own hours report, CSV export.
6. **Scheduling gaps:** weekly/monthly task distribution across visits; marking unresolved tasks missed at shift end and carrying them to an admin-approved later shift; requesting a task; family view of the shopping list; admin dashboard; flagging earlier shifts with a missing checkout on admin screens.
7. **Live providers:** SMTP and Twilio code paths have never run against real services.
8. **Rate limiter is per process** (in memory); needs a shared store or edge limiting if more than one server runs.
9. **Config items the spec lists** that still need real values: apartment coordinates/address, the program workweek, actual schedule, service-plan duties, account contacts, recurring task days and object/storage locations.

## Gotchas for whoever continues

- Stop the backend (the `tsx watch` process and its node child on port 4000, **never** the dev-db process) before `prisma generate`, or Windows locks the DLL.
- Migrations: `prisma migrate dev` refuses non-interactively here. Use `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`, write the SQL without a BOM into a new `migrations/<timestamp>_name/migration.sql`, then `migrate deploy` and `generate`.
- The Bash tool breaks on large heredocs with quotes; write files with the file tools or small node scripts.
- Tests share the dev database. A failed teardown leaves a throwaway household behind; delete by name prefix (`*-test`).
- Prisma `NOT (col IN (...))` drops rows where the column is NULL; count the held set directly instead. An empty filter object is not read as "everything".
- Order spoken or listed task output explicitly (template order); unordered queries gave inconsistent text once.
- The browser pane often cannot screenshot; verify with page text or DOM scripts. React Native Web inputs need the native value setter plus an `input` event to update.
- Dev DB name is `household_care`, encoding WIN1252 (keep dev text to characters that encoding accepts).

## Verification record (as of this snapshot)

- Backend: `tsc` clean; vitest 265 passed across 17 files, run repeatedly with no failures after the ordering fix.
- Mobile: `tsc` and `expo lint` clean; `npm run check:voice` passes 25 phrases; `expo export -p android` bundles.
- Browser walkthroughs done for: Home per role, Alerts flow (tap to acknowledge), Hear, Settings (name, phone code, password), Reports and print output, IP report -> admin correction -> IP sees reopened task.
