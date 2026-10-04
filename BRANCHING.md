# Branches and environments

Three long-lived branches, each matching an environment. Work moves one way: **development, then staging, then main**.

| Branch | Environment | Data | Who uses it |
|---|---|---|---|
| `development` | Local machines (embedded dev database, `npm run dev:db`) | Fake and demo data | Day-to-day building |
| `staging` | A hosted copy for checking before release | Fake data only, never real clients | Testing the whole app the way it will really run |
| `main` | Production | Real client data | The people who depend on it |

`main` always holds what is live (or ready to go live). If it is on `main`, it has already been through `staging`.

## Day-to-day flow

1. Start from `development` and make a short-lived branch for the work: `feature/<name>` for new things, `fix/<name>` for bugs (for example `feature/csv-export`).
2. Commit as you go. When it works, merge the branch into `development`.
3. When `development` has a set of changes you want to try for real, merge `development` into `staging`.
4. Check it on staging (see the checklist below). Only then merge `staging` into `main`.

```bash
git switch development
git switch -c feature/csv-export
# ...work and commit...
git switch development
git merge --no-ff feature/csv-export

git switch staging
git merge --no-ff development      # promote to staging

git switch main
git merge --no-ff staging          # release to production
git switch development
```

Merge with `--no-ff` so each promotion shows up as one clear step in the history. Never commit straight to `main` or `staging`, and never merge `main` or `staging` forward the wrong way except for the hotfix case below.

## Before promoting

- **development to staging:** the backend tests pass (`cd backend && npm test`), and `npx tsc --noEmit` and `npx expo lint` are clean in both `backend` and `mobile`.
- **staging to main:** everything above, plus the app has been tried end to end on staging (sign in as each role, a check-in, a task with a photo, a review, an alert, a report), the database migrations ran cleanly on staging, and `project_state.md` is up to date.

## Database changes

- A schema change always ships with its migration in `backend/prisma/migrations/` in the same commit.
- Migrations are applied in order on each environment (`prisma migrate deploy`) as the code reaches it: development first, then staging, then production.
- Never edit a migration that has already been applied anywhere. Add a new one.
- Take a backup of the production database before applying a migration to it.

## Configuration and secrets

- `.env` files are never committed. `backend/.env.example` and `mobile/.env.example` show what each environment needs.
- Each environment has its own database, its own `JWT_SECRET`, and its own messaging accounts. Staging must never use production's database or secrets, and must never message real people (leave the development outbox on, or use test accounts).
- Real client data lives only in production.

## Hotfixes

If production has a serious bug that cannot wait for the normal flow:

1. Branch from `main`: `git switch -c fix/<name> main`.
2. Fix it, test it, and merge it into `main`.
3. Merge `main` back into `staging` and then `development`, so the fix is not lost the next time they are promoted.

## When a remote is added

Right now the repository only exists on this computer. When it is pushed to GitHub, GitLab or similar, turn on branch protection for `main` and `staging`: require a pull request and passing checks, and forbid force-pushes and deletion. That is what actually stops direct commits; the rules above are the agreement until then.
