/* Architmind CI : serveur de paiement (Cloudflare Worker)
 *
 *  POST /api/paiement/creer     démarre un paiement Paystack pour l'offre choisie (client connecté)
 *  POST /api/paiement/verifier  vérifie un paiement au retour sur le site (client connecté)
 *  POST /api/paiement/webhook   confirmation envoyée par Paystack (signature vérifiée)
 *  tâche quotidienne            rappels d'échéance : notification sur le site + e-mail
 *
 *  Secrets à saisir dans Cloudflare (jamais dans le code) :
 *    PAYSTACK_SECRET            clé secrète Paystack (sk_test_… puis sk_live_…)
 *    FIREBASE_SERVICE_ACCOUNT   contenu du fichier JSON du compte de service Firebase
 *    BREVO_API_KEY              clé API Brevo (e-mails)
 *  Variables : voir wrangler.jsonc (SITE_URL, ORIGINES, FIREBASE_PROJECT_ID, FIREBASE_API_KEY,
 *              MAIL_EXPEDITEUR, MAIL_NOM)
 */

const OFFRES = {
  moyen: { nom: "Moyen", prix: 30000 },
  max: { nom: "Max", prix: 60000 },
};
const DUREE_JOURS = 30;
const RAPPELS = [7, 3, 1]; // jours avant l'échéance
const JOUR = 864e5;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (req.method === "POST" && url.pathname === "/api/paiement/creer") return json(await creer(req, env), 200, cors);
      if (req.method === "POST" && url.pathname === "/api/paiement/verifier") return json(await verifier(req, env), 200, cors);
      if (req.method === "POST" && url.pathname === "/api/paiement/webhook") return await webhook(req, env);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/api/sante"))
        return json({ ok: true, service: "architmind-paiement", mode: String(env.PAYSTACK_SECRET || "").startsWith("sk_live_") ? "réel" : "test" }, 200, cors);
      return json({ erreur: "Adresse inconnue." }, 404, cors);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e && e.stack || e);
      return json({ erreur: e.public || "Erreur interne. Réessayez dans un instant." }, status, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(rappels(env).catch((e) => console.error("rappels", e && e.stack || e)));
  },
};

/* ---------------- Points d'entrée ---------------- */

