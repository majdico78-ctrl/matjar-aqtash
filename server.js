/*
  محمد الأقطش للمجمدات — خادم الموقع المستقل
  يقدّم واجهة المتجر (مجلد public) وكل مسارات البيانات:
    /v1/x/matjar-orders    (GET/POST/PATCH/DELETE) — الطلبيات
    /v1/x/matjar-products  (GET/POST)              — قائمة المنتجات وصورها
    /v1/x/matjar-wallet    (GET/POST)              — أرصدة الزبائن
    /v1/x/matjar-tiles     (GET)                   — بلاطات الخارطة (جوجل/OSM)
  البيانات بملفات JSON داخل مجلد data (يُنشأ تلقائياً).
*/
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const app = express();
app.use(express.json({ limit: "30mb" }));

const DATA = path.join(__dirname, "data");
const ensureData = () => fs.mkdirSync(DATA, { recursive: true });
const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf-8")); } catch (e) { return []; } };
const save = (f, x) => { ensureData(); fs.writeFileSync(path.join(DATA, f), JSON.stringify(x, null, 2)); };
const normPhone = (p) => (p || "").replace(/\D/g, "");

/* ---------- الطلبيات ---------- */
app.get("/v1/x/matjar-orders", (req, res) => res.json(load("matjar-orders.json")));

app.post("/v1/x/matjar-orders", (req, res) => {
  try {
    const order = { id: "o" + Date.now(), ...req.body };
    const all = load("matjar-orders.json");
    all.unshift(order);
    save("matjar-orders.json", all);
    res.status(201).json(order);
  } catch (e) { res.status(400).json({ error: "طلب غير صالح" }); }
});

app.patch("/v1/x/matjar-orders", (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !status) return res.status(400).json({ error: "id وstatus مطلوبان" });
  const all = load("matjar-orders.json");
  const o = all.find((x) => x.id === id);
  if (!o) return res.status(404).json({ error: "الطلب غير موجود" });
  o.status = status;
  save("matjar-orders.json", all);
  res.json(o);
});

app.delete("/v1/x/matjar-orders", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "id مطلوب" });
  save("matjar-orders.json", load("matjar-orders.json").filter((o) => o.id !== id));
  res.json({ ok: true });
});

/* ---------- المنتجات (قائمة واحدة للجميع) ---------- */
app.get("/v1/x/matjar-products", (req, res) => res.json({ products: load("matjar-products.json") }));

app.post("/v1/x/matjar-products", (req, res) => {
  const p = req.body && req.body.products;
  if (!Array.isArray(p)) return res.status(400).json({ error: "products مطلوبة" });
  save("matjar-products.json", p);
  res.json({ ok: true, count: p.length });
});

/* ---------- أرصدة الزبائن ---------- */
const WALLET = "matjar-wallet.json";
app.get("/v1/x/matjar-wallet", (req, res) => {
  const ph = normPhone(req.query.phone || "");
  const all = load(WALLET);
  if (ph) {
    const rows = all.filter((r) => normPhone(r.phone) === ph);
    const balance = rows.reduce((s, r) => s + (r.kind === "شحن" ? r.amount : -r.amount), 0);
    return res.json({ phone: ph, balance, history: rows.reverse() });
  }
  const map = {};
  for (const r of all) {
    const k = normPhone(r.phone);
    if (!k) continue;
    if (!map[k]) map[k] = { name: r.name || "", balance: 0, count: 0 };
    map[k].balance += r.kind === "شحن" ? r.amount : -r.amount;
    map[k].count++;
    if (r.name) map[k].name = r.name;
  }
  res.json(Object.entries(map).map(([phone, v]) => ({ phone, ...v })));
});

app.post("/v1/x/matjar-wallet", (req, res) => {
  const b = req.body || {};
  const phone = normPhone(b.phone || "");
  const amount = Math.round(Number(b.amount) * 100) / 100;
  const kind = b.kind === "خصم" ? "خصم" : "شحن";
  if (!/^07\d{8}$/.test(phone)) return res.status(400).json({ error: "رقم موبايل غير صالح" });
  if (!amount || amount <= 0) return res.status(400).json({ error: "مبلغ غير صالح" });
  const row = { id: "w" + Date.now(), phone, name: (b.name || "").trim(), amount, kind, note: (b.note || "").trim(), at: new Date().toLocaleString("ar-JO") };
  const all = load(WALLET); all.push(row); save(WALLET, all);
  res.status(201).json(row);
});

