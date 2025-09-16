// api/search.js — entire web search -> filter by 6 criteria (with explanations)
// Modes:
//   scope=web   (default): no domain prefilter; score everything, return only ≥25
//   scope=wide  : allow curated scholarly/publishers in early filter (faster)
//   scope=strict: allow only Tier-1 gov/edu/int (fastest, narrowest)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Vary": "Origin"
};

// ---- Curated lists (used only in 'wide' and 'strict') ----
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

// ------------- Utilities -------------
function hostOf(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch{ return ""; } }
function isTrustedHost(host, scope){
  if (!host) return false;
  const govEdu = host.endsWith(".gov") || host.endsWith(".edu") || host.endsWith(".int") || host.endsWith(".gov.ph");
  if (scope === "strict") return govEdu || TIER1_CORE.some(t => host===t || host.endsWith(`.${t}`));
  if (scope === "wide") {
    if (govEdu) return true;
    if (TIER1_CORE.some(t => host===t || host.endsWith(`.${t}`))) return true;
    if (TIER2_INDEXES.some(t => host===t || host.endsWith(`.${t}`))) return true;
    if (TIER3_PUBLISHERS.some(t => host===t || host.endsWith(`.${t}`))) return true;
    return false;
  }
  // scope=web → no prefilter needed; return true so prefilter step doesn't drop anything
  return true;
}
function pick(re, s, group=1){ const m=s.match(re); return m ? (m[group]||"").trim() : ""; }
async function fetchWithTimeout(resource, opts = {}) {
  const { timeout = 8000, ...rest } = opts;
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

// ------------- Vercel handler -------------
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS).end(); return; }

  try {
    const { query: q = "", max = "8", scope = "web" } = req.query || {};
    const query = String(q).trim();
    const limit = Math.min(parseInt(max,10)||8, 12);
    const mode = (scope === "strict" || scope === "wide") ? scope : "web";
    if (!query) { res.writeHead(400, CORS_HEADERS).end(JSON.stringify({ error:"query is required" })); return; }

    // Tier A — CSE (entire web)
    let source_tier = "CSE";
    let candidates = [];
    try {
      candidates = await cseSearch(query);
    } catch {
      source_tier = "FALLBACK";
    }

    // Prefilter based on mode (in web mode, this keeps everything)
    let pool = prefilterCandidates(candidates, mode);

    // If nothing (CSE failed or empty), use free scholarly fallbacks
    if (pool.length === 0) {
      const fb = await tierBSearch(query);
      pool = prefilterCandidates(fb, mode);
      if (pool.length > 0) source_tier = "Crossref/OpenAlex/Wikipedia/PubMed";
    }

    // Cap and analyze with concurrency + timeouts
    pool = pool.slice(0, 20);
    const analyzed = await mapLimited(pool, 4, analyzeOne);
    const credibleOnly = analyzed
      .filter(x => x.verdict === "CREDIBLE")
      .sort((a,b) => b.score_total - a.score_total)
      .slice(0, limit);

    res.writeHead(200, CORS_HEADERS).end(JSON.stringify({
      query, scope: mode, source_tier, results: credibleOnly
    }));
  } catch (err) {
    res.writeHead(500, CORS_HEADERS).end(JSON.stringify({ error:String(err) }));
  }
}

// ------------- Candidate prefilter -------------
function prefilterCandidates(list, mode){
  const byUrl = new Map();
  for (const c of (list||[])) {
    const h = hostOf(c.url);
    if (!isTrustedHost(h, mode)) continue; // in web mode, always true
    if (!byUrl.has(c.url)) byUrl.set(c.url, { title: c.title, url: c.url, host: h });
  }
  return Array.from(byUrl.values());
}

