# RadianSolutions.com

Static site (plain HTML in `public/`) plus a small Node server (`server.js`) for:
- the **contact form** on the home page,
- the **gated capability statement** (form -> saved lead -> emailed, expiring download link),
- the **Ceipal job board** on `/join-us`.

Leads are saved to the Supabase project **RadianSolutions**, table `web_leads`. Emails go out through **Resend** from `info@radiansolutions.com`.

## Dark / Light toggle

Every page has a small **Dark | Light** switch in the bottom-right corner. Dark is the default. The visitor's choice is remembered in their browser (`localStorage`, key `rs-theme`) and applied on every page.

- Dark pages live in `public/` (for example `/solutions`).
- Light pages live in `public/light/` (for example `/light/solutions`) and carry a `canonical` link to the dark URL so search engines index one version.
- Both themes share `public/assets/`, the same API routes and the same private PDF.
- When you change text on a page, change it in **both** `public/<page>.html` and `public/light/<page>.html`.

## Downloadable PDFs and confirmation emails (Resend)

Every PDF on the site is gated by a short form (first name, last name, email, title, company, optional comments). When a visitor submits it:

1. the lead is saved to Supabase (`web_leads`, `source` = the document),
2. **the visitor gets an email from `info@radiansolutions.com`** with an expiring download link (7 days),
3. **`info@radiansolutions.com` gets an alert email** with the visitor's details and which document they requested,
4. the visitor also sees a download button on screen (link valid 1 hour).

| Document | Request page (dark / light) | File in `private/` |
|---|---|---|
| Capability statement | `/capability-statement`, `/light/capability-statement` | `Radian-Solutions-Capability-Statement.pdf` |
| PDL Support brochure | `/get/pdl-brochure`, `/light/get/pdl-brochure` | `Project-Delivery-Lifecycle-Support-Black.pdf` (dark), `...-Blue.pdf` (light) |
| Financial Management brochure | `/get/financial-management-brochure`, `/light/get/financial-management-brochure` | `Financial-Management-Services-Black.pdf` (dark), `...-Blue.pdf` (light) |

The PDFs are not in `public/`, so there is no direct link to them. To add or replace a PDF: put it in `private/`, add an entry to `DOCS` in `server.js`, and copy one of the `public/get/*.html` pages (and its `light/` twin) for the request page.

**Resend setup (once):** create an API key in Resend, verify the domain `radiansolutions.com` (Domains > Add domain, add the DNS records), then set `RESEND_API_KEY` in Railway. Until the domain shows **Verified**, sends from `info@radiansolutions.com` are rejected and visitors see an error. `FROM_EMAIL` (optional) overrides the sender; `LEAD_NOTIFY_EMAIL` changes where the alert goes.

## Pages

| URL | File |
|---|---|
| `/` | `public/index.html` |
| `/solutions` | `public/solutions.html` |
| `/federal-defense`, `/state-local` | `public/federal-defense.html`, `public/state-local.html` |
| `/about`, `/join-us`, `/capability-statement` | `public/about.html`, `public/join-us.html`, `public/capability-statement.html` |
| `/contracts/cmas`, `/contracts/tddc-it-msa`, `/contracts/oasis-plus-small-business`, `/contracts/oasis-plus-hubzone`, `/contracts/mda-shield`, `/contracts/nasa-sewp-vi` | `public/contracts/*.html` |

The capability statement PDF lives in `private/` (not in `public/`), so it can only be downloaded through a signed link.
To replace it, overwrite `private/Radian-Solutions-Capability-Statement.pdf` and deploy.

## Deploy on Railway (one time)

1. Create a GitHub repo and push this folder (`git init`, `git add .`, `git commit`, `git push`).
2. Railway dashboard > **New Project** > **Deploy from GitHub repo** > pick the repo. Railway detects Node and uses `railway.json`.
3. Service > **Variables**: add everything in `.env.example` (see below).
4. Service > **Settings > Networking**: **Generate Domain** to test, then **Custom Domain**: add `www.radiansolutions.com`. Railway shows a CNAME record. Add it at your DNS provider.
   For the bare domain `radiansolutions.com`, set a redirect to `https://www.radiansolutions.com` at your DNS/registrar (or add it as a second Railway custom domain if your DNS supports ALIAS/ANAME).
5. Open `https://<your-domain>/healthz`. It should say `ok`.

### Variables

| Variable | What it is |
|---|---|
| `RESEND_API_KEY` | Resend API key |
| `SUPABASE_URL` | `https://imougnqdcbwrhncsavvh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase > Project Settings > API > `service_role` key. Server only. |
| `DOWNLOAD_SIGNING_SECRET` | Random 32+ byte string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SITE_URL` | `https://www.radiansolutions.com` |
| `LEAD_NOTIFY_EMAIL` | Where lead alerts go. Default `info@radiansolutions.com`. |
| `CEIPAL_CAREER_URL` | Your Ceipal career portal URL (https). Shown in an iframe on `/join-us`. |

### Resend domain

In Resend > **Domains** > add `radiansolutions.com`, add the DNS records it shows (SPF/DKIM), and wait for **Verified**. Until then, sends from `info@radiansolutions.com` will be rejected.
If the Ceipal portal refuses to load in an iframe, ask Ceipal to allow `radiansolutions.com` as an embedding domain.

## Making changes later

- **Edit text or a page:** change the HTML in `public/`, commit and push. Railway redeploys automatically in about a minute.
- **See changes locally:** `npm install`, then `npm run dev`, open `http://localhost:3000`.
- **Roll back:** Railway > Deployments > pick an older deployment > Redeploy.
- **Bigger redesigns:** the pages are generated from the design, so you can also ask Claude to update the design and re-export this folder.
- **Leads:** Supabase dashboard > Table editor > `web_leads` (statuses: new, contacted, qualified, closed).

## Notes

- The in-memory rate limit (8 requests per IP per 15 minutes) resets on every deploy. For heavy traffic, add Cloudflare in front of the domain.
- Free Supabase projects pause after about a week of inactivity. Use the Pro plan for production, or leads will fail to save (the visitor still gets their email).