async function creer(req, env) {
  const user = await utilisateur(req, env);
  const body = await req.json().catch(() => ({}));
  const of = OFFRES[body.offre];
  if (!of) throw erreur(400, "Offre inconnue.");
  if (!user.email) throw erreur(400, "Votre compte n'a pas d'adresse e-mail.");
  const site = env.SITE_URL;
  let retour = String(body.retour || "");
  if (!retour.startsWith(site)) retour = site + "?paiement=1";
  const reference = `am-${body.offre}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const r = await paystack(env, "/transaction/initialize", {
    method: "POST",
    body: {
      email: user.email,
      amount: of.prix * 100, // Paystack : montant × 100, même en FCFA
      currency: "XOF",
      reference,
      callback_url: retour,
      channels: ["mobile_money", "card"],
      metadata: {
        uid: user.uid,
        offre: body.offre,
        custom_fields: [{ display_name: "Offre", variable_name: "offre", value: `Architmind ${of.nom} (1 mois)` }],
      },
    },
  });
  await fsPatch(env, `paiements/${reference}`, {
    uid: user.uid, email: user.email, offre: body.offre, montant: of.prix, devise: "XOF",
    statut: "en_attente", creeLe: new Date(),
  }, { exists: false });
  return { url: r.data.authorization_url, reference };
}

async function verifier(req, env) {
  const user = await utilisateur(req, env);
  const { reference } = await req.json().catch(() => ({}));
  if (!reference || !/^[\w-]{6,80}$/.test(reference)) throw erreur(400, "Référence de paiement manquante.");
  const p = await fsGet(env, `paiements/${reference}`);
  if (!p || p.uid !== user.uid) throw erreur(404, "Paiement introuvable.");
  return await traiter(env, reference);
}

async function webhook(req, env) {
  const raw = await req.text();
  const sig = req.headers.get("x-paystack-signature") || "";
  const attendu = await hmacHex(env.PAYSTACK_SECRET, raw);
  if (!egal(sig, attendu)) return new Response("signature invalide", { status: 401 });
  let ev;
  try { ev = JSON.parse(raw); } catch { return new Response("corps invalide", { status: 400 }); }
  if (ev.event === "charge.success" && ev.data && ev.data.reference) {
    // traitement immédiat : en cas de panne passagère, la réponse 500 fait renvoyer la confirmation par Paystack
    try { await traiter(env, ev.data.reference); }
    catch (e) { if (!e.definitif) throw e; console.error("paiement refusé :", e.message); }
  }
  return new Response("ok");
}

/* ---------------- Activation de l'offre ---------------- */

async function traiter(env, reference) {
  const v = await paystack(env, `/transaction/verify/${encodeURIComponent(reference)}`);
  const d = v.data || {};
  if (d.status !== "success") return { statut: d.status === "abandoned" || d.status === "failed" ? "echec" : "en_attente" };

  let p = await fsGet(env, `paiements/${reference}`);
  const meta = d.metadata || {};
  const uid = (p && p.uid) || meta.uid;
  const offre = (p && p.offre) || meta.offre;
  const of = OFFRES[offre];
  if (!uid || !of) throw definitif(`paiement inconnu ${reference}`);
  if (d.currency !== "XOF" || Number(d.amount) < of.prix * 100) throw definitif(`montant incorrect pour ${reference} : ${d.amount} ${d.currency}`);
  if (p && p.statut === "payé") return { statut: "payé", offre, expire: iso(p.expire), deja: true };

  // verrou : un seul traitement à la fois (le webhook et le retour sur le site peuvent arriver ensemble)
  const libre = !p || p.statut !== "activation" || Date.now() - new Date(p._maj).getTime() > 120000;
  if (!libre) return { statut: "en_cours", offre };
  try {
    await fsPatch(env, `paiements/${reference}`, { statut: "activation", uid, offre }, p ? { updateTime: p._maj } : { exists: false });
  } catch (e) {
    if (e.precondition) return { statut: "en_cours", offre };
    throw e;
  }

  const u = (await fsGet(env, `utilisateurs/${uid}`)) || {};
  const a = u.abonnement || null;
  const now = Date.now();
  let expire;
  if (a && a.reference === reference) {
    expire = new Date(a.expire); // déjà appliqué lors d'un essai précédent
  } else {
    // renouvellement de la même offre avant l'échéance : le mois s'ajoute à la date de fin
    const base = a && a.offre === offre && a.expire && new Date(a.expire).getTime() > now ? new Date(a.expire).getTime() : now;
    expire = new Date(base + DUREE_JOURS * JOUR);
    await fsPatch(env, `utilisateurs/${uid}`, {
      abonnement: { offre, expire, depuis: new Date(now), reference, montant: of.prix, rappels: [] },
    });
  }

  const canal = d.channel === "mobile_money" ? "Mobile Money" : d.channel === "card" ? "carte bancaire" : d.channel || "";
  await fsAdd(env, `utilisateurs/${uid}/notifications`, {
    titre: `Paiement reçu : offre ${of.nom}`,
    texte: `${fcfa(of.prix)} payés${canal ? " par " + canal : ""}. Votre offre ${of.nom} est active jusqu'au ${dateFr(expire)}.`,
    date: new Date(now), lu: false, type: "paiement", reference,
  });
  await fsPatch(env, `paiements/${reference}`, { statut: "payé", payeLe: new Date(now), canal: d.channel || "", expire });

  const email = u.email || (d.customer && d.customer.email);
  await envoyerMail(env, {
    to: email, nom: u.nom,
    sujet: `Reçu de paiement : offre ${of.nom}`,
    titre: "Merci pour votre paiement",
    lignes: [
      `Nous avons bien reçu <b>${fcfa(of.prix)}</b>${canal ? " par " + canal : ""} pour l'offre <b>${of.nom}</b> d'Architmind CI.`,
      `Votre offre est active jusqu'au <b>${dateFr(expire)}</b>.`,
      `Référence du paiement : <span style="font-family:monospace">${esc(reference)}</span>`,
    ],
    bouton: { texte: "Ouvrir Architmind", url: env.SITE_URL + "#creation" },
  }).catch((e) => console.error("e-mail", e && e.message));

  return { statut: "payé", offre, expire: iso(expire) };
}

/* ---------------- Rappels d'échéance (tâche quotidienne) ---------------- */

