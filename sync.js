/* ---------------------------------------------------------------------
   sync.js
   Offline-first sync between Dexie (local, source of truth for the UI)
   and Supabase (remote, source of truth across devices).

   Load order in index.html:
     <script src="dexie.min.js"></script>
     <script type="module" src="supabase-client.js"></script>
     <script type="module" src="sync.js"></script>
     <script src="app.js"></script>

   sync.js reads the same Dexie database app.js uses ('MyShopDB'), so it
   doesn't need app.js to export anything. It exposes window.MyShopSync
   = { syncNow, startAutoSync } for app.js (a classic script) to call.
   --------------------------------------------------------------------- */

import { supabase, getShopId } from './supabase-client.js';

// IMPORTANT: this file must NOT do `new Dexie('MyShopDB')` itself. Dexie only
// creates table properties (db.settings, db.products, ...) on an instance
// that has actually declared them via .version().stores() — a second,
// schema-less instance pointed at the same IndexedDB database does NOT
// inherit those properties, so e.g. `db.settings` would be undefined and
// `db.settings.get(...)` would throw. (This used to be a real bug here.)
//
// Instead, reuse the single Dexie instance app.js opens and schemas —
// exposed as window.MyShopDB. app.js is a deferred classic script that
// runs AFTER this module, so window.MyShopDB isn't set yet while this file
// is first evaluated; the calls below only happen later (once syncNow()
// actually runs, via startAutoSync(), which app.js itself only calls once
// it's done booting) — by then window.MyShopDB is set. This proxy defers
// the lookup of window.MyShopDB until each property is actually accessed,
// so it stays safe regardless of script order.
const db = new Proxy({}, {
  get(_target, prop) {
    if (!window.MyShopDB) {
      throw new Error('sync.js: window.MyShopDB is not ready yet — app.js must run and open the database first.');
    }
    return window.MyShopDB[prop];
  }
});

/** Look up a row's uuid from its local Dexie id. */
async function uuidFor(table, localId) {
  if (localId == null) return null;
  const row = await db[table].get(localId);
  return row ? row.uuid : null;
}

/** Look up (or lazily create a placeholder) local id for a remote uuid. */
async function localIdFor(table, uuid) {
  if (!uuid) return null;
  const row = await db[table].where('uuid').equals(uuid).first();
  return row ? row.id : null;
}

