# Product ID Structure

A real-time collaborative product-category tree (list view + mindmap view),
built for large taxonomies (tens of thousands to hundreds of thousands of
categories). Node.js + Express + WebSocket + PostgreSQL backend, with an
optional one-way export to Google Sheets for reporting.

## What changed from the earlier prototype

The first version of this app was a Claude Artifact (browser-only, backed by
the Artifact platform's own `db`/`room` capabilities). That's fine for a
mockup but can't be hosted on your own domain and can't hold the amount of
data you described. This version is a normal Node.js web app you run and
deploy yourself, with:

- **PostgreSQL** as the real datastore (no size ceiling like the Artifact's
  256 KiB-per-document limit).
- **Lazy loading**: the tree fetches only root categories up front, then a
  node's children only when you expand it — needed once you're past a few
  thousand nodes.
- **Search**: type a name to jump straight to it (essential once there are
  more nodes than you can scroll through).
- **A real WebSocket** for live collaboration between everyone with the link.
- **Export to Google Sheets** as a one-way "push current data out" button —
  Sheets itself is not fast enough to be the live datastore at this scale
  (see the note in the top-level conversation for why).

## Local development

1. Install Node.js 18+ and a PostgreSQL server (or use a free hosted one —
   see [Deploying](#deploying) below, the same connection string works
   locally too).
2. `cd app && npm install`
3. Copy `.env.example` to `.env` and fill in `DATABASE_URL`.
4. `npm run seed:demo` — creates one sheet with a small example taxonomy so
   the app isn't empty on first load. (Optional: `npm run seed:bulk -- 50000`
   creates a 50,000-node sheet if you want to see how it behaves at the scale
   you described.)
5. `npm run dev` — starts the server with auto-reload on file changes.
6. Open `http://localhost:3000`.

Open the same URL in a second browser tab/window to see real-time sync in
action.

## Google Sheets export setup (optional)

The "ส่งออกไป Sheet" button needs a Google **service account** — a robot
account your server authenticates as, separate from your own Google login.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   create a project (or use an existing one).
2. In **APIs & Services → Library**, search for **Google Sheets API** and
   click **Enable**.
3. In **APIs & Services → Credentials**, click **Create Credentials →
   Service account**. Give it any name, skip the optional role/access steps.
4. Open the service account you just created → **Keys** tab → **Add Key →
   Create new key → JSON**. This downloads a `.json` file — keep it private,
   it's a credential.
5. Open that JSON file, copy its **entire contents as one line**, and set it
   as the `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable (in `.env`
   locally, or in your host's environment variable settings once deployed).
6. In the JSON file, find the `"client_email"` field (looks like
   `something@your-project.iam.gserviceaccount.com`). Open the actual Google
   Sheet you want to export to, click **Share**, and share it with that email
   address as **Editor**.
7. In the app, click **ส่งออกไป Sheet**, paste the Sheet's URL (or just its
   ID from the URL), and submit.

Without this env var set, the export button will show a clear error instead
of silently failing.

## Deploying (Render.com)

Render is used here because it supports a long-running Node process with
WebSockets (needed for real-time sync) — many "serverless" hosts don't
support persistent WebSocket connections. The database itself is Supabase
(see below), not Render's own Postgres add-on.

1. Push this `app/` folder to a GitHub repository.
2. Go to [render.com](https://render.com), sign up, click **New → Blueprint**,
   and point it at your repository. Render reads `render.yaml` and sets up
   the web service (free plan) — it does not create its own database.
3. Once created, go to the web service's **Environment** tab and set:
   - `DATABASE_URL` — your Supabase connection string (see
     [Using Supabase](#using-supabase-instead-of-renders-built-in-postgres) below).
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — needed for image
     uploads (see [Image storage](#image-storage-supabase-storage) below).
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — only if you want the Sheets export
     feature (see above).
4. After the first successful deploy, open a one-off shell for the service
   (Render dashboard → your service → **Shell**) and run
   `node scripts/seedDemo.js` once to create a starting sheet (skip this if
   you'd rather start from a completely empty structure — the app also
   auto-creates one empty sheet on first load if none exist).
5. Your app is now live at `https://<your-service-name>.onrender.com`.

### Using Supabase instead of Render's built-in Postgres

The app just needs any standard PostgreSQL connection string in
`DATABASE_URL` — Supabase's database is regular Postgres underneath, so it
works with zero code changes.

Supabase's **free plan allows 2 active projects per account** (paused
projects don't count against that, and free projects auto-pause after a week
of inactivity). If your existing account is already at that limit, a second,
separate Supabase account for this project is a reasonable way around it —
and since accounts are fully isolated from each other, creating a new one
has **no effect whatsoever** on your existing projects or their data; nothing
is shared or freed up between accounts.

