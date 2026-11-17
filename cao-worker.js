// Architmind CI · maquette CAO sur ordinateur, calculée avec Open CASCADE (bibliothèque replicad) dans un fil à part,
// pour que la page ne se fige pas. Le moteur (environ 6,5 Mo compressés) n'est téléchargé qu'à la première demande.
// Repères : plan (x vers la droite, y vers le bas du plan) ; CAO (X = x, Y = D - y, Z = hauteur, en mètres) ;
// 3D du site (three.js) : (X - W/2, Z, D/2 - Y).
let R = null, last = null;
const post = (id, d, tr) => postMessage(Object.assign({ id }, d), tr || []);

async function init(u, id) {
  if (R) return R;
  post(id, { progress: "load" });
  const [lib, ocm] = await Promise.all([import(u.lib), import(u.oc)]);
  const OC = await ocm.default({ locateFile: () => u.wasm });
  lib.setOC(OC);
  R = lib;
  return R;
}

// fusion par paires (plus rapide qu'à la file) ; null si la liste est vide
function fuseAll(a) {
  a = a.filter(Boolean);
  if (!a.length) return null;
  while (a.length > 1) {
    const b = [];
    for (let i = 0; i < a.length; i += 2) b.push(i + 1 < a.length ? a[i].fuse(a[i + 1]) : a[i]);
    a = b;
  }
  return a[0];
}
const vol = s => (s ? R.measureVolume(s) : 0);
const tryDo = (f, s) => { try { return f(s) || s; } catch (e) { return s; } };

