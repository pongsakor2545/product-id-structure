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
WebSockets (needed for real-time sync) and has a managed Postgres add-on —
many "serverless" hosts don't support persistent WebSocket connections.

1. Push this `app/` folder to a GitHub repository.
2. Go to [render.com](https://render.com), sign up, click **New → Blueprint**,
   and point it at your repository. Render reads `render.yaml` in this folder
   and sets up both the web service and the Postgres database automatically.
3. Once created, go to the web service's **Environment** tab and add
   `GOOGLE_SERVICE_ACCOUNT_JSON` if you want the export feature (see above).
   `DATABASE_URL` is already wired up by the blueprint.
4. After the first successful deploy, open a one-off shell for the service
   (Render dashboard → your service → **Shell**) and run
   `node scripts/seedDemo.js` once to create a starting sheet (skip this if
   you'd rather start from a completely empty structure — the app also
   auto-creates one empty sheet on first load if none exist).
5. Your app is now live at `https://<your-service-name>.onrender.com`.

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
- **Images are stored as base64 in Postgres** — fine for moderate use; if
  image uploads become heavy, move them to S3-compatible storage
  (Cloudflare R2, Backblaze B2) and store just a URL instead.
- **Conflict handling is last-writer-wins** at the field level — two people
  editing the exact same field at the exact same moment will have one edit
  win; this matches how the app has behaved throughout this project.
- The Excel/CSV download button only exports what's currently loaded/expanded
  in the browser (by design, given the scale — loading the whole taxonomy
  into one browser tab isn't practical past a certain size). The **Export to
  Google Sheet** button, by contrast, exports the *entire* sheet's data
  server-side regardless of what's currently expanded in your browser.
