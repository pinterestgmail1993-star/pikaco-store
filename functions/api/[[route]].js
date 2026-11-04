// PikaCo API — Cloudflare Pages Function (D1 backend)
// Routes: POST /api/track, POST /api/order, GET /api/admin/stats, POST /api/admin/order_status
// Auth: env.ADMIN_USER / env.ADMIN_PASS (fallback: pikacoadmin / chalhat1 — set env vars to override!)

let ready = false;

async function ensureSchema(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS visits(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sid TEXT, path TEXT,
      ref TEXT, dur INTEGER DEFAULT 0, ua TEXT, country TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS cart_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sid TEXT, action TEXT,
      slug TEXT, name TEXT, price INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS orders(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sid TEXT, name TEXT,
      phone TEXT, city TEXT, address TEXT, items TEXT, total INTEGER,
      status TEXT DEFAULT 'new', notes TEXT)`),
  ]);
  ready = true;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function checkAuth(request, env) {
  const user = env.ADMIN_USER || "pikacoadmin";
  const pass = env.ADMIN_PASS || "chalhat1";
  const hdr = request.headers.get("Authorization") || "";
  if (!hdr.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = atob(hdr.slice(6)); } catch { return false; }
  const idx = decoded.indexOf(":");
  return decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass;
}

function clean(s, max = 200) {
  return String(s == null ? "" : s).slice(0, max).trim();
}

async function handleTrack(request, db, cf) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const ts = Date.now();
  const sid = clean(b.sid, 64) || "anon";
  const type = clean(b.type, 20);
  if (type === "visit") {
    await db.prepare("INSERT INTO visits (ts,sid,path,ref,ua,country) VALUES (?,?,?,?,?,?)")
      .bind(ts, sid, clean(b.path, 160) || "/", clean(b.ref, 200),
            request.headers.get("user-agent") || "", (cf && cf.country) || "")
      .run();
  } else if (type === "duration") {
    const dur = Math.max(0, Math.min(7200, parseInt(b.dur, 10) || 0));
    await db.prepare("UPDATE visits SET dur=? WHERE id=(SELECT MAX(id) FROM visits WHERE sid=? AND path=?)")
      .bind(dur, sid, clean(b.path, 160) || "/").run();
  } else if (type === "cart") {
    await db.prepare("INSERT INTO cart_events (ts,sid,action,slug,name,price) VALUES (?,?,?,?,?,?)")
      .bind(ts, sid, clean(b.action, 20) || "add", clean(b.slug, 80), clean(b.name, 120),
            parseInt(b.price, 10) || 0).run();
  } else {
    return json({ error: "unknown type" }, 400);
  }
  return new Response(null, { status: 204 });
}

async function handleOrder(request, db) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const name = clean(b.name, 80);
  const phone = clean(b.phone, 20);
  const city = clean(b.city, 60);
  const address = clean(b.address, 300);
  const notes = clean(b.notes, 300);
  const items = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
  if (!name || !phone || !address || !items.length) {
    return json({ error: "name, phone, address and items are required" }, 400);
  }
  let total = 0;
  const cleanItems = [];
  for (const it of items) {
    const price = parseInt(it.price, 10) || 0;
    const qty = Math.max(1, Math.min(20, parseInt(it.qty, 10) || 1));
    total += price * qty;
    cleanItems.push({ slug: clean(it.slug, 80), name: clean(it.name, 120), price, qty });
  }
  if (!total) return json({ error: "cart total is zero" }, 400);
  const ts = Date.now();
  const r = await db.prepare(
    "INSERT INTO orders (ts,sid,name,phone,city,address,items,total,notes) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(ts, clean(b.sid, 64), name, phone, city, address,
          JSON.stringify(cleanItems), total, notes).run();
  return json({ ok: true, id: r.meta.last_row_id, total });
}

const DAY = 86400000;

async function handleAdmin(path, request, env, db) {
  if (!checkAuth(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (path === "/admin/stats") {
    const now = Date.now();
    const [vToday, v7, uniq, avgDur, addsToday, daily, topPages, topProducts,
           orders, revenue, recentCarts] = await db.batch([
      db.prepare("SELECT COUNT(*) n FROM visits WHERE ts>?").bind(now - DAY),
      db.prepare("SELECT COUNT(*) n FROM visits WHERE ts>?").bind(now - 7 * DAY),
      db.prepare("SELECT COUNT(DISTINCT sid) n FROM visits WHERE ts>?").bind(now - 7 * DAY),
      db.prepare("SELECT AVG(dur) d FROM visits WHERE ts>? AND dur>0").bind(now - 7 * DAY),
      db.prepare("SELECT COUNT(*) n FROM cart_events WHERE action='add' AND ts>?").bind(now - DAY),
      db.prepare("SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') day, COUNT(*) n FROM visits WHERE ts>? GROUP BY day ORDER BY day DESC LIMIT 14").bind(now - 14 * DAY),
      db.prepare("SELECT path, COUNT(*) v, AVG(dur) d FROM visits WHERE ts>? GROUP BY path ORDER BY v DESC LIMIT 25").bind(now - 7 * DAY),
      db.prepare("SELECT name, COUNT(*) n FROM cart_events WHERE action='add' AND ts>? GROUP BY slug ORDER BY n DESC LIMIT 10").bind(now - 30 * DAY),
      db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 100"),
      db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status!='cancelled'"),
      db.prepare("SELECT * FROM cart_events ORDER BY id DESC LIMIT 30"),
    ]);
    return json({
      visitsToday: vToday.results[0].n,
      visits7d: v7.results[0].n,
      uniqueVisitors: uniq.results[0].n,
      avgDuration: Math.round(avgDur.results[0].d || 0),
      cartAddsToday: addsToday.results[0].n,
      daily: daily.results,
      topPages: topPages.results,
      topProducts: topProducts.results,
      orders: orders.results,
      revenue: revenue.results[0].s,
      recentCarts: recentCarts.results,
    });
  }
  if (path === "/admin/order_status" && request.method === "POST") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const status = ["new", "confirmed", "shipped", "delivered", "cancelled"].includes(b.status) ? b.status : null;
    if (!status || !b.id) return json({ error: "bad status/id" }, 400);
    await db.prepare("UPDATE orders SET status=? WHERE id=?").bind(status, parseInt(b.id, 10)).run();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const db = env.DB;
  if (!db) {
    return json({ error: "D1_NOT_BOUND",
      help: "Create a D1 database in the Cloudflare dashboard, then Pages project -> Settings -> Bindings -> add D1 binding with variable name DB." }, 503);
  }
  try {
    await ensureSchema(db);
    if (path === "/track" && request.method === "POST") return handleTrack(request, db, request.cf);
    if (path === "/order" && request.method === "POST") return handleOrder(request, db);
    if (path.startsWith("/admin")) return handleAdmin(path, request, env, db);
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: "server", detail: String(e).slice(0, 200) }, 500);
  }
}
