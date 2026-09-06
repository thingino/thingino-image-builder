// Thingino Image Builder — Cloudflare Worker broker (proof of concept).
//
// Ports the core of the Rust/VPS broker onto Cloudflare's free tier:
//   * fetch handler  = the HTTP API (build / status / cancel / stats / defconfigs)
//   * scheduled (cron, every 1 min) = dispatch queued, correlate runs, reap
//   * D1             = the SQLite state (builds / events / settings)
//   * Worker Secret  = GITHUB_TOKEN
//
// The GitHub Actions build (build.yml) and the rolling-release download are
// unchanged. The frontend (GitHub Pages / Cloudflare Pages) calls this over CORS.
//
// Not yet ported here (straightforward follow-ups): admin panel + TOTP 2FA
// (Web Crypto HMAC-SHA1) and GitHub App auth (Web Crypto RS256 JWT).

const WINDOW = 3600;
const DAY = 86400;
// Per-admin privileged actions. Named admins are granted a subset; the master always
// has all of them. Everything else in the admin panel stays open to any admin.
const ADMIN_PRIVS = ["clear_logs", "clear_builds", "reset_limits", "edit_limits", "kill_switch", "manage_users", "edit_notice"];

const nowSec = () => Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();
const validUid = (s) => typeof s === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(s);
const validBuildId = (s) => typeof s === "string" && /^[a-f0-9-]{8,40}$/.test(s);

async function limits(env) {
  const n = (k, d) => parseInt(env[k] || "", 10) || d;
  const base = {
    userHourly: n("PER_USER_HOURLY_LIMIT", 2),
    ipHourly: n("PER_IP_HOURLY_LIMIT", 3),
    globalHourly: n("GLOBAL_HOURLY_LIMIT", 20),
    maxConcurrent: n("MAX_CONCURRENT_BUILDS", 6),
    maxQueue: n("MAX_QUEUE", 50),
    retention: n("RETENTION_SECS", 1800),
    failedRetention: n("FAILED_RETENTION_SECS", 3600),
    buildTimeout: n("BUILD_TIMEOUT_SECS", 5400),
  };
  // Runtime overrides set from the admin UI (D1 settings), layered over the vars.
  const ov = await getSetting(env, "limits");
  if (ov) { try { Object.assign(base, JSON.parse(ov)); } catch (_) {} }
  return base;
}

const assetUrl = (env, id) =>
  `https://github.com/${env.GITHUB_REPO}/releases/download/${env.ROLLING_TAG || "web-builds"}/${id}.bin`;

// ---- CORS + JSON ----------------------------------------------------------
function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-builder-uid,authorization",
    "Vary": "Origin",
  };
}
const json = (obj, status, env) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json", ...cors(env) },
  });

// Bucket the client IP: full v4, /64 for v6 (a user usually owns a whole /64).
function ipBucket(ip) {
  if (!ip) return "v4:0.0.0.0";
  if (ip.includes(":")) {
    const [head, tail = ""] = ip.split("::");
    const h = head ? head.split(":").filter(Boolean) : [];
    const t = tail ? tail.split(":").filter(Boolean) : [];
    const fill = Math.max(0, 8 - h.length - t.length);
    const groups = [...h, ...Array(fill).fill("0"), ...t];
    const px = groups.slice(0, 4).map((g) => (parseInt(g || "0", 16) || 0).toString(16).padStart(4, "0")).join(":");
    return `v6:${px}::/64`;
  }
  return `v4:${ip}`;
}
function resolveUid(request) {
  const h = request.headers.get("x-builder-uid");
  return validUid(h) ? h : uuid();
}
// Per-IP fixed-window request guard via the Durable Object limiter. Returns true
// (allow) when RL_DO is unbound or errors — fail-open, so a limiter hiccup never
// blocks legit users; the D1 hourly caps stay the real build throttle.
async function rlGuard(env, ip, max, period) {
  if (!env.RL_DO) return true;
  try {
    const stub = env.RL_DO.get(env.RL_DO.idFromName(ip));
    const { success } = await (await stub.fetch("https://rl/", {
      method: "POST", body: JSON.stringify({ max, period }),
    })).json();
    return success;
  } catch { return true; }
}

// Per-isolate soft limiter for the cheap read endpoints: a Map in isolate memory,
// zero external calls. Imperfect by design (per-PoP, resets on isolate eviction),
// which is fine — reads are cheap and the D1 free read budget is 5M/day; the strict
// Durable Object stays on /api/build where work is actually expensive.
const RL_LOCAL = new Map(); // ip -> [windowStart, count]
function softGuard(ip, max, period) {
  const now = Date.now() / 1000;
  if (RL_LOCAL.size > 4096) { for (const [k, v] of RL_LOCAL) if (now - v[0] >= period) RL_LOCAL.delete(k); }
  let e = RL_LOCAL.get(ip);
  if (!e || now - e[0] >= period) { e = [now, 0]; RL_LOCAL.set(ip, e); }
  e[1]++;
  return e[1] <= max;
}

// ---- D1 helpers -----------------------------------------------------------
const countQ = async (env, sql, ...args) =>
  ((await env.DB.prepare(sql).bind(...args).first()) || { c: 0 }).c;
const getSetting = async (env, key) => {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return r ? r.value : null;
};
const setSetting = (env, key, value) =>
  env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, value).run();
