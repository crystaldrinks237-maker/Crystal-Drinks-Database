# Deploying Crystal Drinks to Render + Neon (free, public link)

This gets you a real `https://something.onrender.com` link that works from
any phone or computer with internet - no Wi-Fi requirement, no laptop that
has to stay on. Two free accounts, no credit card for either.

- **Render** runs the app itself (the Node.js server).
- **Neon** hosts the database (PostgreSQL) - kept separate from Render
  because Render's own free database deletes itself after 30 days; Neon's
  free tier doesn't expire.

Both have a small "wake up" delay after sitting unused for a while (more on
that at the end) - that's the only real trade-off versus a paid plan.

---

## 1. Put the code on GitHub

Render deploys by connecting to a GitHub repository.

1. Create a free GitHub account if you don't have one: https://github.com/signup
2. Create a new, empty repository (e.g. `crystal-drinks`) - keep it **private**
   if you'd rather your code not be public (Render's free tier works fine
   with private repos).
3. Upload this project folder to that repository. The simplest way if you're
   not familiar with git commands: on the repository's GitHub page, use
   "Add file > Upload files" and drag in everything **except** the
   `node_modules` folder (it isn't needed - Render installs dependencies
   itself) and your local `.env` file if you made one (it's already listed
   in `.gitignore` so a normal `git push` would skip it automatically, but
   double-check it isn't uploaded manually).

## 2. Create your database on Neon

1. Sign up free at https://neon.tech (no card required).
2. Create a new project - any name is fine (e.g. "crystal-drinks").
3. On the project's dashboard, find the **Connection string** (sometimes
   under "Connection Details"). Copy it - it looks like:
   ```
   postgresql://your_user:your_password@ep-something.region.aws.neon.tech/neondb?sslmode=require
   ```
   Keep this tab open, or paste it somewhere safe - you'll need it in the next step.

## 3. Create the web service on Render

1. Sign up free at https://render.com (no card required for the free tier).
2. Click **New > Web Service**.
3. Connect your GitHub account and select the repository you created in step 1.
4. Fill in:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Before clicking create, scroll to **Environment Variables** and add:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | paste the Neon connection string from step 2 |
   | `SESSION_SECRET` | any long random string - see note below |

   To generate a good `SESSION_SECRET`, run this on your own computer (with
   Node installed) and paste the result:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   (If you skip this, the app still works, but everyone gets logged out
   whenever Render restarts the app - see the note on sleeping below.)

6. Click **Create Web Service**. Render will install dependencies and start
   the app - watch the logs on screen. The first successful start will show:
   ```
   Created default admin account -> username: admin | password: admin123
   ```
   That confirms the database connected and set itself up correctly.

## 4. Log in and lock it down

1. Open the URL Render gives you (something like `https://crystal-drinks-xxxx.onrender.com`).
2. Log in with `admin` / `admin123`.
3. **Immediately** go to Settings and change that password - this app is now
   reachable by anyone on the internet who finds or guesses the link, not
   just people on your Wi-Fi.
4. Set up your worker accounts, bottle types/qualities, and company details
   as usual (see the main `README.md` for day-to-day use - all of that stays
   the same regardless of where it's hosted).

## 5. Bringing across data from the old local version (optional)

If you already entered real data using the local (laptop + SQLite) version,
you don't have to start over:

1. Find your old project's `data/crystal-drinks.db` file (from the earlier,
   local version of this app) and copy it into **this** project's `data/`
   folder (creating that folder if it isn't there), so the path
   `data/crystal-drinks.db` exists inside this newer project.
2. In this project's folder, run:
   ```
   node scripts/export-sqlite-data.js
   ```
   This creates `sqlite-export.json` alongside it.
3. Create a `.env` file in this project (copy `.env.example`) and set
   `DATABASE_URL` to the **same** Neon connection string you used in step 2 above.
4. Run:
   ```
   node scripts/import-to-postgres.js
   ```
   This connects straight to your Neon database over the internet and loads
   your old data into it, replacing the auto-created defaults. You don't
   need Render running for this step - just this project's folder, Node,
   and internet.
5. Reload the Render URL - your real data should now appear.

## What "a few seconds wait" actually means

Both free tiers sleep when nobody's used them for a while, to stay free:

- **Render**: sleeps after ~15 minutes of no traffic. The next visit takes
  roughly **30-60 seconds** to wake up (you'll just see a loading browser
  tab during that time), then it's fast again until it goes idle once more.
- **Neon**: sleeps after ~5 minutes of no queries, but wakes up much faster
  (usually under a couple of seconds) - you likely won't even notice this one.

Worst case (both asleep at once, e.g. first thing in the morning), the very
first page load might take close to a minute. Every load after that, until
it goes idle again, is normal speed.

## Updating the app later

Whenever you (or I) change the code, push the updated files to the same
GitHub repository - Render automatically rebuilds and redeploys within a
minute or two. Any database changes are applied automatically on startup,
same as the local version - no manual migration step.
