/* ============================================================
   Table Commander — serveur (aucune dépendance, durci pour le web)
   Lancer :  node server.js        puis ouvrir http://localhost:3000

   Protections incluses pour un déploiement public :
   - clés du KV validées (charset + longueur), valeurs limitées à 512 Ko
   - nombre total de clés plafonné, expiration automatique (48 h)
   - limitation de débit par IP (anti-abus / anti-scan)
   - en-têtes de sécurité (CSP, nosniff, permissions, frame)
   - fichiers statiques servis depuis une liste blanche uniquement
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "data.json");

/* ---------- réglages ---------- */
const MAX_VALUE = 512 * 1024;      // taille max d'une valeur (512 Ko)
const MAX_KEYS = 8000;             // nb max de clés en mémoire
const TTL_MS = 48 * 3600 * 1000;   // durée de vie d'une clé : 48 h
const RATE_WINDOW_MS = 10 * 1000;  // fenêtre de limitation de débit
const RATE_MAX = 450;              // requêtes max par IP par fenêtre (plusieurs joueurs peuvent partager une IP)
const KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/; // clés autorisées

/* ---------- stockage clé/valeur avec horodatage ---------- */
let kv = {}, ts = {};
try {
  const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));
  if (raw && raw.__v2) { kv = raw.kv || {}; ts = raw.ts || {}; }
  else { kv = raw || {}; for (const k of Object.keys(kv)) ts[k] = Date.now(); } // migration ancien format
} catch (e) {}
let saveT = null;
const save = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => fs.writeFile(DATA, JSON.stringify({ __v2: true, kv, ts }), () => {}), 500);
};

/* expiration automatique */
setInterval(() => {
  const now = Date.now();
  let n = 0;
  for (const k of Object.keys(ts)) if (now - ts[k] > TTL_MS) { delete kv[k]; delete ts[k]; n++; }
  if (n) save();
}, 10 * 60 * 1000);

/* ---------- limitation de débit par IP ---------- */
const hits = new Map(); // ip -> { n, t0 }
setInterval(() => hits.clear(), RATE_WINDOW_MS * 6); // purge mémoire
const ipOf = (req) => {
  // derrière un hébergeur (Render, etc.), l'IP réelle est dans x-forwarded-for
  const xf = req.headers["x-forwarded-for"];
  return (xf ? String(xf).split(",")[0].trim() : req.socket.remoteAddress) || "?";
};
const rateLimited = (req) => {
  const ip = ipOf(req);
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.t0 > RATE_WINDOW_MS) { h = { n: 0, t0: now }; hits.set(ip, h); }
  h.n++;
  return h.n > RATE_MAX;
};

/* ---------- en-têtes de sécurité ---------- */
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // autorise le micro pour notre propre page (chat vocal), rien d'autre
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=(), payment=()",
  // CSP adaptée à l'app : React/Babel via cdnjs, images Scryfall, polices Google.
  // Si un jour quelque chose se bloque, ouvrez la console du navigateur : elle dira quelle directive ajuster.
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com 'unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' https: data: blob:",
    "connect-src 'self' https://api.scryfall.com https://cards.scryfall.io",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};
const head = (extra) => Object.assign({}, SEC_HEADERS, extra || {});

/* ---------- fichiers statiques : liste blanche ---------- */
const STATIC = {
  "index.html": "text/html; charset=utf-8",
  "app.jsx": "text/javascript; charset=utf-8",
};

const server = http.createServer((req, res) => {
  if (rateLimited(req)) { res.writeHead(429, head({ "Retry-After": "10" })); res.end("trop de requêtes"); return; }

  /* ---- API clé/valeur : GET / PUT / DELETE  /kv/<clé> ---- */
  if (req.url.startsWith("/kv/")) {
    const key = decodeURIComponent(req.url.slice(4).split("?")[0]);
    if (!KEY_RE.test(key)) { res.writeHead(400, head()); res.end("clé invalide"); return; }

    if (req.method === "GET") {
      if (key in kv) { res.writeHead(200, head({ "Content-Type": "application/json", "Cache-Control": "no-store" })); res.end(kv[key]); }
      else { res.writeHead(404, head()); res.end(); }
      return;
    }
    if (req.method === "PUT") {
      if (!(key in kv) && Object.keys(kv).length >= MAX_KEYS) { res.writeHead(507, head()); res.end("stockage plein"); return; }
      let body = "", dead = false;
      req.on("data", (c) => {
        body += c;
        if (body.length > MAX_VALUE) { dead = true; res.writeHead(413, head()); res.end("trop volumineux"); req.destroy(); }
      });
      req.on("end", () => {
        if (dead) return;
        kv[key] = body; ts[key] = Date.now(); save();
        res.writeHead(200, head()); res.end("ok");
      });
      return;
    }
    if (req.method === "DELETE") { delete kv[key]; delete ts[key]; save(); res.writeHead(200, head()); res.end("ok"); return; }
    res.writeHead(405, head()); res.end();
    return;
  }

  /* ---- fichiers statiques (liste blanche stricte) ---- */
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, head()); res.end(); return; }
  const name = req.url === "/" || req.url.startsWith("/?") ? "index.html" : req.url.slice(1).split("?")[0];
  if (!(name in STATIC)) { res.writeHead(404, head()); res.end("introuvable"); return; }
  fs.readFile(path.join(__dirname, name), (err, buf) => {
    if (err) { res.writeHead(404, head()); res.end("introuvable"); return; }
    res.writeHead(200, head({ "Content-Type": STATIC[name], "Cache-Control": "no-cache" }));
    res.end(buf);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  ✦ Table Commander est lancée !");
  console.log("");
  console.log("  Sur ce PC        : http://localhost:" + PORT);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === "IPv4" && !n.internal) console.log("  Ami (même Wi-Fi) : http://" + n.address + ":" + PORT);
    }
  }
  console.log("");
  console.log("  Ctrl+C pour arrêter. Salons sauvegardés dans data.json (expirent après 48 h).");
  console.log("  ⚠ Rappel : le chat vocal ne fonctionne qu'en HTTPS (ou sur localhost).");
});