const logEvent = (env, kind, build_id, uid, ip, detail, ipFull, country, app) =>
  env.DB.prepare("INSERT INTO events(ts,kind,build_id,uid,ip_bucket,ip_full,detail,country,app) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(nowSec(), kind, build_id || null, uid || null, ip || null, ipFull || null, detail || "", country || null, app || null).run();

// Which app a person logged in through, recorded on admin_login_* rows so an audit trail can be
// scoped to one of them. Read this before using it anywhere else: it is asserted by the caller,
// so it is a LABEL. It must never reach an authorization decision and must never change
// behaviour (no per-app throttling, no per-app session TTL). The moment anything forks on it, a
// caller picks its own branch by typing a different word.
//
// Origin first: a browser sets it and page script cannot forge it, so a real browser cannot
// misreport its door. The body field is only the fallback for a caller that sends none. Anything
// outside the allowlist is stored as null rather than kept, so this column cannot be filled with
// arbitrary caller text one row per attempt.
const APP_ALLOW = new Set(["builder", "tb", "tts"]);
const APP_ORIGINS = {
  "https://image-builder.thingino.com": "builder",
  "https://thingino-image-builder-1d2e9b23.thingino.workers.dev": "builder",
  "https://tb.thingino.workers.dev": "tb",
  "https://tts.thingino.workers.dev": "tts",
};
function loginApp(request, body) {
  const byOrigin = APP_ORIGINS[request.headers.get("Origin") || ""];
  if (byOrigin) return byOrigin;
  const claimed = String((body && body.app) || "").toLowerCase();
  return APP_ALLOW.has(claimed) ? claimed : null;
}
// Where the request comes from, for the admin panel's IP columns. Cloudflare geo-tags
// every request at the edge, so this is free: no lookup, no database, no MaxMind. "XX"
// (unknown) and "T1" (Tor) are kept as-is; the panel just shows the code for those.
const reqCountry = (request) => (request.cf && request.cf.country) || null;

// ---- GitHub ---------------------------------------------------------------
function ghHeaders(env, auth) {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "thingino-image-builder-worker",
  };
  if (auth && env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}
// Token for write calls: a GitHub App installation token (so runs are attributed
// to the App/bot, not a personal PAT) when the App is configured, else the static
// GITHUB_TOKEN PAT — dual-mode, like the VPS broker.
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function importRsaKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return crypto.subtle.importKey("pkcs8", b64ToBytes(body), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
async function appJwt(env) {
  const now = nowSec();
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 9 * 60, iss: env.GITHUB_APP_ID })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importRsaKey(env.GITHUB_APP_PRIVATE_KEY), new TextEncoder().encode(data)));
  return `${data}.${b64url(sig)}`;
}
async function installationToken(env) {
  // Worker is stateless → cache the ~1h token in D1; reuse until 5 min before expiry.
  const cached = await getSetting(env, "gh_inst_token");
  const exp = parseInt((await getSetting(env, "gh_inst_token_exp")) || "0", 10);
  if (cached && exp - nowSec() > 300) return cached;
  const r = await fetch(`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST", headers: { ...ghHeaders(env, false), Authorization: `Bearer ${await appJwt(env)}` },
  });
  if (!r.ok) throw new Error(`installation token ${r.status}`);
  const j = await r.json();
  await setSetting(env, "gh_inst_token", j.token);
  await setSetting(env, "gh_inst_token_exp", String(Math.floor(new Date(j.expires_at).getTime() / 1000)));
  return j.token;
}
async function githubToken(env) {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY) {
    try { return await installationToken(env); } catch (_) { /* fall back to the PAT */ }
  }
  return env.GITHUB_TOKEN || null;
}
const ghFetch = async (env, url, opts = {}) => {
  const tok = await githubToken(env);
  return fetch(url, { ...opts, headers: { ...ghHeaders(env, false), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(opts.headers || {}) } });
};

// ---- buildable branches ---------------------------------------------------
// Which of the firmware repo's branches visitors may build from. Chosen in the admin
// panel from the repo's real branch list and kept as ONE settings row, {enabled,default},
// so reading it costs a single row. Only an enabled ref is buildable; anything else falls
// back to the configured default (no arbitrary-ref fetch).
//
// The trio below is the fallback for a broker that has never been configured, or whose row
// is missing/unparseable/empty, so a fresh deploy behaves exactly as it did before this was
// configurable. It is returned as a copy: callers treat the config as theirs.
const REF_FALLBACK = ["master", "ciao", "stable"];
const MAX_REFS = 20;
// A branch name we are willing to put in a settings key, a URL and a CI command line.
// Git's own refname rules, tightened: must start alphanumeric, no "..", no "@{", no "//",
// no trailing separator, no ".lock" component, and a length cap. Membership in `enabled`
// is the real gate — this is the shape check for the places membership cannot be checked
// (see dispatchBuild) and the filter that keeps a hostile settings row inert.
const validRefName = (s) =>
  typeof s === "string" && s.length > 0 && s.length <= 100 &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) &&
  !/\.\.|@\{|\/\/|[./]$|\.lock(\/|$)/.test(s);
async function refConfig(env) {
  const raw = await getSetting(env, "branches");
  if (raw) {
    try {
      const c = JSON.parse(raw);
      const enabled = [...new Set((Array.isArray(c.enabled) ? c.enabled : []).filter(validRefName))].slice(0, MAX_REFS);
      // An empty result means the row said nothing usable, so the built-in set stands:
      // "no branches at all" is never a state a visitor should land in — disabling builds
      // is what the kill switch is for.
      if (enabled.length) return { enabled, default: enabled.includes(c.default) ? c.default : enabled[0] };
    } catch (_) { /* fall through to the built-in set */ }
  }
  return { enabled: [...REF_FALLBACK], default: REF_FALLBACK[0] };
}
const normRefWith = (rc, ref) => (rc.enabled.includes(ref) ? ref : rc.default);

// ---- selectable build options ----------------------------------------------
// The allowlist is the single source of truth (mirrors BUILD_OPTIONS in the Rust
// broker; keep the two in lockstep — a catalog that diverges sends the UI checkboxes
// the other backend rejects). A request may only carry ids this list contains, so
// arbitrary config lines can never reach the build. `defs` holds the Buildroot lines
// the id expands to; the workflow injects them through thingino's user-layer
// local.fragment. `label`/`desc` follow the Buildroot Config.in convention: an
// untagged entry is English, <lang> suffixes are translations, picked by Accept-Language.
const BUILD_OPTIONS = [
  {
    id: "netconsole",
    defs: ["BR2_PACKAGE_THINGINO_UBOOT_NETCONSOLE=y"],
    label: [
      ["", "NetConsole (U-Boot console over UDP)"],
      ["sk", "NetConsole (konzola U-Bootu cez UDP)"],
      ["de", "NetConsole (U-Boot-Konsole über UDP)"],
      ["fr", "NetConsole (console U-Boot sur UDP)"],
      ["es", "NetConsole (consola de U-Boot por UDP)"],
    ],
    desc: [
      ["", "Get an interactive U-Boot prompt over the network instead of the serial port. Needs a board with Ethernet or USB OTG; only effective on branches whose bootloader supports it (ciao, master)."],
      ["sk", "Interaktívna konzola U-Bootu po sieti namiesto sériového portu. Vyžaduje dosku s Ethernetom alebo USB OTG; účinné len na vetvách, ktorých bootloader to podporuje (ciao, master)."],
      ["de", "Interaktive U-Boot-Eingabeaufforderung über das Netzwerk statt der seriellen Schnittstelle. Erfordert ein Board mit Ethernet oder USB OTG; nur wirksam in Zweigen mit unterstützendem Bootloader (ciao, master)."],
      ["fr", "Invitation de commande U-Boot interactive via le réseau au lieu du port série. Nécessite une carte avec Ethernet ou USB OTG ; efficace uniquement sur les branches dont le bootloader le permet (ciao, master)."],
      ["es", "Consola interactiva de U-Boot por red en lugar del puerto serie. Requiere una placa con Ethernet u USB OTG; solo tiene efecto en ramas cuyo bootloader lo admite (ciao, master)."],
    ],
  },
];
const buildOption = (id) => BUILD_OPTIONS.find((o) => o.id === id);
// Localized field: exact lang → untagged (English) → fallback (mirrors the broker's
// build_option_text).
const buildOptionText = (fields, lang, fallback) => {
  const hit = fields.find(([l]) => l === lang) || fields.find(([l]) => l === "");
  return hit ? hit[1] : fallback;
};
// Validate + canonicalise a requested option-id list (mirrors normalize_options):
// unknown ids → "unknown option: <id>" (400), dupes dropped, result sorted and
// comma-joined; null = ok with this canonical string. Empty id strings are ignored,
// not an error, so a trailing comma in a hand-written share link doesn't fail the build.
function normalizeOptions(req) {
  if (!Array.isArray(req)) return { error: null, options: "" };
  const ids = [];
  for (const s of req) {
    if (typeof s !== "string" || s === "") continue;
    if (!buildOption(s)) return { error: `unknown option: ${s}`, options: null };
    if (!ids.includes(s)) ids.push(s);
  }
  return { error: null, options: ids.sort().join(",") };
}
// Canonical options string → the Buildroot lines the workflow injects.
const buildOptionDefs = (options) =>
  options.split(",").filter(buildOption).flatMap((o) => o.defs).join(",");
// Primary language of Accept-Language: first quality-ordered tag, region stripped,
// q<=0 and "*" skipped (mirrors the broker's accept_lang).
function acceptLang(request) {
  const raw = request.headers.get("accept-language") || "";
  let best = null; // [q, tag]
  for (const part of raw.split(",")) {
    const [tagRaw, qRaw] = part.trim().split(";q=");
    const tag = (tagRaw || "").trim();
    if (!tag || tag === "*") continue;
    const q = qRaw !== undefined ? parseFloat(qRaw) : 1;
    if (!(q > 0)) continue;
    if (!best || q > best[0]) best = [q, tag];
  }
  return best ? best[1].split("-")[0].toLowerCase() : "";
}
async function handleBuildOptions(request, env) {
  const lang = acceptLang(request);
  return json(
    BUILD_OPTIONS.map((o) => ({
      id: o.id,
      label: buildOptionText(o.label, lang, o.id),
      desc: buildOptionText(o.desc, lang, ""),
    })),
    200, env
  );
}

// thingino pinned commit + defconfig list, per branch, cached in D1 settings (~5 min).
// `rc` lets a caller that already read the branch config pass it in, so a stats poll
// resolves the ref and reports the list off one read instead of two.
async function resolveThingino(env, ref, rc) {
  ref = normRefWith(rc || (await refConfig(env)), ref);
  const kC = `thingino_commit_${ref}`, kL = `defconfigs_${ref}`, kT = `thingino_ts_${ref}`;
  const ts = parseInt((await getSetting(env, kT)) || "0", 10);
  let commit = await getSetting(env, kC);
  let listJson = await getSetting(env, kL);
  if (commit && listJson && nowSec() - ts < 300) return { commit, list: JSON.parse(listJson) };

  const repo = env.THINGINO_REPO || "themactep/thingino-firmware";
  try {
    const cr = await ghFetch(env, `https://api.github.com/repos/${repo}/commits/${ref}`);
    if (cr.ok) {
      const newCommit = (await cr.json()).sha;
      if (newCommit && newCommit !== commit) {
        const list = await fetchDefconfigs(env, repo, newCommit);
        if (list.length) {
          listJson = JSON.stringify(list);
          await setSetting(env, kL, listJson);
        }
        commit = newCommit;
        await setSetting(env, kC, commit);
      }
      await setSetting(env, kT, String(nowSec()));
    }
  } catch (_) { /* keep last-good */ }
  return { commit: commit || null, list: listJson ? JSON.parse(listJson) : [] };
}
async function fetchDir(env, repo, commit, subdir) {
  const r = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/configs/${subdir}?ref=${commit}`);
  if (!r.ok) return [];
  const arr = await r.json();
  return Array.isArray(arr)
    ? arr.filter((e) => e.type === "dir" && /^[a-z0-9_+]+$/.test(e.name)).map((e) => e.name)
    : [];
}
async function fetchDefconfigs(env, repo, commit) {
  const a = await fetchDir(env, repo, commit, "cameras");
  const b = await fetchDir(env, repo, commit, "cameras-exp");
  return [...new Set([...a, ...b])].sort();
}
// The firmware repo's real branch list, for the admin picker and for validating a save.
// Cached ~5 min in D1 like the commit and defconfig lookups, so opening the panel over and
// over costs one GitHub call rather than one per open. Deliberately a single page: 100
// bounds the parse, and a repo with more branches than that has bigger problems than this
// picker. A failed fetch falls back to the last-good list rather than to "no branches",
// which would otherwise read as "every branch you have enabled no longer exists".
async function repoBranches(env) {
  const cached = await getSetting(env, "gh_branches");
  const ts = parseInt((await getSetting(env, "gh_branches_ts")) || "0", 10);
  const last = () => { try { return cached ? JSON.parse(cached) : []; } catch { return []; } };
  if (cached && nowSec() - ts < 300) return last();
  const repo = env.THINGINO_REPO || "themactep/thingino-firmware";
  try {
    const r = await ghFetch(env, `https://api.github.com/repos/${repo}/branches?per_page=100`);
    if (!r.ok) return last();
    const arr = await r.json();
    const list = Array.isArray(arr) ? [...new Set(arr.map((b) => b && b.name).filter(validRefName))].sort() : [];
    if (!list.length) return last();
    await setSetting(env, "gh_branches", JSON.stringify(list));
    await setSetting(env, "gh_branches_ts", String(nowSec()));
    return list;
  } catch (_) { return last(); }
}

// ---- notice banner --------------------------------------------------------
// An admin-posted banner for the builder page, kept in ONE settings row ({text, level,
// until}) so a stats poll costs a single read. until=0 stays up until cleared; an
// expired notice is filtered here rather than swept, so nothing has to run to hide it.
// The levels are GitHub's five markdown alert types, so the page can borrow a vocabulary
// (and colours) readers already know from every README they've ever opened.
const NOTICE_LEVELS = ["note", "tip", "important", "warning", "caution"];
// The two renamed levels. A notice posted under the old names still renders, and an
// admin page from before the rename can still post, so neither the Worker nor the
// broker has to be updated in lockstep with the static site.
const NOTICE_ALIASES = { info: "note", danger: "caution" };
const normLevel = (l) => {
  const s = NOTICE_ALIASES[l] || l;
  return NOTICE_LEVELS.includes(s) ? s : "note";
};
// The text is admin-typed and lands on a public page, so it is normalised on the way in:
// controls and bidi overrides (which could visually spoof the rest of the banner) become
// spaces, runs of whitespace collapse, and the whole thing is length-capped. The page
// still inserts it as text, never as markup: defence in depth, not the defence.
const cleanNotice = (s) =>
  String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
async function getNotice(env) {
  const raw = await getSetting(env, "notice");
  if (!raw) return null;
  let n;
  try { n = JSON.parse(raw); } catch { return null; }
  if (!n || !n.text) return null;
  if (n.until && n.until <= nowSec()) return null;
  return { text: n.text, level: normLevel(n.level), until: n.until || 0 };
}

