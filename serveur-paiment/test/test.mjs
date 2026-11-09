// Tests du serveur de paiement avec des services simulés (Paystack, Firebase, Google, Brevo).
// Lancer : node test/test.mjs
import assert from "node:assert/strict";
import worker, { _test } from "../src/index.js";

const JOUR = 864e5;
let ok = 0;
const t = async (nom, f) => { await f(); ok++; console.log("✓", nom); };

/* ---------- compte de service de test ---------- */
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pk8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${pk8.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
const env = {
  PAYSTACK_SECRET: "sk_test_secret",
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "sa@architmind.iam.gserviceaccount.com", private_key: PEM, token_uri: "https://oauth2.googleapis.com/token" }),
  BREVO_API_KEY: "xkeysib-test", MAIL_EXPEDITEUR: "contact@exemple.ci", MAIL_NOM: "Architmind CI",
  SITE_URL: "https://truthone-hue.github.io/Architmind/", ORIGINES: "https://truthone-hue.github.io",
  FIREBASE_PROJECT_ID: "architmind-74294", FIREBASE_API_KEY: "AIzaTest",
};

/* ---------- services simulés ---------- */
const DB = {}; // chemin -> {fields, updateTime}
const MAILS = [];
const TX = {}; // reference -> transaction Paystack
let seq = 0, jetonsDemandes = 0;
const ROOT = "https://firestore.googleapis.com/v1/projects/architmind-74294/databases/(default)/documents";
const stamp = () => new Date(Date.now() + (seq++)).toISOString().replace("Z", "123Z");
const enc = _test.enc, dec = _test.dec;
const getPath = (obj, p) => p.split(".").reduce((o, k) => (o && o.mapValue ? o.mapValue.fields[k] : o && o[k]), obj);
function setMasked(fields, newFields, path) {
  const [k, ...rest] = path.split(".");
  if (!rest.length) { if (newFields[k] !== undefined) fields[k] = newFields[k]; else delete fields[k]; return; }
  fields[k] = fields[k] && fields[k].mapValue ? fields[k] : { mapValue: { fields: {} } };
  setMasked(fields[k].mapValue.fields, (newFields[k] && newFields[k].mapValue && newFields[k].mapValue.fields) || {}, rest.join("."));
}
const resp = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const method = init.method || "GET";
  const body = init.body;
  if (url.startsWith("https://identitytoolkit.googleapis.com/v1/accounts:lookup")) {
    const { idToken } = JSON.parse(body);
    const U = { "jeton-awa": { localId: "uAwa", email: "awa@exemple.ci", emailVerified: true, displayName: "Awa" }, "jeton-paul": { localId: "uPaul", email: "paul@exemple.ci" } };
    return U[idToken] ? resp(200, { users: [U[idToken]] }) : resp(400, { error: { message: "INVALID_ID_TOKEN" } });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    const jwt = new URLSearchParams(body).get("assertion");
    const [h, c, s] = jwt.split(".");
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(h + "." + c));
    const claims = JSON.parse(Buffer.from(c, "base64url"));
    if (!valid || claims.scope !== "https://www.googleapis.com/auth/datastore") return resp(400, { error: "invalid_grant" });
    jetonsDemandes++;
    return resp(200, { access_token: "ya29.test", expires_in: 3600 });
  }
  if (url.startsWith("https://api.paystack.co/")) {
    assert.equal(init.headers.Authorization, "Bearer sk_test_secret");
    if (url.endsWith("/transaction/initialize")) {
      const b = JSON.parse(body);
      TX[b.reference] = { ...b, status: "ongoing" };
      return resp(200, { status: true, data: { authorization_url: "https://checkout.paystack.com/" + b.reference, reference: b.reference } });
    }
    const m = /\/transaction\/verify\/(.+)$/.exec(url);
    if (m) {
      const x = TX[decodeURIComponent(m[1])];
      if (!x) return resp(404, { status: false, message: "Transaction reference not found" });
      return resp(200, { status: true, data: { status: x.status, reference: x.reference, amount: x.amount, currency: x.currency, channel: x.channel || "mobile_money", metadata: x.metadata, customer: { email: x.email } } });
    }
  }
  if (url.startsWith(ROOT)) {
    assert.equal(init.headers.Authorization, "Bearer ya29.test");
    const u = new URL(url);
    const rel = decodeURIComponent(u.pathname.split("/documents")[1] || "");
    if (rel === ":runQuery") {
      const q = JSON.parse(body).structuredQuery;
      const [lo, hi] = q.where.compositeFilter.filters.map((f) => new Date(f.fieldFilter.value.timestampValue).getTime());
      const out = Object.entries(DB).filter(([p]) => /^utilisateurs\/[^/]+$/.test(p)).filter(([, d]) => {
        const e = getPath(d.fields, "abonnement.expire");
        if (!e) return false;
        const v = new Date(e.timestampValue).getTime();
        return v >= lo && v <= hi;
      }).map(([p, d]) => ({ document: { name: `projects/architmind-74294/databases/(default)/documents/${p}`, fields: d.fields, updateTime: d.updateTime } }));
      return resp(200, out.length ? out : [{ readTime: "x" }]);
    }
    const path = rel.replace(/^\//, "");
    if (method === "GET") return DB[path] ? resp(200, { name: path, fields: DB[path].fields, updateTime: DB[path].updateTime }) : resp(404, { error: { status: "NOT_FOUND" } });
    if (method === "POST") { const id = "n" + (seq++); DB[path + "/" + id] = { fields: JSON.parse(body).fields, updateTime: stamp() }; return resp(200, { name: path + "/" + id }); }
    if (method === "PATCH") {
      const ex = u.searchParams.get("currentDocument.exists"), ut = u.searchParams.get("currentDocument.updateTime");
      if (ex === "false" && DB[path]) return resp(409, { error: { status: "ALREADY_EXISTS" } });
      if (ut && (!DB[path] || DB[path].updateTime !== ut)) return resp(400, { error: { status: "FAILED_PRECONDITION" } });
      const mask = u.searchParams.getAll("updateMask.fieldPaths");
      const nf = JSON.parse(body).fields;
      const doc = DB[path] || { fields: {} };
      for (const f of mask) setMasked(doc.fields, nf, f);
      doc.updateTime = stamp(); DB[path] = doc;
      return resp(200, { name: path, fields: doc.fields, updateTime: doc.updateTime });
    }
  }
  if (url === "https://api.brevo.com/v3/smtp/email") {
    assert.equal(init.headers["api-key"], "xkeysib-test");
    MAILS.push(JSON.parse(body));
    return resp(201, { messageId: "m" + MAILS.length });
  }
  throw new Error("requête inattendue : " + method + " " + url);
};