async function rappels(env, maintenant = Date.now()) {
  const docs = await fsQuery(env, {
    from: [{ collectionId: "utilisateurs" }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: [
          { fieldFilter: { field: { fieldPath: "abonnement.expire" }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: new Date(maintenant - 2 * JOUR).toISOString() } } },
          { fieldFilter: { field: { fieldPath: "abonnement.expire" }, op: "LESS_THAN_OR_EQUAL", value: { timestampValue: new Date(maintenant + 8 * JOUR).toISOString() } } },
        ],
      },
    },
  });
  let n = 0;
  for (const { path, data } of docs) {
    const a = data.abonnement || {};
    const of = OFFRES[a.offre];
    if (!of || !a.expire) continue;
    const exp = new Date(a.expire).getTime();
    const jours = Math.ceil((exp - maintenant) / JOUR);
    const cle = jours <= 0 ? "expire" : RAPPELS.filter((r) => jours <= r).sort((x, y) => x - y)[0];
    if (!cle) continue;
    const deja = (a.rappels || []).map(String);
    if (deja.includes(String(cle))) continue;
    const uid = path.split("/").pop();
    const fin = dateFr(exp);
    const titre = cle === "expire" ? `Votre offre ${of.nom} a expiré` : jours === 1 ? `Votre offre ${of.nom} expire demain` : `Votre offre ${of.nom} expire dans ${jours} jours`;
    const texte = cle === "expire"
      ? `Elle a pris fin le ${fin} : votre compte est repassé à l'offre Basique gratuite. Renouvelez en un clic pour retrouver ses avantages.`
      : `Échéance le ${fin}. Renouvelez en un clic depuis l'onglet Tarifs pour garder vos avantages.`;
    await fsAdd(env, `utilisateurs/${uid}/notifications`, { titre, texte, date: new Date(maintenant), lu: false, type: "rappel", action: "tarifs" });
    await fsPatch(env, `utilisateurs/${uid}`, { abonnement: { rappels: [...deja, String(cle)] } }, null, ["abonnement.rappels"]);
    await envoyerMail(env, {
      to: data.email, nom: data.nom, sujet: titre, titre,
      lignes: [texte, `Offre ${of.nom} : ${fcfa(of.prix)} par mois, payable par Mobile Money ou carte bancaire.`],
      bouton: { texte: "Renouveler mon offre", url: env.SITE_URL + "#tarifs" },
    }).catch((e) => console.error("e-mail", e && e.message));
    n++;
  }
  return n;
}

/* ---------------- Comptes : vérification de la connexion Firebase ---------------- */

async function utilisateur(req, env) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) throw erreur(401, "Connectez-vous pour payer.");
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: m[1] }),
  });
  const j = await r.json().catch(() => ({}));
  const u = j.users && j.users[0];
  if (!r.ok || !u) throw erreur(401, "Votre session a expiré : reconnectez-vous.");
  return { uid: u.localId, email: u.email || "", nom: u.displayName || "" };
}

/* ---------------- Paystack ---------------- */