// ---- API handlers ---------------------------------------------------------
async function handleDefconfigs(env, ref) {
  const { list } = await resolveThingino(env, ref);
  return json(list, 200, env);
}
async function handleStats(request, env, ref, my) {
  const uid = resolveUid(request);
  // Read once, use twice: resolving the caller's ref and reporting the list to the page.
  const rc = await refConfig(env);
  const { commit } = await resolveThingino(env, ref, rc);
  const cfg = await limits(env);
  const avg = await env.DB.prepare("SELECT avg(finished_ts - dispatched_ts) a FROM builds WHERE (outcome='done' OR (outcome IS NULL AND state='done')) AND finished_ts IS NOT NULL AND dispatched_ts IS NOT NULL").first();
  // The expiry is admin bookkeeping, so the public payload carries only what it renders.
  const notice = await getNotice(env);
  return json({
    running: await countQ(env, "SELECT count(*) c FROM builds WHERE state='running'"),
    queued: await countQ(env, "SELECT count(*) c FROM builds WHERE state='queued'"),
    max_concurrent: cfg.maxConcurrent,
    user_hourly: cfg.userHourly,
    retention_secs: cfg.retention,
    avg_build_secs: avg && avg.a ? Math.round(avg.a) : null,
    builds_enabled: (await getSetting(env, "builds_enabled")) !== "0",
    notice: notice ? { text: notice.text, level: notice.level } : null,
    commit,
    // The branches the page may offer, and which one a visitor who has never chosen gets.
    // The page caches these, so the Settings dialog is populated before the first poll of
    // a return visit; it re-resolves its selection whenever this list changes.
    branches: rc.enabled,
    branch_default: rc.default,
    version: env.VERSION || "v0.1.0",
    uid,
    // Embedded status of the caller's tracked build (?my=<id>), so the page needs one
    // request per poll instead of stats + status. null = unknown/expired-and-purged.
    ...(my ? { my_build: await statusPayload(env, my) } : {}),
  }, 200, env);
}
async function handleBuild(request, env) {
  const rawIp = request.headers.get("CF-Connecting-IP") || "";
  const ip = ipBucket(rawIp);
  // Stricter per-IP build cap on top of the whole-API flood guard (see fetch()):
  // building is the expensive path (it dispatches a CI job).
  if (!(await rlGuard(env, ip, 20, 60)))
    return json({ error: "too many requests from your network — slow down" }, 429, env);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, env); }
  const defconfig = typeof body.defconfig === "string" ? body.defconfig.trim() : "";
  const rc = await refConfig(env);
  const ref = normRefWith(rc, body.ref);
  const { commit, list } = await resolveThingino(env, ref, rc);
  if (!list.includes(defconfig)) return json({ error: "unknown defconfig" }, 400, env);
  // Options are allowlisted ids; the canonical form (sorted, deduped, comma-joined)
  // is what gets stored and dispatched, so (defconfig, commit, options) dedup works
  // regardless of the order the client sent them in. Mirrors the broker's post_build.
  const opt = normalizeOptions(body.options);
  if (opt.error) return json({ error: opt.error }, 400, env);
  const options = opt.options;

  const uid = resolveUid(request);
  const ts = nowSec(), cfg = await limits(env);
  // Hourly window, but never count builds from before an admin "reset limits".
  const resetTs = parseInt((await getSetting(env, "limits_reset_ts")) || "0", 10);
  const cutoff = Math.max(ts - WINDOW, resetTs);

  if ((await getSetting(env, "builds_enabled")) === "0")
    return json({ error: "builds are temporarily disabled during maintenance, check back later" }, 503, env);

  // Dedup: identical (defconfig, commit, options) in flight or done within retention.
  // An image built without NetConsole is not the image a NetConsole request wants.
  if (commit) {
    const e = await env.DB.prepare(
      `SELECT id,state,cancel_requested FROM builds
       WHERE defconfig=? AND commit_sha=? AND COALESCE(options,'')=?
         AND (state IN ('queued','running') OR (state='done' AND finished_ts > ?))
         AND NOT (state='running' AND cancel_requested=1)
       ORDER BY created_ts DESC LIMIT 1`
    ).bind(defconfig, commit, options, ts - cfg.retention).first();
    if (e) {
      await logEvent(env, "dedup", e.id, uid, ip, `reused ${e.state} for ${defconfig}`, rawIp, reqCountry(request));
      const st = e.state === "running" && e.cancel_requested ? "cancelling" : e.state;
      return json({
        build_id: e.id, defconfig, options, state: st, deduped: true,
        download_url: st === "done" ? assetUrl(env, e.id) : null,
        status_url: `/api/status/${e.id}`, commit,
      }, 200, env);
    }
  }

  if ((await countQ(env, "SELECT count(*) c FROM builds WHERE state='queued'")) >= cfg.maxQueue)
    return json({ error: "the build queue is full, try again shortly" }, 503, env);

  const notCancelledUndispatched = "NOT (state='cancelled' AND dispatched_ts IS NULL)";
  // Atomic rate-limit + insert: the global/user/IP caps are guard subqueries on the
  // INSERT, so a concurrent burst can't slip past separate check-then-insert reads.
  const id = uuid();
  const ins = await env.DB.prepare(
    `INSERT INTO builds(id,uid,ip_bucket,ip_full,defconfig,state,created_ts,commit_sha,ref,country,options)
     SELECT ?,?,?,?,?,'queued',?,?,?,?,?
     WHERE (SELECT count(*) FROM builds WHERE created_ts > ? AND ${notCancelledUndispatched}) < ?
       AND (SELECT count(*) FROM builds WHERE uid=? AND created_ts > ? AND ${notCancelledUndispatched}) < ?
       AND (SELECT count(*) FROM builds WHERE ip_bucket=? AND created_ts > ? AND ${notCancelledUndispatched}) < ?`
  ).bind(
    id, uid, ip, rawIp, defconfig, ts, commit, ref, reqCountry(request), options,
    cutoff, cfg.globalHourly,
    uid, cutoff, cfg.userHourly,
    ip, cutoff, cfg.ipHourly,
  ).run();
  if ((ins.meta?.changes ?? 0) === 0) {
    // Capped — re-run the cheap individual counts to pick which 429 message applies.
    // No durable event per rejection: that INSERT is a one-way amplified write a
    // flood can use to exhaust the D1 write budget (audit H2). The flood guard +
    // the 429 are the signal; the re-check reads below only pick the message.
    if ((await countQ(env, `SELECT count(*) c FROM builds WHERE created_ts > ? AND ${notCancelledUndispatched}`, cutoff)) >= cfg.globalHourly)
      return json({ error: `the builder is at its hourly limit (${cfg.globalHourly}/hr) — try again later` }, 429, env);
    if ((await countQ(env, `SELECT count(*) c FROM builds WHERE uid=? AND created_ts > ? AND ${notCancelledUndispatched}`, uid, cutoff)) >= cfg.userHourly)
      return json({ error: `you've reached ${cfg.userHourly} builds this hour — try again later` }, 429, env);
    return json({ error: "too many builds from your network this hour — try again later" }, 429, env);
  }
  await logEvent(env, "queued", id, uid, ip, options ? `${defconfig} [${options}]` : defconfig, rawIp, reqCountry(request));

  // Inline dispatch: if a slot is free, fire the build NOW rather than waiting for
  // the next cron tick. The cron is only a fallback/reconciler for the rest.
  let state = "queued", position = 0;
  if ((await countQ(env, "SELECT count(*) c FROM builds WHERE state='running'")) < cfg.maxConcurrent) {
    // Claim-then-act: atomically flip queued→running so the cron can't grab the same
    // row mid-dispatch. Only dispatch if we won the claim.
    const claim = await env.DB.prepare("UPDATE builds SET state='running', dispatched_ts=? WHERE id=? AND state='queued' AND (SELECT count(*) FROM builds WHERE state='running') < ?").bind(nowSec(), id, cfg.maxConcurrent).run();
    if ((claim.meta?.changes ?? 0) === 1) {
      try {
        await dispatchBuild(env, id, defconfig, commit, ref, options);
        await logEvent(env, "dispatched", id, uid, ip, defconfig);
        state = "running";
      } catch (_) {
        // dispatch failed — release the claim so the cron retries it.
        await env.DB.prepare("UPDATE builds SET state='queued', dispatched_ts=NULL WHERE id=?").bind(id).run();
      }
    }
  }
  if (state === "queued") position = await countQ(env, "SELECT count(*) c FROM builds WHERE state='queued'");
  return json({ build_id: id, defconfig, options, state, position, status_url: `/api/status/${id}`, download_url: assetUrl(env, id), commit }, 202, env);
}
// One build's public status object, shared by /api/status and /api/stats?my= (the
// page piggybacks its own build's status on the stats poll: one request, not two).
// Returns null for an invalid or unknown id.
async function statusPayload(env, id) {
  if (!validBuildId(id)) return null;
  const b = await env.DB.prepare(
    "SELECT defconfig,state,created_ts,dispatched_ts,finished_ts,cancel_requested,COALESCE(options,'') AS options FROM builds WHERE id=?"
  ).bind(id).first();
  if (!b) return null;
  const ts = nowSec();
  const state = b.state === "running" && b.cancel_requested ? "cancelling" : b.state;
  let position = 0;
  if (state === "queued")
    position = await countQ(env, "SELECT count(*) c FROM builds WHERE state='queued' AND created_ts <= ?", b.created_ts);
  let elapsed = 0;
  if (state === "running" || state === "cancelling") elapsed = b.dispatched_ts ? ts - b.dispatched_ts : 0;
  else if (state === "queued") elapsed = ts - b.created_ts;
  else if (b.finished_ts && b.dispatched_ts) elapsed = b.finished_ts - b.dispatched_ts;
  const ready = state === "done";
  return { build_id: id, defconfig: b.defconfig, options: b.options || "", state, ready, position, elapsed_secs: elapsed, download_url: ready ? assetUrl(env, id) : null };
}
async function handleStatus(id, env) {
  if (!validBuildId(id)) return json({ error: "bad build_id" }, 400, env);
  const p = await statusPayload(env, id);
  if (!p) return json({ error: "unknown build" }, 404, env);
  return json(p, 200, env);
}
// Shared cancel: queued → cancelled; running → cancel_requested + stop the GitHub
// run inline if we can find it (the cron retries otherwise). Returns the new state.
async function doCancel(env, b, id, uid) {
  if (b.state === "queued") {
    await env.DB.prepare("UPDATE builds SET state='cancelled', outcome='cancelled', finished_ts=? WHERE id=?").bind(nowSec(), id).run();
    await logEvent(env, "cancelled", id, uid, null, "cancelled while queued");
    return "cancelled";
  }
  if (b.state === "running") {
    await env.DB.prepare("UPDATE builds SET cancel_requested=1 WHERE id=?").bind(id).run();
    let note = "cancel queued (run not yet listed)";
    try {
      const runs = await fetchRuns(env);
      const m = runs.find((r) => (b.run_id && r.run_id === b.run_id) || r.name.includes(id));
      if (m) {
        await cancelRun(env, m.run_id);
        await env.DB.prepare("UPDATE builds SET run_id=? WHERE id=?").bind(m.run_id, id).run();
        note = "cancel sent to run";
      }
    } catch (_) { /* cron will retry */ }
    await logEvent(env, "cancel_requested", id, uid, null, note);
    return "cancelling";
  }
  return "already finished";
}
async function handleCancel(id, request, env) {
  if (!validBuildId(id)) return json({ error: "bad build_id" }, 400, env);
  const uid = resolveUid(request);
  const b = await env.DB.prepare("SELECT uid,state,run_id FROM builds WHERE id=?").bind(id).first();
  if (!b) return json({ error: "unknown build" }, 404, env);
  if (b.uid !== uid) return json({ error: "not your build" }, 403, env);
  return json({ state: await doCancel(env, b, id, uid) }, 200, env);
}
async function handleAdminCancel(id, request, env) {
  if (!(await sessionAdmin(request, env))) return json({ error: "admin auth required" }, 401, env);
  if (!validBuildId(id)) return json({ error: "bad build_id" }, 400, env);
  const b = await env.DB.prepare("SELECT uid,state,run_id FROM builds WHERE id=?").bind(id).first();
  if (!b) return json({ error: "unknown build" }, 404, env);
  await logEvent(env, "admin_cancel", id, b.uid, null, `admin cancelled (was ${b.state})`);
  return json({ state: await doCancel(env, b, id, b.uid) }, 200, env);
}
// Admin: remove a finished build's artifact + Actions run early (the reaper's job, on demand).
async function handleAdminExpire(id, request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "clear_builds"))) return json({ error: "not permitted" }, 403, env);
  if (!validBuildId(id)) return json({ error: "bad build_id" }, 400, env);
  const b = await env.DB.prepare("SELECT uid,state,run_id FROM builds WHERE id=?").bind(id).first();
  if (!b) return json({ error: "unknown build" }, 404, env);
  if (!["done", "failed", "cancelled"].includes(b.state)) return json({ error: "build is not finished" }, 400, env);
  const assetOk = b.state === "done" ? await deleteReleaseAssets(env, id) : true;
  const runOk = b.run_id ? await deleteRun(env, b.run_id) : true;
  if (!(assetOk && runOk)) return json({ error: "GitHub cleanup failed; the cron will retry" }, 502, env);
  await env.DB.prepare("UPDATE builds SET state='expired' WHERE id=?").bind(id).run();
  await logEvent(env, "expired", id, b.uid, null, "admin removed early");
  return json({ ok: true, state: "expired" }, 200, env);
}

