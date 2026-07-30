/* ---------------------------------------------------------------------
   sync.js
   Offline-first sync between Dexie (local, source of truth for the UI)
   and Supabase (remote, source of truth across devices).

   Load order in index.html:
     <script src="dexie.min.js"></script>
     <script type="module" src="supabase-client.js"></script>
     <script type="module" src="sync.js"></script>
     <script src="app.js"></script>

   sync.js reads the same Dexie database app.js uses ('DuketDB'), so it
   doesn't need app.js to export anything. It exposes window.DuketSync
   = { syncNow, startAutoSync } for app.js (a classic script) to call.
   --------------------------------------------------------------------- */

import { supabase, getShopId } from './supabase-client.js';

const db = new Dexie('DuketDB'); // same DB app.js opened — Dexie shares connections by name
// NOTE: this file does not declare .version()/.stores() itself; app.js
// (loaded after this file) owns the schema. Dexie queues operations until
// the DB is actually open, so this is safe regardless of script order.

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
    local: 'accounts', remote: 'accounts',
    toRemote: (a, shopId) => ({
      id: a.uuid, shop_id: shopId, label: a.label, type: a.type,
      number_or_phone: a.numberOrPhone || ''
    }),
    fromRemote: (r) => ({
      uuid: r.id, label: r.label, type: r.type, numberOrPhone: r.number_or_phone, synced: 1
    })
  },
  {
    local: 'suppliers', remote: 'suppliers',
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
    local: 'customers', remote: 'customers',
    toRemote: (c, shopId) => ({
      id: c.uuid, shop_id: shopId, name: c.name, phone: c.phone || '',
      credit_limit: c.creditLimit || 0, due_date: c.dueDate || null, balance: c.balance || 0
    }),
    fromRemote: (r) => ({
      uuid: r.id, name: r.name, phone: r.phone, creditLimit: r.credit_limit,
      dueDate: r.due_date, balance: r.balance, synced: 1
    })
  },
  {
    local: 'products', remote: 'products',
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
      wholesalePrice: r.wholesale_price, quantity: r.quantity, minStock: r.low_stock_threshold,
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
        if (row.id != null) await supabase.from(cfg.remote).delete().eq('id', row.uuid);
        await db[cfg.local].delete(row.id); // fully remove locally now that it's synced
        continue;
      }
      const payload = await cfg.toRemote(row, shopId);
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
  const lastSyncKey = `duket:lastSync:${cfg.local}`;
  const since = localStorage.getItem(lastSyncKey) || '1970-01-01T00:00:00Z';
  const { data, error } = await supabase
    .from(cfg.remote)
    .select('*')
    .eq('shop_id', shopId)
    .gt('updated_at', since);

  if (error) { console.warn(`[sync] pull ${cfg.local} failed`, error.message); return; }
  if (!data || !data.length) return;

  let maxUpdated = since;
  for (const remoteRow of data) {
    const mapped = await cfg.fromRemote(remoteRow);
    const existing = await db[cfg.local].where('uuid').equals(remoteRow.id).first();
    if (existing) await db[cfg.local].update(existing.id, mapped);
    else await db[cfg.local].add(mapped);
    if (remoteRow.updated_at > maxUpdated) maxUpdated = remoteRow.updated_at;
  }
  localStorage.setItem(lastSyncKey, maxUpdated);
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
    for (const cfg of TABLES) await pullTable(cfg, shopId);
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

window.DuketSync = { syncNow, startAutoSync };
