/* ==========================================================================
   Duket — Inventory & POS  (single-file vanilla JS PWA)
   All data lives in IndexedDB via Dexie. localStorage is used ONLY for the
   dark-mode preference. No frameworks, no build step — open index.html or
   serve the folder as-is.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     Small utilities
     --------------------------------------------------------------------- */
  const qs = (sel, el) => (el || document).querySelector(sel);
  const qsa = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const ce = (tag, attrs, html) => {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'dataset') Object.assign(el.dataset, attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    if (html != null) el.innerHTML = html;
    return el;
  };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // RFC4122-ish UUID for rows that need to be identified across devices via
  // Supabase (sync.js matches rows on this, not the local auto-increment id,
  // since two devices can't share auto-increment counters).
  const genUuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });

  const fmtMoney = (n) => {
    n = Number(n) || 0;
    const sign = n < 0 ? '-' : '';
    return sign + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtDate = (d) => {
    d = (d instanceof Date) ? d : new Date(d);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };
  const fmtDateTime = (d) => {
    d = (d instanceof Date) ? d : new Date(d);
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${fmtDate(d)} ${hh}:${mi}`;
  };
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const daysAgo = (n) => { const x = startOfDay(new Date()); x.setDate(x.getDate() - n); return x; };

  function toast(msg, type) {
    const box = qs('#toasts');
    const el = ce('div', { class: 'toast' + (type ? ' ' + type : '') }, escapeHtml(msg));
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, 2200);
    setTimeout(() => el.remove(), 2500);
  }

  function toCSV(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const esc = (v) => {
      v = v == null ? '' : String(v);
      if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
      return v;
    };
    const lines = [headers.map(esc).join(',')];
    for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
    // Leading UTF-8 BOM: product names/notes/etc. are commonly typed in
    // Amharic (Ethiopic script). Without a BOM, Excel — the tool most shop
    // owners actually open CSVs in — misreads the encoding and shows
    // mangled characters (mojibake) for any non-Latin text, even though the
    // file itself is valid UTF-8. Browsers and other spreadsheet apps
    // ignore the BOM harmlessly.
    return '\ufeff' + lines.join('\n');
  }
  function parseCSV(text) {
    // Minimal RFC4180-ish parser: handles quoted fields with commas/newlines.
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM if present (e.g. re-importing a CSV saved by Excel)
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const headers = rows[0];
    return rows.slice(1).filter((r) => r.length > 1 || r[0] !== '').map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ''; });
      return o;
    });
  }
  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = ce('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  const CATEGORY_EMOJI = {
    'Phone': '📱', 'Charger': '🔌', 'Headphones': '🎧', 'Screen Protector': '📲',
    'Power Bank': '🔋', 'Cable': '🔌', 'Case': '📱', 'Speaker': '🎧', 'Other': '🏷️'
  };
  const emojiFor = (cat) => CATEGORY_EMOJI[cat] || '🏷️';

  /* ---------------------------------------------------------------------
     Database (Dexie)
     --------------------------------------------------------------------- */
  const db = new Dexie('DuketDB');
  db.version(1).stores({
    products: '++id, &sku, name, brand, category, barcode, quantity',
    sales: '++id, date, paymentAccountId, customerId',
    saleItems: '++id, saleId, productId',
    purchases: '++id, date, supplierId, productId',
    suppliers: '++id, name',
    customers: '++id, name, phone',
    stockMovements: '++id, date, productId, type',
    accounts: '++id, label, type',
    settings: '&key'
  });
  // v2: adds `uuid` and `synced` as indexed fields. sync.js queries both
  // with .where(...), which Dexie can only do on an indexed keyPath — without
  // this, every sync attempt threw immediately ("KeyPath not indexed") and
  // silently disabled sync entirely. The upgrade() backfills both fields on
  // every row that predates this version, so existing local data gets a
  // stable uuid and is marked dirty (synced=0) to be pushed on first sync.
  const SYNCED_TABLES = ['products', 'sales', 'saleItems', 'purchases', 'suppliers', 'customers', 'stockMovements', 'accounts'];
  db.version(2).stores({
    products: '++id, &sku, name, brand, category, barcode, quantity, uuid, synced',
    sales: '++id, date, paymentAccountId, customerId, uuid, synced',
    saleItems: '++id, saleId, productId, uuid, synced',
    purchases: '++id, date, supplierId, productId, uuid, synced',
    suppliers: '++id, name, uuid, synced',
    customers: '++id, name, phone, uuid, synced',
    stockMovements: '++id, date, productId, type, uuid, synced',
    accounts: '++id, label, type, uuid, synced',
    settings: '&key'
  }).upgrade(async (tx) => {
    for (const name of SYNCED_TABLES) {
      await tx.table(name).toCollection().modify((row) => {
        if (!row.uuid) row.uuid = genUuid();
        if (row.synced == null) row.synced = 0;
      });
    }
  });

  /** Defensive backfill for rows that can arrive without uuid/synced set —
   *  e.g. a JSON backup restored from an older export. Cheap no-op once
   *  every row already has both fields. */
  async function backfillSyncFields() {
    for (const name of SYNCED_TABLES) {
      await db[name].toCollection().modify((row) => {
        if (!row.uuid) row.uuid = genUuid();
        if (row.synced == null) row.synced = 0;
      });
    }
  }

  /* ---------------------------------------------------------------------
     Global state
     --------------------------------------------------------------------- */
  const S = {
    view: 'dashboard',
    theme: localStorage.getItem('duket:theme') || 'light',
    settings: null,           // loaded from db (single row keyed 'shop')
    accounts: [],              // cached payment accounts
    productIndex: [],          // lightweight in-memory index for fast search/virtual list
    cart: [],                  // POS cart: {productId,name,price,cost,qty,unit}
    posDiscount: { type: 'fixed', value: 0 },
    posAccountId: null,
    posCustomer: null,
    productsFilterCat: 'All',
    productsQuery: '',
    stockTab: 'in',            // 'in' | 'adjust' | 'movements'
    peopleTab: 'suppliers',    // 'suppliers' | 'customers'
    reportsRange: { from: daysAgo(6), to: startOfDay(new Date()) },
    chartLoaded: false,
  };

  document.documentElement.setAttribute('data-theme', S.theme);

  /* ---------------------------------------------------------------------
     Seed defaults on first run
     --------------------------------------------------------------------- */
  async function ensureDefaults() {
    let shop = await db.settings.get('shop');
    if (!shop) {
      shop = {
        key: 'shop',
        onboarded: false,
        name: '', address: '', phone: '', tin: '',
        lowStockDefault: 5,
        allowNegativeStock: false,
        receiptHeader: '', receiptFooter: 'አመሰግናለን — Thank you for your business!',
      };
      await db.settings.put(shop);
    }
    const accCount = await db.accounts.count();
    if (accCount === 0) {
      await db.accounts.bulkAdd([
        { label: 'Cash Drawer', type: 'cash', numberOrPhone: '', uuid: genUuid(), synced: 0 },
        { label: 'Telebirr', type: 'mobile_money', numberOrPhone: '', uuid: genUuid(), synced: 0 },
        { label: 'CBE Birr', type: 'mobile_money', numberOrPhone: '', uuid: genUuid(), synced: 0 },
        { label: 'Bank Transfer', type: 'bank', numberOrPhone: '', uuid: genUuid(), synced: 0 },
        { label: 'Credit / Debt', type: 'credit', numberOrPhone: '', uuid: genUuid(), synced: 0 },
      ]);
    }
    S.settings = shop;
    S.accounts = (await db.accounts.toArray()).filter((a) => !a.deleted);
  }

  async function refreshAccounts() { S.accounts = (await db.accounts.toArray()).filter((a) => !a.deleted); }

  /* ---------------------------------------------------------------------
     Product index cache (name/sku/brand/barcode search + virtual list)
     --------------------------------------------------------------------- */
  async function rebuildProductIndex() {
    // Filter out soft-deleted rows (tombstoned locally so the deletion can
    // still be pushed to Supabase on next sync, per sync.js's `deletable`
    // contract) — they must never show up in the UI again.
    S.productIndex = (await db.products.toArray()).filter((p) => !p.deleted);
  }

  function searchProducts(query, category) {
    let list = S.productIndex;
    if (category && category !== 'All') list = list.filter((p) => p.category === category);
    if (query && query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((p) =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        (p.brand && p.brand.toLowerCase().includes(q)) ||
        (p.barcode && p.barcode.toLowerCase().includes(q))
      );
    }
    return list;
  }

  function nextSku(category, brand) {
    const catCode = (category || 'GEN').slice(0, 3).toUpperCase().replace(/[^A-Z]/g, '') || 'GEN';
    const brandCode = (brand || 'GEN').slice(0, 3).toUpperCase().replace(/[^A-Z]/g, '') || 'GEN';
    const prefix = `${catCode}-${brandCode}-`;
    let max = 0;
    for (const p of S.productIndex) {
      if (p.sku && p.sku.startsWith(prefix)) {
        const n = parseInt(p.sku.slice(prefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    }
    return prefix + String(max + 1).padStart(4, '0');
  }

  /* ---------------------------------------------------------------------
     Modal helpers
     --------------------------------------------------------------------- */
  function openModal(innerHtml, onMount) {
    let overlay = qs('#modal-overlay');
    if (!overlay) {
      overlay = ce('div', { id: 'modal-overlay', class: 'modal-overlay' });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
    overlay.classList.add('open');
    if (onMount) onMount(qs('.modal', overlay));
  }
  function closeModal() {
    const overlay = qs('#modal-overlay');
    if (overlay) overlay.classList.remove('open');
  }
  function confirmDialog(title, body, okLabel) {
    return new Promise((resolve) => {
      openModal(`
        <div class="modal-head"><h3>${escapeHtml(title)}</h3>
          <button class="modal-close" data-close>✕</button></div>
        <p style="color:var(--ink-muted);font-size:14px;line-height:1.5;margin-bottom:18px">${escapeHtml(body)}</p>
        <div class="btn-row">
          <button class="btn ghost block" data-cancel>Cancel</button>
          <button class="btn danger block" data-ok>${escapeHtml(okLabel || 'Confirm')}</button>
        </div>`, (modal) => {
        qs('[data-close]', modal).onclick = () => { closeModal(); resolve(false); };
        qs('[data-cancel]', modal).onclick = () => { closeModal(); resolve(false); };
        qs('[data-ok]', modal).onclick = () => { closeModal(); resolve(true); };
      });
    });
  }

  /* ---------------------------------------------------------------------
     App shell (topbar + view container + bottom nav) — rendered once
     --------------------------------------------------------------------- */
  const NAV_ITEMS = [
    { id: 'dashboard', label: 'Dashboard', icon: '🏠' },
    { id: 'products', label: 'Products', icon: '📦' },
    { id: 'pos', label: 'Sale', icon: '🧾', center: true },
    { id: 'reports', label: 'Reports', icon: '📊' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];

  function renderShell() {
    const app = qs('#app');
    app.innerHTML = `
      <header class="topbar">
        <div class="brand"><span class="dot"></span>Duket <span class="offline-pill" id="offline-pill">OFFLINE</span></div>
        <div class="actions">
          <button class="iconbtn" id="theme-toggle" title="Toggle dark mode" aria-label="Toggle dark mode">${S.theme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </header>
      <div class="pull-indicator" id="pull-indicator">⤓ Release to refresh</div>
      <main id="views"></main>
      <nav class="bottomnav" id="bottomnav">
        ${NAV_ITEMS.map((n) => `
          <button class="navbtn ${n.center ? 'pos-btn' : ''}" data-nav="${n.id}">
            <span class="ic">${n.icon}</span><span>${n.label}</span>
          </button>`).join('')}
      </nav>`;
    qs('#theme-toggle').onclick = toggleTheme;
    qsa('[data-nav]').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.nav)));
    updateOfflinePill();
    setupSwipe();
    setupPullToRefresh();
  }

  function toggleTheme() {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('duket:theme', S.theme);
    document.documentElement.setAttribute('data-theme', S.theme);
    qs('#theme-toggle').textContent = S.theme === 'dark' ? '☀️' : '🌙';
  }

  function updateOfflinePill() {
    // Previously this only toggled a class on <body> that no rule in
    // styles.css actually reads, so the pill was permanently stuck showing
    // "OFFLINE" — even with a live connection. Drive the pill directly.
    document.body.classList.toggle('offline', !navigator.onLine);
    const pill = qs('#offline-pill');
    if (!pill) return;
    const online = navigator.onLine;
    pill.textContent = online ? 'ONLINE' : 'OFFLINE';
    pill.classList.toggle('online', online);
  }
  window.addEventListener('online', updateOfflinePill);
  window.addEventListener('offline', updateOfflinePill);

  const VIEW_ORDER = ['dashboard', 'products', 'pos', 'reports', 'settings'];
  const VIEWS = {}; // populated by each view module: { render: async () => html, mount: (el) => {} }

  async function showView(name) {
    if (!VIEWS[name]) return;
    S.view = name;
    qsa('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
    const container = qs('#views');
    container.innerHTML = `<div class="view active" id="view-${name}"></div>`;
    const el = qs(`#view-${name}`);
    el.innerHTML = '<div class="card skeleton" style="height:120px"></div>';
    const html = await VIEWS[name].render();
    el.innerHTML = html;
    if (VIEWS[name].mount) VIEWS[name].mount(el);
    container.scrollTop = 0;
  }

  /* ---------------------------------------------------------------------
     Swipe between tabs
     --------------------------------------------------------------------- */
  function setupSwipe() {
    const main = qs('#views');
    let sx = 0, sy = 0, tracking = false;
    main.addEventListener('touchstart', (e) => {
      if (qs('#modal-overlay.open')) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    main.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        const idx = VIEW_ORDER.indexOf(S.view);
        if (dx < 0 && idx < VIEW_ORDER.length - 1) showView(VIEW_ORDER[idx + 1]);
        if (dx > 0 && idx > 0) showView(VIEW_ORDER[idx - 1]);
      }
    }, { passive: true });
  }

  /* ---------------------------------------------------------------------
     Pull to refresh (re-runs the current view's render)
     --------------------------------------------------------------------- */
  function setupPullToRefresh() {
    const main = qs('#views');
    const indicator = qs('#pull-indicator');
    let sy = 0, pulling = false;
    main.addEventListener('touchstart', (e) => {
      if (main.scrollTop <= 0) { sy = e.touches[0].clientY; pulling = true; }
    }, { passive: true });
    main.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - sy;
      if (dy > 0 && main.scrollTop <= 0) {
        indicator.style.height = Math.min(48, dy / 1.6) + 'px';
      }
    }, { passive: true });
    main.addEventListener('touchend', () => {
      if (pulling && parseInt(indicator.style.height) >= 44) {
        indicator.textContent = '↻ Refreshing…';
        showView(S.view).then(() => { indicator.style.height = '0px'; indicator.textContent = '⤓ Release to refresh'; });
      } else {
        indicator.style.height = '0px';
      }
      pulling = false;
    }, { passive: true });
  }

  /* ---------------------------------------------------------------------
     Keyboard shortcuts (desktop use)
     --------------------------------------------------------------------- */
  document.addEventListener('keydown', (e) => {
    const inInput = /input|textarea|select/i.test(document.activeElement.tagName);
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.ctrlKey && !inInput) {
      if (e.key.toLowerCase() === 'n') { e.preventDefault(); showView('products').then(openProductModal); }
      else if (e.key.toLowerCase() === 's') { e.preventDefault(); showView('pos'); }
      else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        showView(S.view === 'products' ? 'products' : S.view).then(() => {
          const search = qs('#product-search') || qs('#pos-search');
          if (search) search.focus();
        });
      }
    }
  });

  /* ---------------------------------------------------------------------
     DASHBOARD
     --------------------------------------------------------------------- */
  VIEWS.dashboard = {
    async render() {
      const products = S.productIndex.length ? S.productIndex : (await db.products.toArray()).filter((p) => !p.deleted);
      const totalSkus = products.length;
      const stockValue = products.reduce((s, p) => s + (p.costPrice || 0) * (p.quantity || 0), 0);
      const threshold = (p) => (p.minStock != null ? p.minStock : S.settings.lowStockDefault);
      const lowStock = products.filter((p) => p.quantity > 0 && p.quantity <= threshold(p)).length;
      const outStock = products.filter((p) => p.quantity <= 0).length;

      const today = startOfDay(new Date());
      const todaySales = await db.sales.where('date').aboveOrEqual(today.getTime()).toArray();
      const todayRevenue = todaySales.reduce((s, x) => s + x.total, 0);
      const todayProfit = todaySales.reduce((s, x) => s + (x.profit || 0), 0);

      // last 7 days sparkline
      const days = [];
      for (let i = 6; i >= 0; i--) days.push(daysAgo(i));
      const allRecent = await db.sales.where('date').aboveOrEqual(days[0].getTime()).toArray();
      const byDay = days.map((d) => {
        const next = new Date(d); next.setDate(next.getDate() + 1);
        const total = allRecent.filter((s) => s.date >= d.getTime() && s.date < next.getTime())
          .reduce((sum, s) => sum + s.total, 0);
        return { d, total };
      });
      const maxDay = Math.max(1, ...byDay.map((x) => x.total));

      if (totalSkus === 0) {
        return `
          <div class="empty">
            <div class="ic">📦</div>
            <h3>No products yet</h3>
            <p>Add your first product to start tracking stock and making sales.</p>
            <div style="margin-top:16px"><button class="btn primary" id="db-add-first">+ Add first product</button></div>
          </div>`;
      }

      return `
        <div class="grid2">
          <div class="stat-card"><div class="label">Stock Value</div><div class="value num brand">Br ${fmtMoney(stockValue)}</div><div class="sub">${totalSkus} SKUs</div></div>
          <div class="stat-card"><div class="label">Today's Revenue</div><div class="value num">Br ${fmtMoney(todayRevenue)}</div><div class="sub">${todaySales.length} sale${todaySales.length === 1 ? '' : 's'}</div></div>
          <div class="stat-card"><div class="label">Today's Profit</div><div class="value num" style="color:var(--success)">Br ${fmtMoney(todayProfit)}</div></div>
          <div class="stat-card"><div class="label">Stock Alerts</div><div class="value ${outStock ? 'danger' : ''}">${lowStock + outStock}</div><div class="sub">${lowStock} low · ${outStock} out</div></div>
        </div>

        <div class="section-title">Last 7 days</div>
        <div class="card">
          <div class="sparkline">
            ${byDay.map((x) => `<div class="bar ${x.d.getTime() === today.getTime() ? 'today' : ''}" style="height:${Math.max(6, (x.total / maxDay) * 56)}px" title="Br ${fmtMoney(x.total)}"></div>`).join('')}
          </div>
          <div style="display:flex;gap:5px">${byDay.map((x) => `<div class="lbl" style="flex:1">${x.d.getDate()}</div>`).join('')}</div>
        </div>

        <div class="section-title">Quick actions</div>
        <div class="btn-row">
          <button class="btn primary" id="db-add-product" style="flex:1">+ Add Product</button>
          <button class="btn accent" id="db-new-sale" style="flex:1">🧾 New Sale</button>
          <button class="btn ghost" id="db-stock-in" style="flex:1">📥 Stock In</button>
        </div>`;
    },
    mount(el) {
      const addFirst = qs('#db-add-first', el);
      if (addFirst) addFirst.onclick = () => showView('products').then(openProductModal);
      const addP = qs('#db-add-product', el);
      if (addP) addP.onclick = () => showView('products').then(openProductModal);
      const newSale = qs('#db-new-sale', el);
      if (newSale) newSale.onclick = () => showView('pos');
      const stockIn = qs('#db-stock-in', el);
      if (stockIn) stockIn.onclick = () => showView('products').then(() => { setProductsSubTab('stock'); S.stockTab = 'in'; renderProductsBody(); });
    }
  };

  /* ---------------------------------------------------------------------
     Generic virtual list — renders only visible rows (+buffer), capping
     DOM nodes regardless of how many items exist (target: <=50 nodes).
     --------------------------------------------------------------------- */
  function mountVirtualList(container, items, rowHeight, renderRow, emptyHtml) {
    if (!items.length) { container.innerHTML = emptyHtml || '<div class="empty"><p>Nothing here yet.</p></div>'; return; }
    container.innerHTML = `<div class="vlist" style="height:${Math.min(items.length * rowHeight, 60 * rowHeight) || 400}px;max-height:60vh">
        <div class="vlist-spacer" style="height:${items.length * rowHeight}px"></div>
      </div>`;
    const scroller = qs('.vlist', container);
    const spacer = qs('.vlist-spacer', scroller);
    const BUFFER = 6;
    let lastStart = -1;
    function paint() {
      const scrollTop = scroller.scrollTop;
      const viewportH = scroller.clientHeight;
      let start = Math.max(0, Math.floor(scrollTop / rowHeight) - BUFFER);
      let end = Math.min(items.length, Math.ceil((scrollTop + viewportH) / rowHeight) + BUFFER);
      if (start === lastStart) return;
      lastStart = start;
      qsa('.prow', spacer).forEach((n) => n.remove());
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        const row = renderRow(items[i], i);
        row.style.top = (i * rowHeight) + 'px';
        row.style.height = rowHeight + 'px';
        frag.appendChild(row);
      }
      spacer.appendChild(frag);
    }
    scroller.addEventListener('scroll', () => requestAnimationFrame(paint));
    paint();
  }

  /* ---------------------------------------------------------------------
     PRODUCTS view (Catalog / Stock / Suppliers / Customers)
     --------------------------------------------------------------------- */
  const PRODUCT_CATEGORIES = ['Phone', 'Charger', 'Cable', 'Headphones', 'Power Bank', 'Screen Protector', 'Case', 'Speaker', 'Other'];

  function setProductsSubTab(tab) { S.productsSubTab = tab; }

  VIEWS.products = {
    async render() {
      if (!S.productIndex.length) await rebuildProductIndex();
      S.productsSubTab = S.productsSubTab || 'catalog';
      return `
        <div class="segmented" id="products-segmented">
          <button data-tab="catalog">Catalog</button>
          <button data-tab="stock">Stock</button>
          <button data-tab="suppliers">Suppliers</button>
          <button data-tab="customers">Customers</button>
        </div>
        <div id="products-body" style="margin-top:12px"></div>`;
    },
    mount(el) {
      qsa('#products-segmented button', el).forEach((b) => {
        b.addEventListener('click', () => { setProductsSubTab(b.dataset.tab); renderProductsBody(); });
      });
      renderProductsBody();
    }
  };

  function renderProductsBody() {
    const body = qs('#products-body');
    if (!body) return;
    qsa('#products-segmented button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.productsSubTab));
    if (S.productsSubTab === 'catalog') renderCatalogTab(body);
    else if (S.productsSubTab === 'stock') renderStockTab(body);
    else if (S.productsSubTab === 'suppliers') renderPeopleTab(body, 'suppliers');
    else if (S.productsSubTab === 'customers') renderPeopleTab(body, 'customers');
  }

  /* ----- Catalog tab ----- */
  function renderCatalogTab(body) {
    body.innerHTML = `
      <div class="searchbar">
        <span class="ic">🔎</span>
        <input id="product-search" placeholder="Search name, SKU, brand, barcode…" inputmode="search" value="${escapeHtml(S.productsQuery)}">
      </div>
      <div class="chip-select" id="cat-chips" style="margin-top:10px">
        ${['All', ...PRODUCT_CATEGORIES].map((c) => `<button class="chip ${S.productsFilterCat === c ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}
      </div>
      <div class="btn-row" style="margin:12px 0">
        <button class="btn ghost sm" id="csv-export">⬇ Export CSV</button>
        <label class="btn ghost sm" style="cursor:pointer">⬆ Import CSV<input type="file" id="csv-import" accept=".csv" style="display:none"></label>
      </div>
      <div id="catalog-list"></div>
      <button class="fab" id="fab-add-product" aria-label="Add product">+</button>`;

    const doFilter = () => {
      const items = searchProducts(S.productsQuery, S.productsFilterCat)
        .sort((a, b) => a.name.localeCompare(b.name));
      mountVirtualList(qs('#catalog-list'), items, 60, (p) => {
        const low = p.quantity <= (p.minStock != null ? p.minStock : S.settings.lowStockDefault);
        const row = ce('div', { class: 'prow' });
        row.innerHTML = `
          <div class="emoji">${emojiFor(p.category)}</div>
          <div class="info">
            <div class="name">${escapeHtml(p.name)}</div>
            <div class="meta">${escapeHtml(p.sku)} · ${escapeHtml(p.brand || '')}</div>
          </div>
          <div class="price">
            <div class="sell num">Br ${fmtMoney(p.sellingPrice)}</div>
            <div class="qty num ${low ? 'low' : ''}">${p.quantity} in stock</div>
          </div>`;
        row.addEventListener('click', () => openProductModal(p));
        return row;
      }, `<div class="empty"><div class="ic">🔍</div><h3>No matches</h3><p>Try a different search or category.</p></div>`);
    };
    doFilter();

    qs('#product-search', body).addEventListener('input', debounce((e) => {
      S.productsQuery = e.target.value; doFilter();
    }, 300));
    qsa('.chip', qs('#cat-chips', body)).forEach((chip) => {
      chip.addEventListener('click', () => { S.productsFilterCat = chip.dataset.cat; renderCatalogTab(body); });
    });
    qs('#fab-add-product', body).addEventListener('click', () => openProductModal());
    qs('#csv-export', body).addEventListener('click', exportProductsCSV);
    qs('#csv-import', body).addEventListener('change', (e) => {
      if (e.target.files[0]) importProductsCSV(e.target.files[0]);
    });
  }

  async function exportProductsCSV() {
    const rows = S.productIndex.map((p) => ({
      sku: p.sku, name: p.name, brand: p.brand, category: p.category,
      costPrice: p.costPrice, sellingPrice: p.sellingPrice, wholesalePrice: p.wholesalePrice || '',
      quantity: p.quantity, minStock: p.minStock, compatibleModels: p.compatibleModels || '',
      color: p.color || '', supplier: p.supplier || '', barcode: p.barcode || '', notes: p.notes || ''
    }));
    if (!rows.length) { toast('No products to export', 'error'); return; }
    downloadText(`duket-products-${Date.now()}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
    toast('Products exported');
  }

  async function importProductsCSV(file) {
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (!rows.length) { toast('CSV appears empty', 'error'); return; }
      const existingSkus = new Set(S.productIndex.map((p) => p.sku));
      let added = 0, skipped = 0;
      const toAdd = [];
      for (const r of rows) {
        const sku = (r.sku || '').trim() || nextSku(r.category, r.brand);
        if (existingSkus.has(sku)) { skipped++; continue; }
        existingSkus.add(sku);
        toAdd.push({
          sku, name: r.name || 'Unnamed', brand: r.brand || '', category: r.category || 'Other',
          costPrice: parseFloat(r.costPrice) || 0, sellingPrice: parseFloat(r.sellingPrice) || 0,
          wholesalePrice: parseFloat(r.wholesalePrice) || null,
          quantity: parseInt(r.quantity, 10) || 0, minStock: parseInt(r.minStock, 10) || S.settings.lowStockDefault,
          compatibleModels: r.compatibleModels || '', color: r.color || '', supplier: r.supplier || '',
          barcode: r.barcode || '', notes: r.notes || '', createdAt: Date.now(),
          uuid: genUuid(), synced: 0
        });
        added++;
      }
      if (toAdd.length) await db.products.bulkAdd(toAdd);
      await rebuildProductIndex();
      renderProductsBody();
      toast(`Imported ${added} product${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} duplicate SKU(s)` : ''}`);
    } catch (err) {
      console.error(err);
      toast('Import failed — check the CSV format', 'error');
    }
  }

  function openProductModal(product) {
    const isEdit = !!product;
    const p = product || { category: 'Phone' };
    openModal(`
      <div class="modal-head"><h3>${isEdit ? 'Edit product' : 'Add product'}</h3><button class="modal-close" data-close>✕</button></div>
      <form id="product-form">
        <div class="field"><label>Name (English/Amharic)</label><input name="name" required value="${escapeHtml(p.name || '')}" placeholder="e.g. Fast Charger 20W / ፈጣን ቻርጀር"></div>
        <div class="field-row">
          <div class="field"><label>Brand</label><input name="brand" value="${escapeHtml(p.brand || '')}"></div>
          <div class="field"><label>Category</label>
            <select name="category">${PRODUCT_CATEGORIES.map((c) => `<option ${p.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="field"><label>SKU</label><input name="sku" value="${escapeHtml(p.sku || '')}" placeholder="Auto-generated if left blank"></div>
        <div class="field-row">
          <div class="field"><label>Cost Price (ETB)</label><input name="costPrice" type="number" inputmode="numeric" min="0" step="0.01" value="${p.costPrice ?? ''}" required></div>
          <div class="field"><label>Selling Price (ETB)</label><input name="sellingPrice" type="number" inputmode="numeric" min="0" step="0.01" value="${p.sellingPrice ?? ''}" required></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Wholesale Price (ETB, optional)</label><input name="wholesalePrice" type="number" inputmode="numeric" min="0" step="0.01" value="${p.wholesalePrice ?? ''}"></div>
          <div class="field"><label>Quantity</label><input name="quantity" type="number" inputmode="numeric" min="0" step="1" value="${p.quantity ?? 0}" required></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Min Stock Threshold</label><input name="minStock" type="number" inputmode="numeric" min="0" step="1" value="${p.minStock ?? S.settings.lowStockDefault}"></div>
          <div class="field"><label>Color</label><input name="color" value="${escapeHtml(p.color || '')}"></div>
        </div>
        <div class="field"><label>Compatible Models</label><input name="compatibleModels" value="${escapeHtml(p.compatibleModels || '')}" placeholder="e.g. iPhone 13/14/15"></div>
        <div class="field-row">
          <div class="field"><label>Supplier</label><input name="supplier" value="${escapeHtml(p.supplier || '')}"></div>
          <div class="field"><label>Barcode</label><input name="barcode" value="${escapeHtml(p.barcode || '')}"></div>
        </div>
        <div class="field"><label>Notes</label><textarea name="notes">${escapeHtml(p.notes || '')}</textarea></div>
        <div class="btn-row">
          ${isEdit ? '<button type="button" class="btn danger" id="product-delete">Delete</button>' : ''}
          <button type="submit" class="btn primary block">${isEdit ? 'Save changes' : 'Add product'}</button>
        </div>
      </form>`, (modal) => {
      qs('[data-close]', modal).onclick = closeModal;
      const form = qs('#product-form', modal);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const data = {
          name: fd.get('name').trim(),
          brand: fd.get('brand').trim(),
          category: fd.get('category'),
          costPrice: parseFloat(fd.get('costPrice')) || 0,
          sellingPrice: parseFloat(fd.get('sellingPrice')) || 0,
          wholesalePrice: fd.get('wholesalePrice') ? parseFloat(fd.get('wholesalePrice')) : null,
          quantity: parseInt(fd.get('quantity'), 10) || 0,
          minStock: parseInt(fd.get('minStock'), 10) || 0,
          compatibleModels: fd.get('compatibleModels').trim(),
          color: fd.get('color').trim(),
          supplier: fd.get('supplier').trim(),
          barcode: fd.get('barcode').trim(),
          notes: fd.get('notes').trim(),
        };
        if (!S.settings.allowNegativeStock && data.quantity < 0) { toast('Negative stock is not allowed (change in Settings)', 'error'); return; }
        let sku = fd.get('sku').trim();
        if (!sku) sku = nextSku(data.category, data.brand);
        const dup = S.productIndex.find((x) => x.sku === sku && (!isEdit || x.id !== p.id));
        if (dup) { toast(`SKU "${sku}" already exists`, 'error'); return; }
        data.sku = sku;
        try {
          if (isEdit) {
            data.synced = 0; // mark dirty so this edit gets pushed on next sync
            await db.products.update(p.id, data);
            toast('Product updated');
          } else {
            data.createdAt = Date.now();
            data.uuid = genUuid();
            data.synced = 0;
            await db.products.add(data);
            toast('Product added');
          }
          await rebuildProductIndex();
          closeModal();
          if (S.view === 'products') renderProductsBody();
          if (S.view === 'dashboard') showView('dashboard');
        } catch (err) {
          console.error(err);
          if (err.name === 'QuotaExceededError') toast('Device storage is full — free up space and try again', 'error');
          else toast('Could not save product', 'error');
        }
      });
      if (isEdit) {
        qs('#product-delete', modal).onclick = async () => {
          const ok = await confirmDialog('Delete product?', `This removes "${p.name}" permanently. Sales history referencing it is kept.`, 'Delete');
          if (!ok) return;
          // Soft-delete: a hard delete here would never reach other devices,
          // since sync.js can only tell them about a removal by pushing a
          // tombstone row first. The local copy is hidden immediately
          // (rebuildProductIndex filters `deleted`) and is only physically
          // removed once pushTable() has actually synced the tombstone.
          await db.products.update(p.id, { deleted: true, synced: 0 });
          await rebuildProductIndex();
          closeModal();
          renderProductsBody();
          toast('Product deleted');
        };
      }
    });
  }

  /* ----- Stock tab (Stock In / Adjustment / Movement history) ----- */
  function renderStockTab(body) {
    S.stockTab = S.stockTab || 'in';
    body.innerHTML = `
      <div class="segmented">
        <button data-stab="in">Stock In</button>
        <button data-stab="adjust">Adjust</button>
        <button data-stab="movements">History</button>
      </div>
      <div id="stock-body" style="margin-top:12px"></div>`;
    qsa('[data-stab]', body).forEach((b) => b.classList.toggle('active', b.dataset.stab === S.stockTab));
    qsa('[data-stab]', body).forEach((b) => b.addEventListener('click', () => { S.stockTab = b.dataset.stab; renderStockTab(body); }));
    const sbody = qs('#stock-body', body);
    if (S.stockTab === 'in') renderStockIn(sbody);
    else if (S.stockTab === 'adjust') renderStockAdjust(sbody);
    else renderStockHistory(sbody);
  }

  function productPicker(name, placeholder) {
    return `<div class="field"><label>Product</label>
      <input list="dl-${name}" name="${name}" placeholder="${placeholder || 'Type to search…'}" autocomplete="off" required>
      <datalist id="dl-${name}">${S.productIndex.map((p) => `<option value="${escapeHtml(p.name)} (${escapeHtml(p.sku)})">`).join('')}</datalist>
    </div>`;
  }
  function resolveProductFromPickerValue(val) {
    const m = /\(([^)]+)\)\s*$/.exec(val || '');
    const sku = m ? m[1] : val;
    return S.productIndex.find((p) => p.sku === sku) || S.productIndex.find((p) => p.name === val);
  }

  function renderStockIn(el) {
    el.innerHTML = `
      <div class="card">
        <form id="stockin-form">
          ${productPicker('product')}
          <div class="field-row">
            <div class="field"><label>Quantity received</label><input name="qty" type="number" min="1" step="1" inputmode="numeric" required></div>
            <div class="field"><label>Unit cost (ETB)</label><input name="unitCost" type="number" min="0" step="0.01" inputmode="numeric" required></div>
          </div>
          <div class="field-row">
            <div class="field"><label>Supplier</label><input name="supplier" placeholder="Optional"></div>
            <div class="field"><label>Invoice #</label><input name="invoice" placeholder="Optional"></div>
          </div>
          <button class="btn primary block" type="submit">📥 Record Stock In</button>
        </form>
      </div>`;
    qs('#stockin-form', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const product = resolveProductFromPickerValue(fd.get('product'));
      if (!product) { toast('Pick a valid product from the list', 'error'); return; }
      const qty = parseInt(fd.get('qty'), 10);
      const unitCost = parseFloat(fd.get('unitCost'));
      await db.products.update(product.id, { quantity: product.quantity + qty, costPrice: unitCost, synced: 0 });
      await db.purchases.add({ date: Date.now(), productId: product.id, quantity: qty, unitCost, supplier: fd.get('supplier') || '', invoice: fd.get('invoice') || '', uuid: genUuid(), synced: 0 });
      await db.stockMovements.add({ date: Date.now(), productId: product.id, type: 'in', quantity: qty, reason: 'Stock In', note: fd.get('invoice') || '', uuid: genUuid(), synced: 0 });
      await rebuildProductIndex();
      toast(`+${qty} added to ${product.name}`);
      e.target.reset();
    });
  }

  function renderStockAdjust(el) {
    el.innerHTML = `
      <div class="card">
        <form id="adjust-form">
          ${productPicker('product')}
          <div class="field"><label>Reason</label>
            <div class="chip-select" id="adjust-reason">
              ${['Damaged', 'Lost', 'Returned', 'Found'].map((r, i) => `<button type="button" class="chip ${i === 0 ? 'active' : ''}" data-reason="${r}">${r}</button>`).join('')}
            </div>
          </div>
          <div class="field"><label>Quantity change (+ to add, − to remove)</label><input name="delta" type="number" step="1" inputmode="numeric" required placeholder="e.g. -2 or 3"></div>
          <div class="field"><label>Note</label><input name="note" placeholder="Optional detail"></div>
          <button class="btn primary block" type="submit">Save adjustment</button>
        </form>
      </div>`;
    let reason = 'Damaged';
    qsa('[data-reason]', el).forEach((b) => b.addEventListener('click', () => {
      reason = b.dataset.reason;
      qsa('[data-reason]', el).forEach((x) => x.classList.toggle('active', x === b));
    }));
    qs('#adjust-form', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const product = resolveProductFromPickerValue(fd.get('product'));
      if (!product) { toast('Pick a valid product from the list', 'error'); return; }
      const delta = parseInt(fd.get('delta'), 10);
      if (!delta) { toast('Enter a non-zero quantity change', 'error'); return; }
      const newQty = product.quantity + delta;
      if (!S.settings.allowNegativeStock && newQty < 0) { toast('That would take stock negative (disallowed in Settings)', 'error'); return; }
      await db.products.update(product.id, { quantity: newQty, synced: 0 });
      await db.stockMovements.add({ date: Date.now(), productId: product.id, type: 'adjust', quantity: delta, reason, note: fd.get('note') || '', uuid: genUuid(), synced: 0 });
      await rebuildProductIndex();
      toast(`Adjusted ${product.name} by ${delta > 0 ? '+' : ''}${delta}`);
      e.target.reset();
    });
  }

  async function renderStockHistory(el) {
    const moves = await db.stockMovements.orderBy('date').reverse().limit(200).toArray();
    const byId = Object.fromEntries(S.productIndex.map((p) => [p.id, p]));
    if (!moves.length) { el.innerHTML = `<div class="empty"><div class="ic">📜</div><h3>No stock movements yet</h3></div>`; return; }
    el.innerHTML = moves.map((m) => {
      const p = byId[m.productId];
      const pos = m.quantity > 0;
      return `<div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px">
        <div>
          <div style="font-weight:700;font-size:13.5px">${escapeHtml(p ? p.name : 'Unknown product')}</div>
          <div style="font-size:11.5px;color:var(--ink-faint)">${m.type === 'in' ? 'Stock In' : m.reason} · ${fmtDateTime(m.date)}${m.note ? ' · ' + escapeHtml(m.note) : ''}</div>
        </div>
        <div class="num" style="font-weight:800;color:${pos ? 'var(--success)' : 'var(--danger)'}">${pos ? '+' : ''}${m.quantity}</div>
      </div>`;
    }).join('');
  }

  /* ----- Suppliers / Customers ----- */
  async function renderPeopleTab(body, kind) {
    const table = kind === 'suppliers' ? db.suppliers : db.customers;
    const list = (await table.toArray()).filter((p) => !p.deleted);
    body.innerHTML = `
      <div class="btn-row" style="margin-bottom:10px"><button class="btn primary sm" id="add-person">+ Add ${kind === 'suppliers' ? 'Supplier' : 'Customer'}</button></div>
      <div id="people-list"></div>`;
    const listEl = qs('#people-list', body);
    if (!list.length) {
      listEl.innerHTML = `<div class="empty"><div class="ic">${kind === 'suppliers' ? '🚚' : '🧑‍🤝‍🧑'}</div><h3>No ${kind} yet</h3></div>`;
    } else {
      listEl.innerHTML = list.map((p) => `
        <div class="card" data-id="${p.id}" style="cursor:pointer">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:700">${escapeHtml(p.name)}</div>
              <div style="font-size:12px;color:var(--ink-faint)">${escapeHtml(p.phone || '')}${kind === 'suppliers' && p.tin ? ' · TIN ' + escapeHtml(p.tin) : ''}</div>
            </div>
            <div class="num" style="font-weight:800;${(p.balance || 0) > 0 ? 'color:var(--danger)' : ''}">Br ${fmtMoney(p.balance || 0)}</div>
          </div>
        </div>`).join('');
      qsa('[data-id]', listEl).forEach((card) => card.addEventListener('click', () => openPersonModal(kind, list.find((x) => x.id == card.dataset.id))));
    }
    qs('#add-person', body).addEventListener('click', () => openPersonModal(kind));
  }

  function openPersonModal(kind, person) {
    const isEdit = !!person;
    const isSupplier = kind === 'suppliers';
    const p = person || {};
    openModal(`
      <div class="modal-head"><h3>${isEdit ? 'Edit' : 'Add'} ${isSupplier ? 'supplier' : 'customer'}</h3><button class="modal-close" data-close>✕</button></div>
      <form id="person-form">
        <div class="field"><label>Name</label><input name="name" required value="${escapeHtml(p.name || '')}"></div>
        <div class="field"><label>Phone</label><input name="phone" type="tel" placeholder="09xxxxxxxx" value="${escapeHtml(p.phone || '')}"></div>
        ${isSupplier ? `
        <div class="field"><label>TIN</label><input name="tin" value="${escapeHtml(p.tin || '')}"></div>
        <div class="field"><label>Address</label><input name="address" value="${escapeHtml(p.address || '')}"></div>
        <div class="field"><label>Outstanding balance owed to supplier (ETB)</label><input name="balance" type="number" step="0.01" value="${p.balance ?? 0}"></div>
        ` : `
        <div class="field"><label>Credit limit (ETB)</label><input name="creditLimit" type="number" step="0.01" value="${p.creditLimit ?? 0}"></div>
        <div class="field"><label>Outstanding balance owed by customer (ETB)</label><input name="balance" type="number" step="0.01" value="${p.balance ?? 0}"></div>
        `}
        <div class="btn-row">
          ${isEdit ? '<button type="button" class="btn danger" id="person-delete">Delete</button>' : ''}
          <button type="submit" class="btn primary block">Save</button>
        </div>
      </form>`, (modal) => {
      qs('[data-close]', modal).onclick = closeModal;
      qs('#person-form', modal).addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = { name: fd.get('name').trim(), phone: fd.get('phone').trim(), balance: parseFloat(fd.get('balance')) || 0 };
        if (isSupplier) { data.tin = fd.get('tin').trim(); data.address = fd.get('address').trim(); }
        else { data.creditLimit = parseFloat(fd.get('creditLimit')) || 0; }
        const table = isSupplier ? db.suppliers : db.customers;
        if (isEdit) { data.synced = 0; await table.update(p.id, data); }
        else { data.uuid = genUuid(); data.synced = 0; await table.add(data); }
        closeModal();
        renderProductsBody();
        toast('Saved');
      });
      if (isEdit) {
        qs('#person-delete', modal).onclick = async () => {
          const ok = await confirmDialog('Delete?', `Remove "${p.name}" from your ${isSupplier ? 'suppliers' : 'customers'} list.`, 'Delete');
          if (!ok) return;
          // Soft-delete (tombstone), same reasoning as product deletes above.
          await (isSupplier ? db.suppliers : db.customers).update(p.id, { deleted: true, synced: 0 });
          closeModal(); renderProductsBody();
        };
      }
    });
  }

  /* ---------------------------------------------------------------------
     POS (Point of Sale)
     --------------------------------------------------------------------- */
  VIEWS.pos = {
    async render() {
      if (!S.productIndex.length) await rebuildProductIndex();
      if (S.posAccountId == null) {
        const cash = S.accounts.find((a) => a.type === 'cash');
        S.posAccountId = cash ? cash.id : (S.accounts[0] && S.accounts[0].id);
      }
      return `
        <div class="searchbar">
          <span class="ic">🔎</span>
          <input id="pos-search" placeholder="Scan barcode or search product…" autocomplete="off">
        </div>
        <div id="pos-results" style="margin-top:8px"></div>

        <div class="section-title">Cart</div>
        <div id="pos-cart"><div class="empty" style="padding:20px"><p>Cart is empty — search above to add items.</p></div></div>

        <div class="totals-box" id="pos-totals"></div>

        <div class="section-title">Payment</div>
        <div class="card">
          <div class="field"><label>Receiving account</label>
            <select id="pos-account">${S.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.label)}</option>`).join('')}</select>
          </div>
          <div id="pos-account-extra"></div>
          <div class="field-row">
            <div class="field"><label>Discount type</label>
              <select id="pos-disc-type"><option value="fixed">Fixed (ETB)</option><option value="percent">Percent (%)</option></select>
            </div>
            <div class="field"><label>Discount value</label><input id="pos-disc-value" type="number" min="0" step="0.01" value="0"></div>
          </div>
          <button class="btn primary block" id="pos-checkout" disabled>Complete Sale</button>
        </div>

        <div class="section-title">Recent sales</div>
        <div id="pos-recent"></div>`;
    },
    mount(el) {
      const search = qs('#pos-search', el);
      search.focus();
      const doSearch = debounce((q) => {
        const results = q.trim() ? searchProducts(q, 'All').slice(0, 8) : [];
        const box = qs('#pos-results', el);
        box.innerHTML = results.map((p) => `
          <div class="card" data-add="${p.id}" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;cursor:pointer;margin-top:6px">
            <div><div style="font-weight:700;font-size:13.5px">${escapeHtml(p.name)}</div><div style="font-size:11.5px;color:var(--ink-faint)">${escapeHtml(p.sku)} · ${p.quantity} in stock</div></div>
            <div class="num" style="font-weight:800">Br ${fmtMoney(p.sellingPrice)}</div>
          </div>`).join('');
        qsa('[data-add]', box).forEach((c) => c.addEventListener('click', () => {
          addToCart(S.productIndex.find((p) => p.id == c.dataset.add));
          search.value = ''; box.innerHTML = ''; search.focus();
        }));
      }, 300);
      search.addEventListener('input', (e) => doSearch(e.target.value));
      // Barcode-scanner support: Enter key looks for an exact barcode/SKU match
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const q = search.value.trim();
          const exact = S.productIndex.find((p) => p.barcode === q || p.sku === q);
          if (exact) { addToCart(exact); search.value = ''; qs('#pos-results', el).innerHTML = ''; }
          else toast('No exact barcode/SKU match', 'error');
        }
      });
      qs('#pos-account', el).addEventListener('change', (e) => { S.posAccountId = e.target.value; renderAccountExtra(el); });
      renderAccountExtra(el);
      qs('#pos-disc-type', el).addEventListener('change', (e) => { S.posDiscount.type = e.target.value; renderCart(el); });
      qs('#pos-disc-value', el).addEventListener('input', debounce((e) => { S.posDiscount.value = parseFloat(e.target.value) || 0; renderCart(el); }, 200));
      qs('#pos-checkout', el).addEventListener('click', () => checkout(el));
      renderCart(el);
      renderRecentSales(el);
    }
  };

  function renderAccountExtra(el) {
    const acc = S.accounts.find((a) => a.id == S.posAccountId);
    const box = qs('#pos-account-extra', el);
    if (!acc) { box.innerHTML = ''; return; }
    if (acc.type === 'credit') {
      box.innerHTML = `
        <div class="field"><label>Customer name</label><input id="pos-cust-name" required></div>
        <div class="field-row">
          <div class="field"><label>Customer phone</label><input id="pos-cust-phone" type="tel"></div>
          <div class="field"><label>Due date</label><input id="pos-cust-due" type="date"></div>
        </div>`;
    } else if (acc.type === 'mobile_money' || acc.type === 'bank') {
      box.innerHTML = `<div class="field"><label>Payer's account/phone or reference #</label><input id="pos-payer-ref" placeholder="Sender's Telebirr/CBE number or txn ref"></div>`;
    } else {
      box.innerHTML = '';
    }
  }

  function addToCart(product) {
    if (!product) return;
    if (product.quantity <= 0 && !S.settings.allowNegativeStock) { toast(`${product.name} is out of stock`, 'error'); return; }
    const existing = S.cart.find((c) => c.productId === product.id);
    if (existing) existing.qty += 1;
    else S.cart.push({ productId: product.id, name: product.name, price: product.sellingPrice, cost: product.costPrice, qty: 1, stock: product.quantity });
    renderCart(qs('#view-pos'));
  }

  function renderCart(el) {
    if (!el) return;
    const cartBox = qs('#pos-cart', el);
    if (!S.cart.length) {
      cartBox.innerHTML = `<div class="empty" style="padding:20px"><p>Cart is empty — search above to add items.</p></div>`;
    } else {
      cartBox.innerHTML = S.cart.map((c, i) => `
        <div class="cart-item" data-i="${i}">
          <div class="info"><div class="name">${escapeHtml(c.name)}</div><div class="price num">Br ${fmtMoney(c.price)} each</div></div>
          <div class="qty-stepper">
            <button data-dec>−</button><span class="q num">${c.qty}</span><button data-inc>+</button>
          </div>
          <div class="linetotal num">Br ${fmtMoney(c.price * c.qty)}</div>
          <button class="rm" data-rm>✕</button>
        </div>`).join('');
      qsa('[data-inc]', cartBox).forEach((b) => b.addEventListener('click', (e) => { S.cart[+e.target.closest('[data-i]').dataset.i].qty++; renderCart(el); }));
      qsa('[data-dec]', cartBox).forEach((b) => b.addEventListener('click', (e) => {
        const i = +e.target.closest('[data-i]').dataset.i;
        S.cart[i].qty--; if (S.cart[i].qty <= 0) S.cart.splice(i, 1);
        renderCart(el);
      }));
      qsa('[data-rm]', cartBox).forEach((b) => b.addEventListener('click', (e) => { S.cart.splice(+e.target.closest('[data-i]').dataset.i, 1); renderCart(el); }));
    }
    const subtotal = S.cart.reduce((s, c) => s + c.price * c.qty, 0);
    const discount = S.posDiscount.type === 'percent' ? subtotal * (S.posDiscount.value / 100) : S.posDiscount.value;
    const total = Math.max(0, subtotal - discount);
    qs('#pos-totals', el).innerHTML = `
      <div class="totals-row"><span>Subtotal</span><span class="num">Br ${fmtMoney(subtotal)}</span></div>
      <div class="totals-row"><span>Discount</span><span class="num">− Br ${fmtMoney(discount)}</span></div>
      <div class="totals-row grand"><span>Total</span><span class="num">Br ${fmtMoney(total)}</span></div>`;
    const btn = qs('#pos-checkout', el);
    if (btn) btn.disabled = S.cart.length === 0;
  }

  async function checkout(el) {
    const subtotal = S.cart.reduce((s, c) => s + c.price * c.qty, 0);
    const discount = S.posDiscount.type === 'percent' ? subtotal * (S.posDiscount.value / 100) : S.posDiscount.value;
    const total = Math.max(0, subtotal - discount);
    const account = S.accounts.find((a) => a.id == S.posAccountId);
    if (!account) { toast('Choose a receiving account', 'error'); return; }

    let customerId = null, customerName = '', payerRef = '';
    if (account.type === 'credit') {
      const name = (qs('#pos-cust-name', el) || {}).value?.trim();
      if (!name) { toast('Customer name is required for a credit sale', 'error'); return; }
      const phone = (qs('#pos-cust-phone', el) || {}).value?.trim() || '';
      const due = (qs('#pos-cust-due', el) || {}).value || '';
      let cust = (await db.customers.toArray()).find((c) => !c.deleted && c.name.toLowerCase() === name.toLowerCase() && c.phone === phone);
      if (!cust) { customerId = await db.customers.add({ name, phone, creditLimit: 0, balance: 0, uuid: genUuid(), synced: 0 }); }
      else customerId = cust.id;
      await db.customers.update(customerId, { balance: ((await db.customers.get(customerId)).balance || 0) + total, dueDate: due, synced: 0 });
      customerName = name;
    } else if (account.type === 'mobile_money' || account.type === 'bank') {
      payerRef = (qs('#pos-payer-ref', el) || {}).value?.trim() || '';
    }

    // Negative stock guard
    if (!S.settings.allowNegativeStock) {
      for (const c of S.cart) {
        const p = S.productIndex.find((x) => x.id === c.productId);
        if (p && p.quantity - c.qty < 0) { toast(`Not enough stock for ${p.name}`, 'error'); return; }
      }
    }

    try {
      const profit = S.cart.reduce((s, c) => s + (c.price - c.cost) * c.qty, 0) - discount;
      const saleId = await db.sales.add({
        date: Date.now(), subtotal, discount, total, profit,
        paymentAccountId: account.id, paymentAccountLabel: account.label,
        payerReference: payerRef, customerId, customerName,
        uuid: genUuid(), synced: 0
      });
      for (const c of S.cart) {
        await db.saleItems.add({ saleId, productId: c.productId, name: c.name, qty: c.qty, price: c.price, costAtSale: c.cost, uuid: genUuid(), synced: 0 });
        const p = S.productIndex.find((x) => x.id === c.productId);
        const newQty = (p ? p.quantity : 0) - c.qty;
        await db.products.update(c.productId, { quantity: newQty, synced: 0 });
        await db.stockMovements.add({ date: Date.now(), productId: c.productId, type: 'sale', quantity: -c.qty, reason: 'Sale', note: `Sale #${saleId}`, uuid: genUuid(), synced: 0 });
      }
      await rebuildProductIndex();
      printReceipt({ saleId, items: S.cart.slice(), subtotal, discount, total, account, payerRef, customerName });
      S.cart = [];
      S.posDiscount = { type: 'fixed', value: 0 };
      toast('Sale completed', 'success');
      showView('pos');
    } catch (err) {
      console.error(err);
      if (err.name === 'QuotaExceededError') toast('Device storage is full — back up and free space', 'error');
      else toast('Checkout failed', 'error');
    }
  }

  function printReceipt({ saleId, items, subtotal, discount, total, account, payerRef, customerName }) {
    const s = S.settings;
    const html = `
      <h2>${escapeHtml(s.name || 'Duket Shop')}</h2>
      <div class="center">${escapeHtml(s.address || '')}</div>
      <div class="center">${s.phone ? 'Tel: ' + escapeHtml(s.phone) : ''}</div>
      <div class="center">${s.tin ? 'TIN: ' + escapeHtml(s.tin) : ''}</div>
      <hr>
      ${s.receiptHeader ? `<div class="center">${escapeHtml(s.receiptHeader)}</div><hr>` : ''}
      <div>Receipt #${saleId} — ${fmtDateTime(Date.now())}</div>
      <hr>
      <table>${items.map((i) => `
        <tr><td colspan="2">${escapeHtml(i.name)}</td></tr>
        <tr><td>${i.qty} x ${fmtMoney(i.price)}</td><td style="text-align:right">${fmtMoney(i.qty * i.price)}</td></tr>
      `).join('')}</table>
      <hr>
      <table>
        <tr><td>Subtotal</td><td style="text-align:right">${fmtMoney(subtotal)}</td></tr>
        <tr><td>Discount</td><td style="text-align:right">-${fmtMoney(discount)}</td></tr>
        <tr><td><b>TOTAL (ETB)</b></td><td style="text-align:right"><b>${fmtMoney(total)}</b></td></tr>
      </table>
      <hr>
      <div>Paid via: ${escapeHtml(account.label)}</div>
      ${payerRef ? `<div>Payer ref: ${escapeHtml(payerRef)}</div>` : ''}
      ${customerName ? `<div>Customer: ${escapeHtml(customerName)}</div>` : ''}
      <hr>
      <div class="center">${escapeHtml(s.receiptFooter || 'አመሰግናለን — Thank you!')}</div>`;
    qs('#receipt-print').innerHTML = html;
    setTimeout(() => window.print(), 80);
  }

  async function renderRecentSales(el) {
    const sales = await db.sales.orderBy('date').reverse().limit(15).toArray();
    const box = qs('#pos-recent', el);
    if (!sales.length) { box.innerHTML = `<div class="empty" style="padding:16px"><p>No sales yet.</p></div>`; return; }
    box.innerHTML = sales.map((s) => `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px">
        <div><div style="font-weight:700;font-size:13.5px">#${s.id} · ${escapeHtml(s.paymentAccountLabel || '')}</div>
          <div style="font-size:11.5px;color:var(--ink-faint)">${fmtDateTime(s.date)}</div></div>
        <div class="num" style="font-weight:800">Br ${fmtMoney(s.total)}</div>
      </div>`).join('');
  }

  /* ---------------------------------------------------------------------
     Lazy script loader (used for Chart.js — only loaded when Reports
     is opened, never at startup)
     --------------------------------------------------------------------- */
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  const CHARTJS_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js';

  /* ---------------------------------------------------------------------
     REPORTS
     --------------------------------------------------------------------- */
  VIEWS.reports = {
    async render() {
      const from = S.reportsRange.from, to = S.reportsRange.to;
      return `
        <div class="card">
          <div class="field-row">
            <div class="field"><label>From</label><input type="date" id="rep-from" value="${from.toISOString().slice(0, 10)}"></div>
            <div class="field"><label>To</label><input type="date" id="rep-to" value="${to.toISOString().slice(0, 10)}"></div>
          </div>
          <div class="chip-select">
            <button class="chip" data-range="7">Last 7 days</button>
            <button class="chip" data-range="30">Last 30 days</button>
            <button class="chip" data-range="0">Today</button>
          </div>
        </div>
        <div id="reports-body"><div class="card skeleton" style="height:180px;margin-top:10px"></div></div>`;
    },
    mount(el) {
      qs('#rep-from', el).addEventListener('change', (e) => { S.reportsRange.from = startOfDay(new Date(e.target.value)); loadReportsBody(); });
      qs('#rep-to', el).addEventListener('change', (e) => { S.reportsRange.to = startOfDay(new Date(e.target.value)); loadReportsBody(); });
      qsa('[data-range]', el).forEach((b) => b.addEventListener('click', () => {
        const n = parseInt(b.dataset.range, 10);
        S.reportsRange.from = daysAgo(n); S.reportsRange.to = startOfDay(new Date());
        qs('#rep-from', el).value = S.reportsRange.from.toISOString().slice(0, 10);
        qs('#rep-to', el).value = S.reportsRange.to.toISOString().slice(0, 10);
        loadReportsBody();
      }));
      loadReportsBody();
    }
  };

  async function loadReportsBody() {
    const body = qs('#reports-body');
    if (!body) return;
    const from = S.reportsRange.from.getTime();
    const to = S.reportsRange.to.getTime() + 24 * 3600 * 1000 - 1;
    const sales = (await db.sales.where('date').between(from, to, true, true).toArray());
    const revenue = sales.reduce((s, x) => s + x.total, 0);
    const profit = sales.reduce((s, x) => s + (x.profit || 0), 0);
    const products = S.productIndex.length ? S.productIndex : (await db.products.toArray()).filter((p) => !p.deleted);
    const stockCost = products.reduce((s, p) => s + p.costPrice * p.quantity, 0);
    const stockRetail = products.reduce((s, p) => s + p.sellingPrice * p.quantity, 0);
    const threshold = (p) => (p.minStock != null ? p.minStock : S.settings.lowStockDefault);
    const lowStock = products.filter((p) => p.quantity <= threshold(p));

    // Payment account summary
    const byAccount = {};
    for (const s of sales) {
      const k = s.paymentAccountLabel || 'Unknown';
      byAccount[k] = (byAccount[k] || 0) + s.total;
    }

    body.innerHTML = `
      <div class="grid2" style="margin-top:10px">
        <div class="stat-card"><div class="label">Revenue</div><div class="value num brand">Br ${fmtMoney(revenue)}</div><div class="sub">${sales.length} sales</div></div>
        <div class="stat-card"><div class="label">Profit</div><div class="value num" style="color:var(--success)">Br ${fmtMoney(profit)}</div></div>
        <div class="stat-card"><div class="label">Stock Value (Cost)</div><div class="value num">Br ${fmtMoney(stockCost)}</div></div>
        <div class="stat-card"><div class="label">Stock Value (Retail)</div><div class="value num">Br ${fmtMoney(stockRetail)}</div></div>
      </div>

      <div class="section-title">Sales trend</div>
      <div class="card"><canvas id="sales-chart" height="160" aria-label="Sales over time" role="img"></canvas></div>

      <div class="section-title">Payment account summary</div>
      <div class="card">
        <table class="rtable">
          <thead><tr><th>Account</th><th class="num">Received</th></tr></thead>
          <tbody>${Object.keys(byAccount).length ? Object.entries(byAccount).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">Br ${fmtMoney(v)}</td></tr>`).join('') : '<tr><td colspan="2">No sales in this range</td></tr>'}</tbody>
        </table>
        <button class="btn ghost sm" style="margin-top:10px" id="export-accounts">⬇ Export CSV</button>
      </div>

      <div class="section-title">Low stock report</div>
      <div class="card">
        <table class="rtable">
          <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Threshold</th></tr></thead>
          <tbody>${lowStock.length ? lowStock.map((p) => `<tr><td>${escapeHtml(p.name)}</td><td class="num">${p.quantity}</td><td class="num">${threshold(p)}</td></tr>`).join('') : '<tr><td colspan="3">All stocked above threshold 🎉</td></tr>'}</tbody>
        </table>
        <button class="btn ghost sm" style="margin-top:10px" id="export-lowstock">⬇ Export CSV</button>
      </div>

      <div class="section-title">Profit & Loss</div>
      <div class="card">
        <div class="totals-row"><span>Revenue</span><span class="num">Br ${fmtMoney(revenue)}</span></div>
        <div class="totals-row"><span>Discounts given</span><span class="num">− Br ${fmtMoney(sales.reduce((s, x) => s + (x.discount || 0), 0))}</span></div>
        <div class="totals-row"><span>Cost of goods sold</span><span class="num">− Br ${fmtMoney(revenue - profit)}</span></div>
        <div class="totals-row grand"><span>Net profit</span><span class="num">Br ${fmtMoney(profit)}</span></div>
      </div>`;

    qs('#export-accounts').addEventListener('click', () => {
      const rows = Object.entries(byAccount).map(([account, received]) => ({ account, received: received.toFixed(2) }));
      if (!rows.length) { toast('Nothing to export', 'error'); return; }
      downloadText(`duket-payment-accounts-${Date.now()}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
    });
    qs('#export-lowstock').addEventListener('click', () => {
      const rows = lowStock.map((p) => ({ sku: p.sku, name: p.name, quantity: p.quantity, threshold: threshold(p) }));
      if (!rows.length) { toast('Nothing to export', 'error'); return; }
      downloadText(`duket-low-stock-${Date.now()}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
    });

    // Chart: daily revenue across the selected range, lazy-loaded
    try {
      await loadScriptOnce(CHARTJS_CDN);
      const days = [];
      let d = new Date(from);
      const toD = new Date(to);
      while (d <= toD && days.length < 62) { days.push(startOfDay(d)); d = new Date(d); d.setDate(d.getDate() + 1); }
      const perDay = days.map((day) => {
        const next = new Date(day); next.setDate(next.getDate() + 1);
        return sales.filter((s) => s.date >= day.getTime() && s.date < next.getTime()).reduce((s, x) => s + x.total, 0);
      });
      const ctx = qs('#sales-chart');
      if (ctx && window.Chart) {
        new window.Chart(ctx, {
          type: 'bar',
          data: { labels: days.map((d) => `${d.getDate()}/${d.getMonth() + 1}`), datasets: [{ label: 'Revenue (ETB)', data: perDay, backgroundColor: '#0D4A3A' }] },
          options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
        });
      }
    } catch (err) {
      const ctx = qs('#sales-chart');
      if (ctx) ctx.replaceWith(ce('p', {}, 'Chart unavailable offline on first load — connect once to cache it.'));
    }
  }

  /* ---------------------------------------------------------------------
     SETTINGS
     --------------------------------------------------------------------- */
  VIEWS.settings = {
    async render() {
      const s = S.settings;
      return `
        <div class="section-title">Shop info</div>
        <div class="card">
          <form id="shop-form">
            <div class="field"><label>Shop name</label><input name="name" value="${escapeHtml(s.name || '')}" required></div>
            <div class="field"><label>Address</label><input name="address" value="${escapeHtml(s.address || '')}"></div>
            <div class="field-row">
              <div class="field"><label>Phone</label><input name="phone" type="tel" value="${escapeHtml(s.phone || '')}" placeholder="09xxxxxxxx"></div>
              <div class="field"><label>TIN number</label><input name="tin" value="${escapeHtml(s.tin || '')}"></div>
            </div>
            <div class="field"><label>Receipt header (optional)</label><input name="receiptHeader" value="${escapeHtml(s.receiptHeader || '')}"></div>
            <div class="field"><label>Receipt footer</label><input name="receiptFooter" value="${escapeHtml(s.receiptFooter || '')}"></div>
            <div class="field-row">
              <div class="field"><label>Default low stock threshold</label><input name="lowStockDefault" type="number" min="0" step="1" value="${s.lowStockDefault}"></div>
              <div class="field"><label>Allow negative stock?</label>
                <select name="allowNegativeStock"><option value="0" ${!s.allowNegativeStock ? 'selected' : ''}>No</option><option value="1" ${s.allowNegativeStock ? 'selected' : ''}>Yes</option></select>
              </div>
            </div>
            <button class="btn primary block" type="submit">Save shop info</button>
          </form>
        </div>

        <div class="section-title">Payment accounts</div>
        <div class="card" id="accounts-card"></div>

        <div class="section-title">Cloud Sync</div>
        <div class="card" id="sync-card">Loading…</div>

        <div class="section-title">Data</div>
        <div class="card">
          <p style="font-size:13px;color:var(--ink-muted);margin-bottom:12px">Back up your full database as a JSON file, or restore from a previous backup. Keep backups off-device (email, Drive, SD card).</p>
          <div class="btn-row">
            <button class="btn ghost" id="backup-export">⬇ Export backup (JSON)</button>
            <label class="btn ghost" style="cursor:pointer">⬆ Restore backup<input type="file" id="backup-import" accept="application/json" style="display:none"></label>
          </div>
          <button class="btn danger block" style="margin-top:14px" id="reset-all">⚠ Reset all data</button>
        </div>

        <div class="section-title">Appearance</div>
        <div class="card">
          <div class="btn-row"><button class="btn ${S.theme === 'light' ? 'primary' : 'ghost'} sm" data-theme-opt="light">☀️ Light</button>
            <button class="btn ${S.theme === 'dark' ? 'primary' : 'ghost'} sm" data-theme-opt="dark">🌙 Dark</button></div>
        </div>
        <p style="text-align:center;font-size:11.5px;color:var(--ink-faint);margin:18px 0">Duket v1.0 · All data stored on this device</p>`;
    },
    mount(el) {
      qs('#shop-form', el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        Object.assign(S.settings, {
          name: fd.get('name').trim(), address: fd.get('address').trim(), phone: fd.get('phone').trim(),
          tin: fd.get('tin').trim(), receiptHeader: fd.get('receiptHeader').trim(), receiptFooter: fd.get('receiptFooter').trim(),
          lowStockDefault: parseInt(fd.get('lowStockDefault'), 10) || 0,
          allowNegativeStock: fd.get('allowNegativeStock') === '1',
        });
        await db.settings.put(S.settings);
        toast('Shop info saved');
      });
      renderAccountsCard(qs('#accounts-card', el));
      renderSyncCard(qs('#sync-card', el));
      qs('#backup-export', el).addEventListener('click', backupExport);
      qs('#backup-import', el).addEventListener('change', (e) => { if (e.target.files[0]) backupImport(e.target.files[0]); });
      qs('#reset-all', el).addEventListener('click', resetAllData);
      qsa('[data-theme-opt]', el).forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.themeOpt !== S.theme) toggleTheme();
        showView('settings');
      }));
    }
  };

  function renderAccountsCard(box) {
    box.innerHTML = `
      ${S.accounts.map((a) => `
        <div class="cart-item" data-acc="${a.id}">
          <div class="info"><div class="name">${escapeHtml(a.label)}</div><div class="price">${escapeHtml(a.type)}${a.numberOrPhone ? ' · ' + escapeHtml(a.numberOrPhone) : ''}</div></div>
          <button class="btn ghost sm" data-edit-acc>Edit</button>
        </div>`).join('')}
      <button class="btn accent block" style="margin-top:12px" id="add-account">+ Add payment account</button>`;
    qsa('[data-edit-acc]', box).forEach((b) => b.addEventListener('click', (e) => {
      const id = e.target.closest('[data-acc]').dataset.acc;
      openAccountModal(S.accounts.find((a) => a.id == id));
    }));
    qs('#add-account', box).addEventListener('click', () => openAccountModal());
  }

  function openAccountModal(account) {
    const isEdit = !!account;
    const a = account || { type: 'mobile_money' };
    openModal(`
      <div class="modal-head"><h3>${isEdit ? 'Edit' : 'Add'} payment account</h3><button class="modal-close" data-close>✕</button></div>
      <form id="account-form">
        <div class="field"><label>Label</label><input name="label" required value="${escapeHtml(a.label || '')}" placeholder="e.g. CBE Birr"></div>
        <div class="field"><label>Type</label>
          <select name="type">
            <option value="cash" ${a.type === 'cash' ? 'selected' : ''}>Cash</option>
            <option value="mobile_money" ${a.type === 'mobile_money' ? 'selected' : ''}>Mobile Money (Telebirr/CBE Birr)</option>
            <option value="bank" ${a.type === 'bank' ? 'selected' : ''}>Bank Transfer</option>
            <option value="credit" ${a.type === 'credit' ? 'selected' : ''}>Credit / Debt</option>
          </select>
        </div>
        <div class="field"><label>Account number / phone (optional)</label><input name="numberOrPhone" value="${escapeHtml(a.numberOrPhone || '')}"></div>
        <div class="btn-row">
          ${isEdit ? '<button type="button" class="btn danger" id="account-delete">Delete</button>' : ''}
          <button type="submit" class="btn primary block">Save</button>
        </div>
      </form>`, (modal) => {
      qs('[data-close]', modal).onclick = closeModal;
      qs('#account-form', modal).addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = { label: fd.get('label').trim(), type: fd.get('type'), numberOrPhone: fd.get('numberOrPhone').trim() };
        if (isEdit) { data.synced = 0; await db.accounts.update(a.id, data); }
        else { data.uuid = genUuid(); data.synced = 0; await db.accounts.add(data); }
        await refreshAccounts();
        closeModal();
        showView('settings');
        toast('Account saved');
      });
      if (isEdit) {
        qs('#account-delete', modal).onclick = async () => {
          const ok = await confirmDialog('Delete account?', `Remove "${a.label}" from payment options.`, 'Delete');
          if (!ok) return;
          await db.accounts.update(a.id, { deleted: true, synced: 0 });
          await refreshAccounts();
          closeModal();
          showView('settings');
        };
      }
    });
  }

  /* ---------------------------------------------------------------------
     Cloud Sync (Supabase) — sync.js and supabase-client.js implement the
     whole push/pull engine, but nothing in this file ever called them, so
     multi-device sync was dead code that never actually ran. This card is
     the missing entry point: sign in/up, then hand off to
     window.DuketSync.startAutoSync().
     --------------------------------------------------------------------- */
  async function renderSyncCard(box) {
    if (!window.DuketAuth) { box.innerHTML = `<p style="font-size:13px;color:var(--ink-muted)">Cloud sync isn't available on this build.</p>`; return; }
    const session = await window.DuketAuth.getSession();
    if (session) {
      box.innerHTML = `
        <p style="font-size:13px;color:var(--ink-muted);margin-bottom:10px">Signed in as <b>${escapeHtml(session.user.email || '')}</b>. This device syncs automatically with your other devices while online.</p>
        <div class="btn-row">
          <button class="btn ghost sm" id="sync-now">🔄 Sync now</button>
          <button class="btn danger sm" id="sync-signout">Sign out</button>
        </div>`;
      qs('#sync-now', box).addEventListener('click', async () => {
        toast('Syncing…');
        await window.DuketSync.syncNow();
        await rebuildProductIndex();
        await refreshAccounts();
        toast('Sync complete');
      });
      qs('#sync-signout', box).addEventListener('click', async () => {
        await window.DuketAuth.signOut();
        toast('Signed out');
        showView('settings');
      });
    } else {
      box.innerHTML = `
        <p style="font-size:13px;color:var(--ink-muted);margin-bottom:10px">Sign in to back up this shop to the cloud and keep multiple devices in sync.</p>
        <form id="sync-form">
          <div class="field"><label>Email</label><input name="email" type="email" required></div>
          <div class="field"><label>Password</label><input name="password" type="password" required minlength="6"></div>
          <div class="btn-row">
            <button type="submit" class="btn primary sm">Sign in</button>
            <button type="button" class="btn ghost sm" id="sync-signup">Create account</button>
          </div>
        </form>`;
      const form = qs('#sync-form', box);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const { error } = await window.DuketAuth.signIn(fd.get('email').trim(), fd.get('password'));
        if (error) { toast(error.message, 'error'); return; }
        toast('Signed in — syncing…');
        window.DuketSync.startAutoSync();
        showView('settings');
      });
      qs('#sync-signup', box).addEventListener('click', async () => {
        const fd = new FormData(form);
        const email = (fd.get('email') || '').trim();
        const password = fd.get('password') || '';
        if (!email || password.length < 6) { toast('Enter an email and a password (6+ characters)', 'error'); return; }
        const { error } = await window.DuketAuth.signUp(email, password);
        if (error) { toast(error.message, 'error'); return; }
        toast('Account created — syncing…');
        window.DuketSync.startAutoSync();
        showView('settings');
      });
    }
  }

  async function backupExport() {
    try {
      const data = {
        version: 1, exportedAt: new Date().toISOString(),
        products: await db.products.toArray(), sales: await db.sales.toArray(), saleItems: await db.saleItems.toArray(),
        purchases: await db.purchases.toArray(), suppliers: await db.suppliers.toArray(), customers: await db.customers.toArray(),
        stockMovements: await db.stockMovements.toArray(), accounts: await db.accounts.toArray(), settings: await db.settings.toArray(),
      };
      downloadText(`duket-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
      toast('Backup downloaded');
    } catch (err) {
      console.error(err);
      toast('Backup failed', 'error');
    }
  }

  async function backupImport(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const required = ['products', 'sales', 'saleItems', 'accounts', 'settings'];
      for (const k of required) if (!Array.isArray(data[k])) throw new Error('Missing table: ' + k);
      const ok = await confirmDialog('Restore backup?', 'This replaces ALL current data on this device with the backup file. This cannot be undone.', 'Restore');
      if (!ok) return;
      await db.transaction('rw', db.tables, async () => {
        for (const t of db.tables) await t.clear();
        if (data.products.length) await db.products.bulkAdd(data.products);
        if (data.sales.length) await db.sales.bulkAdd(data.sales);
        if (data.saleItems.length) await db.saleItems.bulkAdd(data.saleItems);
        if (data.purchases && data.purchases.length) await db.purchases.bulkAdd(data.purchases);
        if (data.suppliers && data.suppliers.length) await db.suppliers.bulkAdd(data.suppliers);
        if (data.customers && data.customers.length) await db.customers.bulkAdd(data.customers);
        if (data.stockMovements && data.stockMovements.length) await db.stockMovements.bulkAdd(data.stockMovements);
        if (data.accounts.length) await db.accounts.bulkAdd(data.accounts);
        if (data.settings.length) await db.settings.bulkAdd(data.settings);
      });
      await backfillSyncFields(); // in case this backup predates uuid/synced fields
      await ensureDefaults();
      await rebuildProductIndex();
      toast('Backup restored');
      showView('dashboard');
    } catch (err) {
      console.error(err);
      toast('Restore failed — file may be corrupted or invalid', 'error');
    }
  }

  async function resetAllData() {
    const ok = await confirmDialog('Reset ALL data?', 'This permanently deletes every product, sale, and setting on this device. This cannot be undone.', 'Erase everything');
    if (!ok) return;
    const ok2 = await confirmDialog('Are you absolutely sure?', 'Type nothing — just confirm again to permanently erase all shop data.', 'Yes, erase everything');
    if (!ok2) return;
    await db.transaction('rw', db.tables, async () => { for (const t of db.tables) await t.clear(); });
    await ensureDefaults();
    await rebuildProductIndex();
    toast('All data reset');
    showView('dashboard');
  }

  /* ---------------------------------------------------------------------
     Onboarding (empty database, first run)
     --------------------------------------------------------------------- */
  function renderOnboarding() {
    const app = qs('#app');
    app.innerHTML = `
      <div class="onboarding">
        <div class="ic">🏪</div>
        <h1>Welcome to Duket</h1>
        <p>Your offline inventory &amp; point-of-sale manager. Let's set up your shop — this only takes a moment, and everything stays on this device.</p>
        <form id="onboard-form" style="text-align:left">
          <div class="field"><label>Shop name</label><input name="name" required placeholder="e.g. Selam Mobile Accessories"></div>
          <div class="field"><label>Phone</label><input name="phone" type="tel" placeholder="09xxxxxxxx"></div>
          <div class="field"><label>TIN number (optional)</label><input name="tin"></div>
          <button class="btn primary block" type="submit">Get started →</button>
        </form>
      </div>`;
    qs('#onboard-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      Object.assign(S.settings, { name: fd.get('name').trim(), phone: fd.get('phone').trim(), tin: fd.get('tin').trim(), onboarded: true });
      await db.settings.put(S.settings);
      boot();
    });
  }

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */
  async function boot() {
    await ensureDefaults();
    if (!S.settings.onboarded) { renderOnboarding(); return; }
    await rebuildProductIndex();
    renderShell();
    showView('dashboard');
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
    }
    // Cloud sync: only kick off the auto-sync loop once we know a shop
    // owner is actually signed in (startAutoSync() itself no-ops without a
    // session, but there's no point running the 30s timer/online listener
    // at all for the common signed-out, fully-local shop). onAuthChange
    // also starts it the moment someone signs in from the Settings card,
    // and stays subscribed for the rest of the session in case of a token
    // refresh or a sign-in on a previously signed-out device.
    if (window.DuketAuth && window.DuketSync) {
      const session = await window.DuketAuth.getSession();
      if (session) window.DuketSync.startAutoSync();
      window.DuketAuth.onAuthChange((event, sess) => {
        if (sess) window.DuketSync.startAutoSync();
      });
    }
  }

  boot();
})();