// ---------------------------------------------------------------------
// Table configs, pushed/pulled in this order so foreign keys resolve
// (accounts/suppliers/customers/products have none; sales depends on
// accounts+customers; saleItems/purchases/stockMovements depend on
// sales/products).
// ---------------------------------------------------------------------
const TABLES = [
  {
    local: 'accounts', remote: 'accounts', deletable: true,
    toRemote: (a, shopId) => ({
      id: a.uuid, shop_id: shopId, label: a.label, type: a.type,
      number_or_phone: a.numberOrPhone || ''
    }),
    fromRemote: (r) => ({
      uuid: r.id, label: r.label, type: r.type, numberOrPhone: r.number_or_phone, synced: 1
    })
  },
  {
    local: 'suppliers', remote: 'suppliers', deletable: true,
    toRemote: (s, shopId) => ({
      id: s.uuid, shop_id: shopId, name: s.name, phone: s.phone || '',
      tin: s.tin || '', address: s.address || '', balance: s.balance || 0
    }),
    fromRemote: (r) => ({
      uuid: r.id, name: r.name, phone: r.phone, tin: r.tin, address: r.address,
      balance: r.balance, synced: 1
    })
  },
  {
    local: 'customers', remote: 'customers', deletable: true,
    // NOTE: `balance` here is a display cache only — the real value is
    // derived locally as balanceBaseline + sum(that customer's sales), see
    // recomputeCustomerBalances() below. balanceBaseline is what's
    // authoritative and must round-trip through sync.
    toRemote: (c, shopId) => ({
      id: c.uuid, shop_id: shopId, name: c.name, phone: c.phone || '',
      credit_limit: c.creditLimit || 0, due_date: c.dueDate || null,
      balance: c.balance || 0, balance_baseline: c.balanceBaseline || 0
    }),
    fromRemote: (r) => ({
      uuid: r.id, name: r.name, phone: r.phone, creditLimit: r.credit_limit,
      dueDate: r.due_date, balance: r.balance, balanceBaseline: r.balance_baseline || 0, synced: 1
    })
  },
  {
    local: 'products', remote: 'products', deletable: true,
    // NOTE: `quantity` here is a display cache only — the real value is
    // derived locally from the stockMovements ledger, see
    // recomputeProductQuantities() below. Pulling a remote quantity value
    // is intentionally NOT authoritative (fromRemote omits it) so a stale
    // or racy remote figure can never overwrite the locally-derived one.
    toRemote: (p, shopId) => ({
      id: p.uuid, shop_id: shopId, sku: p.sku, name: p.name, brand: p.brand || '',
      category: p.category || 'Other', barcode: p.barcode || '',
      cost_price: p.costPrice || 0, selling_price: p.sellingPrice || 0,
      wholesale_price: p.wholesalePrice ?? null, quantity: p.quantity || 0,
      low_stock_threshold: p.minStock ?? null, compatible_models: p.compatibleModels || '',
      color: p.color || '', supplier: p.supplier || '', notes: p.notes || ''
    }),
    fromRemote: (r) => ({
      uuid: r.id, sku: r.sku, name: r.name, brand: r.brand, category: r.category,
      barcode: r.barcode, costPrice: r.cost_price, sellingPrice: r.selling_price,
      wholesalePrice: r.wholesale_price, minStock: r.low_stock_threshold,
      compatibleModels: r.compatible_models, color: r.color, supplier: r.supplier,
      notes: r.notes, synced: 1
    })
  },
  {
    local: 'sales', remote: 'sales',
    toRemote: async (s, shopId) => ({
      id: s.uuid, shop_id: shopId, date: new Date(s.date).toISOString(),
      payment_account_id: await uuidFor('accounts', s.paymentAccountId),
      payment_account_label: s.paymentAccountLabel || '',
      payer_reference: s.payerReference || '',
      customer_id: await uuidFor('customers', s.customerId),
      customer_name: s.customerName || '',
      discount_type: s.discountType || 'fixed', discount_value: s.discount || 0,
      subtotal: s.subtotal || 0, total: s.total || 0, profit: s.profit || 0
    }),
    fromRemote: async (r) => ({
      uuid: r.id, date: new Date(r.date).getTime(),
      paymentAccountId: await localIdFor('accounts', r.payment_account_id),
      paymentAccountLabel: r.payment_account_label, payerReference: r.payer_reference,
      customerId: await localIdFor('customers', r.customer_id), customerName: r.customer_name,
      discount: r.discount_value, total: r.total, subtotal: r.subtotal, profit: r.profit,
      synced: 1
    })
  },
  {
    local: 'saleItems', remote: 'sale_items',
    toRemote: async (si, shopId) => ({
      id: si.uuid, shop_id: shopId, sale_id: await uuidFor('sales', si.saleId),
      product_id: await uuidFor('products', si.productId), name: si.name,
      unit_price: si.price || 0, unit_cost: si.costAtSale || 0, qty: si.qty || 0
    }),
    fromRemote: async (r) => ({
      uuid: r.id, saleId: await localIdFor('sales', r.sale_id),
      productId: await localIdFor('products', r.product_id), name: r.name,
      price: r.unit_price, costAtSale: r.unit_cost, qty: r.qty, synced: 1
    })
  },
  {
    local: 'purchases', remote: 'purchases',
    toRemote: async (p, shopId) => ({
      id: p.uuid, shop_id: shopId, date: new Date(p.date).toISOString(),
      supplier_id: await localSupplierUuidByName(p.supplier), supplier_name: p.supplier || '',
      invoice: p.invoice || '', product_id: await uuidFor('products', p.productId),
      qty: p.quantity || 0, unit_cost: p.unitCost || 0
    }),
    fromRemote: async (r) => ({
      uuid: r.id, date: new Date(r.date).getTime(), supplier: r.supplier_name || '',
      invoice: r.invoice, productId: await localIdFor('products', r.product_id),
      quantity: r.qty, unitCost: r.unit_cost, synced: 1
    })
  },
  {
    local: 'stockMovements', remote: 'stock_movements',
    toRemote: async (m, shopId) => ({
      id: m.uuid, shop_id: shopId, date: new Date(m.date).toISOString(),
      product_id: await uuidFor('products', m.productId), type: m.type,
      qty_change: m.quantity || 0, reason: m.reason || '', note: m.note || ''
    }),
    fromRemote: async (r) => ({
      uuid: r.id, date: new Date(r.date).getTime(),
      productId: await localIdFor('products', r.product_id), type: r.type,
      quantity: r.qty_change, reason: r.reason, note: r.note, synced: 1
    })
  }
];

