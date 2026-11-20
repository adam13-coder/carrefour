'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

// ---- .env loader (بدون مكتبات) ----
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const { db, verifyPassword, hashPassword, getSettings, setSettings, UPLOAD_DIR } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUSES = ['new', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'];
const SESSION_TTL = 1000 * 60 * 60 * 12;

// ================= Helpers =================
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8'
};
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const r2 = (n) => Math.round(n * 100) / 100;

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'الحجم كبير جدًا')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'بيانات غير صالحة')); }
    });
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
const isSecure = (req) => PROD || req.headers['x-forwarded-proto'] === 'https';

// Rate limiter (in-memory counters لحماية فقط، وليست تخزين بيانات)
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now(); const b = buckets.get(key) || { n: 0, reset: t + windowMs };
  if (t > b.reset) { b.n = 0; b.reset = t + windowMs; }
  b.n++; buckets.set(key, b);
  return b.n <= max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60000).unref();

const str = (v, max, { required = false, label = 'الحقل' } = {}) => {
  const s = typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
  if (required && !s) throw new HttpError(400, `${label} مطلوب`);
  if (s.length > max) throw new HttpError(400, `${label} طويل جدًا`);
  return s;
};
const num = (v, { min = 0, max = 1e6, label = 'القيمة', required = true } = {}) => {
  if ((v === '' || v == null) && !required) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} غير صحيحة`);
  return r2(n);
};
const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

// ================= SSE =================
const adminClients = new Set();
const orderClients = new Map(); // orderId -> Set(res)
function sseInit(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
}
const sseSend = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
setInterval(() => {
  for (const r of adminClients) { try { r.write(': ping\n\n'); } catch {} }
  for (const set of orderClients.values()) for (const r of set) { try { r.write(': ping\n\n'); } catch {} }
}, 25000).unref();

// ================= Domain =================
const orderCode = (id) => `CF-${1000 + id}`;
function loadOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return null;
  o.code = orderCode(o.id);
  o.items = db.prepare('SELECT kind, ref_id, name, price, qty FROM order_items WHERE order_id=? ORDER BY id').all(id);
  return o;
}
function publicOrder(o) {
  return { code: o.code, status: o.status, order_type: o.order_type, customer_name: o.customer_name, items: o.items.map(({ name, price, qty }) => ({ name, price, qty })),
    subtotal: o.subtotal, delivery_fee: o.delivery_fee, total: o.total, created_at: o.created_at, updated_at: o.updated_at };
}
function normPhone(p) { return String(p || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, ''); }

function isOpenNow(s) {
  if (s.orders_open !== '1') return { open: false, reason: 'الطلبات متوقفة مؤقتًا' };
  if (s.enforce_hours === '1') {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const cur = Number(parts.find((p) => p.type === 'hour').value) % 24 * 60 + Number(parts.find((p) => p.type === 'minute').value);
    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const o = toMin(s.hours_open), c = toMin(s.hours_close);
    const open = o === c ? true : (o < c ? cur >= o && cur < c : cur >= o || cur < c);
    if (!open) return { open: false, reason: `خارج ساعات العمل (${s.hours_open} - ${s.hours_close})` };
  }
  return { open: true };
}

function publicSettings(s) {
  const st = isOpenNow(s);
  return { name: s.name, name_en: s.name_en, tagline: s.tagline, manager: s.manager, about: s.about, phone: s.phone, whatsapp: s.whatsapp,
    address: s.address, facebook: s.facebook, hours_open: s.hours_open, hours_close: s.hours_close, delivery_fee: Number(s.delivery_fee),
    free_delivery_over: Number(s.free_delivery_over), min_order: Number(s.min_order), pickup_enabled: s.pickup_enabled === '1',
    delivery_enabled: s.delivery_enabled === '1', is_open: st.open, closed_reason: st.reason || '' };
}

function createOrder(body, ip) {
  const s = getSettings();
  const st = isOpenNow(s);
  if (!st.open) throw new HttpError(403, `نعتذر، لا نستقبل طلبات الآن: ${st.reason}`);
  const name = str(body.name, 80, { required: true, label: 'الاسم' });
  const phone = normPhone(str(body.phone, 30, { required: true, label: 'رقم الهاتف' }));
  if (phone.length < 8 || phone.length > 15) throw new HttpError(400, 'رقم الهاتف غير صحيح');
  const type = body.order_type === 'pickup' ? 'pickup' : 'delivery';
  if (type === 'pickup' && s.pickup_enabled !== '1') throw new HttpError(400, 'الاستلام من المطعم غير متاح حاليًا');
  if (type === 'delivery' && s.delivery_enabled !== '1') throw new HttpError(400, 'التوصيل غير متاح حاليًا');
  const address = type === 'delivery' ? str(body.address, 300, { required: true, label: 'العنوان' }) : str(body.address, 300);
  const notes = str(body.notes, 500);
  if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'السلة فارغة');
  if (body.items.length > 40) throw new HttpError(400, 'عدد الأصناف كبير جدًا');

  // الأسعار تُقرأ دائمًا من قاعدة البيانات — لا نثق بأي سعر قادم من العميل
  const merged = new Map();
  for (const it of body.items) {
    const kind = it.kind === 'offer' ? 'offer' : 'product';
    const id = Number(it.id); const qty = Math.floor(Number(it.qty));
    if (!Number.isInteger(id) || !(qty >= 1 && qty <= 50)) throw new HttpError(400, 'بيانات الصنف غير صحيحة');
    const key = `${kind}:${id}`; merged.set(key, { kind, id, qty: Math.min(50, (merged.get(key)?.qty || 0) + qty) });
  }
  const lines = [];
  for (const { kind, id, qty } of merged.values()) {
    let row;
    if (kind === 'product') {
      row = db.prepare('SELECT p.id, p.name, p.price FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.available=1 AND c.active=1').get(id);
    } else {
      row = db.prepare('SELECT id, title AS name, price FROM offers WHERE id=? AND active=1 AND price IS NOT NULL').get(id);
    }
    if (!row) throw new HttpError(400, 'أحد الأصناف لم يعد متاحًا، برجاء تحديث الصفحة');
    lines.push({ kind, ref_id: row.id, name: row.name, price: row.price, qty });
  }
  const subtotal = r2(lines.reduce((a, l) => a + l.price * l.qty, 0));
  const minOrder = Number(s.min_order);
  if (minOrder > 0 && subtotal < minOrder) throw new HttpError(400, `الحد الأدنى للطلب ${minOrder} ج.م`);
  let fee = 0;
  if (type === 'delivery') {
    fee = Number(s.delivery_fee);
    const free = Number(s.free_delivery_over);
    if (free > 0 && subtotal >= free) fee = 0;
  }
  const total = r2(subtotal + fee);
  const t = now();
  let id;
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO orders(customer_name,phone,address,notes,order_type,subtotal,delivery_fee,total,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(name, phone, address, notes, type, subtotal, fee, total, 'new', t, t);
    id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO order_items(order_id,kind,ref_id,name,price,qty) VALUES(?,?,?,?,?,?)');
    for (const l of lines) ins.run(id, l.kind, l.ref_id, l.name, l.price, l.qty);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const order = loadOrder(id);
  for (const c of adminClients) sseSend(c, 'new-order', order);
  return order;
}

function setOrderStatus(id, status) {
  if (!STATUSES.includes(status)) throw new HttpError(400, 'حالة غير صالحة');
  const o = db.prepare('SELECT id FROM orders WHERE id=?').get(id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
  const order = loadOrder(id);
  for (const c of adminClients) sseSend(c, 'order-updated', order);
  const set = orderClients.get(id);
  if (set) for (const c of set) sseSend(c, 'status', publicOrder(order));
  return order;
}

// ================= Uploads =================
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'صيغة الصورة غير مدعومة (JPG / PNG / WEBP)');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new HttpError(413, 'حجم الصورة أكبر من 4MB');
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  if (!(isJpg || isPng || isWebp)) throw new HttpError(400, 'الملف ليس صورة صالحة');
  const ext = isJpg ? 'jpg' : isPng ? 'png' : 'webp';
  const file = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  return `/uploads/${file}`;
}
function cleanImage(v) {
  const s = str(v, 300);
  if (s && !/^\/(uploads|img)\/[A-Za-z0-9._-]+$/.test(s) && !/^https:\/\/[^\s"'<>]+$/.test(s)) throw new HttpError(400, 'رابط الصورة غير صالح');
  return s;
}

// ================= Routes =================
const routes = [];
const route = (method, pattern, handler, { admin = false } = {}) => {
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, admin });
};

// ---- Public ----
route('GET', '/api/menu', () => {
  const categories = db.prepare('SELECT id,name FROM categories WHERE active=1 ORDER BY sort,id').all();
  const prods = db.prepare('SELECT id,category_id,name,description,price,old_price,image FROM products WHERE available=1 ORDER BY sort,id').all();
  for (const c of categories) c.products = prods.filter((p) => p.category_id === c.id);
  const offers = db.prepare('SELECT id,title,description,badge,price,old_price,image FROM offers WHERE active=1 ORDER BY sort,id').all();
  return { settings: publicSettings(getSettings()), categories: categories.filter((c) => c.products.length), offers };
});
route('POST', '/api/orders', ({ body, ip }) => {
  if (!rateLimit('order:' + ip, 12, 10 * 60 * 1000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
  const o = createOrder(body, ip);
  return { status: 201, data: { code: o.code, order: publicOrder(o) } };
});
function findOrderForCustomer(code, phone) {
  const m = /^CF-(\d+)$/i.exec(String(code || '').trim());
  if (!m) throw new HttpError(400, 'رقم الطلب غير صحيح');
  const id = Number(m[1]) - 1000;
  const o = loadOrder(id);
  if (!o || normPhone(phone) !== o.phone) throw new HttpError(404, 'لم نجد طلبًا بهذه البيانات');
  return o;
}
route('POST', '/api/orders/track', ({ body, ip }) => {
  if (!rateLimit('track:' + ip, 40, 10 * 60 * 1000)) throw new HttpError(429, 'محاولات كثيرة');
  return { order: publicOrder(findOrderForCustomer(body.code, body.phone)) };
});
route('GET', '/api/orders/stream', ({ req, res, url, ip }) => {
  if (!rateLimit('stream:' + ip, 60, 10 * 60 * 1000)) throw new HttpError(429, 'محاولات كثيرة');
  const o = findOrderForCustomer(url.searchParams.get('code'), url.searchParams.get('phone'));
  sseInit(req, res);
  sseSend(res, 'status', publicOrder(o));
  if (!orderClients.has(o.id)) orderClients.set(o.id, new Set());
  orderClients.get(o.id).add(res);
  req.on('close', () => { const s = orderClients.get(o.id); if (s) { s.delete(res); if (!s.size) orderClients.delete(o.id); } });
  return { handled: true };
});

// ---- Admin auth ----
route('POST', '/api/admin/login', ({ body, req, res, ip }) => {
  if (!rateLimit('login:' + ip, 8, 15 * 60 * 1000)) throw new HttpError(429, 'محاولات دخول كثيرة. حاول بعد 15 دقيقة');
  const a = db.prepare('SELECT * FROM admins WHERE username=?').get(str(body.username, 60));
  const ok = a ? verifyPassword(String(body.password || ''), a.password_hash) : (verifyPassword('x', hashPassword('y')), false);
  if (!ok) throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES(?,?,?)').run(sha256(token), a.id, Date.now() + SESSION_TTL);
  const cookie = `cf_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${isSecure(req) ? '; Secure' : ''}`;
  return { headers: { 'Set-Cookie': cookie }, data: { ok: true, username: a.username, default_pw: !!a.default_pw } };
});
route('POST', '/api/admin/logout', ({ req }) => {
  const t = parseCookies(req).cf_admin; if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(t));
  return { headers: { 'Set-Cookie': 'cf_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }, data: { ok: true } };
});
route('GET', '/api/admin/me', ({ admin }) => ({ username: admin.username, default_pw: !!admin.default_pw }), { admin: true });
route('POST', '/api/admin/change-password', ({ body, admin }) => {
  const a = db.prepare('SELECT * FROM admins WHERE id=?').get(admin.id);
  if (!verifyPassword(String(body.current || ''), a.password_hash)) throw new HttpError(400, 'كلمة المرور الحالية غير صحيحة');
  const np = String(body.next || '');
  if (np.length < 8) throw new HttpError(400, 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف');
  const nu = body.username ? str(body.username, 60) : a.username;
  if (nu.length < 3) throw new HttpError(400, 'اسم المستخدم قصير');
  const dup = db.prepare('SELECT id FROM admins WHERE username=? AND id<>?').get(nu, a.id);
  if (dup) throw new HttpError(400, 'اسم المستخدم مستخدم بالفعل');
  db.prepare('UPDATE admins SET password_hash=?, username=?, default_pw=0 WHERE id=?').run(hashPassword(np), nu, a.id);
  return { ok: true };
}, { admin: true });

// ---- Admin: orders ----
route('GET', '/api/admin/orders', ({ url }) => {
  const status = url.searchParams.get('status');
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(300, Number(url.searchParams.get('limit')) || 100);
  let sql = 'SELECT id FROM orders WHERE 1=1'; const args = [];
  if (status === 'active') sql += " AND status IN ('new','preparing','ready','out_for_delivery')";
  else if (status && STATUSES.includes(status)) { sql += ' AND status=?'; args.push(status); }
  if (q) { sql += ' AND (customer_name LIKE ? OR phone LIKE ? OR (1000+id) = ?)'; args.push(`%${q}%`, `%${normPhone(q) || q}%`, Number(q.replace(/\D/g, '')) || -1); }
  sql += ' ORDER BY id DESC LIMIT ?'; args.push(limit);
  return { orders: db.prepare(sql).all(...args).map((r) => loadOrder(r.id)) };
}, { admin: true });
route('PATCH', '/api/admin/orders/:id/status', ({ params, body }) => ({ order: setOrderStatus(Number(params.id), body.status) }), { admin: true });
route('GET', '/api/admin/stats', ({ url }) => {
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (d) => fmt.format(d);
  const keys = []; for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(Date.now() - i * 86400000)));
  const since = new Date(Date.now() - (days + 1) * 86400000).toISOString();
  const rows = db.prepare('SELECT id,total,status,created_at FROM orders WHERE created_at>=?').all(since);
  const byDay = Object.fromEntries(keys.map((k) => [k, { day: k, orders: 0, sales: 0 }]));
  const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let sales = 0, orders = 0;
  for (const r of rows) {
    const k = dayKey(new Date(r.created_at)); if (!byDay[k]) continue;
    statusCounts[r.status]++;
    if (r.status !== 'cancelled') { byDay[k].orders++; byDay[k].sales = r2(byDay[k].sales + r.total); sales = r2(sales + r.total); orders++; }
  }
  const today = byDay[keys[keys.length - 1]];
  const ids = rows.filter((r) => r.status !== 'cancelled' && byDay[dayKey(new Date(r.created_at))]).map((r) => r.id);
  const top = {};
  if (ids.length) {
    for (const it of db.prepare(`SELECT name, SUM(qty) q, SUM(qty*price) rev FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) GROUP BY name ORDER BY q DESC LIMIT 8`).all(...ids)) top[it.name] = it;
  }
  return { days, sales, orders, avg: orders ? r2(sales / orders) : 0, today, series: keys.map((k) => byDay[k]), statusCounts, top: Object.values(top),
    pending: db.prepare("SELECT COUNT(*) c FROM orders WHERE status='new'").get().c };
}, { admin: true });

// ---- Admin: categories ----
route('GET', '/api/admin/catalog', () => ({
  categories: db.prepare('SELECT * FROM categories ORDER BY sort,id').all(),
  products: db.prepare('SELECT * FROM products ORDER BY sort,id').all(),
  offers: db.prepare('SELECT * FROM offers ORDER BY sort,id').all(),
  settings: getSettings()
}), { admin: true });
route('POST', '/api/admin/categories', ({ body }) => {
  const r = db.prepare('INSERT INTO categories(name,sort,active) VALUES(?,?,?)').run(str(body.name, 60, { required: true, label: 'اسم التصنيف' }), num(body.sort ?? 0, { min: -9999, max: 9999, label: 'الترتيب' }), body.active === undefined ? 1 : flag(body.active));
  return { status: 201, data: db.prepare('SELECT * FROM categories WHERE id=?').get(Number(r.lastInsertRowid)) };
}, { admin: true });
route('PUT', '/api/admin/categories/:id', ({ params, body }) => {
  const id = Number(params.id); if (!db.prepare('SELECT id FROM categories WHERE id=?').get(id)) throw new HttpError(404, 'التصنيف غير موجود');
  db.prepare('UPDATE categories SET name=?, sort=?, active=? WHERE id=?').run(str(body.name, 60, { required: true, label: 'اسم التصنيف' }), num(body.sort ?? 0, { min: -9999, max: 9999, label: 'الترتيب' }), flag(body.active), id);
  return db.prepare('SELECT * FROM categories WHERE id=?').get(id);
}, { admin: true });
route('DELETE', '/api/admin/categories/:id', ({ params }) => {
  const id = Number(params.id); const n = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id=?').get(id).c;
  if (n > 0) throw new HttpError(400, `لا يمكن حذف تصنيف به ${n} منتج. احذف المنتجات أو انقلها أولًا (أو أخفِ التصنيف).`);
  db.prepare('DELETE FROM categories WHERE id=?').run(id); return { ok: true };
}, { admin: true });

// ---- Admin: products ----
function productInput(body) {
  const cat = Number(body.category_id);
  if (!db.prepare('SELECT id FROM categories WHERE id=?').get(cat)) throw new HttpError(400, 'اختر تصنيفًا صحيحًا');
  return [cat, str(body.name, 100, { required: true, label: 'اسم المنتج' }), str(body.description, 500), num(body.price, { min: 0, max: 100000, label: 'السعر' }),
    num(body.old_price, { min: 0, max: 100000, label: 'السعر القديم', required: false }), cleanImage(body.image), flag(body.available ?? 1), num(body.sort ?? 0, { min: -9999, max: 9999, label: 'الترتيب' })];
}
route('POST', '/api/admin/products', ({ body }) => {
  const r = db.prepare('INSERT INTO products(category_id,name,description,price,old_price,image,available,sort) VALUES(?,?,?,?,?,?,?,?)').run(...productInput(body));
  return { status: 201, data: db.prepare('SELECT * FROM products WHERE id=?').get(Number(r.lastInsertRowid)) };
}, { admin: true });
route('PUT', '/api/admin/products/:id', ({ params, body }) => {
  const id = Number(params.id); if (!db.prepare('SELECT id FROM products WHERE id=?').get(id)) throw new HttpError(404, 'المنتج غير موجود');
  db.prepare('UPDATE products SET category_id=?,name=?,description=?,price=?,old_price=?,image=?,available=?,sort=? WHERE id=?').run(...productInput(body), id);
  return db.prepare('SELECT * FROM products WHERE id=?').get(id);
}, { admin: true });
route('DELETE', '/api/admin/products/:id', ({ params }) => { db.prepare('DELETE FROM products WHERE id=?').run(Number(params.id)); return { ok: true }; }, { admin: true });

// ---- Admin: offers ----
function offerInput(body) {
  return [str(body.title, 100, { required: true, label: 'عنوان العرض' }), str(body.description, 500), str(body.badge, 30),
    num(body.price, { min: 0, max: 100000, label: 'سعر العرض', required: false }), num(body.old_price, { min: 0, max: 100000, label: 'السعر القديم', required: false }),
    cleanImage(body.image), flag(body.active ?? 1), num(body.sort ?? 0, { min: -9999, max: 9999, label: 'الترتيب' })];
}
route('POST', '/api/admin/offers', ({ body }) => {
  const r = db.prepare('INSERT INTO offers(title,description,badge,price,old_price,image,active,sort) VALUES(?,?,?,?,?,?,?,?)').run(...offerInput(body));
  return { status: 201, data: db.prepare('SELECT * FROM offers WHERE id=?').get(Number(r.lastInsertRowid)) };
}, { admin: true });
route('PUT', '/api/admin/offers/:id', ({ params, body }) => {
  const id = Number(params.id); if (!db.prepare('SELECT id FROM offers WHERE id=?').get(id)) throw new HttpError(404, 'العرض غير موجود');
  db.prepare('UPDATE offers SET title=?,description=?,badge=?,price=?,old_price=?,image=?,active=?,sort=? WHERE id=?').run(...offerInput(body), id);
  return db.prepare('SELECT * FROM offers WHERE id=?').get(id);
}, { admin: true });
route('DELETE', '/api/admin/offers/:id', ({ params }) => { db.prepare('DELETE FROM offers WHERE id=?').run(Number(params.id)); return { ok: true }; }, { admin: true });

// ---- Admin: settings + upload ----
route('PUT', '/api/admin/settings', ({ body }) => {
  const clean = {};
  const text = { name: 80, name_en: 80, tagline: 80, manager: 80, about: 600, phone: 40, whatsapp: 40, address: 300, facebook: 300 };
  for (const [k, max] of Object.entries(text)) if (k in body) clean[k] = str(body[k], max);
  for (const k of ['hours_open', 'hours_close']) if (k in body) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body[k])) throw new HttpError(400, 'صيغة الوقت غير صحيحة (HH:MM)'); clean[k] = body[k]; }
  for (const k of ['delivery_fee', 'free_delivery_over', 'min_order']) if (k in body) clean[k] = num(body[k], { min: 0, max: 100000, label: k });
  for (const k of ['enforce_hours', 'orders_open', 'pickup_enabled', 'delivery_enabled']) if (k in body) clean[k] = flag(body[k]) ? '1' : '0';
  setSettings(clean);
  return { settings: getSettings() };
}, { admin: true });
route('POST', '/api/admin/upload', ({ body }) => ({ url: saveImage(body.data) }), { admin: true });
route('GET', '/api/admin/stream', ({ req, res }) => {
  sseInit(req, res); adminClients.add(res); sseSend(res, 'hello', { ok: true });
  req.on('close', () => adminClients.delete(res));
  return { handled: true };
}, { admin: true });

// ================= Static =================
function serveFile(req, res, base, rel, cache) {
  let p; try { p = decodeURIComponent(rel); } catch { return false; }
  const full = path.normalize(path.join(base, p));
  if (!full.startsWith(base + path.sep) && full !== base) return false;
  let st; try { st = fs.statSync(full); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  if (!MIME[ext]) return false;
  const headers = { 'Content-Type': MIME[ext], 'Content-Length': st.size, 'Cache-Control': cache };
  if (ext === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(full).pipe(res); return true;
}

// ================= Server =================
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; media-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

function getAdmin(req) {
  const t = parseCookies(req).cf_admin; if (!t) return null;
  const row = db.prepare('SELECT a.id, a.username, a.default_pw, s.expires_at FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=?').get(sha256(t));
  if (!row) return null;
  if (row.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(t)); return null; }
  return row;
}
setInterval(() => { try { db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now()); } catch {} }, 3600000).unref();

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);
  try {
    if (url.pathname.startsWith('/api/')) {
      let matched = null, params = {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname); if (m) { matched = r; params = m.groups || {}; break; }
      }
      if (!matched) {
        if (routes.some((r) => r.re.test(url.pathname))) throw new HttpError(405, 'طريقة غير مسموحة');
        throw new HttpError(404, 'غير موجود');
      }
      let admin = null;
      if (matched.admin) { admin = getAdmin(req); if (!admin) throw new HttpError(401, 'يجب تسجيل الدخول'); }
      let body = {};
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch {} if (!ok) throw new HttpError(403, 'مصدر الطلب غير مسموح'); }
        if (!/application\/json/i.test(req.headers['content-type'] || '') && Number(req.headers['content-length'] || 0) > 0) throw new HttpError(415, 'نوع المحتوى غير مدعوم');
        body = await readBody(req);
      }
      const out = await matched.handler({ req, res, url, params, body, admin, ip });
      if (out && out.handled) return;
      if (out && out.data !== undefined) return sendJson(res, out.status || 200, out.data, out.headers);
      return sendJson(res, 200, out);
    }
    // uploads
    if (url.pathname.startsWith('/uploads/')) {
      if (serveFile(req, res, UPLOAD_DIR, url.pathname.slice(9), 'public, max-age=2592000, immutable')) return;
      throw new HttpError(404, 'غير موجود');
    }
    // pages
    let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (rel === 'admin' || rel === 'admin/') rel = 'admin.html';
    const isAsset = /^(css|js|img)\//.test(rel);
    if (serveFile(req, res, PUBLIC_DIR, rel, isAsset ? 'public, max-age=3600' : 'no-cache')) return;
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:sans-serif;background:#0b0b0b;color:#d4af37;text-align:center;padding:4rem"><h1>الصفحة غير موجودة</h1><a style="color:#fff" href="/">العودة للرئيسية</a>');
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error('[error]', e);
    sendJson(res, 500, { error: 'حدث خطأ في الخادم' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`✔ كارفور دشنا يعمل على http://localhost:${PORT}  (الإدارة: /admin)`));
}
module.exports = { server };
