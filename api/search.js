// api/search.js — Decision Tree per Bryan's Guide
// Order: Authority (soft) → Accuracy (KILL) → Currency (soft) → Objectivity (KILL) → Purpose (explain) → Audience (explain)
// Entire web via CSE + free fallbacks (Crossref/OpenAlex/Wikipedia/PubMed). PDF-friendly. APA 7. CORS.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Vary": "Origin"
};

// Curated lists (used for Authority scoring and optional prefilters)
const TIER1_CORE = [
  "who.int","un.org","worldbank.org","unesco.org","unicef.org","oecd.org","imf.org",
  "nih.gov","ncbi.nlm.nih.gov","cdc.gov","nasa.gov","nist.gov","epa.gov","fda.gov",
  "europa.eu","ec.europa.eu","ema.europa.eu","ecdc.europa.eu",
  "psa.gov.ph","pids.gov.ph","ched.gov.ph","neda.gov.ph","dost.gov.ph","dict.gov.ph","deped.gov.ph","doh.gov.ph"
];
const TIER2_INDEXES = [
  "pubmed.ncbi.nlm.nih.gov","pmc.ncbi.nlm.nih.gov","doi.org","openalex.org","crossref.org"
];
const TIER3_PUBLISHERS = [
  "nature.com","science.org","thelancet.com","nejm.org","bmj.com","plos.org","jamanetwork.com",
  "springer.com","link.springer.com","onlinelibrary.wiley.com","tandfonline.com",
  "ieeexplore.ieee.org","dl.acm.org","arxiv.org","ieee.org",
  "jstor.org","sagepub.com","cambridge.org","oup.com","academic.oup.com"
];

// ---------------- utils ----------------
function hostOf(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch{ return ""; } }
function pick(re, s, group=1){ const m=s.match(re); return m ? (m[group]||"").trim() : ""; }

async function fetchWithTimeout(resource, opts = {}) {
  const { timeout = 9000, ...rest } = opts;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try { return await fetch(resource, { ...rest, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}
async function mapLimited(items, limit, fn) {
  const out = Array(items.length);
  let i = 0;
  async function worker(){
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  }
  const workers = Array(Math.min(limit, items.length)).fill(0).map(worker);
  await Promise.allSettled(workers);
  return out.filter(Boolean);
}

// ---------------- handler ----------------
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS).end(); return; }

  try {
    const {
      query: q = "",
      max = "8",
      scope = "web",        // web (entire web), wide, strict
      debug
    } = req.query || {};

    const query = String(q).trim();
    const limit = Math.min(parseInt(max,10)||8, 12);
    const mode = (scope === "strict" || scope === "wide") ? scope : "web";
    const DEBUG = debug === "1";

    if (!query) {
      res.writeHead(400, CORS_HEADERS).end(JSON.stringify({ error: "query is required" }));
      return;
    }

    // Tier A — CSE (entire web)
    let source_tier = "CSE";
    let candidates = [];
    try { candidates = await cseSearch(query); }
    catch { source_tier = "FALLBACK"; }

    let pool = dedupeList(candidates);

    // If CSE empty, use free scholarly fallbacks
    if (pool.length === 0) {
      const fb = await tierBSearch(query);
      pool = dedupeList(fb);
      if (pool.length > 0) source_tier = "Crossref/OpenAlex/Wikipedia/PubMed";
    }

    // Cap and analyze in parallel with the ordered decision tree
    pool = pool.slice(0, 20);
    const analyzed = await mapLimited(pool, 4, analyzeDecisionTree);

    // Keep all items that passed both kill stages (Accuracy & Objectivity); others remain as NOT_CREDIBLE
    const credible = analyzed.filter(x => x.verdict === "CREDIBLE").slice(0, limit);

    const payload = {
      query, scope: mode, source_tier,
      results: credible,
      ...(DEBUG ? { debug_failed: analyzed.filter(x => x.verdict !== "CREDIBLE").slice(0, 10) } : {})
    };
    res.writeHead(200, CORS_HEADERS).end(JSON.stringify(payload));
  } catch (err) {
    res.writeHead(500, CORS_HEADERS).end(JSON.stringify({ error: String(err) }));
  }
}