// purchases.supplier is free text on the app side, not a supplier_id — try
// to resolve it to a saved supplier's uuid by name so reporting joins work
// remotely; falls back to null (supplier_name still carries the text).
async function localSupplierUuidByName(name) {
  if (!name) return null;
  const row = await db.suppliers.where('name').equalsIgnoreCase(name).first();
  return row ? row.uuid : null;
}

// ---------------------------------------------------------------------
// Push: local dirty rows -> Supabase
// ---------------------------------------------------------------------
async function pushTable(cfg, shopId) {
  const dirty = await db[cfg.local].where('synced').equals(0).toArray();
  for (const row of dirty) {
    try {
      if (row.deleted) {
        if (cfg.deletable && row.uuid) {
          // Soft-delete remotely (tombstone) instead of a hard DELETE.
          // A hard delete makes the row vanish from pullTable's
          // `updated_at`-based query entirely, so OTHER devices would never
          // learn the row was removed and would keep it (or even resurrect
          // it) forever. Upserting `deleted: true` keeps a row other
          // devices' pulls will actually see, so they can remove it too.
          const payload = await cfg.toRemote(row, shopId);
          payload.deleted = true;
          const { error } = await supabase.from(cfg.remote).upsert(payload);
          if (error) { console.warn(`[sync] push (delete) ${cfg.local} failed`, error.message); continue; }
        }
        await db[cfg.local].delete(row.id); // local copy no longer needed once the tombstone is pushed
        continue;
      }
      const payload = await cfg.toRemote(row, shopId);
      if (cfg.deletable) payload.deleted = false;
      const { error } = await supabase.from(cfg.remote).upsert(payload);
      if (error) { console.warn(`[sync] push ${cfg.local} failed`, error.message); continue; }
      await db[cfg.local].update(row.id, { synced: 1 });
    } catch (err) {
      console.warn(`[sync] push ${cfg.local} error`, err);
    }
  }
}

// ---------------------------------------------------------------------
// Pull: remote rows changed since last sync -> Dexie
// ---------------------------------------------------------------------
async function pullTable(cfg, shopId) {
  const lastSyncKey = `myshop:lastSync:${cfg.local}`;
  const since = localStorage.getItem(lastSyncKey) || '1970-01-01T00:00:00Z';
  const { data, error } = await supabase
    .from(cfg.remote)
    .select('*')
    .eq('shop_id', shopId)
    .gt('updated_at', since);

  if (error) { console.warn(`[sync] pull ${cfg.local} failed`, error.message); return []; }
  if (!data || !data.length) return [];

  let maxUpdated = since;
  for (const remoteRow of data) {
    const existing = await db[cfg.local].where('uuid').equals(remoteRow.id).first();
    if (cfg.deletable && remoteRow.deleted) {
      // Tombstone from another device — remove locally too, if present.
      if (existing) await db[cfg.local].delete(existing.id);
    } else {
      const mapped = await cfg.fromRemote(remoteRow);
      if (existing) {
        await db[cfg.local].update(existing.id, mapped);
      } else {
        // products' fromRemote deliberately omits `quantity` (see the NOTE
        // above products' cfg) so that updating an EXISTING local row never
        // clobbers its locally-derived quantity with a stale/racy remote
        // figure. But that same omission is wrong for a row that doesn't
        // exist locally yet (new device, or a product created on another
        // device): db.add() would then insert it with quantity literally
        // undefined, which shows as "undefined in stock" in the UI until
        // (if ever) a stockMovements row for it happens to sync down too.
        // Default it to 0 here — recomputeProductQuantities() below will
        // immediately correct it from the ledger for any product touched
        // by movements pulled in this same sync pass.
        if (cfg.local === 'products' && mapped.quantity === undefined) mapped.quantity = 0;
        await db[cfg.local].add(mapped);
      }
    }
    if (remoteRow.updated_at > maxUpdated) maxUpdated = remoteRow.updated_at;
  }
  localStorage.setItem(lastSyncKey, maxUpdated);
  return data;
}

// ---------------------------------------------------------------------
// Derived-value recompute: mirrors recomputeProductQty() / 
// recomputeCustomerBalance() in app.js. product.quantity and
// customer.balance are caches derived from additive, conflict-free rows
// (stockMovements and sales respectively) — never trusted directly from a
// synced row — so a concurrent edit on another device can't clobber them.
// Run this after every pull so newly-arrived movements/sales from other
// devices are reflected immediately.
// ---------------------------------------------------------------------
async function recomputeProductQuantities(productIds) {
  for (const id of productIds) {
    const moves = await db.stockMovements.where('productId').equals(id).toArray();
    const qty = moves.reduce((s, m) => s + (m.quantity || 0), 0);
    const p = await db.products.get(id);
    if (p && p.quantity !== qty) await db.products.update(id, { quantity: qty, synced: 1 });
  }
}

