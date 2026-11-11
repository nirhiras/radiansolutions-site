// Downloads each client's logo from its website into public/assets/clients/<slug>.<ext>.
//   npm run fetch:logos                 -> fetch every logo in scripts/logo-sources.json
//   npm run fetch:logos -- ey kforce    -> fetch only these slugs
//   Logos you already saved in public/assets/clients are kept; add --force to replace them.
// Entries with "logoUrl" are downloaded directly. For the others the script reads the home page and
// picks the most likely logo (a header <img> whose src/alt/class mentions "logo", then og:image, then
// the apple-touch-icon). Afterwards open scripts/logo-preview.html to check every logo by eye, and
// replace any wrong one by saving the right file as public/assets/clients/<slug>.png (or .svg).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i > -1 ? args.splice(i, 2)[1] : null; };
const manifestPath = flag("--manifest") || path.join(here, "logo-sources.json");
const outDir = flag("--out") || path.join(here, "..", "public", "assets", "clients");
const force = args.includes("--force");
const only = args.filter((a) => !a.startsWith("--"));
fs.mkdirSync(outDir, { recursive: true });

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const EXT = { "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
const attr = (tag, name) => { const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")); return m ? (m[2] ?? m[3]) : ""; };

async function get(url, asText) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: asText ? "text/html,*/*" : "image/*,*/*" }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return asText ? { text: await r.text(), url: r.url } : { buf: Buffer.from(await r.arrayBuffer()), type: (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() };
}

function candidates(html, base) {
  const out = []; const add = (src, why) => { if (!src || src.startsWith("data:")) return; try { out.push({ url: new URL(src.replace(/&amp;/g, "&"), base).href, why }); } catch {} };
  const headerPart = (html.match(/<header[\s\S]*?<\/header>/i) || [html.slice(0, 20000)])[0];
  const imgs = (s) => s.match(/<img\b[^>]*>/gi) || [];
  const looksLogo = (t) => /logo|brand|site-?title|masthead/i.test(attr(t, "src") + " " + attr(t, "alt") + " " + attr(t, "class") + " " + attr(t, "id"));
  for (const t of imgs(headerPart)) if (looksLogo(t)) add(attr(t, "src") || attr(t, "data-src"), "header logo image");
  for (const m of headerPart.matchAll(/<a\b[^>]*>\s*(<svg\b[\s\S]*?<\/svg>)/gi)) {
    const svg = m[1], open = svg.match(/^<svg\b[^>]*>/i)[0], anchor = m[0].slice(0, m[0].indexOf(svg));
    if (/logo|brand/i.test(open + " " + anchor) || /href\s*=\s*["']\/?["']/.test(anchor)) {
      if (svg.length < 200000) out.push({ inline: /xmlns\s*=/.test(open) ? svg : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"'), why: "inline SVG in header" });
    }
  }
  for (const t of imgs(html)) if (looksLogo(t)) add(attr(t, "src") || attr(t, "data-src"), "page logo image");
  for (const t of html.match(/<meta\b[^>]*>/gi) || []) if (/og:image$/i.test(attr(t, "property")) ) add(attr(t, "content"), "og:image");
  for (const t of html.match(/<link\b[^>]*>/gi) || []) if (/apple-touch-icon/i.test(attr(t, "rel"))) add(attr(t, "href"), "apple-touch-icon");
  for (const t of html.match(/<link\b[^>]*>/gi) || []) if (/icon/i.test(attr(t, "rel"))) add(attr(t, "href"), "site icon");
  return out;
}

const items = JSON.parse(fs.readFileSync(manifestPath, "utf8")).filter((i) => !only.length || only.includes(i.slug));
const report = [];
for (const it of items) {
  const have = Object.values(EXT).map((e) => path.join(outDir, `${it.slug}.${e}`)).find((f) => fs.existsSync(f));
  if (have && !force) { console.log(`KEEP  ${it.slug.padEnd(8)} already has ${path.basename(have)} (use --force to replace it)`); report.push({ ...it, saved: { file: have, url: "(existing file)", why: "your own file", bytes: 0 }, note: "" }); continue; }
  let saved = null, note = "";
  try {
    let list = [];
    if (it.logoUrl) list.push({ url: it.logoUrl, why: "known logo address" });
    else { const page = await get(it.site, true); list = candidates(page.text, page.url); }
    for (const c of list) {
      try {
        const { buf, type } = c.inline ? { buf: Buffer.from(c.inline), type: "image/svg+xml" } : await get(c.url, false);
        const ext = EXT[type] || (c.url.match(/\.(svg|png|jpe?g|webp|gif)(\?|$)/i) || [])[1]?.toLowerCase().replace("jpeg", "jpg");
        if (!ext || buf.length < 120) continue;
        for (const e of Object.values(EXT)) fs.rmSync(path.join(outDir, `${it.slug}.${e}`), { force: true });
        const file = path.join(outDir, `${it.slug}.${ext}`); fs.writeFileSync(file, buf);
        saved = { file, url: c.url || "(inline SVG)", why: c.why, bytes: buf.length }; break;
      } catch (e) { note = e.message; }
    }
    if (!saved) note = note || "no usable logo found";
  } catch (e) { note = e.message; }
  report.push({ ...it, saved, note });
  console.log(saved ? `OK    ${it.slug.padEnd(8)} ${saved.why.padEnd(20)} ${saved.url}` : `MISS  ${it.slug.padEnd(8)} ${note}  -> save the logo by hand as public/assets/clients/${it.slug}.png`);
}

// A contact sheet so you can check every logo by eye.
const cards = report.map((r) => {
  const rel = r.saved ? "../" + path.relative(path.join(here, ".."), r.saved.file).replace(/\\/g, "/") : null;
  return `<div class="c"><div class="b">${rel ? `<img src="${rel.replace(/^\.\.\//, "../")}" alt="">` : "<em>missing</em>"}</div><b>${r.slug}</b><small>${r.name}</small><small>${r.saved ? r.saved.why : r.note}</small></div>`;
}).join("");
fs.writeFileSync(path.join(here, "logo-preview.html"), `<!doctype html><meta charset="utf-8"><title>Client logos</title><style>body{font:14px system-ui;margin:24px;background:#f4f4f5}.g{display:flex;flex-wrap:wrap;gap:16px}.c{width:200px;background:#fff;border:1px solid #ddd;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:4px}.b{height:80px;display:flex;align-items:center;justify-content:center;background:#fff}.b img{max-width:100%;max-height:70px}small{color:#666}</style><h2>Client logos: check each one</h2><div class="g">${cards}</div>`);
console.log(`\n${report.filter((r) => r.saved).length} of ${report.length} logos saved to ${outDir}\nNow run:  open scripts/logo-preview.html`);