// ------------- Providers -------------
// Google CSE (entire web)
async function cseSearch(query){
  const key = process.env.CSE_KEY, cx = process.env.CSE_CX;
  if (!key || !cx) throw new Error("Missing CSE_KEY or CSE_CX");
  const u = new URL("https://www.googleapis.com/customsearch/v1");
  u.searchParams.set("key", key);
  u.searchParams.set("cx", cx);
  u.searchParams.set("q", query);
  u.searchParams.set("num", "10");
  const r = await fetchWithTimeout(u, { timeout: 8000 });
  if (r.status === 429) throw new Error("CSE quota exceeded");
  if (!r.ok) throw new Error(`CSE HTTP ${r.status}`);
  const j = await r.json();
  return (j.items || []).map(i => ({ title: i.title, url: i.link }));
}

// Fallbacks: Crossref + OpenAlex + Wikipedia refs + PubMed
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
    const j = await (await fetchWithTimeout(u,{timeout:8000})).json();
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
    const j = await (await fetchWithTimeout(u,{timeout:8000})).json();
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
    const sj = await (await fetchWithTimeout(s,{timeout:8000})).json();
    const pageId = sj.query?.search?.[0]?.pageid; if (!pageId) return;

    const p = new URL("https://en.wikipedia.org/w/api.php");
    p.searchParams.set("action","parse"); p.searchParams.set("pageid", String(pageId));
    p.searchParams.set("prop","externallinks"); p.searchParams.set("format","json");
    p.searchParams.set("origin","*");
    const pj = await (await fetchWithTimeout(p,{timeout:8000})).json();
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
    const es = await (await fetchWithTimeout(esearch,{timeout:8000})).json();
    const ids = es.esearchresult?.idlist || []; if (!ids.length) return;
    for (const id of ids) {
      const url = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
      out.set(url, { title: `PubMed ${id}`, url });
    }
  }catch{}
}