/* ---------- رسائل الزبائن ---------- */
const MSGS = "matjar-messages.json";
app.get("/v1/x/matjar-messages", (req, res) => {
  const oid = (req.query.orderId || "").trim();
  const all = load(MSGS);
  res.json(oid ? all.filter((m) => m.orderId === oid) : all);
});
app.post("/v1/x/matjar-messages", (req, res) => {
  const b = req.body || {};
  if (!b.orderId || !b.text) return res.status(400).json({ error: "orderId و text مطلوبان" });
  const row = { id: "m" + Date.now(), orderId: b.orderId, phone: normPhone(b.phone || "") || undefined, text: String(b.text), total: Number(b.total) || undefined, at: new Date().toLocaleString("ar-JO") };
  const all = load(MSGS); all.push(row); save(MSGS, all);
  res.status(201).json(row);
});

/* ---------- بلاطات الخارطة ---------- */
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const mem = new Map();

async function grab(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(String(r.status));
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, ct: r.headers.get("content-type") || "image/jpeg" };
}

function logTile(m) {
  try { ensureData(); fs.appendFileSync(path.join(DATA, "matjar-tiles.log"), `${new Date().toISOString()} ${m}\n`); } catch (e) {}
}

app.get("/v1/x/matjar-tiles", async (req, res) => {
  const clamp = (v, n) => Math.max(0, Math.min(n - 1, v));
  const z = Math.max(0, Math.min(20, parseInt(req.query.z) || 16));
  const n = Math.pow(2, z);
  const x = clamp(parseInt(req.query.x) || 0, n);
  const y = clamp(parseInt(req.query.y) || 0, n);
  const s = req.query.s === "m" ? "m" : "g";
  const fmt = req.query.fmt === "b64" ? "b64" : "bin";
  const key = `${s}/${z}/${x}/${y}`;

  const hit = mem.get(key);
  if (hit) {
    logTile(`200 cache ${key} ${fmt}`);
    if (fmt === "b64") return res.json({ b64: hit.buf.toString("base64") });
    return sendTile(res, hit);
  }
  try {
    const got = await grab(`https://mt1.google.com/vt/lyrs=${s === "m" ? "m" : "y"}&hl=ar&x=${x}&y=${y}&z=${z}&s=Galileo`, { "User-Agent": UA });
    if (mem.size > 600) mem.clear();
    mem.set(key, got);
    logTile(`200 google ${key} ${fmt} ${got.buf.length}b`);
    if (fmt === "b64") return res.json({ b64: got.buf.toString("base64") });
    return sendTile(res, got);
  } catch (e) {
    try {
      const got = await grab(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, { "User-Agent": "MatjarAqtash/1.0 (contact 0792145720)" });
      if (mem.size > 600) mem.clear();
      mem.set(key, got);
      logTile(`200 osm ${key} ${fmt} ${got.buf.length}b`);
      if (fmt === "b64") return res.json({ b64: got.buf.toString("base64") });
      return sendTile(res, got);
    } catch (e2) {
      logTile(`502 ${key} ${fmt}`);
      res.status(502).send("no tile");
    }
  }
});

function sendTile(res, got) {
  res.set("Content-Type", got.ct);
  res.set("Cache-Control", "public, max-age=86400");
  res.send(got.buf);
}

/* ---------- الواجهة: نسخة الموقع + حقن جسر vellum ---------- */
const PUBLIC = path.join(__dirname, "public");
const INDEX = (() => {
  let html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf-8");
  const shim = `<script>
window.vellum = {
  fetch: (url, opts) => fetch(url, opts),
  asset: (p) => fetch(p).then(r => r.blob()),
  notify: (m) => console.log("notify:", m)
};
</script>`;
  html = html.replace("<body>", "<body>" + shim);
  return html;
})();

app.get("/", (req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.send(INDEX); });
app.use(express.static(PUBLIC, { index: false, maxAge: "1h" }));
// أي مسار غير معروف يرجع للواجهة (روابط مباشرة)
app.use((req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.send(INDEX); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`متجر محمد الأقطش يعمل على المنفذ ${PORT}`));