To use Supabase as the database:
1. At [supabase.com](https://supabase.com), create a project (on whichever
   account you choose).
2. Click **Connect** on the project dashboard, choose the **Session pooler**
   connection string (IPv4-compatible — needed since Render doesn't support
   outbound IPv6) — it looks like
   `postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with the database password you set when creating
   the project.
3. Paste that full string as `DATABASE_URL` on the web service in Render's
   **Environment** tab.
4. Redeploy. The app creates its tables automatically on first boot (see
   `server/db.js`), so no manual schema setup is needed in Supabase.

### Image storage (Supabase Storage)

Product images are uploaded to **Supabase Storage**, not the database, so
they use the separate (and larger) 1 GB free-tier "file storage" quota
instead of the 500 MB "database size" quota — important once you're
uploading a lot of product photos.

1. In your Supabase project dashboard, go to **Project Settings → API**.
2. Copy the **Project URL** → set it as `SUPABASE_URL`.
3. Copy the **`service_role`** secret key (not the `anon` key — it needs
   write access to create the storage bucket and upload files) → set it as
   `SUPABASE_SERVICE_ROLE_KEY`.
4. Set both as environment variables (in `.env` locally, or Render's
   **Environment** tab once deployed) and restart/redeploy. The app
   automatically creates a public `product-images` bucket on first boot —
   no manual bucket setup needed.

Without these two variables set, the app still runs fine — image uploads
will just show a clear error until they're configured.

### Pointing your own domain at it

1. Buy a domain if you don't have one — [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/)
   sells at cost (no markup), or use any registrar you like (Namecheap,
   Google Domains successors, etc.).
2. In the Render dashboard, open your web service → **Settings → Custom
   Domains → Add Custom Domain**, and enter your domain (e.g.
   `products.yourcompany.com` or the bare domain).
3. Render shows you a DNS record to add (a `CNAME` for a subdomain, or an
   `A`/`ALIAS` record for a bare domain). Add that record in your domain
   registrar's DNS settings.
4. Wait for DNS to propagate (usually minutes, sometimes up to a few hours).
   Render automatically issues a free HTTPS certificate once it verifies the
   domain.

## Known limitations / good next steps

- **No login** — anyone with the link can view and edit everything, matching
  "anyone with the link" from the original request. Add an auth layer if
  that's ever a concern (e.g. a shared password gate, or real accounts).
- **Images are stored in Supabase Storage** (see
  [Image storage](#image-storage-supabase-storage) above), with just the
  public URL kept in Postgres — scales to a large number of product photos
  without touching the smaller database-size quota.
- **Conflict handling is last-writer-wins** at the field level — two people
  editing the exact same field at the exact same moment will have one edit
  win; this matches how the app has behaved throughout this project.
- The Excel/CSV download button only exports what's currently loaded/expanded
  in the browser (by design, given the scale — loading the whole taxonomy
  into one browser tab isn't practical past a certain size). The **Export to
  Google Sheet** button, by contrast, exports the *entire* sheet's data
  server-side regardless of what's currently expanded in your browser.