// ---- scheduler (cron) -----------------------------------------------------
async function dispatchBuild(env, id, defconfig, commit, ref, options) {
  // ref rides along so CI can pick the matching upstream ccache channel and name the
  // build branch; the workflow re-validates its shape before it reaches a command line.
  //
  // Shape-checked here, NOT re-checked against the enabled set. A queued build carries the
  // branch it was created for, and an admin who removes that branch between queue and
  // dispatch must not silently turn it into a build of a different one: the commit is
  // already pinned, so coercing the name would only mislabel what CI actually builds.
  const cp = { build_id: id, defconfig, ref: validRefName(ref) ? ref : REF_FALLBACK[0] };
  if (commit) cp.commit = commit;
  // Canonical option ids + the config lines they expand to, comma-joined so the
  // workflow can inject them into a local.fragment without any JSON parsing. Only
  // allowlisted ids are ever here (normalized at request time), and the workflow
  // re-validates both strings' shapes before touching a file.
  if (options) {
    cp.options = options;
    cp.option_defs = buildOptionDefs(options);
  }
  const r = await ghFetch(env, `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event_type: "web-build", client_payload: cp }),
  });
  if (!r.ok) throw new Error(`dispatch ${r.status}`);
}
// Newest 50 dispatch runs. Failed runs linger here for FAILED_RETENTION_SECS, so the
// list can in principle overflow, but do NOT raise this to 100: each run object is ~13 KB
// of JSON we mostly discard, and a full page is ~1.3 MB to parse against the free plan's
// 10 ms CPU per invocation (cron included). Overflowing 50 force-fails one build at its
// timeout; overflowing the CPU budget kills the whole tick, and reaping is what drains
// the pile, so that would not recover. Overflow needs ~34 failures inside one 8h window.
async function fetchRuns(env) {
  const r = await ghFetch(env, `https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs?per_page=50&event=repository_dispatch`);
  if (!r.ok) return [];
  return ((await r.json()).workflow_runs || []).map((x) => ({
    run_id: x.id, name: x.name || x.display_title || "", status: x.status || "", conclusion: x.conclusion || null,
  }));
}
// Does the rolling release already carry this build's image? Asked only on the timeout
// path, where the alternative is calling a build failed on the strength of a clock. A
// published .bin means CI finished the job whatever our bookkeeping says, so this is the
// more authoritative answer, and it costs one request.
async function releaseHasAsset(env, id) {
  try {
    const r = await ghFetch(env, `https://api.github.com/repos/${env.GITHUB_REPO}/releases/tags/${env.ROLLING_TAG || "web-builds"}`);
    if (!r.ok) return false;
    return ((await r.json()).assets || []).some((a) => a.name === `${id}.bin`);
  } catch { return false; }
}
const cancelRun = (env, runId) =>
  ghFetch(env, `https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
async function deleteRun(env, runId) {
  try {
    const r = await ghFetch(env, `https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${runId}`, { method: "DELETE" });
    return r.ok || r.status === 404;
  } catch { return false; }
}
async function deleteReleaseAssets(env, id) {
  try {
    const r = await ghFetch(env, `https://api.github.com/repos/${env.GITHUB_REPO}/releases/tags/${env.ROLLING_TAG || "web-builds"}`);
    if (r.status === 404) return true;
    if (!r.ok) return false;
    const v = await r.json();
    const targets = [`${id}.bin`, `${id}.bin.sha256sum`];
    let ok = true;
    for (const a of v.assets || []) {
      if (targets.includes(a.name)) {
        const d = await ghFetch(env, `https://api.github.com/repos/${env.GITHUB_REPO}/releases/assets/${a.id}`, { method: "DELETE" });
        if (!(d.ok || d.status === 404)) ok = false;
      }
    }
    return ok;
  } catch { return false; }
}

// How long a tick may be missing before request traffic runs one instead. Cron is a
// 1-minute trigger, so this is two missed windows: long enough that a slow tick or a
// clock skew never trips it, short enough that a watching visitor sees their build
// finish within a poll or two of the run actually ending.
const TICK_STALE_SECS = 120;

