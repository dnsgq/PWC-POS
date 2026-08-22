# PWC Prints & Crafts POS

This is the production version of your POS app, connected to a real Supabase
database instead of temporary chat storage.

## What's in this folder

- `src/App.jsx` — the whole app (same features you already tested)
- `src/api.js` — talks to your Supabase database
- `src/supabaseClient.js` — connects using your project's URL/key
- `.env.example` — template for your Supabase credentials

## Step 1 — Put this code on GitHub

1. Go to github.com, click the **+** in the top right → **New repository**
2. Name it something like `pwc-pos`, keep it **Private**, click **Create repository**
3. On the next page, click **uploading an existing file**
4. Unzip the file I gave you, then drag *the contents of the folder* (not the
   zip itself, and not the folder — its contents) into the upload area
5. Scroll down, click **Commit changes**

## Step 2 — Add your Supabase credentials to Vercel (not GitHub)

Your Supabase URL and key should **never** be typed directly into a file you
upload to GitHub — instead, Vercel has a private place for them.

## Step 3 — Deploy on Vercel

1. Go to vercel.com, log in (you already connected it to GitHub earlier)
2. Click **Add New** → **Project**
3. Find and select your `pwc-pos` repository → **Import**
4. Before clicking Deploy, open **Environment Variables** and add two:
   - `VITE_SUPABASE_URL` → your Project URL (e.g. `https://uwanwjkfrdczrrbktclt.supabase.co`)
   - `VITE_SUPABASE_ANON_KEY` → your Publishable/anon key
5. Click **Deploy** and wait about a minute
6. You'll get a real web address like `pwc-pos.vercel.app` — that's the app,
   live, for anyone on your team to bookmark

## Step 4 — Turn on live sync (optional but recommended)

So that a transaction entered on one phone shows up instantly on another:

1. In Supabase, go to **Database** → **Replication**
2. Turn on replication for all four tables: `employees`, `attendance`,
   `transactions`, `closings`

## After deploying

Any time I make more changes to the app, I'll give you an updated file —
you'll re-upload it to the same GitHub repository (drag and drop again,
same steps as Step 1) and Vercel will automatically redeploy within a minute.

## If something goes wrong

- **Blank white page** → almost always means the two environment variables
  in Vercel are missing or misspelled. Double check `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` under Project → Settings → Environment Variables.
- **Login says PIN incorrect for everyone** → check the `employees` table in
  Supabase Table Editor still has Razel and Raquel's rows.
