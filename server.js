// RadianSolutions.com: serves the static pages in /public and a small API.
//   POST /api/request-document      -> any gated PDF (capability statement, PDL brochure, Financial Management brochure):
//                                      saves the lead, emails the visitor a confirmation with an expiring link (from info@),
//                                      emails info@ a lead alert, and returns a short-lived download link
//   POST /api/capability-statement  -> same as above for the capability statement (kept for older pages)
//   POST /api/contact               -> saves lead, emails confirmation + internal alert
//   GET  /download/:doc?v=...&exp=...&sig=...  -> serves the private PDF if the link is valid
//   GET  /healthz                   -> health check for Railway

import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PRIVATE_DIR = path.join(__dirname, "private");

// Every downloadable PDF lives in /private and is only served through a signed, expiring link.
// "black" = file shown with the dark theme, "blue" = file shown with the light theme.
const DOCS = {
  "capability-statement": {
    title: "capability statement", subject: "Your Radian Solutions capability statement",
    intro: "our two-page capability statement",
    files: { default: "Radian-Solutions-Capability-Statement.pdf" },
  },
  "pdl-brochure": {
    title: "PDL Support brochure", subject: "Your Radian Solutions PDL Support brochure",
    intro: "our Project Delivery Lifecycle (PDL) Support brochure",
    files: { black: "Project-Delivery-Lifecycle-Support-Black.pdf", blue: "Project-Delivery-Lifecycle-Support-Blue.pdf" },
  },
  "financial-management-brochure": {
    title: "Financial Management Services brochure", subject: "Your Radian Solutions Financial Management Services brochure",
    intro: "our Financial Management Services brochure",
    files: { black: "Financial-Management-Services-Black.pdf", blue: "Financial-Management-Services-Blue.pdf" },
  },
};
const pickVariant = (doc, theme) => (doc.files.default ? "default" : theme === "light" ? "blue" : "black");

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const SITE_URL = (env.SITE_URL || "https://www.radiansolutions.com").replace(/\/$/, "");
const FROM = env.FROM_EMAIL || "Radian Solutions <info@site.radiansolutions.com>";
const REPLY_TO = "info@radiansolutions.com";
const NOTIFY = env.LEAD_NOTIFY_EMAIL || "info@radiansolutions.com";
const SECRET = env.DOWNLOAD_SIGNING_SECRET || "";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
// Minimal Supabase REST (PostgREST) client for the web_leads table. It uses plain fetch, so it works on any Node 18+ and
// avoids the @supabase/supabase-js library, whose realtime part needs Node 22 and crashed the server on Railway's Node 20.
function makeLeadsClient(url, key) {
  const base = url.replace(/\/+$/, "") + "/rest/v1/web_leads";
  const baseHeaders = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) baseHeaders.Authorization = "Bearer " + key; // legacy JWT keys; new sb_secret_ keys use apikey only
  const q = encodeURIComponent;
  async function call(query, opts = {}) {
    try {
      const r = await fetch(base + query, { ...opts, headers: { ...baseHeaders, ...(opts.headers || {}) }, signal: AbortSignal.timeout(8000) });
      const text = await r.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok) return { error: { message: (body && (body.message || body.hint || body.error)) || `HTTP ${r.status}` }, data: null, headers: r.headers };
      return { error: null, data: body, headers: r.headers };
    } catch (e) { return { error: { message: e.message }, data: null, headers: null }; }
  }
  const json = (o) => JSON.stringify(o);
  return {
    find: (email, source) => call(`?select=id&email=eq.${q(email)}&source=eq.${q(source)}&limit=1`),
    insert: (row) => call("", { method: "POST", headers: { Prefer: "return=minimal" }, body: json(row) }),
    updateById: (id, patch) => call(`?id=eq.${q(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: json(patch) }),
    markEmailSent: (email, source) => call(`?email=eq.${q(email)}&source=eq.${q(source)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: json({ email_sent_at: new Date().toISOString() }) }),
    async count() {
      const r = await call("?select=id&limit=1", { headers: { Prefer: "count=exact" } });
      if (r.error) return { error: r.error, count: null };
      const m = (r.headers.get("content-range") || "").match(/\/(\d+)$/); return { error: null, count: m ? Number(m[1]) : null };
    },
  };
}
const sb = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? makeLeadsClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY) : null;

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy
app.disable("x-powered-by");