// The cron is Cloudflare's to fire, and on 2026-09-02 it silently stopped for four hours
// while fetch traffic kept flowing normally: no scheduled invocation in the tail, the
// trigger still registered, the script untouched for three weeks. Nothing else moves a
// build along, so finished runs sat in 'running' forever, the queue never drained and the
// reaper never ran. So the polling endpoints carry a fallback clock: when the last
// completed tick is older than the window above, the request runs one. The D1 lease below
// is what keeps a hundred concurrent pollers to a single tick.
async function maybeTick(env) {
  try {
    const last = parseInt((await getSetting(env, "tick_last_ok")) || "0", 10);
    if (nowSec() - last <= TICK_STALE_SECS) return;
    await schedulerStep(env, "fetch");
  } catch (e) {
    console.error("maybeTick failed:", e);
  }
}
// Records that a tick actually completed, and logs the changeover when the clock driving
// them switches. That transition is the only trace a cron outage leaves in the panel, so
// it is an event; the per-tick timestamp is not (an event a minute would bury the log).
async function noteTick(env, ts, source) {
  const prev = await getSetting(env, "tick_source");
  await setSetting(env, "tick_last_ok", String(ts));
  if (prev === source) return;
  await setSetting(env, "tick_source", source);
  await logEvent(env, source === "fetch" ? "cron_stalled" : "cron_resumed", null, null, null,
    source === "fetch" ? "no cron tick in the last window; ticking from request traffic" : "cron trigger firing again");
}
async function schedulerStep(env, source) {
  const ts = nowSec();
  // Advisory D1 lease so overlapping cron ticks don't double-process (best-effort).
  // The 50s lease auto-expires before the next 1-min tick if a run dies mid-flight.
  const lock = parseInt((await getSetting(env, "cron_lock")) || "0", 10);
  if (lock > ts) return;
  await setSetting(env, "cron_lock", String(ts + 50));
  try {
    // A fetch-driven tick skips the cache warming: it is an optimisation for the request
    // path, and the request that triggered this tick has just resolved its own ref anyway.
    // Reconciling, dispatching and reaping are the parts that must not stop.
    await schedulerWork(env, ts, source !== "fetch");
    await noteTick(env, ts, source || "cron");
  } catch (e) {
    // Surface recurring failures instead of letting waitUntil swallow them silently.
    console.error("schedulerStep failed:", e);
    try { await logEvent(env, "cron_error", null, null, null, String((e && e.message) || e)); } catch (_) {}
  } finally {
    try { await setSetting(env, "cron_lock", "0"); } catch (_) {}
  }
}
async function schedulerWork(env, ts, warm) {
  const cfg = await limits(env);
  // Warm the per-branch commit + defconfig caches so visitors rarely pay the GitHub
  // round-trip inline. This used to warm every branch, which was safe while there were
  // exactly three of them; the list is admin-editable now, so it warms the default (where
  // most visitors land) plus one other per tick, rotated by the clock so no cursor has to
  // be stored. A ref left cold just means the next request for it refreshes it itself,
  // which is already what happens whenever its 5 min TTL lapses.
  if (warm) {
    const rc = await refConfig(env);
    const others = rc.enabled.filter((r) => r !== rc.default);
    for (const r of [rc.default, ...(others.length ? [others[Math.floor(ts / 60) % others.length]] : [])])
      await resolveThingino(env, r, rc);
  }

  const running = ((await env.DB.prepare("SELECT id,run_id,dispatched_ts,cancel_requested FROM builds WHERE state='running'").all()).results) || [];
  const slots = Math.max(0, cfg.maxConcurrent - running.length);
  const queued = slots > 0
    ? ((await env.DB.prepare("SELECT id,defconfig,commit_sha,ref,COALESCE(options,'') AS options FROM builds WHERE state='queued' ORDER BY created_ts ASC LIMIT ?").bind(slots).all()).results) || []
    : [];

  const runs = running.length ? await fetchRuns(env) : [];

  for (const b of running) {
    const m = runs.find((r) => (b.run_id && r.run_id === b.run_id) || r.name.includes(b.id));
    if (b.cancel_requested) {
      if (m && m.status === "completed") {
        await deleteRun(env, m.run_id);
        await env.DB.prepare("UPDATE builds SET state='cancelled', outcome='cancelled', finished_ts=?, run_id=NULL WHERE id=?").bind(ts, b.id).run();
        await logEvent(env, "cancelled", b.id, null, null, "run stopped + deleted");
      } else if (m) {
        await cancelRun(env, m.run_id);
        // Backstop: if the run won't stop within the build timeout, force-finish it so
        // it can't pin a concurrency slot indefinitely.
        if (ts - (b.dispatched_ts || ts) > cfg.buildTimeout) {
          await deleteRun(env, m.run_id);
          await env.DB.prepare("UPDATE builds SET state='cancelled', outcome='cancelled', finished_ts=?, run_id=NULL WHERE id=?").bind(ts, b.id).run();
          await logEvent(env, "cancelled", b.id, null, null, "force-cancelled at timeout");
        }
      } else if (b.dispatched_ts && ts - b.dispatched_ts > 180) {
        // Give up only after a grace window — otherwise we'd orphan a run that
        // simply hasn't appeared in the runs list yet.
        await env.DB.prepare("UPDATE builds SET state='cancelled', outcome='cancelled', finished_ts=? WHERE id=?").bind(ts, b.id).run();
        await logEvent(env, "cancelled", b.id, null, null, "cancelled (run not found after grace)");
      }
      // else: stay 'cancelling' and retry next tick
      continue;
    }
    if (m) {
      if (!b.run_id) await env.DB.prepare("UPDATE builds SET run_id=? WHERE id=?").bind(m.run_id, b.id).run();
      if (m.status === "completed") {
        const st = m.conclusion === "success" ? "done" : m.conclusion === "cancelled" ? "cancelled" : "failed";
        // Guard on state='running' so two overlapping cron ticks can't both apply the
        // transition (which would double-count total_done + duplicate GitHub cleanup).
        const fin = await env.DB.prepare("UPDATE builds SET state=?, outcome=?, finished_ts=? WHERE id=? AND state='running'").bind(st, st, ts, b.id).run();
        if ((fin.meta?.changes ?? 0) === 1) {
          // All-time count of successful builds. Lives in settings, so it survives the
          // reaper + clear-logs + clear-builds (which only touch builds/events).
          if (st === "done") await env.DB.prepare("INSERT INTO settings(key,value) VALUES('total_done','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
          await logEvent(env, st, b.id, null, null, `run ${m.run_id} ${m.conclusion || "?"}`);
        }
      } else if (ts - (b.dispatched_ts || ts) > cfg.buildTimeout) {
        // Run is listed but still in-progress past the timeout — stop it and fail the build.
        await cancelRun(env, m.run_id);
        await env.DB.prepare("UPDATE builds SET state='failed', outcome='failed', finished_ts=?, run_id=? WHERE id=?").bind(ts, m.run_id, b.id).run();
        await logEvent(env, "failed", b.id, null, null, `timed out after ${cfg.buildTimeout}s (run cancelled)`);
      }
    } else if (ts - (b.dispatched_ts || ts) > cfg.buildTimeout) {
      // No run under this id and the clock has run out. Before calling it failed, ask the
      // release: when ticks stop for longer than the timeout, a build that succeeded and
      // published its image comes back here looking exactly like one that never ran, and
      // failing it would throw away a finished image the requester is still waiting for.
      const shipped = await releaseHasAsset(env, b.id);
      const st = shipped ? "done" : "failed";
      const fin = await env.DB.prepare("UPDATE builds SET state=?, outcome=?, finished_ts=? WHERE id=? AND state='running'").bind(st, st, ts, b.id).run();
      if ((fin.meta?.changes ?? 0) === 1) {
        if (shipped) await env.DB.prepare("INSERT INTO settings(key,value) VALUES('total_done','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
        await logEvent(env, st, b.id, null, null, shipped ? "run not listed, but its image is published" : "timed out / run not found");
      }
    }
  }

  for (const q of queued) {
    // Claim-then-act: atomically flip queued→running so an inline dispatch (or another
    // overlapping tick) can't grab the same row. Skip if we didn't win the claim.
    const claim = await env.DB.prepare("UPDATE builds SET state='running', dispatched_ts=? WHERE id=? AND state='queued' AND (SELECT count(*) FROM builds WHERE state='running') < ?").bind(nowSec(), q.id, cfg.maxConcurrent).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;
    try {
      await dispatchBuild(env, q.id, q.defconfig, q.commit_sha, q.ref, q.options);
      await logEvent(env, "dispatched", q.id, null, null, q.defconfig);
    } catch (_) {
      // Release the claim back to queued, count the attempt, and fail after 3 tries.
      await env.DB.prepare("UPDATE builds SET state='queued', dispatched_ts=NULL, attempts=attempts+1 WHERE id=?").bind(q.id).run();
      const at = ((await env.DB.prepare("SELECT attempts FROM builds WHERE id=?").bind(q.id).first()) || { attempts: 0 }).attempts;
      if (at >= 3) {
        await env.DB.prepare("UPDATE builds SET state='failed', outcome='failed', finished_ts=? WHERE id=?").bind(nowSec(), q.id).run();
        await logEvent(env, "failed", q.id, null, null, "dispatch failed 3x");
      }
    }
  }

  const reap = ((await env.DB.prepare("SELECT id,state,run_id,finished_ts FROM builds WHERE state IN ('done','failed','cancelled') AND finished_ts IS NOT NULL ORDER BY finished_ts ASC").all()).results) || [];
  // Each reap costs up to three GitHub calls (release lookup, asset delete, run delete)
  // against a 50-subrequest ceiling per invocation, and a backlog builds up whenever ticks
  // stop for a while. Oldest first, a few per tick: the queue drains over the next few
  // minutes instead of one tick trying to clear it all and dying halfway through.
  let budget = 8;
  for (const b of reap) {
    if (budget <= 0) break;
    const age = ts - b.finished_ts;
    // A failed build holds its Actions run (and so its logs) for the longer window, so an
    // admin can still open the run from the panel and see what broke. done and cancelled
    // reap on the short one: a cancelled build's run was already deleted by the cancel path.
    const expired = age > (b.state === "failed" ? cfg.failedRetention : cfg.retention);
    if (!expired) continue;
    budget--;
    // A cancelled build can still have an artifact: the run publishes the image as its
    // last step, and someone who cancels a build the page still shows as running (which
    // is what a stalled tick looks like from outside) cancels a run that already uploaded.
    // Observed on 2026-09-02: cc2e82d5 published at 05:20, was cancelled at 05:47, and its
    // 16 MB .bin outlived every row that referred to it. So cancelled sweeps its assets
    // too; the lookup 404s harmlessly when there was nothing to publish. Only a failed
    // build is exempt, its run dies before the upload step.
    const assetOk = b.state === "failed" ? true : await deleteReleaseAssets(env, b.id);
    const runOk = b.run_id ? await deleteRun(env, b.run_id) : true;
    if (assetOk && runOk) {
      await env.DB.prepare("UPDATE builds SET state='expired' WHERE id=?").bind(b.id).run();
      await logEvent(env, "expired", b.id, null, null, `reaped ${b.state}`);
    }
  }

  await env.DB.prepare("DELETE FROM builds WHERE state='expired' AND finished_ts < ?").bind(ts - 7 * DAY).run();
  await env.DB.prepare("DELETE FROM events WHERE ts < ?").bind(ts - 7 * DAY).run();
}

// ---- admin (TOTP 2FA + sessions in D1) ------------------------------------
// Sliding inactivity timeout: any authenticated admin request refreshes the session;
// one idle for this long is dropped. The 8h TTL set at login stays the absolute cap.
// The admin page enforces the same window client-side on real user input, so its 10s
// stats poll can't keep an abandoned-but-visible tab logged in forever (admin.js).
const SESSION_IDLE_SECS = 2 * 3600;
function ctEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s.trim().toUpperCase()) {
    if (ch === "=" || ch === " ") continue;
    const i = A.indexOf(ch);
    if (i < 0) return null;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}
async function hotp(secret, counter) {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 2 ** 32));
  dv.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = mac[19] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return bin % 1000000;
}
async function totpCheck(secretB32, code) {
  if (!/^[0-9]{6}$/.test(code)) return false;
  const secret = base32Decode(secretB32);
  if (!secret) return false;
  const want = parseInt(code, 10);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (const c of [step - 1, step, step + 1]) if ((await hotp(secret, c)) === want) return true;
  return false;
}
// Like totpCheck, but returns the matching 30s step counter (for single-use anti-replay)
// instead of a bool — or null if nothing in the ±1 window matches / bad input.
async function totpStep(secretB32, code) {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  if (!secret) return null;
  const want = parseInt(code, 10);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (const c of [step - 1, step, step + 1]) if ((await hotp(secret, c)) === want) return c;
  return null;
}
// --- account helpers: randomness, base32 encode, base64, PBKDF2 password hashing ---
const randBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const randToken = () => [...randBytes(24)].map((b) => b.toString(16).padStart(2, "0")).join("");
function base32Encode(bytes) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0, out = "";
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += A[(val >> bits) & 31]; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
const newTotpSecret = () => base32Encode(randBytes(20));
// ---- TOTP secret sealing (AES-256-GCM, key = Worker secret TOTP_ENC_KEY) ----------
// 2FA seeds used to sit in D1 as plaintext base32, so a database read could mint valid
// codes and bypass the second factor entirely. Sealed rows are "enc1.<ivB64>.<ctB64>";
// base32 has no dot, so legacy plaintext rows are unambiguous and keep working (each
// re-seals on its owner's next successful login). With the key absent: plaintext rows
// still verify and new secrets are written plaintext, so deploy order can't brick login;
// sealed rows fail closed, because decrypting them needs the key by design.
async function totpEncKey(env) {
  if (!env.TOTP_ENC_KEY) return null;
  let raw;
  try { raw = b64ToBytes(env.TOTP_ENC_KEY); } catch { return null; }
  if (raw.length !== 32) return null;
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function sealTotp(env, secretB32) {
  const k = await totpEncKey(env);
  if (!k) return secretB32;
  const iv = randBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(secretB32)));
  return `enc1.${bytesToB64(iv)}.${bytesToB64(ct)}`;
}
// The stored secret back as plaintext base32, or null when it can't be recovered
// (sealed row + missing/wrong key, or tampered ciphertext -> GCM auth failure).
async function openTotp(env, stored) {
  const s = String(stored || "");
  if (!s.startsWith("enc1.")) return s || null;
  const k = await totpEncKey(env);
  if (!k) return null;
  const [, ivB64, ctB64] = s.split(".");
  if (!ivB64 || !ctB64) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64) }, k, b64ToBytes(ctB64));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}