// ---------------- providers ----------------
async function cseSearch(query){
  const key = process.env.CSE_KEY, cx = process.env.CSE_CX;
  if (!key || !cx) throw new Error("Missing CSE_KEY or CSE_CX");
  const u = new URL("https://www.googleapis.com/customsearch/v1");
  u.searchParams.set("key", key);
  u.searchParams.set("cx", cx);
  u.searchParams.set("q", query);
  u.searchParams.set("num", "10");
  const r = await fetchWithTimeout(u, { timeout: 9000 });
  if (r.status === 429) throw new Error("CSE quota exceeded");
  if (!r.ok) throw new Error(`CSE HTTP ${r.status}`);
  const j = await r.json();
  return (j.items || []).map(i => ({ title: i.title, url: i.link }));
}

async function tierBSearch(query){
  const map = new Map();
  await addCrossref(query, map);
  await addOpenAlex(query, map);
  await addWikipediaRefs(query, map);
  await addPubMed(query, map);
  return [...map.values()];
}
async function addCrossref(q, out){
  try{
    const u = new URL("https://api.crossref.org/works");
    u.searchParams.set("query", q); u.searchParams.set("rows","15");
    const j = await (await fetchWithTimeout(u,{timeout:9000})).json();
    for (const it of (j.message?.items||[])) {
      const doi = it.DOI;
      const url = it.URL || (doi ? `https://doi.org/${doi}` : null);
      if (!url) continue;
      out.set(url, { title: it.title?.[0] || url, url });
    }
  }catch{}
}
async function addOpenAlex(q, out){
  try{
    const u = new URL("https://api.openalex.org/works");
    u.searchParams.set("search", q); u.searchParams.set("per_page","15");
    const j = await (await fetchWithTimeout(u,{timeout:9000})).json();
    for (const it of (j.results||[])) {
      const url = it.primary_location?.source?.hosted_document?.url
        || it.primary_location?.landing_page_url
        || (it.doi ? `https://doi.org/${it.doi}` : null);
      if (!url) continue;
      out.set(url, { title: it.title || url, url });
    }
  }catch{}
}
async function addWikipediaRefs(q, out){
  try{
    const s = new URL("https://en.wikipedia.org/w/api.php");
    s.searchParams.set("action","query"); s.searchParams.set("list","search");
    s.searchParams.set("format","json"); s.searchParams.set("srsearch", q);
    s.searchParams.set("origin","*");
    const sj = await (await fetchWithTimeout(s,{timeout:9000})).json();
    const pageId = sj.query?.search?.[0]?.pageid; if (!pageId) return;

    const p = new URL("https://en.wikipedia.org/w/api.php");
    p.searchParams.set("action","parse"); p.searchParams.set("pageid", String(pageId));
    p.searchParams.set("prop","externallinks"); p.searchParams.set("format","json");
    p.searchParams.set("origin","*");
    const pj = await (await fetchWithTimeout(p,{timeout:9000})).json();
    for (const L of (pj.parse?.externallinks||[])) {
      if (/doi\.org|\.gov(\.|\/)|\.edu(\.|\/)|who\.int|un\.org|worldbank\.org|unesco\.org|unicef\.org|nih\.gov|oecd\.org|imf\.org/i.test(L)) {
        out.set(L, { title: L, url: L });
      }
    }
  }catch{}
}
async function addPubMed(q, out){
  try{
    const esearch = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
    esearch.searchParams.set("db","pubmed"); esearch.searchParams.set("retmode","json");
    esearch.searchParams.set("retmax","15"); esearch.searchParams.set("term", q);
    const es = await (await fetchWithTimeout(esearch,{timeout:9000})).json();
    const ids = es.esearchresult?.idlist || []; if (!ids.length) return;
    for (const id of ids) {
      const url = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
      out.set(url, { title: `PubMed ${id}`, url });
    }
  }catch{}
}

