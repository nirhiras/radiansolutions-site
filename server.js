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
import { createClient } from "@supabase/supabase-js";

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
const FROM = env.FROM_EMAIL || "Radian Solutions <info@radiansolutions.com>";
const REPLY_TO = "info@radiansolutions.com";
const NOTIFY = env.LEAD_NOTIFY_EMAIL || "info@radiansolutions.com";
const SECRET = env.DOWNLOAD_SIGNING_SECRET || "";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const supabase =
  env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy
app.disable("x-powered-by");

// ---------- small helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

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
  if (!supabase) return;
  try {
    if (dedupe) {
      const { data } = await supabase.from("web_leads").select("id").eq("email", row.email).eq("source", row.source).maybeSingle();
      if (data) {
        await supabase.from("web_leads").update({ ...row, last_requested_at: new Date().toISOString() }).eq("id", data.id);
        return;
      }
    }
    const { error } = await supabase.from("web_leads").insert(row);
    if (error) console.error("Supabase insert failed:", error.message);
  } catch (e) {
    console.error("Supabase error:", e.message);
  }
}

const wrapHtml = (inner) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#0d253d;max-width:560px">${inner}
   <p>Radian Solutions<br>Sacramento, CA<br>(916) 602-1900 &middot; www.radiansolutions.com</p></div>`;

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

  const first = clean(b.first, 80), last = clean(b.last, 80), title = clean(b.title, 120), company = clean(b.company, 160);
  const email = clean(b.email, 200).toLowerCase(), comments = clean(b.comments, 2000);
  if (!first || !last || !title || !company || !EMAIL_RE.test(email))
    return res.status(422).json({ ok: false, error: "Please complete all required fields." });
  if (!SECRET || !resend) return res.status(500).json({ ok: false, error: "The server is not fully configured yet. Please email info@radiansolutions.com." });

  // 1) Save the lead first, so it is never lost if email delivery fails.
  await saveLead({ source: docId, first_name: first, last_name: last, email, title, company, comments: comments || null }, true);

  // 2) Confirmation to the visitor, from info@radiansolutions.com (link valid 7 days)
  const emailLink = SITE_URL + signedPath(docId, variant, 7 * 24 * 3600);
  const { error } = await resend.emails.send({
    from: FROM, to: [email], replyTo: REPLY_TO, subject: doc.subject,
    html: wrapHtml(`<p>Hi ${esc(first)},</p><p>Thanks for your interest in Radian Solutions. Here is ${doc.intro}:</p>
      <p><a href="${esc(emailLink)}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px">Download the ${esc(doc.title)} (PDF)</a></p>
      <p>This link works for 7 days. If you have a requirement in mind, just reply to this email. A real person will answer.</p>`),
    text: `Hi ${first},\n\nThanks for your interest in Radian Solutions. Download ${doc.intro} (link valid 7 days):\n${emailLink}\n\nIf you have a requirement in mind, just reply to this email.\n\nRadian Solutions\nSacramento, CA\n(916) 602-1900 | www.radiansolutions.com`,
    tags: [{ name: "source", value: docId }],
  });
  if (error) {
    console.error("Resend confirmation failed:", error);
    return res.status(502).json({ ok: false, error: "We could not send the confirmation email. Please check the address and try again." });
  }
  if (supabase) await supabase.from("web_leads").update({ email_sent_at: new Date().toISOString() }).eq("email", email).eq("source", docId);

  // 3) Lead alert to info@radiansolutions.com (a failure here never blocks the visitor)
  const alert = await resend.emails.send({
    from: FROM, to: [NOTIFY], replyTo: email,
    subject: `New download: ${doc.title} (${company})`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#0d253d">
      <p><strong>${esc(first)} ${esc(last)}</strong>, ${esc(title)}, ${esc(company)}</p>
      <p>Email: ${esc(email)}<br>Document: ${esc(doc.title)}<br>Site theme: ${esc(theme)}</p>
      <p>Comments: ${comments ? esc(comments) : "(none)"}</p></div>`,
  });
  if (alert.error) console.error("Resend lead alert failed:", alert.error);

  res.json({ ok: true, downloadUrl: signedPath(docId, variant, 3600) }); // on-screen link: 1 hour
}
app.post("/api/request-document", express.json({ limit: "20kb" }), (req, res) => handleDocumentRequest(req, res, null));
app.post("/api/capability-statement", express.json({ limit: "20kb" }), (req, res) => handleDocumentRequest(req, res, "capability-statement"));

app.post("/api/contact", express.json({ limit: "20kb" }), async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ ok: false, error: "Too many requests. Please try again later." });
  const b = req.body || {};
  if (clean(b.website, 200)) return res.json({ ok: true });
  const name = clean(b.name, 160), email = clean(b.email, 200).toLowerCase(), sector = clean(b.sector, 80), message = clean(b.message, 4000);
  if (!name || !message || !EMAIL_RE.test(email)) return res.status(422).json({ ok: false, error: "Please add your name, a valid email and a message." });
  if (!resend) return res.status(500).json({ ok: false, error: "The server is not fully configured yet. Please email info@radiansolutions.com." });

  await saveLead({ source: "contact-form", first_name: name, last_name: "", email, title: null, company: null, comments: `Sector: ${sector || "n/a"}\n\n${message}` }, false);

  const alert = await resend.emails.send({
    from: FROM, to: [NOTIFY], replyTo: email,
    subject: `Website message from ${name}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#0d253d"><p><strong>${esc(name)}</strong> (${esc(email)}), sector: ${esc(sector || "n/a")}</p><p style="white-space:pre-wrap">${esc(message)}</p></div>`,
  });
  if (alert.error) {
    console.error("Resend contact alert failed:", alert.error);
    return res.status(502).json({ ok: false, error: "We could not send your message. Please email info@radiansolutions.com." });
  }
  const conf = await resend.emails.send({
    from: FROM, to: [email], replyTo: REPLY_TO, subject: "We got your message",
    html: wrapHtml(`<p>Hi ${esc(name)},</p><p>Thanks for reaching out. We received your message and a real person will reply soon. You can answer this email if you want to add anything.</p>`),
  });
  if (conf.error) console.error("Resend contact confirmation failed:", conf.error);
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
app.get(["/contracts/oasis-plus-small-business", "/contracts/oasis-plus-hubzone", "/light/contracts/oasis-plus-small-business", "/light/contracts/oasis-plus-hubzone"], (req, res) =>
  res.redirect(301, req.path.startsWith("/light") ? "/light/contracts/oasis-plus" : "/contracts/oasis-plus"));

// /join-us (both themes) gets the Ceipal URL injected at request time.
app.get(["/join-us", "/join-us.html", "/light/join-us", "/light/join-us.html"], (req, res) => {
  const url = env.CEIPAL_CAREER_URL && /^https:\/\//.test(env.CEIPAL_CAREER_URL) ? env.CEIPAL_CAREER_URL : "";
  const file = req.path.startsWith("/light") ? path.join(PUBLIC_DIR, "light", "join-us.html") : path.join(PUBLIC_DIR, "join-us.html");
  res.type("html").send(fs.readFileSync(file, "utf8").replace("__CEIPAL_URL__", esc(url)));
});

app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: "1h", index: "index.html" }));

app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html")));

app.listen(PORT, () => console.log(`RadianSolutions.com listening on ${PORT}`));