const bytesToB64 = (u8) => btoa(String.fromCharCode(...u8));
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// Do NOT raise this on the Worker. One PBKDF2 verify at 100k already costs ~24ms, and the
// Cloudflare free plan bills CPU time with a ~10ms target (measured tolerance ~26ms); every
// login pays it. 600k (OWASP's number) would be ~120ms and trip the CPU limit (login 1102s)
// and burn the CPU budget. The VPS broker, which has no per-request CPU cap, uses 600k. Each
// hash records its own iteration count, so raising the broker's value stays compatible here.
const PBKDF2_ITERS = 100000;
// A fixed, well-formed dummy hash ("iters.saltB64.hashB64") to verify against when an
// admin row is missing/disabled/unenrolled, so login timing can't enumerate usernames.
const DUMMY_PW_HASH = `${PBKDF2_ITERS}.${bytesToB64(new Uint8Array(16))}.${bytesToB64(new Uint8Array(32))}`;
async function pbkdf2(password, salt, iters) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" }, key, 256));
}
// Stored as "iters.saltB64.hashB64" so the work factor can change without breaking old hashes.
async function hashPassword(password) {
  const salt = randBytes(16);
  return `${PBKDF2_ITERS}.${bytesToB64(salt)}.${bytesToB64(await pbkdf2(password, salt, PBKDF2_ITERS))}`;
}
async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [iters, saltB64, hashB64] = stored.split(".");
  if (!iters || !saltB64 || !hashB64) return false;
  return ctEq(bytesToB64(await pbkdf2(password, b64ToBytes(saltB64), parseInt(iters, 10))), hashB64);
}
const bearer = (request) => {
  const a = request.headers.get("authorization") || "";
  return a.startsWith("Bearer ") ? a.slice(7) : "";
};
// Sessions are stored as the hex SHA-256 of the bearer token, so D1 never holds a value
// that opens an admin session and a database read can't replay one. The raw token exists
// only in the login response and the admin's browser. (Deploying this invalidates rows
// created before it: a presented token hashes to 64 hex chars and never matches a stored
// raw uuid, so pre-change sessions just fail auth and the sweep deletes them at expiry.)
const tokenHash = async (t) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
// Returns the session's admin identity ("master" or a username), or null.
async function sessionAdmin(request, env) {
  const tok = bearer(request);
  if (!tok) return null;
  const th = await tokenHash(tok);
  const t = nowSec();
  await env.DB.prepare("DELETE FROM sessions WHERE expires <= ? OR last_active <= ?").bind(t, t - SESSION_IDLE_SECS).run();
  const r = await env.DB.prepare("SELECT admin,expires,last_active FROM sessions WHERE token=?").bind(th).first();
  // Fail closed: a null/empty stored admin must NOT default to "master" (master login
  // sets identity="master" explicitly, so the master path is unaffected).
  if (!(r && r.expires > t && r.last_active > t - SESSION_IDLE_SECS && r.admin)) return null;
  // Revocation is authoritative: a named admin's session is valid only while their
  // account still exists and isn't disabled (master is env-based, always valid).
  if (r.admin !== "master") {
    const a = await env.DB.prepare("SELECT disabled FROM admins WHERE username=?").bind(r.admin).first();
    if (!a || a.disabled) return null;
  }
  // Slide the inactivity window; at most one write a minute so the admin page's
  // 10s stats poll doesn't burn D1 writes.
  if (t - r.last_active >= 60) await env.DB.prepare("UPDATE sessions SET last_active=? WHERE token=?").bind(t, th).run();
  return r.admin;
}
// Does this admin identity hold a given privilege? The master always does (root); a
// named admin only if it's in their granted set. Unknown user / bad JSON → false.
async function adminCan(env, who, priv) {
  if (who === "master") return true;
  if (!who) return false;
  const a = await env.DB.prepare("SELECT privileges FROM admins WHERE username=?").bind(who).first();
  try { return !!(a && a.privileges) && JSON.parse(a.privileges).includes(priv); } catch { return false; }
}

async function handleAdminLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, env); }
  const rawIp = request.headers.get("CF-Connecting-IP") || "";
  const ip = ipBucket(rawIp);
  const app = loginApp(request, body);
  const fails = await countQ(env, "SELECT count(*) c FROM events WHERE kind='admin_login_fail' AND ip_bucket=? AND ts > ?", ip, nowSec() - 900);
  if (fails >= 10) {
    await logEvent(env, "admin_login_throttled", null, null, ip, "too many failed logins", rawIp, reqCountry(request), app);
    return json({ error: "too many attempts — try again later" }, 429, env);
  }
  const totp = String(body.totp || "").trim();
  let identity = null;
  if (body.username) {
    // Named admin: username + password + their own TOTP (all enforced).
    const u = String(body.username).toLowerCase();
    const a = await env.DB.prepare("SELECT pw_hash,totp_secret,disabled,last_totp_step FROM admins WHERE username=?").bind(u).first();
    // Always pay the PBKDF2 cost — verify against a dummy hash when the user is absent/
    // disabled/unenrolled — so response time doesn't reveal whether the username exists.
    const usable = a && !a.disabled && a.pw_hash;
    const pwOk = await verifyPassword(String(body.password || ""), usable ? a.pw_hash : DUMMY_PW_HASH);
    if (usable && pwOk) {
      // Single-use TOTP: the code's 30s step must be strictly newer than the last we accepted.
      const secret = await openTotp(env, a.totp_secret);
      const step = secret ? await totpStep(secret, totp) : null;
      if (step !== null && step > (a.last_totp_step || 0)) {
        identity = u;
        await env.DB.prepare("UPDATE admins SET last_login=?, last_totp_step=? WHERE username=?").bind(nowSec(), step, u).run();
        // Opportunistic seal: a plaintext legacy secret is re-written encrypted the first
        // time its owner logs in after the key exists. One write, once per account.
        if (env.TOTP_ENC_KEY && !String(a.totp_secret).startsWith("enc1."))
          await env.DB.prepare("UPDATE admins SET totp_secret=? WHERE username=?").bind(await sealTotp(env, secret), u).run();
      }
    }
  } else if (env.ADMIN_TOKEN && env.ADMIN_TOTP_SECRET) {
    // Master break-glass: token + master TOTP (a Worker secret, independent of D1).
    const mstep = await totpStep(env.ADMIN_TOTP_SECRET, totp);
    const mlast = parseInt((await getSetting(env, "master_totp_step")) || "0", 10);
    if (ctEq(String(body.token || ""), env.ADMIN_TOKEN) && mstep !== null && mstep > mlast) {
      await setSetting(env, "master_totp_step", String(mstep));
      identity = "master";
    }
  }
  if (!identity) {
    // Sanitize the username before logging so arbitrary text/HTML can't enter events.detail.
    let failDetail = "bad token or 2FA";
    if (body.username) {
      const un = String(body.username).toLowerCase();
      failDetail = /^[a-z0-9_.-]{1,32}$/.test(un) ? `bad login (${un})` : "bad login (invalid username)";
    }
    await logEvent(env, "admin_login_fail", null, null, ip, failDetail, rawIp, reqCountry(request), app);
    return json({ error: "invalid credentials" }, 401, env);
  }
  const session = uuid(), ttl = 8 * 3600;
  await env.DB.prepare("INSERT INTO sessions(token,admin,expires,last_active) VALUES(?,?,?,?)").bind(await tokenHash(session), identity, nowSec() + ttl, nowSec()).run();
  await logEvent(env, "admin_login_ok", null, null, ip, `session created (${identity})`, rawIp, reqCountry(request), app);
  return json({ session, expires_in: ttl, admin: identity, master: identity === "master" }, 200, env);
}
async function handleAdminLogout(request, env) {
  const tok = bearer(request);
  if (tok) await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(await tokenHash(tok)).run();
  return json({ ok: true }, 200, env);
}