/* ---------- outils ---------- */
const doc = (p) => DB[p] && Object.fromEntries(Object.entries(DB[p].fields).map(([k, v]) => [k, dec(v)]));
const call = (path, { method = "POST", token, body, headers = {}, raw } = {}) =>
  worker.fetch(new Request("https://architmind-paiement.exemple.workers.dev" + path, {
    method, headers: { Origin: "https://truthone-hue.github.io", ...(token ? { Authorization: "Bearer " + token } : {}), ...(body || raw ? { "Content-Type": "application/json" } : {}), ...headers },
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  }), env);
async function hmac(s) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PAYSTACK_SECRET), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(s))).toString("hex");
}
async function webhook(reference) {
  const raw = JSON.stringify({ event: "charge.success", data: { reference } });
  return call("/api/paiement/webhook", { raw, headers: { "x-paystack-signature": await hmac(raw) } });
}
const notifs = (uid) => Object.keys(DB).filter((p) => p.startsWith(`utilisateurs/${uid}/notifications/`)).map(doc);

// profils existants (créés par le site à l'inscription)
DB["utilisateurs/uAwa"] = { fields: { nom: enc("Awa Traoré"), email: enc("awa@exemple.ci"), quota: enc({ jour: "2026-11-09", nb: 2 }) }, updateTime: stamp() };
DB["utilisateurs/uPaul"] = { fields: { nom: enc("Paul"), email: enc("paul@exemple.ci") }, updateTime: stamp() };

