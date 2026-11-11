// Sends the same two kinds of email the website sends, then asks Resend what happened to each one.
//   1) a visitor-style confirmation to every address you pass on the command line
//   2) a lead-alert-style email to LEAD_NOTIFY_EMAIL (default info@radiansolutions.com)
// Usage:  npm run test:email -- you@gmail.com another@example.org
import { Resend } from "resend";

const env = process.env;
const key = env.RESEND_API_KEY;
const FROM = env.FROM_EMAIL || "Radian Solutions <info@site.radiansolutions.com>";
const NOTIFY = env.LEAD_NOTIFY_EMAIL || "info@radiansolutions.com";
const REPLY_TO = "info@radiansolutions.com";
const externals = process.argv.slice(2).filter((a) => a.includes("@"));

const line = (s = "") => console.log(s);
if (!key || key.includes("xxxx")) { console.error("RESEND_API_KEY is missing. Put your real key in .env (see .env.example)."); process.exit(2); }
if (!externals.length) { console.error("Give at least one outside address, e.g.  npm run test:email -- yourname@gmail.com"); process.exit(2); }

const resend = new Resend(key);
line(`Sending as:      ${FROM}`);
line(`Visitor test to: ${externals.join(", ")}`);
line(`Lead alert to:   ${NOTIFY}`);
line();

// Is the sending domain verified? (Only works with a full-access key; sending-only keys cannot list domains.)
try {
  const m = FROM.match(/@([^>\s]+)/); const fromDomain = m && m[1].toLowerCase();
  const { data, error } = await resend.domains.list();
  if (error) throw new Error(error.message);
  const hit = (data?.data || []).find((d) => d.name.toLowerCase() === fromDomain);
  line(hit ? `Domain check:    ${hit.name} is "${hit.status}" in Resend` : `Domain check:    ${fromDomain} was not found in this Resend account  <-- sends from this address will be rejected`);
} catch (e) { line(`Domain check:    skipped (${e.message}). That is normal for a sending-only API key.`); }
line();

const stamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
const jobs = [];
for (const to of externals) {
  jobs.push({ label: `visitor confirmation -> ${to}`, payload: { from: FROM, to: [to], replyTo: REPLY_TO, subject: "TEST: Your Radian Solutions confirmation",
    html: `<p>This is a test of the Radian Solutions confirmation email, sent ${stamp}.</p><p>If you can read this, visitors will receive their download confirmations.</p>`,
    text: `This is a test of the Radian Solutions confirmation email, sent ${stamp}.` } });
}
jobs.push({ label: `lead alert -> ${NOTIFY}`, payload: { from: FROM, to: [NOTIFY], replyTo: externals[0], subject: "TEST: New download alert (Radian website)",
  html: `<p>This is a test of the lead alert email, sent ${stamp}.</p><p>Real alerts list the visitor's name, company, email and the document they requested.</p>`,
  text: `This is a test of the lead alert email, sent ${stamp}.` } });

const sent = [];
for (const j of jobs) {
  const { data, error } = await resend.emails.send(j.payload);
  if (error) { line(`FAILED   ${j.label}\n         ${error.name || ""} ${error.message}`); sent.push({ ...j, failed: true }); }
  else { line(`ACCEPTED ${j.label}  (id ${data.id})`); sent.push({ ...j, id: data.id }); }
}

line("\nChecking delivery status with Resend...");
const final = {}; let cannotRead = false;
for (let i = 0; i < 12 && !cannotRead; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  let pending = 0;
  for (const s of sent) {
    if (s.failed || final[s.id]) continue;
    const { data, error } = await resend.emails.get(s.id);
    if (error) { cannotRead = true; break; }
    const ev = data?.last_event || "unknown";
    if (["delivered", "bounced", "complained", "failed", "suppressed"].includes(ev)) final[s.id] = ev; else pending++;
  }
  if (!pending) break;
}
line();
let bad = 0;
for (const s of sent) {
  if (s.failed) { bad++; line(`FAILED  ${s.label}`); continue; }
  if (cannotRead) { line(`SENT    ${s.label}: accepted by Resend (id ${s.id})`); continue; }
  const st = final[s.id] || "still pending (check the Resend Emails log)";
  if (final[s.id] && final[s.id] !== "delivered") bad++;
  line(`${st === "delivered" ? "OK   " : "CHECK"}  ${s.label}: ${st}`);
}
if (cannotRead) line("\nNote: this API key is sending-only, so Resend will not tell the script the delivery status. Open Resend > Emails to see Delivered / Bounced for each id above.");
line("\nNow open each inbox, and its Junk / Quarantine folder, to confirm you can see the message.");
process.exit(bad ? 1 : 0);