// --- Admin user management (master token only) + invite self-enrollment ----
async function handleAdminInvite(request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "manage_users"))) return json({ error: "not permitted" }, 403, env);
  let body; try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, env); }
  const u = String(body.username || "").toLowerCase().trim();
  if (!/^[a-z0-9_.-]{3,32}$/.test(u)) return json({ error: "username must be 3-32 chars: a-z 0-9 . _ -" }, 400, env);
  if (u === "master") return json({ error: "reserved username" }, 400, env);
  if (await env.DB.prepare("SELECT username FROM admins WHERE username=?").bind(u).first())
    return json({ error: "that username already exists" }, 409, env);
  const token = randToken(), secret = newTotpSecret(), exp = nowSec() + 60 * 60;
  await env.DB.prepare("INSERT INTO admins(username,totp_secret,invite_token,invite_expires,created_ts,created_by) VALUES(?,?,?,?,?,?)")
    .bind(u, await sealTotp(env, secret), token, exp, nowSec(), who).run();
  await logEvent(env, "admin_user_invited", null, null, null, `invited ${u}`);
  return json({ ok: true, username: u, invite_token: token, expires_in: 60 * 60 }, 200, env);
}
async function handleAdminListUsers(request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "manage_users"))) return json({ error: "not permitted" }, 403, env);
  const rows = (await env.DB.prepare("SELECT username,pw_hash,invite_token,invite_expires,disabled,created_ts,last_login,privileges FROM admins ORDER BY created_ts DESC").all()).results || [];
  const users = rows.map((r) => {
    let privileges = [];
    try { if (r.privileges) privileges = JSON.parse(r.privileges); } catch { privileges = []; }
    const state = r.disabled ? "disabled" : (r.pw_hash ? "active" : (r.invite_expires > nowSec() ? "invited" : "invite-expired"));
    const u = { username: r.username, state, created_ts: r.created_ts, last_login: r.last_login, privileges };
    // For a pending invite, return the token + expiry so the master can recover the link.
    if (state === "invited") { u.invite_token = r.invite_token; u.invite_expires = r.invite_expires; }
    return u;
  });
  return json({ users }, 200, env);
}
async function handleAdminDeleteUser(username, request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "manage_users"))) return json({ error: "not permitted" }, 403, env);
  const u = String(username).toLowerCase();
  const r = await env.DB.prepare("DELETE FROM admins WHERE username=?").bind(u).run();
  await env.DB.prepare("DELETE FROM sessions WHERE admin=?").bind(u).run();
  await logEvent(env, "admin_user_deleted", null, null, null, `deleted ${u}`);
  return json({ ok: true, deleted: r.meta?.changes ?? 0 }, 200, env);
}
async function handleAdminDisableUser(username, request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "manage_users"))) return json({ error: "not permitted" }, 403, env);
  let body; try { body = await request.json(); } catch { body = {}; }
  const u = String(username).toLowerCase(), dis = body.disabled ? 1 : 0;
  await env.DB.prepare("UPDATE admins SET disabled=? WHERE username=?").bind(dis, u).run();
  if (dis) await env.DB.prepare("DELETE FROM sessions WHERE admin=?").bind(u).run();
  await logEvent(env, "admin_user_disabled", null, null, null, `${dis ? "disabled" : "enabled"} ${u}`);
  return json({ ok: true }, 200, env);
}
// Replace a named admin's granted privilege set (master only). Unknown names are dropped
// and dupes collapsed; an empty/missing array clears all privileges.
async function handleAdminSetPrivileges(username, request, env) {
  if ((await sessionAdmin(request, env)) !== "master") return json({ error: "master token required" }, 403, env);
  let body; try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, env); }
  const privs = Array.isArray(body.privileges) ? [...new Set(body.privileges.filter((p) => ADMIN_PRIVS.includes(p)))] : [];
  const r = await env.DB.prepare("UPDATE admins SET privileges=? WHERE username=?").bind(JSON.stringify(privs), String(username).toLowerCase()).run();
  if ((r.meta?.changes ?? 0) === 0) return json({ error: "unknown user" }, 404, env);
  await logEvent(env, "admin_privileges", null, null, null, `${String(username).toLowerCase()}: [${privs.join(",")}]`);
  return json({ ok: true, username: String(username).toLowerCase(), privileges: privs }, 200, env);
}
// Invite enrollment (no session — the invitee isn't an admin yet).
const inviteOtpauth = (username, secret) => {
  const issuer = "thingino image builder";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
};
async function handleGetInvite(token, env) {
  const a = await env.DB.prepare("SELECT username,totp_secret,invite_expires,pw_hash FROM admins WHERE invite_token=?").bind(token).first();
  if (!a || a.pw_hash) return json({ error: "invalid or already-used invite" }, 404, env);
  if (a.invite_expires <= nowSec()) return json({ error: "this invite has expired" }, 410, env);
  // The enrollee needs the plaintext seed once, to scan into their authenticator; this is
  // the enrollment bootstrap and it is gated by the one-time invite token.
  const secret = await openTotp(env, a.totp_secret);
  if (!secret) return json({ error: "server key unavailable, ask the master admin" }, 500, env);
  return json({ username: a.username, secret, otpauth: inviteOtpauth(a.username, secret) }, 200, env);
}
async function handleAcceptInvite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, env); }
  const a = await env.DB.prepare("SELECT username,totp_secret,invite_expires,pw_hash,last_totp_step FROM admins WHERE invite_token=?").bind(String(body.token || "")).first();
  if (!a || a.pw_hash) return json({ error: "invalid or already-used invite" }, 404, env);
  if (a.invite_expires <= nowSec()) return json({ error: "this invite has expired" }, 410, env);
  const pw = String(body.password || "");
  if (pw.length < 10) return json({ error: "password must be at least 10 characters" }, 400, env);
  // Validate the 2FA code, but do NOT consume the step here — enrollment isn't a login,
  // and advancing it would reject the user's immediate first login with the same code.
  // Single-use anti-replay applies from the first login onward (login advances the step).
  const secret = await openTotp(env, a.totp_secret);
  if (!secret) return json({ error: "server key unavailable, ask the master admin" }, 500, env);
  if ((await totpStep(secret, String(body.totp || "").trim())) === null)
    return json({ error: "that 2FA code doesn't match — re-scan and try the next code" }, 401, env);
  await env.DB.prepare("UPDATE admins SET pw_hash=?, invite_token=NULL, invite_expires=NULL WHERE username=?")
    .bind(await hashPassword(pw), a.username).run();
  await logEvent(env, "admin_user_enrolled", null, null, null, `${a.username} enrolled`);
  return json({ ok: true, username: a.username }, 200, env);
}
async function handleAdminStats(request, env) {
  const me = await sessionAdmin(request, env);
  if (!me) return json({ error: "admin auth required" }, 401, env);
  // ?all=builds / ?all=events / ?all=builds,events widens that table from the light
  // default (newest 25 / 60) to effectively the whole 7-day retention window, clamped
  // server-side so the panel can't request without bound. Independent per table, only
  // for authenticated admins, and only while expanded.
  const allOf = new Set(((new URL(request.url).searchParams.get("all")) || "").split(","));
  const bLimit = allOf.has("builds") ? 500 : 25, eLimit = allOf.has("events") ? 1000 : 60;
  const cfg = await limits(env);
  const counts = {};
  for (const s of ["queued", "running", "done", "failed", "cancelled", "expired"])
    counts[s] = await countQ(env, "SELECT count(*) c FROM builds WHERE state=?", s);
  const avg = await env.DB.prepare("SELECT avg(finished_ts - dispatched_ts) a FROM builds WHERE (outcome='done' OR (outcome IS NULL AND state='done')) AND finished_ts IS NOT NULL AND dispatched_ts IS NOT NULL").first();
  const builds = ((await env.DB.prepare("SELECT id,defconfig,ref,state,outcome,created_ts,dispatched_ts,finished_ts,run_id,cancel_requested,uid,ip_bucket,ip_full,country,COALESCE(options,'') AS options FROM builds ORDER BY created_ts DESC LIMIT ?").bind(bLimit).all()).results || []).map((b) => ({
    build_id: b.id, defconfig: b.defconfig, ref: b.ref, options: b.options,
    state: b.state === "running" && b.cancel_requested ? "cancelling" : b.state,
    outcome: b.outcome,
    created_ts: b.created_ts, dispatched_ts: b.dispatched_ts, finished_ts: b.finished_ts, run_id: b.run_id, uid: b.uid,
    ip: b.ip_full || b.ip_bucket, ip_bucket: b.ip_bucket, country: b.country,
  }));
  // A login through another app's sign-in page belongs on that app's page, not here, so the
    // ones this panel shows are its own. Filtered, not deleted: the row stays in the table and
    // stays in the 7 day window, this is only which rows the panel draws. Written as "labelled
    // as something else" rather than "labelled builder" on purpose, so rows from before the
    // label existed, which have no app at all, keep showing here instead of vanishing.
    const events = ((await env.DB.prepare("SELECT ts,kind,build_id,detail,uid,ip_bucket,ip_full,country FROM events WHERE NOT (kind LIKE 'admin_login%' AND app IS NOT NULL AND app <> 'builder') ORDER BY id DESC LIMIT ?").bind(eLimit).all()).results || []).map((e) => ({
    ts: e.ts, kind: e.kind, build_id: e.build_id, detail: e.detail, uid: e.uid,
    ip: e.ip_full || e.ip_bucket, ip_bucket: e.ip_bucket, country: e.country,
  }));
  return json({
    builds_enabled: (await getSetting(env, "builds_enabled")) !== "0",
    // With the expiry, unlike the public payload: the card shows when it clears itself.
    notice: await getNotice(env),
    counts,
    last24h: await countQ(env, "SELECT count(*) c FROM builds WHERE created_ts > ?", nowSec() - DAY),
    // For the "showing latest N of M kept (7 days)" lines: the builds total is the sum of
    // the state counts client-side; events need their own count. 7 matches the cron prune.
    events_total: await countQ(env, "SELECT count(*) c FROM events WHERE NOT (kind LIKE 'admin_login%' AND app IS NOT NULL AND app <> 'builder')"),
    kept_days: 7,
    total_done: parseInt((await getSetting(env, "total_done")) || "0", 10),
    avg_build_secs: avg && avg.a ? Math.round(avg.a) : null,
    max_concurrent: cfg.maxConcurrent, retention_secs: cfg.retention,
    limits: { userHourly: cfg.userHourly, ipHourly: cfg.ipHourly, globalHourly: cfg.globalHourly, maxConcurrent: cfg.maxConcurrent, maxQueue: cfg.maxQueue, retention: cfg.retention },
    // What the branches card shows when collapsed. The repo's full branch list is a
    // separate call, made only when someone actually opens the card to edit it.
    branches: await refConfig(env),
    usage: {
      globalHourly: await countQ(env, "SELECT count(*) c FROM builds WHERE created_ts > ? AND NOT (state='cancelled' AND dispatched_ts IS NULL)", Math.max(nowSec() - WINDOW, parseInt((await getSetting(env, "limits_reset_ts")) || "0", 10))),
      maxConcurrent: counts.running, maxQueue: counts.queued,
    },
    recent_builds: builds, recent_events: events,
    // Lets the panel link a build's run id straight to its Actions run, without the
    // static page having to hardcode the repo (config.js is rewritten at deploy time).
    repo: env.GITHUB_REPO || null,
    // No self-update on the Worker: it deploys via git push, not a container swap, so the
    // admin version card is hidden and the version shows in the page footer instead.
    version: env.VERSION || "v0.1.0", latest_version: null, update_available: false, self_update: false,
    me, master: me === "master", manage_users: await adminCan(env, me, "manage_users"),
    edit_notice: await adminCan(env, me, "edit_notice"),
  }, 200, env);
}
// Post or clear the single public notice banner. Empty text clears it, so the panel's
// Clear button is just a post with no text. One notice exists at a time by construction:
// it is one settings row, independent of the builds-disabled banner.
async function handleAdminNotice(request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "edit_notice"))) return json({ error: "not permitted" }, 403, env);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, env); }
  const text = cleanNotice(body.text);
  if (!text) {
    await setSetting(env, "notice", "");
    await logEvent(env, "admin_notice", null, null, null, "notice cleared");
    return json({ ok: true, notice: null }, 200, env);
  }
  const level = normLevel(body.level);
  // hours <= 0 or absent means no expiry; the cap keeps a typo from parking a banner for years.
  const hours = parseInt(body.hours, 10);
  const until = Number.isFinite(hours) && hours > 0 ? nowSec() + Math.min(hours, 720) * 3600 : 0;
  const notice = { text, level, until };
  await setSetting(env, "notice", JSON.stringify(notice));
  await logEvent(env, "admin_notice", null, null, null, `notice set (${level}, ${until ? `${hours}h` : "no expiry"})`);
  return json({ ok: true, notice }, 200, env);
}
async function handleAdminToggle(request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "kill_switch"))) return json({ error: "not permitted" }, 403, env);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, env); }
  await setSetting(env, "builds_enabled", body.enabled ? "1" : "0");
  await logEvent(env, "admin_toggle", null, null, null, `builds_enabled=${!!body.enabled}`);
  return json({ builds_enabled: !!body.enabled }, 200, env);
}
async function handleAdminClearLogs(request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "clear_logs"))) return json({ error: "not permitted" }, 403, env);
  // Preserve recent admin_login_fail rows (the 15-min window) so clearing logs can't
  // wipe the per-IP brute-force throttle that counts them.
  const r = await env.DB.prepare("DELETE FROM events WHERE NOT (kind='admin_login_fail' AND ts > ?)").bind(nowSec() - 900).run();
  const n = r.meta?.changes ?? 0;
  await logEvent(env, "admin_clear_logs", null, null, null, `cleared ${n} events`);
  return json({ ok: true, cleared: n }, 200, env);
}
// Delete finished builds (done/failed/cancelled/expired) from the list; never queued/running.
async function handleAdminClearBuilds(request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "clear_builds"))) return json({ error: "not permitted" }, 403, env);
  // Reap GitHub artifacts/runs for done/failed rows before deleting them (cancelled/expired
  // already had theirs removed by cancel or the reaper). Best-effort.
  const reap = ((await env.DB.prepare("SELECT id,run_id,state FROM builds WHERE state IN ('done','failed')").all()).results) || [];
  for (const b of reap) {
    try {
      if (b.state === "done") await deleteReleaseAssets(env, b.id);
      if (b.run_id) await deleteRun(env, b.run_id);
    } catch (_) { /* best-effort */ }
  }
  const r = await env.DB.prepare("DELETE FROM builds WHERE state IN ('done','failed','cancelled','expired')").run();
  const n = r.meta?.changes ?? 0;
  await logEvent(env, "admin_clear_builds", null, null, null, `cleared ${n} finished builds`);
  return json({ ok: true, cleared: n }, 200, env);
}
async function handleAdminResetLimits(request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "reset_limits"))) return json({ error: "not permitted" }, 403, env);
  // Mark "now" so the rate-limit queries ignore every build created before this.
  await setSetting(env, "limits_reset_ts", String(nowSec()));
  await logEvent(env, "admin_reset_limits", null, null, null, "hourly limits reset");
  return json({ ok: true }, 200, env);
}
// Set runtime limit overrides (stored in D1; layered over the wrangler.toml vars).
async function handleAdminLimits(request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "edit_limits"))) return json({ error: "not permitted" }, 403, env);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, env); }
  const cur = await limits(env);
  const next = {};
  for (const k of ["userHourly", "ipHourly", "globalHourly", "maxConcurrent", "maxQueue", "retention"]) {
    const v = parseInt(body[k], 10);
    next[k] = Number.isFinite(v) && v > 0 && v <= 100000 ? v : cur[k];
  }
  await setSetting(env, "limits", JSON.stringify(next));
  await logEvent(env, "admin_limits", null, null, null, JSON.stringify(next));
  return json({ ok: true, limits: next }, 200, env);
}
// The branch picker's own data: the repo's real branch list alongside what is enabled now.
// Fetched when the card is opened for editing, not on the panel's 10s poll — the current
// selection rides along on admin stats, which is all the collapsed view needs.
async function handleAdminBranches(request, env) {
  if (!(await sessionAdmin(request, env))) return json({ error: "admin auth required" }, 401, env);
  const rc = await refConfig(env);
  return json({
    all: await repoBranches(env),
    repo: env.THINGINO_REPO || "themactep/thingino-firmware",
    enabled: rc.enabled, default: rc.default,
  }, 200, env);
}
// Set which branches visitors may build from. Shares the edit_limits privilege: both are
// "what the builder will accept from a visitor", and neither can reach anyone's account.
async function handleAdminSetBranches(request, env) {
  const who = await sessionAdmin(request, env);
  if (!who) return json({ error: "admin auth required" }, 401, env);
  if (!(await adminCan(env, who, "edit_limits"))) return json({ error: "not permitted" }, 403, env);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, env); }
  // Non-strings are dropped rather than stringified, so this agrees with the broker's
  // `filter_map(as_str)` on a hand-made request that puts a number in the list.
  const want = [...new Set((Array.isArray(body.enabled) ? body.enabled : []).filter((b) => typeof b === "string"))];
  // An empty set would leave the page with nothing to offer and every request coerced to a
  // branch nobody picked. Turning the builder off is the kill switch's job, not this one's.
  if (!want.length) return json({ error: "enable at least one branch" }, 400, env);
  if (want.length > MAX_REFS) return json({ error: `at most ${MAX_REFS} branches` }, 400, env);
  // Echoed names are capped and land in the panel via textContent, never as markup.
  const bad = want.find((b) => !validRefName(b));
  if (bad) return json({ error: `not a usable branch name: ${bad.slice(0, 60)}` }, 400, env);
  // Must exist upstream: enabling a typo would offer visitors a branch whose build can only
  // fail at checkout, minutes later. Skipped when the list is empty, which means the fetch
  // failed rather than that the repo has no branches — no reason to block an edit on that.
  const all = await repoBranches(env);
  const gone = all.length ? want.find((b) => !all.includes(b)) : null;
  if (gone) return json({ error: `no such branch: ${gone.slice(0, 60)}` }, 400, env);
  const next = { enabled: want, default: want.includes(body.default) ? body.default : want[0] };
  await setSetting(env, "branches", JSON.stringify(next));
  await logEvent(env, "admin_branches", null, null, null, JSON.stringify(next));
  return json({ ok: true, ...next }, 200, env);
}

