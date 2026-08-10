# Patient Notes

A phone-friendly selector for the Plaud → DrChrono note workflow. The provider taps today's
patient, and the note Plaud records uploads to the right chart automatically (via the Zap).

## How it works

1. The page loads **today's schedule** from DrChrono (`GET /api/today`) so the provider taps a
   name instead of typing it.
2. On confirm, the backend writes both `selected_patient_name` **and** `selected_patient_id`
   into Zapier Storage (`POST /api/select`).
3. The Zap reads those keys (Step 3) and uploads the Plaud note to that patient in DrChrono
   (Step 4). The patient ID gives an exact chart match, no name typing.

If the schedule can't load (or a patient isn't on it), searching a name still works as a
name-only fallback, matching the previous behavior.

## Patient search

`GET /api/patients/search?q=` asks DrChrono to do the matching (`/patients` filtered by
`first_name` / `last_name`, which are case-insensitive **prefix** matches) rather than keeping
a local copy of the roster to filter.

Do not reintroduce a full-roster crawl. The practice has 14,000+ charts, DrChrono serves
`/patients_summary` 50 at a time and ignores `page_size`, and the roster comes back
oldest-first — so any bounded crawl drops the **newest** patients silently, and an unbounded
one burns ~280 calls against a 500/hour limit. That combination is what previously made
recent patients unfindable and rate-limited the whole app.

## Run locally

```
npm install
cp .env.example .env   # fill in the DrChrono + Zapier values
npm start              # http://localhost:3000
```

## Deploy (Render)

Web service, Node runtime, `npm install` / `node server.js` (see `render.yaml`). Set the env
vars from `.env.example` in the Render dashboard.

## Notes on the DrChrono token

DrChrono rotates the refresh token on every refresh. The newest token is persisted to Zapier
Storage (`drchrono_refresh_token`) so restarts always use a fresh one. The
`DRCHRONO_REFRESH_TOKEN` env var is only the first-time seed.
