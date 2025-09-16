// api/search.js  (Vercel Serverless Function)

// --- Quick CORS so Hostinger can call this API ---
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",             // you can lock this to your domain later
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Vary": "Origin"
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS).end();
    return;
  }

  try {
    const { query: q = "", max = "8" } = req.query || {};
    const query = String(q).trim();
    const limit = Math.min(parseInt(max, 10) || 8, 12);
    if (!query) {
      res.writeHead(400, CORS_HEADERS).end(JSON.stringify({ error: "query is required" }));
      return;
    }

    // 1) Search with Google CSE (free: 100/day)
    const candidates = await cseSearch(query);

    // 2) Fetch & score (cap work to keep free/fast)
    const top = candidates.slice(0, 20);
    const analyzed = [];
    for (const c of top) {
      const meta = await getPageMeta(c.url);
      const parts = [
        scorePurpose(meta, c.url),
        scoreAuthority(meta, c.url),
        scoreAudience(meta, c.url),
        scoreObjectivity(meta, c.url),
        scoreAccuracy(meta, c.url),
        scoreCurrency(meta, c.url)
      ];
      const total = parts.reduce((s, p) => s + p.score, 0);
      const verdict = total >= 25 ? "CREDIBLE" : total >= 20 ? "LIMITED" : "NOT_CREDIBLE";
      if (verdict === "CREDIBLE") {
        analyzed.push({
          title: meta.title || c.title || c.url,
          url: c.url,
          publisher: meta.publisher || hostOf(c.url),
          published: meta.published || null,
          score_total: total,
          verdict,
          scores: Object.fromEntries(parts.map(p => [p.name, p.score])),
          why: parts.flatMap(p => p.reasons)
        });
      }
      if (analyzed.length >= limit) break;
    }

    res.writeHead(200, CORS_HEADERS).end(JSON.stringify({
      query,
      source_tier: "CSE",
      results: analyzed
    }));
  } catch (err) {
    res.writeHead(500, CORS_HEADERS).end(JSON.stringify({ error: String(err) }));
  }
}

// ===== Helpers =====
async function cseSearch(query) {
  const key = process.env.CSE_KEY;  // set in Vercel dashboard
  const cx  = process.env.CSE_CX;   // set in Vercel dashboard
  if (!key || !cx) throw new Error("Missing CSE_KEY or CSE_CX env vars");

  const u = new URL("https://www.googleapis.com/customsearch/v1");
  u.searchParams.set("key", key);
  u.searchParams.set("cx", cx);
  u.searchParams.set("q", query);
  u.searchParams.set("num", "10");

  const r = await fetch(u, { method: "GET" });
  if (r.status === 429) throw new Error("CSE quota exceeded (free 100/day)");
  if (!r.ok) throw new Error(`CSE HTTP ${r.status}`);
  const j = await r.json();
  const items = j.items || [];
  return items.map(i => ({ title: i.title, url: i.link }));
}

function hostOf(u) { try { return new URL(u).hostname; } catch { return ""; } }
function pick(re, s, group = 1) { const m = s.match(re); return m ? (m[group] || "").trim() : ""; }

async function getPageMeta(u) {
  try {
    const r = await fetch(u, { redirect: "follow" });
    const html = await r.text();
    const title = pick(/<title>([^<]+)<\/title>/i, html);
    const author = pick(/name=["']author["'][^>]*content=["']([^"']+)/i, html);
    const published = pick(/(article:published_time|datePublished)["']\s*content=["']([^"']+)/i, html, 2);
    const modified  = pick(/(article:modified_time|last-modified)["']\s*content=["']([^"']+)/i, html, 2);
    return { url: u, title, author, published, modified, publisher: hostOf(u), html };
  } catch {
    return { url: u, title: "", author: "", published: "", modified: "", publisher: hostOf(u), html: "" };
  }
}

// ---- 6 Criteria, deterministic and explainable ----
function score(name, score, reasons) { return { name, score, reasons }; }

function scorePurpose(meta, url) {
  const reasons = [];
  const info = /research|report|method|policy|about/i.test(meta.html);
  const ads  = /advert|sponsored/i.test(meta.html);
  let sc = info ? 5 : 3;
  if (ads) { sc = Math.min(sc, 3); reasons.push("Ads/sponsorship signals found"); }
  reasons.push(info ? "Informational/educational signals" : "General content");
  return score("Purpose", sc, reasons);
}
function scoreAuthority(meta, url) {
  const h = hostOf(url);
  const major =
    h.endsWith(".gov") || h.endsWith(".edu") || h.endsWith(".gov.ph") ||
    /(^|\.)who\.int$|(^|\.)un\.org$|(^|\.)worldbank\.org$|(^|\.)unesco\.org$|(^|\.)unicef\.org$|(^|\.)nih\.gov$|(^|\.)ncbi\.nlm\.nih\.gov$|(^|\.)oecd\.org$|(^|\.)imf\.org$|(^|\.)pids\.gov\.ph$|(^|\.)psa\.gov\.ph$|(^|\.)ched\.gov\.ph$|(^|\.)dost\.gov\.ph$|(^|\.)dict\.gov\.ph$/i.test(h);
  const reasons = [];
  if (major) { reasons.push("Government/major organization domain"); return score("Authority", 5, reasons); }
  if (meta.author) { reasons.push("Named author present"); return score("Authority", 3, reasons); }
  reasons.push("Publisher/author unclear");
  return score("Authority", 1, reasons);
}
function scoreAudience(meta) {
  return score("Audience", 3, ["General audience language acceptable"]);
}
function scoreObjectivity(meta) {
  const biased = /opinion|editorial/i.test(meta.html) && !/methods|references|bibliography/i.test(meta.html);
  if (biased) return score("Objectivity", 3, ["Opinion/editorial signals without balancing methods"]);
  return score("Objectivity", 4, ["Neutral/balanced tone indicators"]);
}
function scoreAccuracy(meta) {
  const doiLinks   = (meta.html.match(/doi\.org\/\d+\.\d+\/[^\s"'<)]+/gi) || []).length;
  const govEduRefs = (meta.html.match(/https?:\/\/[a-z0-9.-]+\.(gov|edu)(\.[a-z.]+)?\//gi) || []).length;
  const refsHead   = /References|Citations|Bibliography/i.test(meta.html);
  if (doiLinks + govEduRefs >= 3) return score("Accuracy", 5, ["Multiple DOI/gov/edu citations"]);
  if (refsHead || doiLinks + govEduRefs >= 1) return score("Accuracy", 3, ["Some citations present"]);
  return score("Accuracy", 1, ["Few/no credible citations found"]);
}
function scoreCurrency(meta) {
  const t = Date.parse(meta.modified || meta.published || "");
  if (!isNaN(t)) {
    const months = (Date.now() - t) / (1000*60*60*24*30);
    if (months <= 18) return score("Currency", 5, ["Recently published/updated"]);
    if (months <= 60) return score("Currency", 3, ["Acceptably dated"]);
    return score("Currency", 1, ["Likely outdated for fast topics"]);
  }
  return score("Currency", 1, ["No clear date found"]);
}