// ---------- small helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Every form on the site collects the same fields. Required: first name, last name, email, sector.
// Optional: title, company, comments. "source" is never read from the form: the server sets it from the endpoint / document id.
const SECTORS = ["Federal / DoD", "State government", "Local government / utility", "Prime contractor / teaming", "Private sector", "Other"];
function readLead(b) {
  const lead = {
    first_name: clean(b.first, 80), last_name: clean(b.last, 80), email: clean(b.email, 200).toLowerCase(),
    title: clean(b.title, 120) || null, company: clean(b.company, 160) || null,
    sector: clean(b.sector, 80), comments: clean(b.comments, 4000) || null,
  };
  const ok = lead.first_name && lead.last_name && EMAIL_RE.test(lead.email) && SECTORS.includes(lead.sector);
  return { lead, error: ok ? null : "Please complete all required fields: first name, last name, a valid email and your sector." };
}
const leadSummaryHtml = (l) =>
  `<p><strong>${esc(l.first_name)} ${esc(l.last_name)}</strong><br>Email: ${esc(l.email)}<br>Title: ${esc(l.title || "(none)")}<br>Company: ${esc(l.company || "(none)")}<br>Sector: ${esc(l.sector)}</p>`;

// Simple in-memory rate limit: 8 submissions per IP per 15 minutes.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 15 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now);
  hits.set(ip, list);
  return list.length > 8;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some((t) => now - t < 15 * 60 * 1000)) hits.delete(ip);
}, 10 * 60 * 1000).unref();

// Signed, expiring download links (HMAC). PDFs are never served from /public.
const b64 = (buf) => buf.toString("base64url");
function sign(docId, variant, exp) {
  return b64(crypto.createHmac("sha256", SECRET).update(`${docId}:${variant}:${exp}`).digest());
}
function signedPath(docId, variant, ttlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `/download/${docId}?v=${variant}&exp=${exp}&sig=${sign(docId, variant, exp)}`;
}
function validLink(docId, variant, exp, sig) {
  if (!SECRET || !DOCS[docId] || !DOCS[docId].files[variant] || !/^\d+$/.test(String(exp)) || typeof sig !== "string") return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const a = Buffer.from(sign(docId, variant, exp)), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function saveLead(row, dedupe) {
  if (!sb) return;
  try {
    if (dedupe) {
      const found = await sb.find(row.email, row.source);
      if (found.error) console.error("[leads] LOOKUP FAILED:", found.error.message);
      const id = found.data && found.data[0] && found.data[0].id;
      if (id) {
        const patch = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== ""));
        const up = await sb.updateById(id, { ...patch, last_requested_at: new Date().toISOString() });
        if (up.error) console.error("[leads] UPDATE FAILED:", up.error.message); else console.log(`[leads] updated existing lead source=${row.source}`);
        return;
      }
    }
    const ins = await sb.insert(row);
    if (ins.error) console.error("[leads] SAVE FAILED:", ins.error.message);
    else console.log(`[leads] saved source=${row.source}`);
  } catch (e) {
    console.error("[leads] SAVE ERROR:", e.message);
  }
}