function build(d, o) {
  if (last) { last.step.forEach(x => { try { x.shape.delete(); } catch (e) {} }); last = null; }
  const D = d.D, H = d.H;
  // pavé donné en coordonnées du plan (x, y) et en hauteur (z)
  const box = (x0, y0, z0, x1, y1, z1) => R.makeBox([Math.min(x0, x1), D - Math.max(y0, y1), Math.min(z0, z1)], [Math.max(x0, x1), D - Math.min(y0, y1), Math.max(z0, z1)]);
  const out = { levels: [], roof: {}, q: { murExt: 0, murPatio: 0, murSep: 0, murInt: 0, ouv: 0, ouvTab: 0, dalles: 0, dallesTop: 0, poteaux: 0, acrotere: 0, acroL: 0, escalier: 0, soubassement: 0, toit: 0 } };
  const q = out.q;
  // mur : pavé moins ses ouvertures (fenêtres cintrées si demandé)
  const wall = (w, y0) => {
    const t = w.t, h = w.o === "h", e = t / 2 + 0.06;
    const bx = (a, b, z0, z1, th) => h ? box(a, w.c - th, y0 + z0, b, w.c + th, y0 + z1) : box(w.c - th, a, y0 + z0, w.c + th, b, y0 + z1);
    let s = bx(w.s0, w.s1, 0, H, t / 2);
    for (const op of w.ops) {
      const a = Math.max(w.s0, op.d0), b = Math.min(w.s1, op.d1);
      if (b - a < 0.02) continue;
      const bot = op.bot <= 0.001 ? -0.05 : op.bot, top = Math.min(op.top, H - 0.02);
      const arch = o.arches && op.k === "win" && w.ext && b - a >= 0.5 && top - bot > 0.6;
      const rise = arch ? Math.min(0.3, (b - a) * 0.25) : 0, len = b - a;
      const ca = a - w.s0 < 0.002 ? a - 0.05 : a, cb = w.s1 - b < 0.002 ? b + 0.05 : b;
      s = s.cut(bx(ca, cb, bot, top - rise, e));
      let area = len * (top - Math.max(0, bot) - rise);
      if (rise) {
        // arc de cercle : corde = largeur de la fenêtre, flèche = rise
        const rr = (len * len / 4 + rise * rise) / (2 * rise), mid = (a + b) / 2, zc = y0 + top - rr;
        const cyl = h ? R.makeCylinder(rr, 2 * e, [mid, D - (w.c + e), zc], [0, 1, 0]) : R.makeCylinder(rr, 2 * e, [w.c - e, D - mid, zc], [1, 0, 0]);
        const cap = cyl.intersect(bx(a, b, top - rise, top + 0.01, e));
        s = s.cut(cap);
        const th = 2 * Math.asin(len / (2 * rr));
        area += rr * rr * (th - Math.sin(th)) / 2;
      }
      q.ouv += area;
      q.ouvTab += (2 * (top - Math.max(0, bot)) + len) * t; // tableaux et linteau, à enduire
    }
    return s;
  };
  const meshOf = (s, cat, li) => {
    if (!s) return null;
    const m = s.mesh({ tolerance: 0.006, angularTolerance: 0.25 }), E = s.meshEdges({ tolerance: 0.006, angularTolerance: 0.25 });
    const V = m.vertices, N = m.normals, pos = new Float32Array(V.length), nor = new Float32Array(N.length);
    for (let i = 0; i < V.length; i += 3) {
      pos[i] = V[i] - d.W / 2; pos[i + 1] = V[i + 2]; pos[i + 2] = D / 2 - V[i + 1];
      nor[i] = N[i]; nor[i + 1] = N[i + 2]; nor[i + 2] = -N[i + 1];
    }
    const L = E.lines, ed = new Float32Array(L.length);
    for (let i = 0; i < L.length; i += 3) { ed[i] = L[i] - d.W / 2; ed[i + 1] = L[i + 2]; ed[i + 2] = D / 2 - L[i + 1]; }
    return { cat, li, pos, nor, idx: Uint32Array.from(m.triangles), ed };
  };
  const step = [], meshes = [], done = {};
  const keep = (s, cat, li, name, color) => { if (!s) return; step.push({ shape: s, name, color }); const m = meshOf(s, cat, li); if (m) meshes.push(m); };
  d.levels.forEach((L, li) => {
    post(d.id, { progress: "level", li, n: d.levels.length });
    const y0 = L.y0, nm = L.name;
    // étage courant identique à un autre : on recopie ses solides, décalés en hauteur
    if (L.same !== undefined && done[L.same]) {
      const src = done[L.same], dz = y0 - d.levels[src.base].y0;
      Object.entries(src.solids).forEach(([cat, s]) => keep(s.clone().translate([0, 0, dz]), cat, li, nm + " · " + src.names[cat], src.colors[cat]));
      Object.entries(src.q).forEach(([k, v]) => q[k] += v);
      done[li] = src;
      return;
    }
    const q0 = Object.assign({}, q);
    let ext = fuseAll(L.walls.filter(w => w.cat === "ext").map(w => wall(w, y0)).concat(L.corners.map(c => box(c.x - c.s / 2, c.y - c.s / 2, y0, c.x + c.s / 2, c.y + c.s / 2, y0 + H))));
    if (ext && o.corners && d.corners.length) ext = tryDo(s => s.fillet(0.08, e => e.inDirection("Z").either(d.corners.map(([x, y]) => f => f.inBox([x - 0.16, D - y - 0.16, y0 - 0.5], [x + 0.16, D - y + 0.16, y0 + H + 0.5])))), ext);
    let pat = fuseAll(L.walls.filter(w => w.cat === "patio").map(w => wall(w, y0)));
    let sep = fuseAll(L.walls.filter(w => w.cat === "sep").map(w => wall(w, y0)));
    let int = fuseAll(L.walls.filter(w => w.cat === "int").map(w => wall(w, y0)));
    // chaque volume de mur n'est compté qu'une fois : les cloisons s'arrêtent au nu des murs de façade
    if (pat && ext) pat = pat.cut(ext);
    if (sep && ext) sep = sep.cut(ext);
    if (int) { [ext, pat, sep].forEach(x => { if (x) int = int.cut(x); }); }
    q.murExt += vol(ext) / d.TO; q.murPatio += vol(pat) / 0.15; q.murSep += vol(sep) / d.TO; q.murInt += vol(int) / d.TI;
    // poteaux des terrasses et galeries
    const posts = fuseAll(L.posts.map(p => o.roundPosts ? R.makeCylinder(0.125, H, [p.x, D - p.y, y0]) : box(p.x - 0.12, p.y - 0.12, y0, p.x + 0.12, p.y + 0.12, y0 + H)));
    q.poteaux += vol(posts);
    // dalle haute : une seule pièce par niveau ; bords arrondis si demandé
    let slab = fuseAll(L.slabs.map(r => box(r.x0, r.y0, y0 + H, r.x1, r.y1, y0 + H + d.SL)));
    if (slab) slab = tryDo(s => s.simplify(), slab);
    if (slab && o.slabEdges) slab = tryDo(s => s.fillet(0.1, e => e.either([f => f.inPlane("XY", y0 + H), f => f.inPlane("XY", y0 + H + d.SL)])), slab);
    if (L.top) q.dallesTop += vol(slab); else q.dalles += vol(slab);
    // escalier en béton armé : marches posées sur une paillasse de 15 cm, comme sur un chantier (pas un bloc plein)
    const stair = fuseAll(L.steps.map(s => box(s.x0, s.y0, y0 + Math.max(0, s.h - (s.r || 0.18) - 0.15), s.x1, s.y1, y0 + s.h)));
    q.escalier += vol(stair);
    const sol = { ext, pat, sep, int, posts, stair }, names = { ext: "Murs de façade", pat: "Murs sur patio", sep: "Murs séparatifs", int: "Cloisons", posts: "Poteaux", stair: "Escalier", slab: L.top ? "Dalle de toiture" : "Dalle haute" };
    const colors = { ext: "#efebe3", pat: "#efebe3", sep: "#e3ded4", int: "#f4f2ee", posts: "#e9e5dc", stair: "#cfc8bb", slab: "#d9d5cc" };
    if (!L.top) sol.slab = slab;
    Object.entries(sol).forEach(([cat, s]) => keep(s, cat, li, nm + " · " + names[cat], colors[cat]));
    if (L.top) { out.roofSlab = slab; keep(slab, "slab", -1, nm + " · " + names.slab, colors.slab); }
    const dq = {}; Object.keys(q).forEach(k => dq[k] = q[k] - q0[k]);
    done[li] = { solids: Object.fromEntries(Object.entries(sol).filter(([, s]) => s)), q: dq, names, colors, base: li };
  });
  // toiture : acrotères ou toits en pente
  post(d.id, { progress: "roof" });
  const acro = fuseAll(d.parapets.map(p => box(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1)));
  q.acrotere = vol(acro); q.acroL = d.parapets.reduce((s, p) => s + Math.max(Math.abs(p.x1 - p.x0), Math.abs(p.y1 - p.y0)), 0);
  keep(acro, "acro", -1, "Toiture · Acrotères", "#efebe3");
  const roofs = fuseAll(d.roofs.map(r => {
    const f = R.makePolygon(r.pts.map(([x, y, z]) => [x, D - y, z]));
    return R.basicFaceExtrusion(f, new R.Vector([r.v[0], -r.v[1], r.v[2]]));
  }));
  q.toit = roofs ? R.measureArea(roofs) : 0;
  keep(roofs, "roof", -1, "Toiture", "#cfc8bb");
  // soubassement
  if (d.plinth) { const p = d.plinth, s = box(p.x0, p.y0, 0, p.x1, p.y1, p.h); q.soubassement = vol(s); keep(s, "plinth", 0, "Soubassement", "#cfc8bb"); }
  last = { key: d.key, step };
  return { meshes, q };
}

onmessage = async (e) => {
  const { id, cmd } = e.data;
  try {
    await init(e.data.urls, id);
    if (cmd === "build") {
      const t0 = Date.now(), d = Object.assign({ id }, e.data.desc), r = build(d, e.data.opts || {});
      const tr = [];
      r.meshes.forEach(m => tr.push(m.pos.buffer, m.nor.buffer, m.idx.buffer, m.ed.buffer));
      post(id, { meshes: r.meshes, q: r.q, ms: Date.now() - t0 }, tr);
    } else if (cmd === "step") {
      if (!last || last.key !== e.data.key) throw new Error("maquette à recalculer");
      const blob = await R.exportSTEP(last.step, { unit: "M", modelUnit: "M" });
      const buf = await blob.arrayBuffer();
      post(id, { step: buf }, [buf]);
    } else post(id, { ok: true });
  } catch (err) {
    post(id, { error: String((err && err.message) || err) });
  }
};
