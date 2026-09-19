# Streamlist

A personal, single-user movie tracker: tell it which streaming services you
actually pay for and get a **weekly email** with two things — new horror
movies that just became available, and an AI-scored top 10 horror picks
currently streaming, with anything you've already seen (per your Letterboxd
import) grayed out but still shown.

No push notifications, no app to keep open, no computer that has to stay
on — the weekly email is sent by a free GitHub Actions schedule, and your
data lives in a small hosted Supabase database instead of a local file.

## Stack

- **Data:** Supabase (hosted Postgres, free tier)
- **Movie data & streaming availability:** [TMDb API](https://www.themoviedb.org/documentation/api) (free)
- **Email:** [Resend](https://resend.com) (free tier: 100/day, 3,000/month — a weekly email uses almost none of that)
- **Weekly schedule:** GitHub Actions (free for public and most personal-use private repos)
- **The web app** (for managing your list/services locally): Node/Express — optionally deployable to Netlify later, but works fine run locally with `npm start` since you only need it when you're actually curating your list

## Setup

### 1. Install

```bash
npm install
```

### 2. TMDb (movie data)

1. Create a free account at https://www.themoviedb.org
2. Settings → API → request a key (choose "Developer" / personal use)
3. Copy the "API Key (v3 auth)"

### 3. Supabase (your database)

1. Create a free project at https://supabase.com
2. In the project, go to the **SQL Editor** → New query → paste in the contents of
   [`supabase/schema.sql`](./supabase/schema.sql) → Run. This creates all four tables
   and seeds a starter list of streaming services.
3. Go to **Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** secret key → `SUPABASE_SERVICE_ROLE_KEY` (not the `anon` key — the
     service role key is what lets the server/script bypass row-level security; it never
     goes anywhere near the browser)

### 4. Resend (the email itself)

1. Create a free account at https://resend.com
2. Settings → API Keys → create one → copy it
3. Set `DIGEST_TO_EMAIL` to the same email address you signed up to Resend with — without
   verifying your own domain, Resend's shared sending address can only deliver to your own
   account's email, which is all this app needs anyway. (You can verify a custom domain
   later, under Resend → Domains, if you want a nicer "from" name.)

### 5. Configure

```bash
cp .env.example .env
```

Fill in the five values from steps 2–4 (`TMDB_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `DIGEST_TO_EMAIL`).

### 6. Run the app locally, build your list

```bash
npm start
```

Open http://localhost:3000. In **Settings**, check off the streaming services
you actually have, then import your Letterboxd export (Letterboxd → Settings
→ Import & Export → Export Your Data → unzip the .zip). Upload `ratings.csv`,
`watched.csv`, or `diary.csv` as **"I've watched these"** — that's what
powers the gray-out-if-already-seen behavior in the top 10. Separately,
upload `watchlist.csv` as **"I want to watch these"** if you want those
tracked in My List too.

You only need this running while you're actively managing your list — it
doesn't need to stay on for the weekly email to work.

### 7. Wire up the weekly email (GitHub Actions)

1. Push this project to a GitHub repo (private is fine).
2. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**,
   and add each of these as a separate secret:
   - `TMDB_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `RESEND_API_KEY`
   - `DIGEST_TO_EMAIL`
   - `DIGEST_FROM_EMAIL` (optional — only if you set a custom one)
3. That's it — [`.github/workflows/weekly-digest.yml`](./.github/workflows/weekly-digest.yml)
   is already set up to run every **Monday at 13:00 UTC** (~9am US Eastern). Edit the cron
   line in that file if you want a different day/time — [crontab.guru](https://crontab.guru)
   is handy for building the expression.

To test it without waiting for Monday: in the repo's **Actions** tab, click into
"Weekly horror digest" → **Run workflow** → Run workflow. That fires it on demand.

You can also test end-to-end from the local app: **Settings → "Send me this
week's digest now."** Same code path as the scheduled run.

## How the two email sections work

**New horror this week:** each run asks TMDb for every horror movie currently
streaming (subscription or free/ad-supported — not rent/buy) on your
selected services, and compares that list against everything it's seen in
previous runs (stored in the `horror_seen` table). Anything not seen before
goes in this section. Once a title has been reported, it won't be reported
again even if it temporarily drops off and comes back later — a deliberate
simplification to avoid re-notifying you about the same movie. "New" means
new-to-you since the last run, so with a weekly cadence you might hear about
something a few days after it technically went up — a fine tradeoff for a
once-a-week email.

**Top 10 horror streaming now:** this is a ranked, evergreen list — not
limited to what's new — of the best-reviewed horror movies currently on your
selected services. It uses the same "weighted rating" formula behind IMDb's
Top 250: a title's TMDb rating is pulled toward the pool's average the fewer
votes it has, so a movie with a 9.0 from 40 votes doesn't outrank one with a
7.8 from 20,000 — reasonably confident quality over raw popularity, no LLM
call required. Titles you've marked "watched" via Letterboxd import still
appear (so you can see they made the cut) but are shown grayed out.

**Your liked-list availability** is still tracked (so **My List** in the app
shows accurate "streaming now" badges, refreshed on the same weekly run) —
it's just no longer a separate email section, since the top 10 replaced it.

## A few intentional limits (draft scope)

- **Single user, no login.** Nothing here has auth. The Supabase service role
  key and Resend/TMDb keys only ever live in your `.env` file and GitHub
  Actions secrets — never in frontend code — so this is safe as long as you
  don't deploy the web UI somewhere public without adding real auth first.
- **"Available" means subscription or free/ad-supported**, not rent/buy —
  change the `flatrate`/`free`/`ads` filter in `tmdb.js` if you want rent/buy
  included too.
- **Letterboxd matching is best-effort** — it takes TMDb's top search result
  per title+year. Worth a skim through **My List** after a big import.
- **Letterboxd's own API isn't used** — they explicitly don't grant API
  access for personal/recommendation projects like this one, even to Pro/Patron
  accounts, so CSV export/import is the actual supported path in.
- **Horror is currently hardcoded** as the digest genre (TMDb genre id 27).
  If you want other genres later, `tmdb.discoverHorrorOnProviders` in
  `tmdb.js` is a good starting point to generalize.

## Project structure

```
server.js                    Express app — local UI for managing your list/services
checker.js                    Horror discovery diff + top-10 quality ranking + liked-list refresh
email.js                       Builds and sends the digest via Resend
db.js                          Supabase client
tmdb.js                        TMDb API wrapper (search, watch providers, horror discovery)
scripts/weekly-digest.js       The script GitHub Actions (and "npm run digest") runs
supabase/schema.sql            Run once in the Supabase SQL Editor to set up your database
.github/workflows/weekly-digest.yml   The weekly schedule
public/
  index.html                   The UI (My List / Add Movies / Settings tabs)
  app.js                        Frontend logic
  styles.css                    Dark, Letterboxd-inspired styling
```
