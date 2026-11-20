'use strict';
// اختبار شامل: يشغّل الخادم على قاعدة بيانات مؤقتة ويختبر المسار الكامل فعليًا عبر HTTP
const os = require('node:os'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-test-'));
process.env.DATA_DIR = tmp; process.env.ADMIN_USER = 'admin'; process.env.ADMIN_PASSWORD = 'mohamed amer 123';
const { server } = require('../server');
let base, cookie = '', passed = 0;
const ok = (name) => { passed++; console.log(`  ✔ ${name}`); };
async function call(method, url, body, { auth = true, headers = {} } = {}) {
  const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {} return { status: r.status, data, headers: r.headers };
}
function sse(url, withAuth) {
  const events = []; const ac = new AbortController();
  fetch(base + url, { signal: ac.signal, headers: withAuth ? { Cookie: cookie } : {} }).then(async (r) => {
    const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value);
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (.*)/.exec(blk), d = /data: (.*)/.exec(blk); if (ev && d) events.push({ event: ev[1], data: JSON.parse(d[1]) }); } }
  }).catch(() => {});
  return { events, close: () => ac.abort() };
}
const wait = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout'); };

(async () => {
  await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`;
  console.log('اختبار كارفور دشنا —', base);

  // الصفحات
  for (const p of ['/', '/admin', '/css/style.css', '/js/app.js', '/js/admin.js', '/img/team.jpg']) { const r = await fetch(base + p); assert.equal(r.status, 200, p); } ok('الصفحات والملفات الثابتة تعمل');
  assert.equal((await fetch(base + '/..%2f..%2fetc/passwd')).status, 404); assert.equal((await fetch(base + '/uploads/..%2f..%2fcarrefour.db')).status, 404); ok('حماية Path Traversal');
  assert.equal((await fetch(base + '/server.js')).status, 404); assert.equal((await fetch(base + '/db.js')).status, 404); ok('ملفات الخادم غير متاحة للعامة');

  // حماية الإدارة
  for (const [m, u] of [['GET', '/api/admin/orders'], ['GET', '/api/admin/catalog'], ['POST', '/api/admin/products'], ['PUT', '/api/admin/settings'], ['GET', '/api/admin/stream'], ['POST', '/api/admin/upload']]) assert.equal((await call(m, u, m === 'GET' ? null : {}, { auth: false })).status, 401, u);
  ok('كل مسارات الإدارة ترفض الزائر (401)');
  assert.equal((await call('POST', '/api/admin/login', { username: 'admin', password: 'wrong' })).status, 401); ok('رفض كلمة مرور خاطئة');
  const bad = await call('POST', '/api/admin/login', { username: 'admin', password: 'mohamed amer 123' }, { headers: { Origin: 'http://evil.example' } }); assert.equal(bad.status, 403); ok('رفض طلبات من مصدر (Origin) غريب');
  const lg = await call('POST', '/api/admin/login', { username: 'admin', password: 'mohamed amer 123' }); assert.equal(lg.status, 200);
  const sc = lg.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); cookie = sc.split(';')[0]; ok('تسجيل دخول المدير + كوكي HttpOnly/SameSite');
  const dbRaw = fs.readFileSync(path.join(tmp, 'carrefour.db')); assert.ok(!dbRaw.includes('mohamed amer 123')); ok('كلمة السر غير مخزنة كنص (مشفرة scrypt)');
  const html = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8'); assert.ok(!html.includes('mohamed amer')); ok('لا توجد بيانات دخول في كود الواجهة');

  // منيو فارغ ثم إضافة
  let m = (await call('GET', '/api/menu', null, { auth: false })).data; assert.equal(m.categories.length, 0); ok('المنيو يبدأ فارغًا (لا أسعار مخترعة)');
  const cat = (await call('POST', '/api/admin/categories', { name: 'اختبار', sort: 1 })).data; assert.ok(cat.id);
  const cat2 = (await call('POST', '/api/admin/categories', { name: 'مخفي', sort: 2 })).data;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await call('POST', '/api/admin/upload', { data: png }); assert.equal(up.status, 200); assert.equal((await fetch(base + up.data.url)).status, 200); ok('رفع صورة وعرضها');
  assert.equal((await call('POST', '/api/admin/upload', { data: 'data:image/png;base64,' + Buffer.from('<?php evil ?>').toString('base64') })).status, 400); ok('رفض ملف مزيف بامتداد صورة');
  const p1 = (await call('POST', '/api/admin/products', { category_id: cat.id, name: 'صنف أ', description: 'وصف', price: 50, image: up.data.url })).data;
  const p2 = (await call('POST', '/api/admin/products', { category_id: cat.id, name: 'صنف ب', price: 30.5 })).data;
  const p3 = (await call('POST', '/api/admin/products', { category_id: cat.id, name: 'غير متاح', price: 10, available: false })).data;
  const p4 = (await call('POST', '/api/admin/products', { category_id: cat2.id, name: 'تصنيف مخفي', price: 10 })).data; await call('PUT', `/api/admin/categories/${cat2.id}`, { name: 'مخفي', sort: 2, active: false });
  const off = (await call('POST', '/api/admin/offers', { title: 'عرض', price: 70, badge: 'وفّر' })).data;
  assert.equal((await call('POST', '/api/admin/products', { category_id: cat.id, name: 'x', price: -5 })).status, 400); ok('إضافة تصنيفات ومنتجات وعروض + التحقق من المدخلات');
  await call('PUT', '/api/admin/settings', { delivery_fee: 15, min_order: 20, phone: '01000000000' });
  m = (await call('GET', '/api/menu', null, { auth: false })).data; assert.equal(m.categories.length, 1); assert.equal(m.categories[0].products.length, 2); assert.equal(m.offers.length, 1); assert.equal(m.settings.delivery_fee, 15); ok('المنيو العام يعرض المتاح فقط');

  // الطلبات
  const adminStream = sse('/api/admin/stream', true); await wait(() => adminStream.events.find((e) => e.event === 'hello'));
  const order = { name: 'عميل تجريبي', phone: '٠١٢٣٤٥٦٧٨٩٠', address: 'شارع الاختبار', notes: 'بدون بصل', order_type: 'delivery', items: [{ kind: 'product', id: p1.id, qty: 2, price: 1 }, { kind: 'product', id: p2.id, qty: 1 }, { kind: 'offer', id: off.id, qty: 1 }] };
  const noName = await call('POST', '/api/orders', { ...order, name: '' }, { auth: false }); assert.equal(noName.status, 400);
  assert.equal((await call('POST', '/api/orders', { ...order, items: [{ kind: 'product', id: p3.id, qty: 1 }] }, { auth: false })).status, 400); assert.equal((await call('POST', '/api/orders', { ...order, items: [{ kind: 'product', id: p4.id, qty: 1 }] }, { auth: false })).status, 400); ok('رفض صنف غير متاح/مخفي/بيانات ناقصة');
  assert.equal((await call('POST', '/api/orders', { ...order, items: [{ kind: 'product', id: p2.id, qty: 0 }] }, { auth: false })).status, 400); assert.equal((await call('POST', '/api/orders', { ...order, items: [{ kind: 'product', id: p2.id, qty: 1e9 }] }, { auth: false })).status, 400); ok('رفض كميات غير منطقية');
  const created = await call('POST', '/api/orders', order, { auth: false }); assert.equal(created.status, 201);
  const exp = 50 * 2 + 30.5 + 70; assert.equal(created.data.order.subtotal, exp); assert.equal(created.data.order.delivery_fee, 15); assert.equal(created.data.order.total, exp + 15); assert.match(created.data.code, /^CF-\d+$/); ok(`إتمام طلب برقم ${created.data.code} — السعر يُحسب من الخادم ويتجاهل سعر العميل`);
  const ev = await wait(() => adminStream.events.find((e) => e.event === 'new-order')); assert.equal(ev.data.code, created.data.code); assert.equal(ev.data.items.length, 3); ok('ظهور الطلب فورًا في لوحة الإدارة (SSE)');
  const list = (await call('GET', '/api/admin/orders')).data.orders; assert.equal(list[0].code, created.data.code); assert.equal(list[0].customer_name, 'عميل تجريبي'); assert.equal(list[0].phone, '01234567890'); assert.equal(list[0].address, 'شارع الاختبار'); ok('بيانات العميل محفوظة في قاعدة البيانات');

  // تتبع العميل لحظيًا
  assert.equal((await call('POST', '/api/orders/track', { code: created.data.code, phone: '01999999999' }, { auth: false })).status, 404); ok('تتبع الطلب يتطلب رقم الهاتف الصحيح');
  const cs = sse(`/api/orders/stream?code=${created.data.code}&phone=01234567890`); await wait(() => cs.events.find((e) => e.event === 'status'));
  const id = list[0].id; for (const st of ['preparing', 'ready', 'out_for_delivery', 'completed']) {
    const r = await call('PATCH', `/api/admin/orders/${id}/status`, { status: st }); assert.equal(r.status, 200);
    await wait(() => cs.events.some((e) => e.event === 'status' && e.data.status === st)); await wait(() => adminStream.events.some((e) => e.event === 'order-updated' && e.data.status === st));
  } ok('تحديث الحالة (تحضير ← جاهز ← توصيل ← مكتمل) يصل للعميل والمدير لحظيًا');
  assert.equal((await call('PATCH', `/api/admin/orders/${id}/status`, { status: 'bogus' })).status, 400); ok('رفض حالة غير صالحة');
  const t = (await call('POST', '/api/orders/track', { code: created.data.code, phone: '01234567890' }, { auth: false })).data.order; assert.equal(t.status, 'completed'); assert.equal(t.address, undefined); ok('بيانات التتبع العامة لا تكشف العنوان');
  const c2 = await call('POST', '/api/orders', { ...order, order_type: 'pickup', items: [{ kind: 'product', id: p1.id, qty: 1 }] }, { auth: false }); assert.equal(c2.data.order.delivery_fee, 0);
  await call('PATCH', `/api/admin/orders/${list[0].id + 1}/status`, { status: 'cancelled' }); ok('طلب استلام من المطعم + إلغاء طلب');
  await call('PUT', '/api/admin/settings', { min_order: 100 }); const small = await call('POST', '/api/orders', { ...order, items: [{ kind: 'product', id: p2.id, qty: 1 }] }, { auth: false }); assert.equal(small.status, 400); await call('PUT', '/api/admin/settings', { min_order: 20 }); ok('تطبيق الحد الأدنى للطلب');

  // إغلاق الطلبات
  await call('PUT', '/api/admin/settings', { orders_open: false }); assert.equal((await call('POST', '/api/orders', order, { auth: false })).status, 403); assert.equal((await call('GET', '/api/menu', null, { auth: false })).data.settings.is_open, false);
  await call('PUT', '/api/admin/settings', { orders_open: true }); ok('إيقاف استقبال الطلبات من الإدارة');

  // إحصائيات
  const st = (await call('GET', '/api/admin/stats?days=7')).data; assert.equal(st.orders, 1); assert.equal(st.sales, exp + 15); assert.equal(st.statusCounts.cancelled, 1); assert.ok(st.top.length); ok('الإحصائيات صحيحة');

  // حذف وتعديل
  assert.equal((await call('DELETE', `/api/admin/categories/${cat.id}`)).status, 400); assert.equal((await call('PUT', `/api/admin/products/${p2.id}`, { category_id: cat.id, name: 'صنف ب', price: 99 })).data.price, 99); assert.equal((await call('DELETE', `/api/admin/products/${p2.id}`)).status, 200);
  const oldItems = (await call('GET', '/api/admin/orders')).data.orders.find((o) => o.id === id).items; assert.ok(oldItems.some((i) => i.name === 'صنف ب' && i.price === 30.5)); ok('تعديل/حذف منتج ولا يتغير سعر الطلبات القديمة');

  // تغيير كلمة السر والجلسات
  assert.equal((await call('POST', '/api/admin/change-password', { current: 'x', next: 'newpassword1' })).status, 400); assert.equal((await call('POST', '/api/admin/change-password', { current: 'mohamed amer 123', next: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/admin/change-password', { current: 'mohamed amer 123', next: 'newpassword1', username: 'boss' })).status, 200);
  assert.equal((await call('POST', '/api/admin/login', { username: 'admin', password: 'mohamed amer 123' })).status, 401); assert.equal((await call('POST', '/api/admin/login', { username: 'boss', password: 'newpassword1' })).status, 200); ok('تغيير بيانات الدخول يعمل');
  await call('POST', '/api/admin/logout'); assert.equal((await call('GET', '/api/admin/orders')).status, 401); ok('تسجيل الخروج يُبطل الجلسة');
  for (let i = 0; i < 12; i++) await call('POST', '/api/admin/login', { username: 'boss', password: 'bad' }); assert.equal((await call('POST', '/api/admin/login', { username: 'boss', password: 'newpassword1' })).status, 429); ok('حد محاولات الدخول (Rate limit)');

  adminStream.close(); cs.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ نجحت كل الاختبارات (${passed})`); process.exit(0);
})().catch((e) => { console.error('\n❌ فشل الاختبار:', e); process.exit(1); });