/* ---------- scénarios ---------- */
let ref1;
await t("santé et CORS", async () => {
  const r = await call("/", { method: "GET" });
  assert.equal(r.status, 200); assert.equal((await r.json()).mode, "test");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://truthone-hue.github.io");
  const o = await call("/api/paiement/creer", { method: "OPTIONS" });
  assert.equal(o.status, 204); assert.match(o.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  const autre = await worker.fetch(new Request("https://x.dev/", { headers: { Origin: "https://pirate.exemple" } }), env);
  assert.equal(autre.headers.get("Access-Control-Allow-Origin"), null);
});

await t("créer : connexion et offre exigées", async () => {
  assert.equal((await call("/api/paiement/creer", { body: { offre: "max" } })).status, 401);
  assert.equal((await call("/api/paiement/creer", { token: "faux", body: { offre: "max" } })).status, 401);
  const r = await call("/api/paiement/creer", { token: "jeton-awa", body: { offre: "basique" } });
  assert.equal(r.status, 400); assert.equal((await r.json()).erreur, "Offre inconnue.");
});

await t("créer : paiement Max de 60 000 FCFA", async () => {
  const r = await call("/api/paiement/creer", { token: "jeton-awa", body: { offre: "max", retour: "https://truthone-hue.github.io/Architmind/?paiement=1" } });
  assert.equal(r.status, 200);
  const j = await r.json(); ref1 = j.reference;
  assert.match(j.url, /^https:\/\/checkout\.paystack\.com\//);
  const tx = TX[ref1];
  assert.equal(tx.amount, 6000000); assert.equal(tx.currency, "XOF"); assert.equal(tx.email, "awa@exemple.ci");
  assert.equal(tx.callback_url, "https://truthone-hue.github.io/Architmind/?paiement=1");
  assert.deepEqual(tx.channels, ["mobile_money", "card"]);
  assert.equal(tx.metadata.uid, "uAwa");
  const p = doc(`paiements/${ref1}`);
  assert.equal(p.statut, "en_attente"); assert.equal(p.montant, 60000); assert.equal(p.uid, "uAwa");
});

await t("adresse de retour étrangère remplacée", async () => {
  const r = await call("/api/paiement/creer", { token: "jeton-paul", body: { offre: "moyen", retour: "https://pirate.exemple/vol" } });
  const j = await r.json();
  assert.equal(TX[j.reference].callback_url, "https://truthone-hue.github.io/Architmind/?paiement=1");
  assert.equal(TX[j.reference].amount, 3000000);
});

await t("webhook : signature fausse refusée", async () => {
  const raw = JSON.stringify({ event: "charge.success", data: { reference: ref1 } });
  const r = await call("/api/paiement/webhook", { raw, headers: { "x-paystack-signature": "abc" } });
  assert.equal(r.status, 401);
  assert.equal(doc("utilisateurs/uAwa").abonnement, undefined);
});

await t("vérifier avant paiement : en attente, rien d'activé", async () => {
  const r = await call("/api/paiement/verifier", { token: "jeton-awa", body: { reference: ref1 } });
  assert.equal((await r.json()).statut, "en_attente");
  assert.equal(doc("utilisateurs/uAwa").abonnement, undefined);
});

await t("webhook valide : offre Max activée 30 jours, notification et reçu", async () => {
  TX[ref1].status = "success";
  const avant = Date.now();
  const r = await webhook(ref1);
  assert.equal(r.status, 200);
  const u = doc("utilisateurs/uAwa");
  assert.equal(u.abonnement.offre, "max");
  const jours = (u.abonnement.expire.getTime() - avant) / JOUR;
  assert.ok(jours > 29.99 && jours < 30.01, "durée " + jours);
  assert.deepEqual(u.abonnement.rappels, []);
  assert.equal(u.nom, "Awa Traoré"); assert.equal(u.quota.nb, 2); // le reste du profil est conservé
  assert.equal(doc(`paiements/${ref1}`).statut, "payé");
  const n = notifs("uAwa");
  assert.equal(n.length, 1); assert.equal(n[0].titre, "Paiement reçu : offre Max"); assert.match(n[0].texte, /60 000 FCFA payés par Mobile Money/);
  assert.equal(MAILS.length, 1); assert.equal(MAILS[0].to[0].email, "awa@exemple.ci"); assert.equal(MAILS[0].subject, "Reçu de paiement : offre Max");
});

await t("doublons : webhook rejoué et vérification au retour sans double activation", async () => {
  const exp1 = doc("utilisateurs/uAwa").abonnement.expire.getTime();
  assert.equal((await webhook(ref1)).status, 200);
  const r = await call("/api/paiement/verifier", { token: "jeton-awa", body: { reference: ref1 } });
  const j = await r.json();
  assert.equal(j.statut, "payé"); assert.equal(j.deja, true);
  assert.equal(doc("utilisateurs/uAwa").abonnement.expire.getTime(), exp1);
  assert.equal(notifs("uAwa").length, 1); assert.equal(MAILS.length, 1);
});

await t("vérifier le paiement d'un autre compte : refusé", async () => {
  const r = await call("/api/paiement/verifier", { token: "jeton-paul", body: { reference: ref1 } });
  assert.equal(r.status, 404);
});

await t("renouvellement avant l'échéance : le mois s'ajoute à la date de fin", async () => {
  const exp1 = doc("utilisateurs/uAwa").abonnement.expire.getTime();
  const r = await call("/api/paiement/creer", { token: "jeton-awa", body: { offre: "max" } });
  const ref2 = (await r.json()).reference;
  TX[ref2].status = "success"; TX[ref2].channel = "card";
  await call("/api/paiement/verifier", { token: "jeton-awa", body: { reference: ref2 } });
  const exp2 = doc("utilisateurs/uAwa").abonnement.expire.getTime();
  assert.ok(Math.abs(exp2 - exp1 - 30 * JOUR) < 5000, "prolongé de 30 jours");
  assert.match(notifs("uAwa").at(-1).texte, /par carte bancaire/);
});

await t("montant trafiqué : refusé", async () => {
  const r = await call("/api/paiement/creer", { token: "jeton-paul", body: { offre: "max" } });
  const ref = (await r.json()).reference;
  TX[ref].status = "success"; TX[ref].amount = 100;
  const w = await webhook(ref);
  assert.equal(w.status, 200); // refus définitif : journalisé, rien à renvoyer ; l'offre n'est pas activée
  assert.equal(doc("utilisateurs/uPaul").abonnement, undefined);
});

await t("rappels : 7, 3 et 1 jour avant, puis expiration, sans doublon", async () => {
  const exp = doc("utilisateurs/uAwa").abonnement.expire.getTime();
  const mails0 = MAILS.length, n0 = notifs("uAwa").length;
  assert.equal(await _test.rappels(env, exp - 20 * JOUR), 0);
  assert.equal(await _test.rappels(env, exp - 6.5 * JOUR), 1);
  assert.equal(await _test.rappels(env, exp - 6.2 * JOUR), 0); // même jour : pas de doublon
  assert.equal(await _test.rappels(env, exp - 2.5 * JOUR), 1);
  assert.equal(await _test.rappels(env, exp - 0.5 * JOUR), 1);
  assert.equal(await _test.rappels(env, exp + 0.5 * JOUR), 1);
  assert.equal(await _test.rappels(env, exp + 1.5 * JOUR), 0);
  const titres = notifs("uAwa").slice(n0).map((x) => x.titre);
  assert.deepEqual(titres, ["Votre offre Max expire dans 7 jours", "Votre offre Max expire dans 3 jours", "Votre offre Max expire demain", "Votre offre Max a expiré"]);
  assert.equal(MAILS.length - mails0, 4);
  assert.deepEqual(doc("utilisateurs/uAwa").abonnement.rappels, ["7", "3", "1", "expire"]);
  assert.equal(doc("utilisateurs/uAwa").abonnement.offre, "max"); // le reste de l'abonnement est conservé
});

await t("jeton Google réutilisé", async () => { assert.equal(jetonsDemandes, 1); });

console.log(`\n${ok} tests réussis`);