async function paystack(env, path, { method = "GET", body } = {}) {
  const r = await fetch("https://api.paystack.co" + path, {
    method,
    headers: { Authorization: "Bearer " + env.PAYSTACK_SECRET, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status) {
    const e = new Error("Paystack " + r.status + " : " + (j.message || ""));
    e.status = 502; e.public = "Le service de paiement ne répond pas. Réessayez dans un instant.";
    throw e;
  }
  return j;
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret || ""), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function egal(a, b) {
  if (!a || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/* ---------------- Firestore (API REST, compte de service) ---------------- */

let JETON = { v: null, exp: 0 };
async function jetonGoogle(env) {
  if (JETON.v && Date.now() < JETON.exp - 60000) return JETON.v;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri || "https://oauth2.googleapis.com/token";
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud, iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", pemBuf(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + claims));
  const r = await fetch(aud, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + claims + "." + b64urlBuf(sig),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("jeton Google refusé : " + JSON.stringify(j));
  JETON = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return JETON.v;
}

const racine = (env) => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function fsFetch(env, method, url, body) {
  const r = await fetch(url, {
    method, headers: { Authorization: "Bearer " + (await jetonGoogle(env)), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404 && method === "GET") return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Firestore ${method} ${r.status} : ${JSON.stringify(j.error || j)}`);
    e.precondition = r.status === 409 || r.status === 412 || (j.error && j.error.status === "FAILED_PRECONDITION") || (j.error && j.error.status === "ALREADY_EXISTS");
    throw e;
  }
  return j;
}

async function fsGet(env, path) {
  const doc = await fsFetch(env, "GET", `${racine(env)}/${path}`);
  if (!doc) return null;
  return Object.assign(decFields(doc.fields || {}), { _maj: doc.updateTime });
}

// fusionne les champs donnés (les autres champs du document sont conservés)
async function fsPatch(env, path, data, pre, masque) {
  const q = new URLSearchParams();
  for (const f of masque || Object.keys(data)) q.append("updateMask.fieldPaths", f);
  if (pre && pre.exists === false) q.append("currentDocument.exists", "false");
  if (pre && pre.updateTime) q.append("currentDocument.updateTime", pre.updateTime);
  return fsFetch(env, "PATCH", `${racine(env)}/${path}?${q}`, { fields: encFields(data) });
}

async function fsAdd(env, colPath, data) {
  return fsFetch(env, "POST", `${racine(env)}/${colPath}`, { fields: encFields(data) });
}

async function fsQuery(env, structuredQuery) {
  const res = await fsFetch(env, "POST", `${racine(env)}:runQuery`, { structuredQuery });
  return (res || []).filter((x) => x.document).map((x) => ({
    path: x.document.name.split("/documents/")[1],
    data: decFields(x.document.fields || {}),
  }));
}

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: encFields(v) } };
}
const encFields = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, enc(v)]));
function dec(f) {
  if ("stringValue" in f) return f.stringValue;
  if ("integerValue" in f) return Number(f.integerValue);
  if ("doubleValue" in f) return f.doubleValue;
  if ("booleanValue" in f) return f.booleanValue;
  if ("timestampValue" in f) return new Date(f.timestampValue);
  if ("nullValue" in f) return null;
  if ("arrayValue" in f) return (f.arrayValue.values || []).map(dec);
  if ("mapValue" in f) return decFields(f.mapValue.fields || {});
  return null;
}
const decFields = (fs) => Object.fromEntries(Object.entries(fs).map(([k, v]) => [k, dec(v)]));

/* ---------------- E-mails (Brevo) ---------------- */

async function envoyerMail(env, { to, nom, sujet, titre, lignes, bouton }) {
  if (!env.BREVO_API_KEY || !env.MAIL_EXPEDITEUR || !to) return false;
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#ECEDEA;font-family:Arial,Helvetica,sans-serif;color:#0F1211">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" style="max-width:520px;background:#FFFFFF;border-radius:18px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 26px">
<div style="font-weight:800;font-size:20px;letter-spacing:-.02em">Architmind <span style="color:#B87A14">CI</span></div>
<h1 style="font-size:22px;margin:22px 0 12px">${esc(titre)}</h1>
<p style="font-size:15px;line-height:1.55;margin:0 0 14px">Bonjour ${esc(nom || "")},</p>
${lignes.map((l) => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px">${l}</p>`).join("")}
${bouton ? `<p style="margin:22px 0 6px"><a href="${esc(bouton.url)}" style="display:inline-block;background:#0F1211;color:#FFFFFF;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:999px">${esc(bouton.texte)}</a></p>` : ""}
<p style="font-size:12px;color:#646D69;line-height:1.5;margin:24px 0 0">Architmind CI · Fait par Hunter Agency. Vous recevez cet e-mail parce que vous avez un compte Architmind.</p>
</td></tr></table></td></tr></table></body></html>`;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { email: env.MAIL_EXPEDITEUR, name: env.MAIL_NOM || "Architmind CI" }, to: [{ email: to, ...(nom ? { name: nom } : {}) }], subject: sujet, htmlContent: html }),
  });
  if (!r.ok) throw new Error("Brevo " + r.status + " " + (await r.text()));
  return true;
}

/* ---------------- Outils ---------------- */

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const ok = (env.ORIGINES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (ok.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (o, status, headers) => new Response(JSON.stringify(o), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
const definitif = (message) => Object.assign(new Error(message), { definitif: true, status: 400, public: "Paiement non reconnu." });
const erreur = (status, message) => Object.assign(new Error(message), { status, public: message });
const fcfa = (n) => new Intl.NumberFormat("fr-FR").format(n).replace(/ | /g, " ") + " FCFA";
const dateFr = (d) => new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Abidjan" });
const iso = (d) => (d ? new Date(d).toISOString() : null);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function b64urlBuf(buf) {
  const a = new Uint8Array(buf); let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64url = (str) => b64urlBuf(new TextEncoder().encode(str));
function pemBuf(pem) {
  const b = atob(String(pem).replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, ""));
  const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a.buffer;
}

export const _test = { rappels, traiter, enc, dec, reinitialiserJeton: () => { JETON = { v: null, exp: 0 }; } };
