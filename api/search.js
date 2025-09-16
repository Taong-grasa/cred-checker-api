// api/search.js — speed+quality patch: prefilter, concurrency, timeouts, trusted fast-path

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Vary": "Origin"
};

// --- trusted domains for fast-path and early filtering ---
const TRUSTED = [
  "who.int","un.org","worldbank.org","unesco.org","unicef.org",
  "nih.gov","ncbi.nlm.nih.gov","oecd.org","imf.org",
  "psa.gov.ph","pids.gov.ph","ched.gov.ph","neda.gov.ph","dost.gov.ph","dict.gov.ph","deped.gov.ph"
];
function hostOf(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch{ return ""; } }
function isTrustedHost(h){
  if(!h) return false;
  if (h.endsWith(".gov") || h.endsWith(".edu") || h.endsWith(".gov.ph")) return true;
  return TRUSTED.some(t => h === t || h.endsWith(`.${t}`));
}

// simple timeout wrapper
async function fetchWithTimeout(resource, opts = {}) {
  const { timeout = 8000, ...rest } = opts;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try { return await fetch(resource, { ...rest, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// limit concurrency (simple pool)
async function mapLimited(items, limit, fn) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array(Math.min(limit, items.length)).fill(0).map(worker);
  await Promise.allSettled(workers);
  return out;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS).end(); return; }

  try {
    const { query: q = "", max = "8" } = req.query || {};
    const query = String(q).trim();
    const limit = Math.min(parseInt(max, 10) || 8, 12);
    if (!query) { res.writeHead(400, CORS_HEADERS).end(JSON.stringify({ error:"query is required" })); return; }

    // ---- Tier A: CSE
    let source_tier = "CSE";
    let candidates = [];
    try {
      candidates = await cseSearch(query);
    } catch { source_tier = "FALLBACK"; }

    // EARLY FILTER: keep only trusted hosts & dedupe
    const byUrl = new Map();
    for (const c of candidates) {
      const h = hostOf(c.url);
      if (!isTrustedHost(h)) continue;       // drop weak domains early
      if (!byUrl.has(c.url)) byUrl.set(c.url, { title: c.title, url: c.url, host: h });
    }
    let pool = Array.from(byUrl.values());
    // If CSE was empty or all filtered, use fallbacks
    if (pool.length === 0) {
      const fb = await tierBSearch(query);
      const fbByUrl = new Map();
      for (const c of fb) {
        const h = hostOf(c.url);
        if (!isTrustedHost(h)) continue;
        if (!fbByUrl.has(c.url)) fbByUrl.set(c.url, { title:c.title, url:c.url, host:h });
      }
      pool = Array.from(fbByUrl.values());
      if (pool.length > 0) source_tier = "Crossref/OpenAlex/Wikipedia";
    }

    // cap candidates for speed
    pool = pool.slice(0, 16);

    // analyze with limited concurrency and timeouts
    const analyzed = await mapLimited(pool, 4, async (c) => analyzeOne(c));
    const credible = analyzed
      .filter(Boolean)
      .filter(x => x.verdict === "CREDIBLE")
      .sort((a,b) => b.score_total - a.score_total)
      .slice(0, limit);

    res.writeHead(200, CORS_HEADERS).end(JSON.stringify({ query, source_tier, results: credible }));
  } catch (err) {
    res.writeHead(500, CORS_HEADERS).end(JSON.stringify({ error: String(err) }));
  }
}

/* ---------- Providers ---------- */

async function cseSearch(query) {
  const key = process.env.CSE_KEY, cx = process.env.CSE_CX;
  if (!key || !cx) throw new Error("Missing CSE_KEY or CSE_CX");
  const u = new URL("https://www.googleapis.com/customsearch/v1");
  u.searchParams.set("key", key); u.searchParams.set("cx", cx);
  u.searchParams.set("q", query); u.searchParams.set("num", "10");
  const r = await fetchWithTimeout(u, { timeout: 8000 });
  if (r.status === 429) throw new Error("CSE quota");
  if (!r.ok) throw new Error(`CSE HTTP ${r.status}`);
  const j = await r.json();
  return (j.items || []).map(i => ({ title: i.title, url: i.link }));
}

async function tierBSearch(query){
  const map = new Map();
  await addCrossref(query, map);
  await addOpenAlex(query, map);
  await addWikipediaRefs(query, map);
  return [...map.values()];
}
async function addCrossref(q, out){
  try{
    const u = new URL("https://api.crossref.org/works");
    u.searchParams.set("query", q); u.searchParams.set("rows", "15");
    const j = await (await fetchWithTimeout(u, { timeout: 8000 })).json();
    for (const it of (j.message?.items||[])) {
      const doi = it.DOI; const url = it.URL || (doi ? `https://doi.org/${doi}` : null);
      if (!url) continue;
      out.set(url, { title: it.title?.[0] || url, url });
    }
  }catch{}
}
async function addOpenAlex(q,out){
  try{
    const u = new URL("https://api.openalex.org/works");
    u.searchParams.set("search", q); u.searchParams.set("per_page","15");
    const j = await (await fetchWithTimeout(u, { timeout: 8000 })).json();
    for (const it of (j.results||[])) {
      const url = it.primary_location?.source?.hosted_document?.url
        || it.primary_location?.landing_page_url
        || (it.doi ? `https://doi.org/${it.doi}` : null);
      if (!url) continue;
      out.set(url, { title: it.title || url, url });
    }
  }catch{}
}
async function addWikipediaRefs(q,out){
  try{
    const s = new URL("https://en.wikipedia.org/w/api.php");
    s.searchParams.set("action","query"); s.searchParams.set("list","search");
    s.searchParams.set("format","json"); s.searchParams.set("srsearch", q);
    s.searchParams.set("origin","*");
    const sj = await (await fetchWithTimeout(s,{timeout:8000})).json();
    const id = sj.query?.search?.[0]?.pageid; if (!id) return;
    const p = new URL("https://en.wikipedia.org/w/api.php");
    p.searchParams.set("action","parse"); p.searchParams.set("pageid", String(id));
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

/* ---------- Analyze & Score ---------- */

function pick(re, s, group=1){ const m = s.match(re); return m ? (m[group]||"").trim() : ""; }

async function getPageMeta(u){
  try{
    const r = await fetchWithTimeout(u, { redirect:"follow", timeout: 8000 });
    const ct = r.headers.get("content-type") || "";
    if (/pdf/i.test(ct)) { return { url:u, title:"", author:"", published:"", modified:"", publisher: hostOf(u), html:"" }; }
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

// deterministic scoring
function score(name,score,reasons){ return { name, score, reasons }; }

function scorePurpose(meta){
  const reasons=[]; const info=/research|report|method|policy|about/i.test(meta.html);
  const ads=/advert|sponsored/i.test(meta.html);
  let sc=info?5:3; if(ads){ sc=Math.min(sc,3); reasons.push("Ads/sponsorship signals"); }
  reasons.push(info? "Informational/educational signals" : "General content");
  return score("Purpose", sc, reasons);
}
function scoreAuthority(meta, url){
  const h=hostOf(url); const reasons=[];
  if (isTrustedHost(h)){ reasons.push("Government/major organization domain"); return score("Authority",5,reasons); }
  if (meta.author){ reasons.push("Named author present"); return score("Authority",3,reasons); }
  reasons.push("Publisher/author unclear"); return score("Authority",1,reasons);
}
function scoreAudience(){ return score("Audience",3,["General audience language acceptable"]); }
function scoreObjectivity(meta){
  const biased=/opinion|editorial/i.test(meta.html) && !/methods|references|bibliography/i.test(meta.html);
  return biased ? score("Objectivity",3,["Opinion/editorial signals"]) : score("Objectivity",4,["Neutral/balanced tone indicators"]);
}
function scoreAccuracy(meta){
  const doi=(meta.html.match(/doi\.org\/\d+\.\d+\/[^\s"'<)]+/gi)||[]).length;
  const govEdu=(meta.html.match(/https?:\/\/[a-z0-9.-]+\.(gov|edu)(\.[a-z.]+)?\//gi)||[]).length;
  const refs=/References|Citations|Bibliography/i.test(meta.html);
  if (doi+govEdu>=3) return score("Accuracy",5,["Multiple DOI/gov/edu citations"]);
  if (refs || doi+govEdu>=1) return score("Accuracy",3,["Some citations present"]);
  return score("Accuracy",1,["Few/no credible citations"]);
}
function scoreCurrency(meta){
  const t=Date.parse(meta.modified||meta.published||""); if(!isNaN(t)){
    const m=(Date.now()-t)/(1000*60*60*24*30);
    if(m<=18) return score("Currency",5,["Recently published/updated"]);
    if(m<=60) return score("Currency",3,["Acceptably dated"]);
    return score("Currency",1,["Likely outdated"]);
  }
  return score("Currency",1,["No clear date found"]);
}

function formatAPA(meta){
  const { author, published, title, publisher, url } = meta;
  const authorStr = authorNameToAPA(author);
  const d = parseDateYMD(published); const dateStr = d ? apaDateString(d) : "n.d.";
  const titleStr = (title || "(No title)").replace(/\s*[-|–]\s*[^-|–]+$/,'').trim();
  const site = publisher || hostOf(url);
  if (authorStr) return { apa: `${authorStr} (${dateStr}). ${titleStr}. ${site}. ${url}` };
  return { apa: `${titleStr}. (${dateStr}). ${site}. ${url}` };
}
function authorNameToAPA(name){ if(!name) return ""; const n=name.trim(); if(!n) return "";
  if(n.includes(",")){ const [last,rest]=n.split(",",2).map(s=>s.trim());
    const initials=(rest||"").split(/\s+/).filter(Boolean).map(w=>w[0].toUpperCase()+".").join(" ");
    return `${last}, ${initials}`; }
  const parts=n.split(/\s+/).filter(Boolean); if(parts.length===1) return parts[0];
  const last=parts.pop(); const initials=parts.map(w=>w[0].toUpperCase()+".").join(" "); return `${last}, ${initials}`;
}
function parseDateYMD(iso){ if(!iso) return null; const d=new Date(iso); return isNaN(d)?null:d; }
function apaDateString(d){ const m=["January","February","March","April","May","June","July","August","September","October","November","December"]; return `${d.getUTCFullYear()}, ${m[d.getUTCMonth()]} ${d.getUTCDate()}`; }

async function analyzeOne(c){
  // fast-path: if domain is trusted, we can likely pass without heavy content (still try to fetch)
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
  const verdict = total>=25 ? "CREDIBLE" : total>=20 ? "LIMITED" : "NOT_CREDIBLE";
  if (verdict!=="CREDIBLE") return null;
  const { apa } = formatAPA(meta);
  return {
    title: meta.title || c.title || c.url,
    url: c.url,
    publisher: meta.publisher || hostOf(c.url),
    published: meta.published || null,
    score_total: total,
    verdict,
    scores: Object.fromEntries(parts.map(p=>[p.name,p.score])),
    why: parts.flatMap(p=>p.reasons),
    apa
  };
}