const wrapHtml = (inner) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#0d253d;max-width:560px">${inner}
   <p style="margin-bottom:4px">Radian Solutions, LLC<br>717 K Street, Suite 403, Sacramento, CA 95814<br>(916) 602-1900 &middot; www.radiansolutions.com</p><p style="font-size:13px;color:#5d6c84;margin-top:0">You are receiving this message because you requested information or a document at radiansolutions.com. Reply to this email if you have a question.</p></div>`;


// ---------- API ----------
async function handleDocumentRequest(req, res, forcedDoc) {
  if (limited(req.ip)) return res.status(429).json({ ok: false, error: "Too many requests. Please try again later." });
  const b = req.body || {};
  if (clean(b.website, 200)) return res.json({ ok: true, downloadUrl: "/" }); // honeypot

  const docId = forcedDoc || clean(b.doc, 60);
  const doc = DOCS[docId];
  if (!doc) return res.status(422).json({ ok: false, error: "Unknown document." });
  const theme = clean(b.theme, 10) === "light" ? "light" : "dark";
  const variant = pickVariant(doc, theme);

  const { lead, error: leadError } = readLead(b);
  if (leadError) return res.status(422).json({ ok: false, error: leadError });
  const { first_name: first, last_name: last, email, title, company, sector, comments } = lead;
  if (!SECRET || !resend) return res.status(500).json({ ok: false, error: "The server is not fully configured yet. Please email info@radiansolutions.com." });

  // 1) Save the lead first, so it is never lost if email delivery fails.
  await saveLead({ source: docId, ...lead }, true);

  // 2) Confirmation to the visitor, from info@radiansolutions.com (link valid 7 days)
  const emailLink = SITE_URL + signedPath(docId, variant, 7 * 24 * 3600);
  const { data: sentData, error } = await resend.emails.send({
    from: FROM, to: [email], replyTo: REPLY_TO, subject: doc.subject,
    html: wrapHtml(`<p>Hi ${esc(first)},</p><p>Thanks for your interest in Radian Solutions. Here is ${doc.intro}:</p>
      <p><a href="${esc(emailLink)}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px">Download the ${esc(doc.title)} (PDF)</a></p>
      <p>This link works for 7 days. If you have a requirement in mind, just reply to this email. A real person will answer.</p>`),
    text: `Hi ${first},\n\nThanks for your interest in Radian Solutions. Download ${doc.intro} (link valid 7 days):\n${emailLink}\n\nIf you have a requirement in mind, just reply to this email.\n\nRadian Solutions, LLC\n717 K Street, Suite 403, Sacramento, CA 95814\n(916) 602-1900 | www.radiansolutions.com\n\nYou are receiving this message because you requested information or a document at radiansolutions.com.`,
    tags: [{ name: "source", value: docId }],
  });
  if (error) {
    console.error("[mail] confirmation FAILED:", JSON.stringify(error), `from="${FROM}"`);
    return res.status(502).json({ ok: false, error: "We could not send the confirmation email. Please check the address and try again." });
  }
  console.log(`[mail] confirmation accepted by Resend id=${sentData && sentData.id} doc=${docId} from="${FROM}"`);
  if (sb) await sb.markEmailSent(email, docId);

  // 3) Lead alert to info@radiansolutions.com (a failure here never blocks the visitor)
  const alert = await resend.emails.send({
    from: FROM, to: [NOTIFY], replyTo: email,
    subject: `New download: ${doc.title} (${company || sector})`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#0d253d">
      ${leadSummaryHtml(lead)}
      <p>Source: ${esc(docId)}<br>Document: ${esc(doc.title)}<br>Site theme: ${esc(theme)}</p>
      <p>Comments: ${comments ? esc(comments) : "(none)"}</p></div>`,
  });
  if (alert.error) console.error("[mail] lead alert FAILED:", JSON.stringify(alert.error));
  else console.log(`[mail] lead alert accepted by Resend id=${alert.data && alert.data.id} to=${NOTIFY}`);

  res.json({ ok: true, downloadUrl: signedPath(docId, variant, 3600) }); // on-screen link: 1 hour
}
app.post("/api/request-document", express.json({ limit: "20kb" }), (req, res) => handleDocumentRequest(req, res, null));
app.post("/api/capability-statement", express.json({ limit: "20kb" }), (req, res) => handleDocumentRequest(req, res, "capability-statement"));

app.post("/api/contact", express.json({ limit: "20kb" }), async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ ok: false, error: "Too many requests. Please try again later." });
  const b = req.body || {};
  if (clean(b.website, 200)) return res.json({ ok: true });
  const { lead, error: leadError } = readLead(b);
  if (leadError) return res.status(422).json({ ok: false, error: leadError });
  const { email, sector } = lead, first = lead.first_name, name = `${lead.first_name} ${lead.last_name}`, message = lead.comments || "(no comments)";
  if (!resend) return res.status(500).json({ ok: false, error: "The server is not fully configured yet. Please email info@radiansolutions.com." });

  await saveLead({ source: "contact-form", ...lead }, false);

  // 1) The message itself goes to info@radiansolutions.com. Replying to it replies to the visitor.
  const alert = await resend.emails.send({
    from: FROM, to: [NOTIFY], replyTo: email,
    subject: `Website message from ${name}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#0d253d">${leadSummaryHtml(lead)}<p>Source: contact-form</p><p style="white-space:pre-wrap">${esc(message)}</p></div>`,
    text: `${name} (${email})\nTitle: ${lead.title || "(none)"}\nCompany: ${lead.company || "(none)"}\nSector: ${sector}\nSource: contact-form\n\n${message}`,
    tags: [{ name: "source", value: "contact-form" }],
  });
  if (alert.error) {
    console.error("[mail] contact message to NOTIFY FAILED:", JSON.stringify(alert.error), `from="${FROM}" to="${NOTIFY}"`);
    return res.status(502).json({ ok: false, error: "We could not send your message. Please email info@radiansolutions.com." });
  }
  console.log(`[mail] contact message accepted by Resend id=${alert.data && alert.data.id} to=${NOTIFY}`);

  // 2) Confirmation to the visitor, from the verified sender (info@site.radiansolutions.com)
  const conf = await resend.emails.send({
    from: FROM, to: [email], replyTo: REPLY_TO, subject: "We got your message",
    html: wrapHtml(`<p>Hi ${esc(first)},</p><p>Thanks for reaching out. We received your message and a real person will reply soon. You can answer this email if you want to add anything.</p>`),
    text: `Hi ${first},\n\nThanks for reaching out. We received your message and a real person will reply soon. You can answer this email if you want to add anything.\n\nRadian Solutions, LLC\n717 K Street, Suite 403, Sacramento, CA 95814\n(916) 602-1900 | www.radiansolutions.com\n\nYou are receiving this message because you contacted us at radiansolutions.com.`,
    tags: [{ name: "source", value: "contact-form" }],
  });
  if (conf.error) console.error("[mail] contact confirmation FAILED:", JSON.stringify(conf.error), `from="${FROM}" to="${email}"`);
  else console.log(`[mail] contact confirmation accepted by Resend id=${conf.data && conf.data.id}`);
  res.json({ ok: true });
});

