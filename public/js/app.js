'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const money = (n) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const STATUS = { new: 'تم استلام الطلب', preparing: 'قيد التحضير', ready: 'جاهز', out_for_delivery: 'خرج للتوصيل', completed: 'مكتمل', cancelled: 'ملغي' };
  const FLOW_DELIVERY = ['new', 'preparing', 'ready', 'out_for_delivery', 'completed'];
  const FLOW_PICKUP = ['new', 'preparing', 'ready', 'completed'];

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  async function api(path, opts = {}) {
    const r = await fetch(path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'حدث خطأ، حاول مرة أخرى');
    return data;
  }
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }
  const safeImg = (u) => (/^(\/(uploads|img)\/[\w.-]+|https:\/\/[^\s"'<>]+)$/.test(u || '') ? u : '');
  const placeholder = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '54'); s.setAttribute('height', '54'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', '#d4af37'); s.setAttribute('stroke-width', '1.4'); s.innerHTML = '<path d="M7 3v8a2 2 0 0 0 2 2v8M11 3v8M7 7h4M17 3c-2 2-3 5-3 8h3v10"/>'; return s; };

  // ---------- State ----------
  let menu = null;
  let cart = {}; // key "product:12" -> qty
  try { cart = JSON.parse(localStorage.getItem('cf_cart') || '{}') || {}; } catch { cart = {}; }
  let orderType = 'delivery';
  let activeCat = 'all';
  let query = '';
  const saveCart = () => localStorage.setItem('cf_cart', JSON.stringify(cart));

  const findItem = (key) => {
    const [kind, id] = key.split(':'); const n = Number(id);
    if (!menu) return null;
    if (kind === 'offer') { const o = menu.offers.find((x) => x.id === n && x.price != null); return o && { key, kind, id: n, name: o.title, price: o.price, image: o.image }; }
    for (const c of menu.categories) { const p = c.products.find((x) => x.id === n); if (p) return { key, kind, id: n, name: p.name, price: p.price, image: p.image }; }
    return null;
  };
  const cartLines = () => Object.entries(cart).map(([k, q]) => { const it = findItem(k); return it ? { ...it, qty: q } : null; }).filter(Boolean);
  const subtotal = () => cartLines().reduce((a, l) => a + l.price * l.qty, 0);
  function deliveryFee() {
    if (orderType !== 'delivery') return 0;
    const s = menu.settings; if (s.free_delivery_over > 0 && subtotal() >= s.free_delivery_over) return 0; return s.delivery_fee;
  }
  function setQty(key, q) {
    if (q <= 0) delete cart[key]; else cart[key] = Math.min(50, q);
    saveCart(); renderCartCount(); renderMenu(); if ($('#drawer').classList.contains('open')) renderDrawer();
  }
  function renderCartCount() {
    const n = cartLines().reduce((a, l) => a + l.qty, 0); const c = $('#cartCount'); c.textContent = n;
    const b = $('#cartBtn'); b.classList.remove('bump'); void b.offsetWidth; if (n) b.classList.add('bump');
  }

  // ---------- Menu ----------
  function priceEl(p, oldP) {
    return h('div', { class: 'price-row' }, h('span', { class: 'price' }, money(p), h('small', {}, 'ج.م')), oldP ? h('span', { class: 'old' }, money(oldP)) : null);
  }
  function actionEl(key) {
    const q = cart[key] || 0;
    if (!q) return h('button', { class: 'add', onclick: () => { setQty(key, 1); toast('تمت الإضافة للسلة'); } }, 'أضف +');
    return h('div', { class: 'stepper' }, h('button', { onclick: () => setQty(key, q + 1), 'aria-label': 'زيادة' }, '+'), h('span', {}, q), h('button', { onclick: () => setQty(key, q - 1), 'aria-label': 'نقص' }, '−'));
  }
  function productCard(p) {
    const img = safeImg(p.image);
    return h('article', { class: 'card' },
      h('div', { class: 'img' }, img ? h('img', { src: img, alt: p.name, loading: 'lazy' }) : placeholder()),
      h('div', { class: 'body' }, h('h4', {}, p.name), p.description ? h('p', {}, p.description) : h('p', {}),
        h('div', { class: 'foot' }, priceEl(p.price, p.old_price), actionEl(`product:${p.id}`))));
  }
  function renderTabs() {
    const t = $('#tabs'); t.replaceChildren();
    const mk = (id, name) => h('button', { class: 'tab' + (activeCat === id ? ' on' : ''), role: 'tab', onclick: () => { activeCat = id; renderTabs(); renderMenu(); } }, name);
    t.append(mk('all', 'الكل'));
    for (const c of menu.categories) t.append(mk(String(c.id), c.name));
  }
  function renderMenu() {
    const root = $('#menuRoot'); root.replaceChildren();
    if (!menu.categories.length) {
      root.append(h('div', { class: 'empty' }, h('b', {}, 'المنيو قيد التجهيز'), 'سيتم إضافة الأصناف قريبًا. تابعنا!'));
      $('#tabs').hidden = true; $('#searchBox').hidden = true; return;
    }
    const q = query.trim().toLowerCase(); let any = false;
    for (const c of menu.categories) {
      if (activeCat !== 'all' && String(c.id) !== activeCat) continue;
      const prods = c.products.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
      if (!prods.length) continue; any = true;
      root.append(h('section', { class: 'cat-block' }, h('h3', {}, c.name), h('div', { class: 'grid' }, prods.map(productCard))));
    }
    if (!any) root.append(h('div', { class: 'empty' }, h('b', {}, 'لا توجد نتائج'), 'جرّب كلمة بحث مختلفة.'));
  }
  function renderOffers() {
    const sec = $('#offers'), grid = $('#offersGrid'); grid.replaceChildren();
    sec.hidden = !menu.offers.length; $('#navOffers').hidden = !menu.offers.length;
    for (const o of menu.offers) {
      const img = safeImg(o.image);
      grid.append(h('article', { class: 'offer' }, img ? h('img', { src: img, alt: '', loading: 'lazy' }) : null, o.badge ? h('span', { class: 'badge' }, o.badge) : null,
        h('div', { class: 'in' }, h('h3', {}, o.title), o.description ? h('p', {}, o.description) : null,
          o.price != null ? h('div', { class: 'price-row' }, priceEl(o.price, o.old_price), actionEl(`offer:${o.id}`)) : null)));
    }
  }
  function renderInfo() {
    const s = menu.settings; const hours = `${s.hours_open} – ${s.hours_close}`;
    document.title = `${s.name} | ${s.tagline}`;
    $('#brandName').textContent = s.name; $('#brandTag').textContent = s.tagline; $('#heroName').textContent = s.name; $('#heroTag').textContent = s.tagline;
    $('#heroAbout').textContent = s.about; $('#heroHours').textContent = hours; $('#heroManager').textContent = s.manager;
    $('#aboutText').textContent = s.about; $('#aboutManager').textContent = s.manager; $('#aboutAddress').textContent = s.address || '—'; $('#aboutHours').textContent = hours;
    $('#contactAddress').textContent = s.address || ''; $('#footName').textContent = s.name;
    const bar = $('#closedBar'); bar.hidden = s.is_open; bar.textContent = s.is_open ? '' : `نعتذر، ${s.closed_reason}. يمكنك تصفح المنيو الآن.`;
    const a = $('#contactActions'); a.replaceChildren();
    const digits = (v) => String(v || '').replace(/\D/g, '');
    if (s.phone) a.append(h('a', { class: 'btn btn-gold', href: `tel:${digits(s.phone)}` }, `اتصل: ${s.phone}`));
    if (s.whatsapp) a.append(h('a', { class: 'btn btn-ghost', href: `https://wa.me/${digits(s.whatsapp)}`, target: '_blank', rel: 'noopener' }, 'واتساب'));
    if (/^https:\/\//.test(s.facebook)) a.append(h('a', { class: 'btn btn-ghost', href: s.facebook, target: '_blank', rel: 'noopener' }, 'فيسبوك'));
  }

  // ---------- Drawer / checkout ----------
  const form = { name: localStorage.getItem('cf_name') || '', phone: localStorage.getItem('cf_phone') || '', address: localStorage.getItem('cf_addr') || '', notes: '' };
  function openDrawer() { renderDrawer(); $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#backdrop').hidden = false; document.body.style.overflow = 'hidden'; }
  function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#backdrop').hidden = true; document.body.style.overflow = ''; }
  function renderDrawer() {
    const body = $('#drawerBody'); const keep = document.activeElement && document.activeElement.id; body.replaceChildren();
    const lines = cartLines();
    if (!lines.length) { body.append(h('div', { class: 'empty' }, h('b', {}, 'السلة فارغة'), 'أضف أصنافًا من المنيو لتبدأ طلبك.'), h('button', { class: 'btn btn-gold', style: 'width:100%;margin-top:1rem', onclick: () => { closeDrawer(); location.hash = '#menu'; } }, 'تصفح المنيو')); return; }
    for (const l of lines) {
      const img = safeImg(l.image);
      body.append(h('div', { class: 'ci' }, h('div', { class: 'im' }, img ? h('img', { src: img, alt: '' }) : null),
        h('div', {}, h('b', {}, l.name), h('small', {}, `${money(l.price)} ج.م`), h('button', { class: 'rm', onclick: () => setQty(l.key, 0) }, 'حذف')),
        h('div', { class: 'stepper' }, h('button', { onclick: () => setQty(l.key, l.qty + 1) }, '+'), h('span', {}, l.qty), h('button', { onclick: () => setQty(l.key, l.qty - 1) }, '−'))));
    }
    const s = menu.settings;
    const seg = h('div', { class: 'seg' });
    if (s.delivery_enabled) seg.append(h('button', { class: orderType === 'delivery' ? 'on' : '', onclick: () => { orderType = 'delivery'; renderDrawer(); } }, '🛵 توصيل'));
    if (s.pickup_enabled) seg.append(h('button', { class: orderType === 'pickup' ? 'on' : '', onclick: () => { orderType = 'pickup'; renderDrawer(); } }, '🏪 استلام من المطعم'));
    if (!s.delivery_enabled && orderType === 'delivery') orderType = 'pickup';
    if (!s.pickup_enabled && orderType === 'pickup') orderType = 'delivery';
    body.append(seg);
    const field = (id, label, extra = {}, tag = 'input') => {
      const el = h(tag, { id, ...extra }); el.value = form[id.replace('f_', '')] || '';
      el.addEventListener('input', () => { form[id.replace('f_', '')] = el.value; });
      return h('div', { class: 'fld' }, h('label', { for: id }, label), el);
    };
    body.append(field('f_name', 'الاسم *', { autocomplete: 'name', maxlength: 80 }),
      field('f_phone', 'رقم الهاتف *', { inputmode: 'tel', autocomplete: 'tel', maxlength: 20 }),
      orderType === 'delivery' ? field('f_address', 'العنوان بالتفصيل *', { autocomplete: 'street-address', maxlength: 300 }) : null,
      field('f_notes', 'ملاحظات (اختياري)', { maxlength: 500 }, 'textarea'));
    const fee = deliveryFee(), sub = subtotal();
    const sum = h('div', { class: 'sum' }, h('div', {}, h('span', {}, 'المجموع'), h('span', {}, `${money(sub)} ج.م`)));
    if (orderType === 'delivery') sum.append(h('div', {}, h('span', {}, 'رسوم التوصيل'), h('span', {}, fee ? `${money(fee)} ج.م` : 'مجانًا')));
    sum.append(h('div', { class: 't' }, h('span', {}, 'الإجمالي'), h('span', {}, `${money(sub + fee)} ج.م`)));
    body.append(sum);
    if (s.min_order > 0 && sub < s.min_order) body.append(h('div', { class: 'err' }, `الحد الأدنى للطلب ${money(s.min_order)} ج.م`));
    if (!s.is_open) body.append(h('div', { class: 'err' }, `لا نستقبل طلبات الآن: ${s.closed_reason}`));
    const err = h('div', { class: 'err', id: 'orderErr', hidden: true });
    const btn = h('button', { class: 'btn btn-gold', style: 'width:100%', id: 'submitOrder', disabled: !s.is_open || (s.min_order > 0 && sub < s.min_order), onclick: () => submitOrder(btn, err) }, 'تأكيد الطلب');
    body.append(err, btn, h('small', { style: 'display:block;text-align:center;color:var(--muted);margin-top:.7rem' }, 'الدفع عند الاستلام'));
    if (keep && $('#' + keep)) { const e = $('#' + keep); e.focus(); try { e.setSelectionRange(e.value.length, e.value.length); } catch {} }
  }
  async function submitOrder(btn, errBox) {
    errBox.hidden = true; btn.disabled = true; btn.textContent = 'جارٍ إرسال الطلب…';
    try {
      const items = cartLines().map((l) => ({ kind: l.kind, id: l.id, qty: l.qty }));
      const { code, order } = await api('/api/orders', { method: 'POST', body: { name: form.name, phone: form.phone, address: form.address, notes: form.notes, order_type: orderType, items } });
      localStorage.setItem('cf_name', form.name); localStorage.setItem('cf_phone', form.phone); localStorage.setItem('cf_addr', form.address);
      localStorage.setItem('cf_last', JSON.stringify({ code, phone: form.phone }));
      cart = {}; saveCart(); renderCartCount(); renderMenu(); renderOffers(); closeDrawer(); showDone(order, form.phone);
    } catch (e) { errBox.textContent = e.message; errBox.hidden = false; btn.disabled = false; btn.textContent = 'تأكيد الطلب'; }
  }

  // ---------- Order tracking (live) ----------
  let es = null;
  function trackerEl(o) {
    const flow = o.order_type === 'pickup' ? FLOW_PICKUP : FLOW_DELIVERY;
    const idx = flow.indexOf(o.status);
    const wrap = h('div', { class: 'tracker' }, h('h4', {}, `طلب ${o.code}`), h('small', { style: 'color:var(--muted)' }, `الحالة الحالية: ${STATUS[o.status]}`));
    if (o.status === 'cancelled') wrap.append(h('div', { class: 'cancelled-note' }, 'تم إلغاء هذا الطلب. للاستفسار تواصل معنا.'));
    else wrap.append(h('div', { class: 'steps' }, flow.map((s, i) => h('div', { class: 'step' + (i < idx ? ' done' : '') + (i === idx ? ' now' : '') + (i === idx && s === 'completed' ? ' done' : '') }, h('i', {}, i < idx || o.status === 'completed' ? '✓' : i + 1), STATUS[s]))));
    const lines = h('div', { class: 'lines' }, o.items.map((i) => h('div', {}, h('span', {}, `${i.name} × ${i.qty}`), h('span', {}, `${money(i.price * i.qty)} ج.م`))));
    if (o.order_type === 'delivery') lines.append(h('div', {}, h('span', {}, 'رسوم التوصيل'), h('span', {}, o.delivery_fee ? `${money(o.delivery_fee)} ج.م` : 'مجانًا')));
    lines.append(h('div', { class: 'tot' }, h('span', {}, 'الإجمالي'), h('span', {}, `${money(o.total)} ج.م`)));
    wrap.append(lines); return wrap;
  }
  function watch(code, phone, container) {
    if (es) es.close();
    es = new EventSource(`/api/orders/stream?code=${encodeURIComponent(code)}&phone=${encodeURIComponent(phone)}`);
    es.addEventListener('status', (ev) => { const o = JSON.parse(ev.data); container.replaceChildren(trackerEl(o)); if (o.status === 'completed' || o.status === 'cancelled') { /* keep open */ } });
  }
  function showDone(order, phone) {
    const card = $('#doneCard'); card.replaceChildren();
    const live = h('div', {});
    card.append(h('div', { class: 'check' }, '✓'), h('h3', { style: 'text-align:center;color:var(--gold2)' }, 'تم استلام طلبك بنجاح'),
      h('p', { style: 'text-align:center;color:var(--muted);margin:.3rem 0 .8rem' }, 'رقم طلبك — احتفظ به لمتابعة الحالة'), h('div', { class: 'code' }, order.code), live,
      h('button', { class: 'btn btn-gold', style: 'width:100%;margin-top:1.2rem', onclick: () => { $('#doneModal').hidden = true; document.body.style.overflow = ''; } }, 'تمام'));
    live.append(trackerEl(order)); watch(order.code, phone, live);
    $('#doneModal').hidden = false; document.body.style.overflow = 'hidden';
  }
  $('#trackForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const box = $('#trackResult'); box.replaceChildren();
    const code = $('#trackCode').value.trim().toUpperCase(), phone = $('#trackPhone').value.trim();
    try { const { order } = await api('/api/orders/track', { method: 'POST', body: { code, phone } }); const live = h('div', {}, trackerEl(order)); box.append(live); watch(order.code, phone, live); }
    catch (err) { box.append(h('div', { class: 'err', style: 'margin-top:1rem' }, err.message)); }
  });
  try { const last = JSON.parse(localStorage.getItem('cf_last') || 'null'); if (last) { $('#trackCode').value = last.code; $('#trackPhone').value = last.phone; } } catch {}

  // ---------- Init ----------
  async function load() {
    try { menu = await api('/api/menu'); }
    catch (e) { $('#menuRoot').replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'تعذر تحميل المنيو'), e.message)); return; }
    renderInfo(); renderTabs(); renderMenu(); renderOffers(); renderCartCount();
  }
  $('#cartBtn').addEventListener('click', () => (menu ? openDrawer() : null));
  $('#closeCart').addEventListener('click', closeDrawer);
  $('#backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); $('#doneModal').hidden = true; document.body.style.overflow = ''; } });
  $('#searchBox').addEventListener('input', (e) => { query = e.target.value; renderMenu(); });
  window.addEventListener('scroll', () => $('#nav').classList.toggle('solid', scrollY > 30), { passive: true });
  $('#year').textContent = new Date().getFullYear();
  load(); setInterval(() => { if (!document.hidden && !$('#drawer').classList.contains('open')) api('/api/menu').then((m) => { menu = m; renderInfo(); renderTabs(); renderMenu(); renderOffers(); }).catch(() => {}); }, 60000);
})();