// ------------- Page analysis + scoring + APA -------------
async function getPageMeta(u){
  try{
    const r = await fetchWithTimeout(u, { redirect:"follow", timeout: 9000 });
    const ct = r.headers.get("content-type") || "";
    if (/pdf/i.test(ct)) {
      // PDFs are slow to parse; skip body but still score on metadata/URL
      return { url:u, title:"", author:"", published:"", modified:"", publisher:hostOf(u), html:"" };
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

function score(name,score,reasons){ return { name, score, reasons }; }

// 1) Purpose
function scorePurpose(meta){
  const reasons = [];
  const info = /research|report|method|policy|about|dataset|guideline|fact\s*sheet/i.test(meta.html);
  const ads  = /advert|sponsored|subscribe|buy\s+now/i.test(meta.html);
  let sc = info ? 5 : 3;
  if (ads){ sc = Math.min(sc, 3); reasons.push("Advertising/sales signals present"); }
  reasons.push(info ? "Informational/educational indicators found" : "General content (not clearly research/policy)");
  return score("Purpose", sc, reasons);
}

// 2) Authority
function scoreAuthority(meta, url){
  const h = hostOf(url);
  const govEdu = h.endsWith(".gov") || h.endsWith(".edu") || h.endsWith(".int") || h.endsWith(".gov.ph");
  const major =
    govEdu ||
    TIER1_CORE.some(t => h===t || h.endsWith(`.${t}`)) ||
    TIER2_INDEXES.some(t => h===t || h.endsWith(`.${t}`)) ||
    TIER3_PUBLISHERS.some(t => h===t || h.endsWith(`.${t}`));
  const reasons = [];
  if (major) { reasons.push("Government/major org, index, or publisher domain"); return score("Authority", 5, reasons); }
  if (meta.author) { reasons.push("Named author present"); return score("Authority", 3, reasons); }
  reasons.push("Publisher/author unclear");
  return score("Authority", 1, reasons);
}

// 3) Audience
function scoreAudience(){
  return score("Audience", 3, ["General audience language acceptable"]);
}

// 4) Objectivity
function scoreObjectivity(meta){
  const biased = /opinion|editorial|commentary/i.test(meta.html) && !/methods|references|bibliography/i.test(meta.html);
  return biased ? score("Objectivity", 3, ["Opinion/editorial signals without balancing methods/references"])
                : score("Objectivity", 4, ["Neutral/balanced tone indicators"]);
}

// 5) Accuracy
function scoreAccuracy(meta){
  const doi   = (meta.html.match(/doi\.org\/\d+\.\d+\/[^\s"'<)]+/gi)||[]).length;
  const govEd = (meta.html.match(/https?:\/\/[a-z0-9.-]+\.(gov|edu|int)(\.[a-z.]+)?\//gi)||[]).length;
  const refsH = /References|Citations|Bibliography/i.test(meta.html);
  if (doi + govEd >= 3) return score("Accuracy", 5, ["Multiple DOI/gov/edu/int citations found"]);
  if (refsH || doi + govEd >= 1) return score("Accuracy", 3, ["Some citations or credible references present"]);
  return score("Accuracy", 1, ["Few or no credible citations found"]);
}

// 6) Currency
function scoreCurrency(meta){
  const t = Date.parse(meta.modified || meta.published || "");
  if (!isNaN(t)) {
    const months = (Date.now() - t) / (1000*60*60*24*30);
    if (months <= 18) return score("Currency", 5, ["Recently published/updated"]);
    if (months <= 60) return score("Currency", 3, ["Acceptably dated"]);
    return score("Currency", 1, ["Likely outdated for fast-moving topics"]);
  }
  return score("Currency", 1, ["No clear date found"]);
}

// APA 7th formatting (simple, robust)
function formatAPA(meta){
  const { author, published, title, publisher, url } = meta;
  const authorStr = authorNameToAPA(author);
  const d = parseDateYMD(published);
  const dateStr = d ? apaDateString(d) : "n.d.";
  const titleStr = cleanTitle(title || "(No title)");
  const site = publisher || hostOf(url);
  if (authorStr) return { apa: `${authorStr} (${dateStr}). ${titleStr}. ${site}. ${url}` };
  return { apa: `${titleStr}. (${dateStr}). ${site}. ${url}` };
}
function authorNameToAPA(name){
  if (!name) return ""; const n = name.trim(); if (!n) return "";
  if (n.includes(",")) {
    const [last, rest] = n.split(",", 2).map(s => s.trim());
    const initials = (rest||"").split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()+".").join(" ");
    return `${last}, ${initials}`;
  }
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const last = parts.pop();
  const initials = parts.map(w => w[0].toUpperCase()+".").join(" ");
  return `${last}, ${initials}`;
}
function parseDateYMD(iso){ if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : d; }
function apaDateString(d){
  const m=["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${d.getUTCFullYear()}, ${m[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function cleanTitle(t){ return t.replace(/\s*[-|–]\s*[^-|–]+$/,'').trim(); }

async function analyzeOne(c){
  const meta = await getPageMeta(c.url);
  const parts = [
    scorePurpose(meta, c.url),
    scoreAuthority(meta, c.url),
    scoreAudience(meta, c.url),
    scoreObjectivity(meta, c.url),
    scoreAccuracy(meta, c.url),
    scoreCurrency(meta, c.url)
  ];
  const total = parts.reduce((s,p)=>s+p.score,0);
  const verdict = total >= 25 ? "CREDIBLE" : total >= 20 ? "LIMITED" : "NOT_CREDIBLE";
  if (verdict !== "CREDIBLE") return null;

  const { apa } = formatAPA(meta);
  return {
    title: meta.title || c.title || c.url,
    url: c.url,
    publisher: meta.publisher || hostOf(c.url),
    published: meta.published || null,
    score_total: total,
    verdict,
    scores: Object.fromEntries(parts.map(p=>[p.name,p.score])),
    why: parts.flatMap(p=>p.reasons),   // <-- explanations behind each score
    apa
  };
}