app.get("/download/:doc", (req, res) => {
  const docId = req.params.doc, variant = clean(req.query.v, 20) || "default";
  if (!validLink(docId, variant, req.query.exp, req.query.sig))
    return res.status(403).type("text/plain").send("This download link is invalid or has expired. Please request the document again from radiansolutions.com.");
  const file = path.join(PRIVATE_DIR, DOCS[docId].files[variant]);
  if (!fs.existsSync(file)) return res.status(404).type("text/plain").send("File not found.");
  res.setHeader("Cache-Control", "private, no-store");
  res.download(file, DOCS[docId].files[variant]);
});

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

// ---------- pages ----------
const security = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
};
app.use(security);

// Old OASIS+ URLs now point to the merged page.
// Short, shareable addresses for the NASA SEWP VI contract-holder page
app.get(["/sewp", "/nasa-sewp", "/nasa-sewp-vi", "/sewp-vi"], (req, res) => res.redirect(301, "/contracts/nasa-sewp-vi"));
app.get(["/light/sewp", "/light/nasa-sewp", "/light/nasa-sewp-vi", "/light/sewp-vi"], (req, res) => res.redirect(301, "/light/contracts/nasa-sewp-vi"));
app.get(["/contracts/oasis-plus-small-business", "/contracts/oasis-plus-hubzone", "/light/contracts/oasis-plus-small-business", "/light/contracts/oasis-plus-hubzone"], (req, res) =>
  res.redirect(301, req.path.startsWith("/light") ? "/light/contracts/oasis-plus" : "/contracts/oasis-plus"));

// /join-us (both themes) gets the Ceipal URL injected at request time.
app.get(["/join-us", "/join-us.html", "/light/join-us", "/light/join-us.html"], (req, res) => {
  const url = env.CEIPAL_CAREER_URL && /^https:\/\//.test(env.CEIPAL_CAREER_URL) ? env.CEIPAL_CAREER_URL : "";
  const file = req.path.startsWith("/light") ? path.join(PUBLIC_DIR, "light", "join-us.html") : path.join(PUBLIC_DIR, "join-us.html");
  res.type("html").send(fs.readFileSync(file, "utf8").replace("__CEIPAL_URL__", esc(url)));
});

// Client logos: /logos/<slug> serves public/assets/clients/<slug>.(svg|png|webp|jpg|gif), whichever file exists.
// If none exists the Home page shows the client's name as text instead.
const LOGO_DIR = path.join(PUBLIC_DIR, "assets", "clients");
app.get("/logos/:slug", (req, res) => {
  const slug = String(req.params.slug || "");
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return res.status(404).end();
  for (const ext of ["svg", "png", "webp", "jpg", "gif"]) {
    const f = path.join(LOGO_DIR, `${slug}.${ext}`);
    if (fs.existsSync(f)) { res.setHeader("Cache-Control", "no-cache"); return res.sendFile(f); } // browsers re-check each time (cheap 304), so a replaced logo shows up immediately
  }
  res.status(404).end();
});

app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: "1h", index: "index.html" }));

app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html")));

app.listen(PORT, () => {
  console.log(`RadianSolutions.com listening on ${PORT}`);
  console.log(`[config] resend_key=${!!env.RESEND_API_KEY} signing_secret=${!!SECRET} supabase=${!!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)} ceipal_url=${!!env.CEIPAL_CAREER_URL} from="${FROM}" notify="${NOTIFY}" site_url="${SITE_URL}"`);
  if (sb) {
    const probe = async (label) => {
      const { error, count } = await sb.count();
      if (error) console.error(`[leads] database check FAILED (${label}): ${error.message}  -> leads are NOT being saved. Check SUPABASE_URL, the service role key, that the web_leads table exists, and that the project is not paused.`);
      else console.log(`[leads] database check OK (${label}): web_leads reachable, ${count} rows`);
    };
    probe("startup");
    setInterval(() => probe("daily keep-alive"), 12 * 60 * 60 * 1000).unref();
  } else console.log("[leads] database NOT configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or leads will not be saved");
});
