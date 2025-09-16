// api/search.js — with free fallbacks (Crossref + OpenAlex + Wikipedia refs)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
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

    // ---- TIER A: Google CSE ----
    let source_tier = "CSE";
    let candidates = [];
    try {
      candidates = await cseSearch(query);
    } catch (e) {
      // If CSE quota or API error, we’ll fallback
      source_tier = "FALLBACK";
    }

    // Analyze Tier A first if we have candidates
    let analyzed = [];
    if (candidates.length > 0) {
      analyzed = await analyzeAndScore(candidates, limit);
    }

    // If CSE failed OR no credible results, run FALLBACKS
    if (source_tier === "FALLBACK" || analyzed.length === 0) {
      const fb = await tierBSearch(query);            // Crossref + OpenAlex + Wikipedia refs
      const analyzedFB = await analyzeAndScore(fb, limit);
      if (analyzedFB.length > 0) {
        source_tier = "Crossref/OpenAlex/Wikipedia";
        analyzed = analyzedFB;
      }
    }

    res.writeHead(200, CORS_HEADERS).end(JSON.stringify({
      query,
      source_tier,
      results: analyzed
    }));
  } catch (err) {
    res.writeHead(500, CORS_HEADERS).end(JSON.stringify({ error: String(err) }));
  }
}

/* =========================
   External Search Providers
   ========================= */

// TIER A — Google CSE (100 free queries/day)
async function cseSearch(query) {
  const key = process.env.CSE_KEY;
  const cx  = process.env.CSE_CX;
  if (!key || !cx) throw new Error("Missing CSE_KEY or CSE_CX");

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

// TIER B — Free fallbacks (no keys required)
async function tierBSearch(query) {
  const map = new Map(); // url -> { title, url }

  await addCrossref(query, map);
  await addOpenAlex(query, map);
  await addWikipediaRefs(query, map);

  return [...map.values()];
}

async function addCrossref(q, out) {
  try {
    const u = new URL("https://api.crossref.org/works");
    u.searchParams.set("query", q);
    u.searchParams.set("rows", "15");
    const j = await (await fetch(u)).json();
    const items = j.message?.items || [];
    for (const it of items) {
      const doi = it.DOI;
      const url = it.URL || (doi ? `https://doi.org/${doi}` : null);
      if (!url) continue;
      const title = (it.title && it.title[0]) ? it.title[0] : url;
      out.set(url, { title, url });
    }
  } catch {}
}

async function addOpenAlex(q, out) {
  try {
    const u = new URL("https://api.openalex.org/works");
    u.searchParams.set("search", q);
    u.searchParams.set("per_page", "15");
    const j = await (await fetch(u)).json();
    const items = j.results || [];
    for (const it of items) {
      const url =
        it.primary_location?.source?.hosted_document?.url ||
        it.primary_location?.landing_page_url ||
        (it.doi ? `https://doi.org/${it.doi}` : null);
      if (!url) continue;
      out.set(url, { title: it.title || url, url });
    }
  } catch {}
}

async function addWikipediaRefs(q, out) {
  try {
    // 1) Search Wikipedia for the topic
    const s = new URL("https://en.wikipedia.org/w/api.php");
    s.searchParams.set("action", "query");
    s.searchParams.set("list", "search");
    s.searchParams.set("format", "json");
    s.searchParams.set("srsearch", q);
    s.searchParams.set("origin", "*"); // allow CORS
    const sj = await (await fetch(s)).json();
    const pageId = sj.query?.search?.[0]?.pageid;
    if (!pageId) return;

    // 2) Get external links (references) from the article
    const p = new URL("https://en.wikipedia.org/w/api.php");
    p.searchParams.set("action", "parse");
    p.searchParams.set("pageid", String(pageId));
    p.searchParams.set("prop", "externallinks");
    p.searchParams.set("format", "json");
    p.searchParams.set("origin", "*");
    const pj = await (await fetch(p)).json();
    const links = pj.parse?.externallinks || [];

    // 3) Keep only DOI/gov/edu/major org/publishers
    for (const L of links) {
      if (/doi\.org|\.gov(\.|\/)|\.edu(\.|\/)|who\.int|un\.org|worldbank\.org|unesco\.org|unicef\.org|nih\.gov|oecd\.org|imf\.org/i.test(L)) {
        out.set(L, { title: L, url: L });
      }
    }
  } catch {}
}

/* =========================
   Analyze & Score Pages
   ========================= */

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

function score(name, score, reasons) { return { name, score, reasons }; }

function scorePurpose(meta) {
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
function scoreAudience() {
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

async function analyzeAndScore(candidates, max) {
  // Dedup + cap fetch cost
  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    const u = c.url;
    if (!u || seen.has(u)) continue;
    seen.add(u);
    unique.push(c);
    if (unique.length >= 20) break; // cap
  }

  const results = [];
  for (const c of unique) {
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
      results.push({
        title: meta.title || c.title || c.url,
        url: c.url,
        publisher: meta.publisher || hostOf(c.url),
        published: meta.published || null,
        score_total: total,
        verdict,
        scores: Object.fromEntries(parts.map(p => [p.name, p.score])),
        why: parts.flatMap(p => p.reasons)
      });
      if (results.length >= max) break;
    }
  }
  // Sort by score desc
  results.sort((a, b) => b.score_total - a.score_total);
  return results;
}