async function recomputeCustomerBalances(customerIds) {
  for (const id of customerIds) {
    const customer = await db.customers.get(id);
    if (!customer) continue;
    const sales = await db.sales.where('customerId').equals(id).toArray();
    const salesSum = sales.reduce((s, x) => s + (x.total || 0), 0);
    const balance = (customer.balanceBaseline || 0) + salesSum;
    if (customer.balance !== balance) await db.customers.update(id, { balance, synced: 1 });
  }
}

// ---------------------------------------------------------------------
// Shop settings: a single Dexie row (db.settings, key 'shop') maps to a
// single row in the remote `shops` table (auto-created by the
// handle_new_user trigger on signup) — handled separately from the
// per-row TABLES above since there's exactly one row, not a collection.
// ---------------------------------------------------------------------
async function syncShopSettings(shopId) {
  const local = await db.settings.get('shop');

  // Brand-new device: no local settings row exists at all yet. Pull
  // whatever's on the server if it's already onboarded, instead of
  // silently doing nothing and letting ensureDefaults() create blank
  // local defaults that mask the real shop data.
  if (!local) {
    const { data: remote } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (remote && remote.onboarded) {
      await db.settings.put({
        key: 'shop', name: remote.name, address: remote.address, phone: remote.phone,
        tin: remote.tin, lowStockDefault: remote.low_stock_default,
        allowNegativeStock: remote.allow_negative_stock, receiptHeader: remote.receipt_header,
        receiptFooter: remote.receipt_footer, onboarded: remote.onboarded
      });
    }
    return;
  }

  // First time this device has seen this shop (fresh install/new device,
  // hasn't been through onboarding here yet) — pull whatever's already on
  // the server instead of overwriting it with blank local defaults.
  if (!local.onboarded) {
    const { data: remote } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (remote && remote.onboarded) {
      await db.settings.put({
        key: 'shop', name: remote.name, address: remote.address, phone: remote.phone,
        tin: remote.tin, lowStockDefault: remote.low_stock_default,
        allowNegativeStock: remote.allow_negative_stock, receiptHeader: remote.receipt_header,
        receiptFooter: remote.receipt_footer, onboarded: remote.onboarded
      });
      return;
    }
  }

  // Otherwise this device is the source of truth for settings — push up.
  // (Simple last-write-wins; fine for the common case of one owner editing
  // shop settings. If multiple staff edit settings concurrently on
  // different devices, whichever syncs last wins.)
  await supabase.from('shops').update({
    name: local.name, address: local.address || '', phone: local.phone,
    tin: local.tin, low_stock_default: local.lowStockDefault,
    allow_negative_stock: local.allowNegativeStock, receipt_header: local.receiptHeader,
    receipt_footer: local.receiptFooter, onboarded: local.onboarded
  }).eq('id', shopId);
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------
let syncing = false;

export async function syncNow() {
  if (syncing || !navigator.onLine) return;
  const shopId = await getShopId();
  if (!shopId) return; // not signed in yet
  syncing = true;
  try {
    await syncShopSettings(shopId);
    for (const cfg of TABLES) await pushTable(cfg, shopId);

    const touchedProducts = new Set();
    const touchedCustomers = new Set();
    for (const cfg of TABLES) {
      const pulled = await pullTable(cfg, shopId);
      if (!pulled || !pulled.length) continue;
      if (cfg.local === 'stockMovements') {
        for (const r of pulled) {
          const localId = await localIdFor('products', r.product_id);
          if (localId != null) touchedProducts.add(localId);
        }
      } else if (cfg.local === 'sales') {
        for (const r of pulled) {
          const localId = await localIdFor('customers', r.customer_id);
          if (localId != null) touchedCustomers.add(localId);
        }
      }
    }
    if (touchedProducts.size) await recomputeProductQuantities(touchedProducts);
    if (touchedCustomers.size) await recomputeCustomerBalances(touchedCustomers);
  } finally {
    syncing = false;
  }
}

let started = false;
export function startAutoSync() {
  if (started) return;
  started = true;
  syncNow();
  window.addEventListener('online', syncNow);
  setInterval(syncNow, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
}

window.MyShopSync = { syncNow, startAutoSync };
