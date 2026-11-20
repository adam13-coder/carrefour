'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const money = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const STATUS = { new: 'جديد', preparing: 'قيد التحضير', ready: 'جاهز', out_for_delivery: 'خرج للتوصيل', completed: 'مكتمل', cancelled: 'ملغي' };
  const fmtTime = (iso) => new Date(iso).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' });

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v; else if (k === 'checked') el.checked = !!v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  async function api(path, method = 'GET', body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/api/admin/login') { showLogin(); throw new Error('انتهت الجلسة، سجّل الدخول مرة أخرى'); }
    if (!r.ok) throw new Error(data.error || 'حدث خطأ');
    return data;
  }
  function toast(msg, kind = '', big = false) {
    const t = h('div', { class: `tst ${kind} ${big ? 'big' : ''}` }, msg); $('#toasts').append(t); setTimeout(() => t.remove(), big ? 7000 : 3200);
  }
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, 'bad'); } };

  // ---------- sound & alerts ----------
  let audio = null, soundOn = localStorage.getItem('cf_sound') !== '0';
  function unlockAudio() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch {} }
  function beep() {
    if (!soundOn) return; unlockAudio(); if (!audio) return;
    const seq = [880, 1175, 880, 1175, 1480]; let t = audio.currentTime;
    for (const f of seq) { const o = audio.createOscillator(), g = audio.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22); o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.24); t += 0.25; }
  }
  const baseTitle = document.title; let flashT;
  function flashTitle(n) { clearInterval(flashT); let on = false; flashT = setInterval(() => { document.title = on ? baseTitle : `🔔 طلب جديد (${n})`; on = !on; }, 900); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearInterval(flashT); document.title = baseTitle; } });
  document.addEventListener('click', unlockAudio, { once: true });

  // ---------- state ----------
  const S = { me: null, tab: 'orders', orders: [], filter: 'active', q: '', catalog: null, fresh: new Set(), es: null, poll: null };
  const app = $('#app');

  // ---------- login ----------
  function showLogin() {
    if (S.es) S.es.close(); clearInterval(S.poll);
    const err = h('div', { class: 'err', hidden: true });
    const u = h('input', { id: 'u', autocomplete: 'username', required: true }), p = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn gold', type: 'submit' }, 'دخول');
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      try { const r = await api('/api/admin/login', 'POST', { username: u.value, password: p.value }); S.me = r; enter(); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
    } }, h('h1', {}, 'لوحة إدارة كارفور دشنا'), h('p', {}, 'سجّل دخولك للمتابعة'), err,
      h('div', { class: 'f' }, h('label', { for: 'u' }, 'اسم المستخدم'), u), h('div', { class: 'f' }, h('label', { for: 'p' }, 'كلمة المرور'), p), btn,
      h('a', { href: '/', style: 'text-align:center;font-size:.85rem' }, '← العودة للموقع'));
    app.replaceChildren(h('div', { class: 'login' }, form)); u.focus();
  }

  // ---------- shell ----------
  const TABS = [['orders', '📥 الطلبات'], ['stats', '📊 الإحصائيات'], ['products', '🍽️ المنتجات'], ['categories', '🗂️ التصنيفات'], ['offers', '🏷️ العروض'], ['settings', '⚙️ الإعدادات'], ['account', '🔐 الحساب']];
  const pending = () => S.orders.filter((o) => o.status === 'new').length;
  function shell() {
    const side = h('aside', { class: 'side' }, h('div', { class: 'logo' }, h('i', {}, 'C'), h('b', {}, 'كارفور دشنا')));
    for (const [id, label] of TABS) {
      side.append(h('button', { class: 'nav-i' + (S.tab === id ? ' on' : ''), onclick: () => { S.tab = id; render(); } }, h('span', {}, label), id === 'orders' && pending() ? h('span', { class: 'pill' }, pending()) : null));
    }
    side.append(h('div', { class: 'sp' }),
      h('button', { class: 'nav-i', onclick: () => { soundOn = !soundOn; localStorage.setItem('cf_sound', soundOn ? '1' : '0'); unlockAudio(); if (soundOn) beep(); render(); } }, soundOn ? '🔔 الصوت: يعمل' : '🔕 الصوت: متوقف'),
      h('a', { class: 'nav-i', href: '/', target: '_blank' }, '↗ فتح الموقع'),
      h('button', { class: 'nav-i lo', onclick: guard(async () => { await api('/api/admin/logout', 'POST'); S.me = null; showLogin(); }) }, '🚪 تسجيل الخروج'));
    return side;
  }
  async function render() {
    const main = h('main', { class: 'main' }); app.replaceChildren(h('div', { class: 'shell' }, shell(), main));
    if (S.me.default_pw && S.tab !== 'account') main.append(h('div', { class: 'warn' }, '⚠️ ما زلت تستخدم كلمة المرور الأولية. غيّرها الآن من تبويب «الحساب» لحماية لوحة الإدارة.'));
    try { await ({ orders: vOrders, stats: vStats, products: vProducts, categories: vCategories, offers: vOffers, settings: vSettings, account: vAccount })[S.tab](main); }
    catch (e) { main.append(h('div', { class: 'err' }, e.message)); }
  }
  async function enter() {
    await loadOrders(); S.tab = 'orders'; render(); connect();
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    clearInterval(S.poll); S.poll = setInterval(async () => { try { const before = new Set(S.orders.map((o) => o.id)); await loadOrders(); const nw = S.orders.filter((o) => !before.has(o.id)); if (nw.length) onNew(nw[0], true); refresh(); } catch {} }, 20000);
  }
  async function loadOrders() { S.orders = (await api('/api/admin/orders?limit=300')).orders; }
  async function loadCatalog() { S.catalog = await api('/api/admin/catalog'); return S.catalog; }

  // ---------- realtime ----------
  function connect() {
    if (S.es) S.es.close();
    S.es = new EventSource('/api/admin/stream');
    S.es.addEventListener('new-order', (e) => onNew(JSON.parse(e.data)));
    S.es.addEventListener('order-updated', (e) => { const o = JSON.parse(e.data); const i = S.orders.findIndex((x) => x.id === o.id); if (i >= 0) S.orders[i] = o; else S.orders.unshift(o); refresh(); });
    S.es.onopen = () => { loadOrders().then(refresh).catch(() => {}); };
  }
  function onNew(o, silentList) {
    if (!S.orders.some((x) => x.id === o.id)) S.orders.unshift(o);
    S.fresh.add(o.id); setTimeout(() => S.fresh.delete(o.id), 20000);
    beep(); toast(`🔔 طلب جديد ${o.code} — ${o.customer_name} — ${money(o.total)} ج.م`, '', true);
    if (document.hidden) flashTitle(pending());
    try { if (window.Notification && Notification.permission === 'granted') new Notification(`طلب جديد ${o.code}`, { body: `${o.customer_name} — ${money(o.total)} ج.م` }); } catch {}
    if (!silentList) refresh();
  }
  function refresh() { if (S.tab === 'orders') render(); else { const old = $('.side'); if (old) old.replaceWith(shell()); } }

  // ---------- orders ----------
  const NEXT = { new: ['preparing', 'قبول وبدء التحضير'], preparing: ['ready', 'جاهز'], ready: null, out_for_delivery: ['completed', 'تم التسليم / مكتمل'] };
  function actionsFor(o) {
    const a = [];
    if (o.status === 'new') a.push(['preparing', 'قبول / قيد التحضير', true]);
    if (o.status === 'preparing') a.push(['ready', 'جاهز', true]);
    if (o.status === 'ready') { if (o.order_type === 'delivery') a.push(['out_for_delivery', 'خرج للتوصيل', true]); a.push(['completed', 'مكتمل', o.order_type === 'pickup']); }
    if (o.status === 'out_for_delivery') a.push(['completed', 'مكتمل', true]);
    if (!['completed', 'cancelled'].includes(o.status)) a.push(['cancelled', 'إلغاء', false, true]);
    if (['completed', 'cancelled'].includes(o.status)) a.push(['new', 'إعادة فتح', false]);
    return a;
  }
  const setStatus = guard(async (id, status) => { const { order } = await api(`/api/admin/orders/${id}/status`, 'PATCH', { status }); const i = S.orders.findIndex((x) => x.id === id); if (i >= 0) S.orders[i] = order; render(); });
  function printOrder(o) {
    let r = $('#receipt'); if (!r) { r = h('div', { id: 'receipt' }); document.body.append(r); }
    r.replaceChildren(h('h2', {}, 'كارفور دشنا'), h('p', {}, `طلب ${o.code} — ${fmtTime(o.created_at)}`), h('p', {}, `${o.customer_name} — ${o.phone}`), o.address ? h('p', {}, o.address) : null, h('hr'),
      ...o.items.map((i) => h('p', {}, `${i.name} × ${i.qty} = ${money(i.price * i.qty)}`)), h('hr'), h('p', {}, `التوصيل: ${money(o.delivery_fee)}`), h('h3', {}, `الإجمالي: ${money(o.total)} ج.م`), o.notes ? h('p', {}, `ملاحظات: ${o.notes}`) : null);
    window.print();
  }
  function orderCard(o) {
    return h('article', { class: 'order' + (S.fresh.has(o.id) ? ' fresh' : '') },
      h('div', { class: 'hd' }, h('span', { class: 'code' }, o.code), h('span', { class: `st ${o.status}` }, STATUS[o.status])),
      h('div', { class: 'meta' }, h('b', {}, o.customer_name), ' · ', h('a', { href: `tel:${o.phone}` }, o.phone), h('br'), `${fmtTime(o.created_at)} · ${o.order_type === 'pickup' ? '🏪 استلام من المطعم' : '🛵 توصيل'}`),
      o.order_type === 'delivery' ? h('div', { class: 'meta' }, '📍 ', h('b', {}, o.address)) : null,
      h('div', { class: 'items' }, o.items.map((i) => h('div', {}, h('span', {}, `${i.name} × ${i.qty}`), h('span', {}, money(i.price * i.qty))))),
      o.notes ? h('div', { class: 'note' }, '📝 ', o.notes) : null,
      h('div', { class: 'meta' }, `المجموع ${money(o.subtotal)} + توصيل ${money(o.delivery_fee)}`),
      h('div', { class: 'tot' }, h('span', {}, 'الإجمالي'), h('span', {}, `${money(o.total)} ج.م`)),
      h('div', { class: 'acts' }, actionsFor(o).map(([st, label, primary, danger]) => h('button', { class: 'btn sm' + (primary ? ' gold' : '') + (danger ? ' danger' : ''), onclick: () => { if (st === 'cancelled' && !confirm('تأكيد إلغاء الطلب؟')) return; setStatus(o.id, st); } }, label)), h('button', { class: 'btn sm', onclick: () => printOrder(o) }, '🖨️ طباعة')));
  }
  async function vOrders(main) {
    const filters = [['active', 'النشطة'], ['new', 'جديدة'], ['preparing', 'قيد التحضير'], ['ready', 'جاهزة'], ['out_for_delivery', 'خرجت للتوصيل'], ['completed', 'مكتملة'], ['cancelled', 'ملغاة'], ['all', 'الكل']];
    const match = (o) => (S.filter === 'all' ? true : S.filter === 'active' ? ['new', 'preparing', 'ready', 'out_for_delivery'].includes(o.status) : o.status === S.filter);
    const q = S.q.trim().toLowerCase();
    const list = S.orders.filter(match).filter((o) => !q || o.customer_name.toLowerCase().includes(q) || o.phone.includes(q) || o.code.toLowerCase().includes(q));
    const search = h('input', { placeholder: 'بحث بالاسم / الهاتف / رقم الطلب', value: S.q, style: 'background:#141414;border:1px solid #2b2619;border-radius:10px;padding:.45rem .8rem;min-width:240px' });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { S.q = search.value; render(); } });
    main.append(h('div', { class: 'top' }, h('h2', {}, `الطلبات (${pending()} جديد)`), h('div', { class: 'row' }, search, h('button', { class: 'btn', onclick: guard(async () => { await loadOrders(); render(); toast('تم التحديث'); }) }, '↻ تحديث'))),
      h('div', { class: 'chips' }, filters.map(([id, l]) => h('button', { class: 'chip' + (S.filter === id ? ' on' : ''), onclick: () => { S.filter = id; render(); } }, l, ` (${S.orders.filter((o) => id === 'all' ? true : id === 'active' ? ['new', 'preparing', 'ready', 'out_for_delivery'].includes(o.status) : o.status === id).length})`))),
      list.length ? h('div', { class: 'orders' }, list.map(orderCard)) : h('div', { class: 'box', style: 'text-align:center;color:#b0a891' }, 'لا توجد طلبات هنا حاليًا. ستظهر الطلبات الجديدة فورًا مع تنبيه صوتي.'));
  }

  // ---------- stats ----------
  let statDays = 7;
  async function vStats(main) {
    const st = await api(`/api/admin/stats?days=${statDays}`);
    const max = Math.max(1, ...st.series.map((d) => d.sales));
    main.append(h('div', { class: 'top' }, h('h2', {}, 'الإحصائيات'), h('div', { class: 'chips', style: 'margin:0' }, [[1, 'اليوم'], [7, '7 أيام'], [30, '30 يوم'], [90, '90 يوم']].map(([d, l]) => h('button', { class: 'chip' + (statDays === d ? ' on' : ''), onclick: () => { statDays = d; render(); } }, l)))),
      h('div', { class: 'kpis' }, h('div', { class: 'kpi' }, h('small', {}, 'إجمالي المبيعات'), h('b', {}, `${money(st.sales)} ج.م`)), h('div', { class: 'kpi' }, h('small', {}, 'عدد الطلبات'), h('b', {}, st.orders)),
        h('div', { class: 'kpi' }, h('small', {}, 'متوسط الطلب'), h('b', {}, `${money(st.avg)} ج.م`)), h('div', { class: 'kpi' }, h('small', {}, 'مبيعات اليوم'), h('b', {}, `${money(st.today.sales)} ج.م`)), h('div', { class: 'kpi' }, h('small', {}, 'طلبات جديدة بانتظار القبول'), h('b', {}, st.pending))),
      h('div', { class: 'box' }, h('h3', {}, 'المبيعات اليومية'), h('div', { class: 'bars' }, st.series.map((d) => h('div', { class: 'bar', title: `${d.day}: ${money(d.sales)} ج.م — ${d.orders} طلب` }, h('span', {}, d.sales ? money(d.sales) : ''), h('i', { style: `height:${Math.max(1, (d.sales / max) * 120)}px` }), h('small', {}, st.series.length > 15 ? d.day.slice(8) : d.day.slice(5)))))),
      h('div', { class: 'two' }, h('div', { class: 'box' }, h('h3', {}, 'الأكثر مبيعًا'), st.top.length ? h('div', { class: 'tw' }, h('table', {}, h('tbody', {}, st.top.map((t) => h('tr', {}, h('td', {}, t.name), h('td', {}, `${t.q} قطعة`), h('td', {}, `${money(t.rev)} ج.م`)))))) : h('p', { class: 'meta' }, 'لا بيانات بعد')),
        h('div', { class: 'box' }, h('h3', {}, 'الطلبات حسب الحالة'), h('table', {}, h('tbody', {}, Object.entries(st.statusCounts).map(([k, v]) => h('tr', {}, h('td', {}, h('span', { class: `st ${k}` }, STATUS[k])), h('td', {}, v))))))),
      h('p', { class: 'meta' }, 'المبيعات تُحسب على الطلبات غير الملغاة.'));
  }

  // ---------- modal helpers ----------
  function modal(title, body, onSave, saveLabel = 'حفظ') {
    const err = h('div', { class: 'err', hidden: true }); const close = () => ov.remove();
    const save = h('button', { class: 'btn gold', onclick: async () => { err.hidden = true; save.disabled = true; try { await onSave(); close(); } catch (e) { err.textContent = e.message; err.hidden = false; } finally { save.disabled = false; } } }, saveLabel);
    const ov = h('div', { class: 'modal' }, h('div', { class: 'mcard' }, h('h3', {}, title), body, err, h('div', { class: 'row' }, save, h('button', { class: 'btn', onclick: close }, 'إلغاء'))));
    document.body.append(ov); return ov;
  }
  const field = (label, input) => h('div', { class: 'f' }, h('label', {}, label), input);
  function resizeToDataUrl(file, max = 1100) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error('اختر صورة JPG أو PNG أو WEBP'));
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('تعذر قراءة الصورة'));
      fr.onload = () => {
        const img = new Image();
        img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height); resolve(c.toDataURL('image/jpeg', 0.86)); };
        img.onerror = () => reject(new Error('تعذر قراءة الصورة')); img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  function imagePicker(initial) {
    const state = { url: initial || '' };
    const prev = h('img', { alt: '' }); const sync = () => { if (state.url) { prev.src = state.url; prev.style.display = ''; } else prev.style.display = 'none'; }; sync();
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    const status = h('small', { class: 'meta' });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return; status.textContent = 'جارٍ الرفع…';
      try { const data = await resizeToDataUrl(file.files[0]); const r = await api('/api/admin/upload', 'POST', { data }); state.url = r.url; sync(); status.textContent = 'تم رفع الصورة ✓'; }
      catch (e) { status.textContent = e.message; }
    });
    const rm = h('button', { class: 'btn sm', type: 'button', onclick: () => { state.url = ''; file.value = ''; sync(); status.textContent = ''; } }, 'إزالة الصورة');
    return { state, el: h('div', { class: 'f' }, h('label', {}, 'صورة (اختياري)'), h('div', { class: 'imgbox' }, prev, h('div', { class: 'f' }, file, h('div', { class: 'row' }, rm, status)))) };
  }
  const sortInput = (v) => h('input', { type: 'number', value: v ?? 0 });
  const confirmDel = (what) => confirm(`حذف ${what}؟ لا يمكن التراجع.`);

  // ---------- products ----------
  function productModal(p) {
    const cats = S.catalog.categories; if (!cats.length) return toast('أضف تصنيفًا أولًا من تبويب «التصنيفات»', 'bad');
    const f = { cat: h('select', {}, cats.map((c) => h('option', { value: c.id, ...(p && p.category_id === c.id ? { selected: true } : {}) }, c.name))), name: h('input', { value: p?.name || '', maxlength: 100 }), desc: h('textarea', { maxlength: 500 }, p?.description || ''),
      price: h('input', { type: 'number', min: 0, step: '0.5', value: p?.price ?? '' }), old: h('input', { type: 'number', min: 0, step: '0.5', value: p?.old_price ?? '' }), sort: sortInput(p?.sort), av: h('input', { type: 'checkbox', checked: p ? !!p.available : true }) };
    const img = imagePicker(p?.image);
    modal(p ? 'تعديل منتج' : 'إضافة منتج', h('div', { class: 'f' }, field('التصنيف', f.cat), field('اسم المنتج *', f.name), field('الوصف', f.desc), h('div', { class: 'three' }, field('السعر (ج.م) *', f.price), field('السعر قبل الخصم', f.old), field('الترتيب', f.sort)), img.el, h('label', { class: 'sw' }, f.av, 'متاح للطلب')),
      async () => { const body = { category_id: Number(f.cat.value), name: f.name.value, description: f.desc.value, price: f.price.value, old_price: f.old.value, image: img.state.url, available: f.av.checked, sort: f.sort.value };
        await api(p ? `/api/admin/products/${p.id}` : '/api/admin/products', p ? 'PUT' : 'POST', body); toast('تم الحفظ'); render(); });
  }
  function bulkModal() {
    const cats = S.catalog.categories; if (!cats.length) return toast('أضف تصنيفًا أولًا', 'bad');
    const cat = h('select', {}, cats.map((c) => h('option', { value: c.id }, c.name)));
    const ta = h('textarea', { style: 'min-height:180px', placeholder: 'سطر لكل منتج بالشكل:\nاسم المنتج | السعر | الوصف (اختياري)\n\nمثال:\nاسم الصنف | 100 | وصف قصير' });
    modal('رفع منيو دفعة واحدة', h('div', { class: 'f' }, field('التصنيف', cat), field('المنتجات', ta), h('small', { class: 'meta' }, 'يمكنك إضافة الصور لاحقًا بتعديل كل منتج.')), async () => {
      const rows = ta.value.split('\n').map((l) => l.trim()).filter(Boolean); if (!rows.length) throw new Error('اكتب منتجًا واحدًا على الأقل');
      let ok = 0; for (const [i, row] of rows.entries()) { const [name, price, ...d] = row.split('|').map((x) => x.trim()); if (!name || isNaN(Number(price))) throw new Error(`السطر ${i + 1} غير صحيح: ${row}`); }
      for (const row of rows) { const [name, price, ...d] = row.split('|').map((x) => x.trim()); await api('/api/admin/products', 'POST', { category_id: Number(cat.value), name, price, description: d.join(' | ') }); ok++; }
      toast(`تمت إضافة ${ok} منتج`); render();
    }, 'إضافة الكل');
  }
  async function vProducts(main) {
    const c = await loadCatalog(); const cname = Object.fromEntries(c.categories.map((x) => [x.id, x.name]));
    main.append(h('div', { class: 'top' }, h('h2', {}, `المنتجات (${c.products.length})`), h('div', { class: 'row' }, h('button', { class: 'btn gold', onclick: () => productModal() }, '+ إضافة منتج'), h('button', { class: 'btn', onclick: bulkModal }, '⬆ رفع منيو دفعة واحدة'))),
      c.products.length ? h('div', { class: 'box tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'المنتج', 'التصنيف', 'السعر', 'متاح', ''].map((x) => h('th', {}, x)))), h('tbody', {}, c.products.map((p) => h('tr', {},
        h('td', {}, p.image ? h('img', { class: 'thumb', src: p.image, alt: '' }) : h('div', { class: 'thumb' })), h('td', {}, h('b', {}, p.name), h('br'), h('small', { class: 'meta' }, p.description)), h('td', {}, cname[p.category_id]),
        h('td', {}, `${money(p.price)}`, p.old_price ? h('small', { class: 'meta' }, ` (قبل ${money(p.old_price)})`) : null),
        h('td', {}, h('button', { class: 'btn sm', onclick: guard(async () => { await api(`/api/admin/products/${p.id}`, 'PUT', { ...p, available: !p.available }); render(); }) }, p.available ? '✅ متاح' : '⛔ غير متاح')),
        h('td', {}, h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => productModal(p) }, 'تعديل'), h('button', { class: 'btn sm danger', onclick: guard(async () => { if (confirmDel(`«${p.name}»`)) { await api(`/api/admin/products/${p.id}`, 'DELETE'); render(); } }) }, 'حذف')))))))) : h('div', { class: 'box', style: 'text-align:center' }, 'لا توجد منتجات بعد. ابدأ بإضافة تصنيف ثم أضف منتجاتك.'));
  }

  // ---------- categories ----------
  function categoryModal(c) {
    const name = h('input', { value: c?.name || '', maxlength: 60 }), sort = sortInput(c?.sort), act = h('input', { type: 'checkbox', checked: c ? !!c.active : true });
    modal(c ? 'تعديل تصنيف' : 'إضافة تصنيف', h('div', { class: 'f' }, field('اسم التصنيف *', name), field('الترتيب (الأصغر أولًا)', sort), h('label', { class: 'sw' }, act, 'ظاهر في المنيو')),
      async () => { await api(c ? `/api/admin/categories/${c.id}` : '/api/admin/categories', c ? 'PUT' : 'POST', { name: name.value, sort: sort.value, active: act.checked }); toast('تم الحفظ'); render(); });
  }
  async function vCategories(main) {
    const c = await loadCatalog();
    main.append(h('div', { class: 'top' }, h('h2', {}, 'التصنيفات'), h('button', { class: 'btn gold', onclick: () => categoryModal() }, '+ إضافة تصنيف')),
      c.categories.length ? h('div', { class: 'box tw' }, h('table', {}, h('tbody', {}, c.categories.map((x) => h('tr', {}, h('td', {}, h('b', {}, x.name)), h('td', {}, `${c.products.filter((p) => p.category_id === x.id).length} منتج`), h('td', {}, x.active ? 'ظاهر' : 'مخفي'), h('td', {}, `ترتيب ${x.sort}`),
        h('td', {}, h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => categoryModal(x) }, 'تعديل'), h('button', { class: 'btn sm danger', onclick: guard(async () => { if (confirmDel(`التصنيف «${x.name}»`)) { await api(`/api/admin/categories/${x.id}`, 'DELETE'); render(); } }) }, 'حذف')))))))) : h('div', { class: 'box', style: 'text-align:center' }, 'لا توجد تصنيفات بعد (مثال: مشويات، بيتزا، مشروبات…).'));
  }

  // ---------- offers ----------
  function offerModal(o) {
    const f = { title: h('input', { value: o?.title || '', maxlength: 100 }), desc: h('textarea', { maxlength: 500 }, o?.description || ''), badge: h('input', { value: o?.badge || '', maxlength: 30, placeholder: 'مثال: وفّر 20%' }), price: h('input', { type: 'number', min: 0, step: '0.5', value: o?.price ?? '' }), old: h('input', { type: 'number', min: 0, step: '0.5', value: o?.old_price ?? '' }), sort: sortInput(o?.sort), act: h('input', { type: 'checkbox', checked: o ? !!o.active : true }) };
    const img = imagePicker(o?.image);
    modal(o ? 'تعديل عرض' : 'إضافة عرض', h('div', { class: 'f' }, field('عنوان العرض *', f.title), field('الوصف', f.desc), field('شارة (اختياري)', f.badge), h('div', { class: 'three' }, field('سعر العرض (اتركه فارغًا لعرض إعلاني فقط)', f.price), field('السعر قبل الخصم', f.old), field('الترتيب', f.sort)), img.el, h('label', { class: 'sw' }, f.act, 'العرض فعّال')),
      async () => { const body = { title: f.title.value, description: f.desc.value, badge: f.badge.value, price: f.price.value, old_price: f.old.value, image: img.state.url, active: f.act.checked, sort: f.sort.value }; await api(o ? `/api/admin/offers/${o.id}` : '/api/admin/offers', o ? 'PUT' : 'POST', body); toast('تم الحفظ'); render(); });
  }
  async function vOffers(main) {
    const c = await loadCatalog();
    main.append(h('div', { class: 'top' }, h('h2', {}, 'العروض'), h('button', { class: 'btn gold', onclick: () => offerModal() }, '+ إضافة عرض')),
      c.offers.length ? h('div', { class: 'box tw' }, h('table', {}, h('tbody', {}, c.offers.map((o) => h('tr', {}, h('td', {}, o.image ? h('img', { class: 'thumb', src: o.image, alt: '' }) : h('div', { class: 'thumb' })), h('td', {}, h('b', {}, o.title), h('br'), h('small', { class: 'meta' }, o.description)), h('td', {}, o.price != null ? `${money(o.price)} ج.م` : 'إعلان فقط'), h('td', {}, o.active ? 'فعّال' : 'متوقف'),
        h('td', {}, h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => offerModal(o) }, 'تعديل'), h('button', { class: 'btn sm danger', onclick: guard(async () => { if (confirmDel(`العرض «${o.title}»`)) { await api(`/api/admin/offers/${o.id}`, 'DELETE'); render(); } }) }, 'حذف')))))))) : h('div', { class: 'box', style: 'text-align:center' }, 'لا توجد عروض بعد.'));
  }

  // ---------- settings ----------
  async function vSettings(main) {
    const { settings: s } = await loadCatalog();
    const inp = (k, o = {}) => h('input', { value: s[k] ?? '', ...o });
    const f = { name: inp('name'), name_en: inp('name_en'), tagline: inp('tagline'), manager: inp('manager'), about: h('textarea', {}, s.about), phone: inp('phone', { inputmode: 'tel' }), whatsapp: inp('whatsapp', { inputmode: 'tel', placeholder: 'بصيغة دولية مثل 2010xxxxxxx' }), address: inp('address'), facebook: inp('facebook', { placeholder: 'https://…' }),
      hours_open: inp('hours_open', { type: 'time' }), hours_close: inp('hours_close', { type: 'time' }), delivery_fee: inp('delivery_fee', { type: 'number', min: 0, step: '0.5' }), free_delivery_over: inp('free_delivery_over', { type: 'number', min: 0 }), min_order: inp('min_order', { type: 'number', min: 0 }) };
    const cb = (k, label) => { const i = h('input', { type: 'checkbox', checked: s[k] === '1' }); return { i, el: h('label', { class: 'sw' }, i, label) }; };
    const open = cb('orders_open', 'استقبال الطلبات مفتوح'), enf = cb('enforce_hours', 'منع الطلبات خارج ساعات العمل'), del = cb('delivery_enabled', 'تفعيل التوصيل'), pick = cb('pickup_enabled', 'تفعيل الاستلام من المطعم');
    const save = h('button', { class: 'btn gold', onclick: guard(async () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])); body.orders_open = open.i.checked; body.enforce_hours = enf.i.checked; body.delivery_enabled = del.i.checked; body.pickup_enabled = pick.i.checked;
      await api('/api/admin/settings', 'PUT', body); toast('تم حفظ الإعدادات'); }) }, 'حفظ الإعدادات');
    main.append(h('div', { class: 'top' }, h('h2', {}, 'إعدادات المطعم')),
      h('div', { class: 'box' }, h('h3', {}, 'بيانات المطعم'), h('div', { class: 'two' }, field('الاسم', f.name), field('الاسم بالإنجليزية', f.name_en), field('الوصف المختصر', f.tagline), field('الإدارة', f.manager), field('الهاتف', f.phone), field('واتساب', f.whatsapp), field('العنوان', f.address), field('رابط فيسبوك', f.facebook)), field('نبذة عن المطعم', f.about)),
      h('div', { class: 'box' }, h('h3', {}, 'ساعات العمل'), h('div', { class: 'two' }, field('يفتح', f.hours_open), field('يغلق', f.hours_close)), enf.el, h('small', { class: 'meta' }, 'التوقيت المستخدم: القاهرة. إن لم تفعّل المنع فالساعات للعرض فقط.')),
      h('div', { class: 'box' }, h('h3', {}, 'الطلبات والتوصيل'), open.el, del.el, pick.el, h('div', { class: 'three', style: 'margin-top:.8rem' }, field('رسوم التوصيل (ج.م)', f.delivery_fee), field('توصيل مجاني فوق (0 = غير مفعّل)', f.free_delivery_over), field('الحد الأدنى للطلب', f.min_order))), save);
  }

  // ---------- account ----------
  async function vAccount(main) {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nu = h('input', { value: S.me.username, autocomplete: 'username' }), np = h('input', { type: 'password', autocomplete: 'new-password' }), np2 = h('input', { type: 'password', autocomplete: 'new-password' });
    main.append(h('div', { class: 'top' }, h('h2', {}, 'الحساب والأمان')), h('div', { class: 'box', style: 'max-width:520px' }, h('div', { class: 'f' }, field('كلمة المرور الحالية', cur), field('اسم المستخدم', nu), field('كلمة المرور الجديدة (8 أحرف فأكثر)', np), field('تأكيد كلمة المرور الجديدة', np2),
      h('button', { class: 'btn gold', onclick: guard(async () => { if (np.value !== np2.value) throw new Error('تأكيد كلمة المرور غير مطابق'); await api('/api/admin/change-password', 'POST', { current: cur.value, username: nu.value, next: np.value }); S.me.default_pw = false; S.me.username = nu.value; toast('تم تغيير بيانات الدخول'); render(); }) }, 'حفظ'))));
  }

  // ---------- boot ----------
  api('/api/admin/me').then((me) => { S.me = me; enter(); }).catch(() => showLogin());
})();
