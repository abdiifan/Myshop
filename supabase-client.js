/* ---------------------------------------------------------------------
   supabase-client.js
   Loads the Supabase client and exposes small auth helpers.
   Include this as a <script type="module"> AFTER dexie.min.js and
   BEFORE app.js in index.html, or import it from app.js if app.js is
   also converted to a module.
   --------------------------------------------------------------------- */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---- fill these in with your project's values (Project Settings > API) ----
const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
// -----------------------------------------------------------------------

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,     // keeps the session in localStorage across app loads
    autoRefreshToken: true,
    detectSessionInUrl: false // Duket is a PWA, not doing OAuth redirect flows
  }
});

/** Create a new shop owner account. The `handle_new_user` trigger in
 *  schema.sql automatically creates their shop + owner membership + default
 *  accounts server-side, so nothing else needs to happen here. */
export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  return { data, error };
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error };
}

export async function signOut() {
  return supabase.auth.signOut();
}

/** Returns the logged-in user's session, or null if signed out.
 *  Works fully offline once a session has been established once, since
 *  supabase-js reads the cached session from localStorage first. */
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

/** Every business row needs shop_id. Cache it after first lookup so we're
 *  not hitting the network for it on every sync tick. */
let _cachedShopId = null;

export async function getShopId({ forceRefresh = false } = {}) {
  if (_cachedShopId && !forceRefresh) return _cachedShopId;
  const session = await getSession();
  if (!session) return null;

  // Try local cache first (works offline after first successful login)
  const cached = localStorage.getItem('duket:shopId');
  if (cached && !forceRefresh) {
    _cachedShopId = cached;
    return cached;
  }

  if (!navigator.onLine) return cached || null;

  const { data, error } = await supabase
    .from('shop_members')
    .select('shop_id')
    .eq('user_id', session.user.id)
    .single();

  if (error || !data) return null;
  _cachedShopId = data.shop_id;
  localStorage.setItem('duket:shopId', data.shop_id);
  return data.shop_id;
}

export function clearShopIdCache() {
  _cachedShopId = null;
  localStorage.removeItem('duket:shopId');
}

/** Listen for sign-in / sign-out so app.js can show/hide the login screen
 *  and kick off an initial sync. */
export function onAuthChange(callback) {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') clearShopIdCache();
    callback(event, session);
  });
}

// app.js is a classic (non-module) script, so bridge these helpers onto
// window for it to call. sync.js does the same for the sync functions.
window.DuketAuth = {
  supabase, signUp, signIn, signOut, getSession, getShopId, onAuthChange
};