// ---- Durable Object: per-IP rate limiter (audit F12) ----------------------
// One instance per key (IP) → a single strongly-consistent in-memory fixed-window
// counter. Declared SQLite-backed (free-tier eligible) but stores nothing; on
// eviction the window just resets (fail-open), which is fine for a flood guard.
export class RateLimiter {
  constructor(_state, _env) {
    this.count = 0;
    this.windowStart = 0;
  }
  async fetch(request) {
    const { max, period } = await request.json();
    const now = Date.now() / 1000;
    if (now - this.windowStart >= period) { this.windowStart = now; this.count = 0; }
    this.count++;
    return Response.json({ success: this.count <= max });
  }
}

// ---- entrypoints ----------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    const url = new URL(request.url), p = url.pathname;
    // Whole-API per-IP flood guard, so no endpoint — not just
    // /api/build — can burn the free-tier request/D1 budget (audit H1). This global
    // guard is a per-isolate in-memory counter, NOT the Durable Object: a DO round-trip
    // per read doubled our billable events (and a rejected request still counts toward
    // the Workers daily limit anyway), so the exact DO check is reserved for /api/build.
    if (p.startsWith("/api/")) {
      const gip = ipBucket(request.headers.get("CF-Connecting-IP") || "");
      if (!softGuard(gip, 90, 60)) return json({ error: "too many requests — slow down" }, 429, env);
    }
    // Fallback clock (see maybeTick), behind the flood guard so a request being turned
    // away never reaches D1. Only the polling endpoints carry it, so it costs one settings
    // read per poll while the cron is healthy, and it runs after the response, so no
    // visitor waits on it. Anyone watching a build is polling one of these.
    // /api/health is in there so an uptime monitor doubles as an off-platform heartbeat:
    // the fallback clock only turns while someone is looking, and a pinger is someone
    // looking. Health used to sit outside the flood guard above; it is inside it now,
    // because it can reach D1 through this. 90/min per IP leaves any monitor untouched.
    if (request.method === "GET" && (p === "/api/stats" || p === "/api/admin/stats" || p === "/api/health" || p.startsWith("/api/status/")))
      ctx.waitUntil(maybeTick(env));
    try {
      if (p === "/api/health") return new Response("ok", { headers: cors(env) });
      if (p === "/api/defconfigs" && request.method === "GET") return await handleDefconfigs(env, url.searchParams.get("ref"));
      if (p === "/api/build-options" && request.method === "GET") return await handleBuildOptions(request, env);
      if (p === "/api/stats" && request.method === "GET") return await handleStats(request, env, url.searchParams.get("ref"), url.searchParams.get("my"));
      if (p === "/api/build" && request.method === "POST") return await handleBuild(request, env);
      let m;
      if ((m = p.match(/^\/api\/status\/(.+)$/)) && request.method === "GET") return await handleStatus(m[1], env);
      if ((m = p.match(/^\/api\/cancel\/(.+)$/)) && request.method === "POST") return await handleCancel(m[1], request, env);
      if ((m = p.match(/^\/api\/admin\/cancel\/(.+)$/)) && request.method === "POST") return await handleAdminCancel(m[1], request, env);
      if ((m = p.match(/^\/api\/admin\/expire\/(.+)$/)) && request.method === "POST") return await handleAdminExpire(m[1], request, env);
      if (p === "/api/admin/login" && request.method === "POST") return await handleAdminLogin(request, env);
      if (p === "/api/admin/stats" && request.method === "GET") return await handleAdminStats(request, env);
      if (p === "/api/admin/toggle" && request.method === "POST") return await handleAdminToggle(request, env);
      if (p === "/api/admin/notice" && request.method === "POST") return await handleAdminNotice(request, env);
      if (p === "/api/admin/clear-logs" && request.method === "POST") return await handleAdminClearLogs(request, env);
      if (p === "/api/admin/clear-builds" && request.method === "POST") return await handleAdminClearBuilds(request, env);
      if (p === "/api/admin/reset-limits" && request.method === "POST") return await handleAdminResetLimits(request, env);
      if (p === "/api/admin/limits" && request.method === "POST") return await handleAdminLimits(request, env);
      if (p === "/api/admin/branches" && request.method === "GET") return await handleAdminBranches(request, env);
      if (p === "/api/admin/branches" && request.method === "POST") return await handleAdminSetBranches(request, env);
      if (p === "/api/admin/users" && request.method === "POST") return await handleAdminInvite(request, env);
      if (p === "/api/admin/users" && request.method === "GET") return await handleAdminListUsers(request, env);
      if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/disable$/)) && request.method === "POST") return await handleAdminDisableUser(m[1], request, env);
      if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/privileges$/)) && request.method === "POST") return await handleAdminSetPrivileges(m[1], request, env);
      if ((m = p.match(/^\/api\/admin\/users\/([^/]+)$/)) && request.method === "DELETE") return await handleAdminDeleteUser(m[1], request, env);
      if ((m = p.match(/^\/api\/admin\/invite\/([^/]+)$/)) && request.method === "GET") return await handleGetInvite(m[1], env);
      if (p === "/api/admin/accept-invite" && request.method === "POST") return await handleAcceptInvite(request, env);
      if (p === "/api/admin/logout" && request.method === "POST") return await handleAdminLogout(request, env);
      return json({ error: "not found" }, 404, env);
    } catch (e) {
      return json({ error: "internal error" }, 500, env);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(schedulerStep(env, "cron"));
  },
};