function dedupeList(list){
  const by = new Map();
  for (const c of list || []) { if (!by.has(c.url)) by.set(c.url, c); }
  return [...by.values()];
}

// ---------------- page fetch + meta ----------------
async function getPageMeta(u){
  try{
    const r = await fetchWithTimeout(u, { redirect:"follow", timeout: 9000 });
    const ct = r.headers.get("content-type") || "";
    if (/pdf/i.test(ct)) {
      // Keep PDFs; we won’t parse body HTML, but we’ll score with domain/URL and conservative rules
      return { url:u, title:"", author:"", published:"", modified:"", publisher:hostOf(u), html:"", pdf:true };
    }
    const html = await r.text();
    const title = pick(/<title>([^<]+)<\/title>/i, html);
    const author = pick(/name=["']author["'][^>]*content=["']([^"']+)/i, html);
    const published = pick(/(article:published_time|datePublished)["']\s*content=["']([^"']+)/i, html, 2);
    const modified  = pick(/(article:modified_time|last-modified)["']\s*content=["']([^"']+)/i, html, 2);
    const host = hostOf(u);
    const publisher = guessPublisher(html, host) || host;
    return { url:u, title, author, published, modified, publisher, html };
  }catch{
    const host = hostOf(u);
    return { url:u, title:"", author:"", published:"", modified:"", publisher:host, html:"" };
  }
}
function guessPublisher(html, host){
  const og = pick(/property=["']og:site_name["'][^>]*content=["']([^"']+)/i, html);
  const pub = pick(/name=["']publisher["'][^>]*content=["']([^"']+)/i, html);
  return og || pub || host;
}

// ---------------- scoring (0–5) ----------------
function s(name,score,reasons){ return { name, score, reasons }; }

// Authority (soft): pass if >=3 (gov/edu/int/publishers=5; named author=3; else 1)
function scoreAuthority(meta, url){
  const h = hostOf(url);
  const govEdu = h.endsWith(".gov") || h.endsWith(".edu") || h.endsWith(".int") || h.endsWith(".gov.ph");
  const major =
    govEdu ||
    TIER1_CORE.some(t => h===t || h.endsWith(`.${t}`)) ||
    TIER2_INDEXES.some(t => h===t || h.endsWith(`.${t}`)) ||
    TIER3_PUBLISHERS.some(t => h===t || h.endsWith(`.${t}`));
  if (major) return s("Authority", 5, ["Government/major org, index, or publisher"]);
  if (meta.author) return s("Authority", 3, ["Named author present"]);
  return s("Authority", 1, ["Publisher/author unclear"]);
}

// Accuracy (KILL if <3)
function scoreAccuracy(meta){
  const html = meta.html || "";
  const doi   = (html.match(/doi\.org\/\d+\.\d+\/[^\s"'<)]+/gi)||[]).length;
  const govEd = (html.match(/https?:\/\/[a-z0-9.-]+\.(gov|edu|int)(\.[a-z.]+)?\//gi)||[]).length;
  const refsH = /References|Citations|Bibliography/i.test(html);
  if (doi + govEd >= 3) return s("Accuracy", 5, ["Multiple DOI/gov/edu/int citations"]);
  if (refsH || doi + govEd >= 1) return s("Accuracy", 3, ["Some citations/credible references"]);
  return s("Accuracy", 1, ["Few/no credible citations"]);
}

// Currency (soft): recent=5, okay=3, old/undated=1 (gov/edu PDF undated allowed as 3)
function scoreCurrency(meta, url){
  const t = Date.parse(meta.modified || meta.published || "");
  if (!isNaN(t)) {
    const months = (Date.now() - t) / (1000*60*60*24*30);
    if (months <= 18) return s("Currency", 5, ["Recently published/updated"]);
    if (months <= 60) return s("Currency", 3, ["Acceptably dated"]);
    return s("Currency", 1, ["Likely outdated for fast-moving topics"]);
  }
  if (meta.pdf) {
    const h = hostOf(url);
    const govEdu = h.endsWith(".gov") || h.endsWith(".edu") || h.endsWith(".int") || h.endsWith(".gov.ph");
    if (govEdu) return s("Currency", 3, ["Undated PDF on credible domain (allowed)"]);
  }
  return s("Currency", 1, ["No clear date found"]);
}

// Objectivity (KILL if <3)
function scoreObjectivity(meta){
  const html = meta.html || "";
  const biased = /opinion|editorial|commentary/i.test(html) && !/methods|references|bibliography/i.test(html);
  if (biased) return s("Objectivity", 2, ["Opinion/editorial without balancing methods/refs"]);
  return s("Objectivity", 4, ["Neutral/balanced tone indicators"]);
}

// Purpose (explain if fails): educational/research/guideline=5; general=3; ad/promotional=1
function scorePurpose(meta){
  const html = meta.html || "";
  const info = /research|report|method|policy|guideline|fact\s*sheet|white\s*paper|dataset/i.test(html);
  const ad   = /advert|sponsored|buy\s+now|subscribe|promotion|shop/i.test(html);
  if (ad) return s("Purpose", 1, ["Promotional/advertising signals"]);
  if (info) return s("Purpose", 5, ["Educational/research/guideline indicators"]);
  return s("Purpose", 3, ["General informational content"]);
}

// Audience (explain if fails): general/academic ok=3–4; overt marketing/too vague=1–2
function scoreAudience(meta){
  const html = meta.html || "";
  const veryTech = /complexity|notation|theorem|proof|asymptotic/i.test(html) && /references/i.test(html);
  const marketing = /buy|pricing|plans|signup|subscribe|resources for customers/i.test(html);
  if (marketing) return s("Audience", 2, ["Marketing/customer-facing language"]);
  if (veryTech)  return s("Audience", 3, ["Technical/academic audience"]);
  return s("Audience", 3, ["General audience acceptable"]);
}

// PDF adjustment: lightly help gov/edu PDFs where HTML isn’t available
function pdfAdjust(meta, url, scores){
  if (!meta.pdf) return;
  const h = hostOf(url);
  const govEdu = h.endsWith(".gov") || h.endsWith(".edu") || h.endsWith(".int") || h.endsWith(".gov.ph");
  if (govEdu) {
    // push Authority to 5 if not already; nudge Accuracy by +1 up to 3 baseline
    if (scores.Authority.score < 5) { scores.Authority.score = 5; scores.Authority.reasons.push("Gov/edu PDF baseline"); }
    if (scores.Accuracy.score < 3)  { scores.Accuracy.score = 3; scores.Accuracy.reasons.push("Gov/edu PDF—assume embedded references"); }
  }
}

// APA 7th
function formatAPA(meta){
  const { author, published, title, publisher, url } = meta;
  const authorStr = authorNameToAPA(author);
  const d = parseDateYMD(published);
  const dateStr = d ? apaDateString(d) : "n.d.";
  const titleStr = cleanTitle(title || "(No title)");
  const site = publisher || hostOf(url);
  if (authorStr) return `${authorStr} (${dateStr}). ${titleStr}. ${site}. ${url}`;
  return `${titleStr}. (${dateStr}). ${site}. ${url}`;
}
function authorNameToAPA(name){
  if (!name) return ""; const n=name.trim(); if(!n) return "";
  if (n.includes(",")) {
    const [last, rest] = n.split(",",2).map(s=>s.trim());
    const initials = (rest||"").split(/\s+/).filter(Boolean).map(w=>w[0].toUpperCase()+".").join(" ");
    return `${last}, ${initials}`;
  }
  const parts=n.split(/\s+/).filter(Boolean); if(parts.length===1) return parts[0];
  const last=parts.pop(); const initials=parts.map(w=>w[0].toUpperCase()+".").join(" ");
  return `${last}, ${initials}`;
}
function parseDateYMD(iso){ if(!iso) return null; const d=new Date(iso); return isNaN(d)?null:d; }
function apaDateString(d){
  const m=["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${d.getUTCFullYear()}, ${m[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function cleanTitle(t){ return t.replace(/\s*[-|–]\s*[^-|–]+$/,'').trim(); }

// ---------------- decision tree analyzer ----------------
async function analyzeDecisionTree(c){
  const meta = await getPageMeta(c.url);

  const A  = scoreAuthority(meta, c.url);     // Stage 1 (soft)
  const AC = scoreAccuracy(meta);             // Stage 2 (KILL if <3)
  const C  = scoreCurrency(meta, c.url);      // Stage 3 (soft)
  const O  = scoreObjectivity(meta);          // Stage 4 (KILL if <3)
  const P  = scorePurpose(meta);              // Stage 5 (explain if fails)
  const AU = scoreAudience(meta);             // Stage 6 (explain if fails)

  const scores = { Authority: A, Accuracy: AC, Currency: C, Objectivity: O, Purpose: P, Audience: AU };

  // PDF adjustments (after raw scoring)
  pdfAdjust(meta, c.url, scores);

  // Re-read scores after potential adjustment
  const A2 = scores.Authority.score;
  const AC2 = scores.Accuracy.score;
  const C2 = scores.Currency.score;
  const O2 = scores.Objectivity.score;
  const P2 = scores.Purpose.score;
  const AU2 = scores.Audience.score;

  const stage_notes = [];
  const why = [];

  // Authority: if fails (<3), continue but record the flag
  if (A2 < 3) stage_notes.push({ stage: "Authority", status: "failed-soft", reason: scores.Authority.reasons[0] || "Low authority" });
  why.push(...scores.Authority.reasons);

  // Accuracy: if fails (<3) → NOT_CREDIBLE (stop)
  if (AC2 < 3) {
    why.push(...scores.Accuracy.reasons);
    return finalize(meta, c, scores, why, stage_notes, "NOT_CREDIBLE", "Accuracy", "Insufficient evidence/citations");
  }
  why.push(...scores.Accuracy.reasons);

  // Currency: if fails (<3), continue but record the flag
  if (C2 < 3) stage_notes.push({ stage: "Currency", status: "failed-soft", reason: scores.Currency.reasons[0] || "Outdated/undated" });
  why.push(...scores.Currency.reasons);

  // Objectivity: if fails (<3) → NOT_CREDIBLE (stop)
  if (O2 < 3) {
    why.push(...scores.Objectivity.reasons);
    return finalize(meta, c, scores, why, stage_notes, "NOT_CREDIBLE", "Objectivity", "Biased/opinion without balancing evidence");
  }
  why.push(...scores.Objectivity.reasons);

  // Purpose: if fails (<3), include a clear explanation of the primary purpose
  if (P2 < 3) stage_notes.push({ stage: "Purpose", status: "explain", purpose: "Promotional/advertising or non-educational" });
  why.push(...scores.Purpose.reasons);

  // Audience: if fails (<3), explain only
  if (AU2 < 3) stage_notes.push({ stage: "Audience", status: "explain", reason: scores.Audience.reasons[0] || "Not suitable for general readers" });
  why.push(...scores.Audience.reasons);

  // If we reach here, both kill-switches passed → CREDIBLE
  return finalize(meta, c, scores, why, stage_notes, "CREDIBLE");
}

function finalize(meta, c, scoresObj, whyArr, notes, verdict, failedStage=null, failMsg=null){
  const parts = [scoresObj.Authority, scoresObj.Accuracy, scoresObj.Currency, scoresObj.Objectivity, scoresObj.Purpose, scoresObj.Audience];
  const scores = Object.fromEntries(parts.map(p => [p.name, p.score]));
  const total = parts.reduce((s,p)=>s+p.score,0);
  const apa = formatAPA(meta);

  return {
    title: meta.title || c.title || c.url,
    url: c.url,
    publisher: meta.publisher || hostOf(c.url),
    published: meta.published || null,
    scores,
    score_total: total,
    verdict,
    stage_notes: notes,          // exact behavior per your guide
    failed_stage: failedStage,   // only when NOT_CREDIBLE due to kill-switch
    stage_reason: failMsg,       // only when NOT_CREDIBLE due to kill-switch
    why: [...new Set(whyArr)].slice(0, 12),
    apa
  };
}




