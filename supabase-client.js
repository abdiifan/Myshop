/* ---------------------------------------------------------------------
   supabase-client.js
   Loads the Supabase client and exposes small auth helpers.
   Include this as a <script type="module"> AFTER dexie.min.js and
   BEFORE app.js in index.html, or import it from app.js if app.js is
   also converted to a module.
   --------------------------------------------------------------------- */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---- fill these in with your project's values (Project Settings > API) ----

// -----------------------------------------------------------------------

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,     // keeps the session in localStorage across app loads
    autoRefreshToken: true,
    // Password-reset links land back on this app with a recovery token in
    // the URL, so this needs to be true to pick it up (fires the
    // PASSWORD_RECOVERY auth event below). We're still not doing OAuth
    // redirect flows, just this one email-link case.
    detectSessionInUrl: true
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

/** Sends the user a "reset your password" email. They land back on this
 *  app URL with a recovery token, which fires the PASSWORD_RECOVERY event
 *  in onAuthChange below so app.js can show a "set a new password" form. */
export async function resetPasswordForEmail(email) {
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname
  });
  return { data, error };
}

/** Sets a new password for the CURRENTLY signed-in user — used both for
 *  the "reset link → new password" flow (PASSWORD_RECOVERY session) and
 *  for a plain "change my password" option while already signed in. */
export async function updatePassword(newPassword) {
  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  return { data, error };
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
  const cached = localStorage.getItem('myshop:shopId');
  if (cached && !forceRefresh) {
    _cachedShopId = cached;
    return cached;
  }

  if (!navigator.onLine) return cached || null;

  // IMPORTANT: use maybeSingle(), not single(). single() errors both when
  // the row genuinely doesn't exist AND when something else goes wrong
  // (e.g. an RLS policy silently blocking the read), which used to make
  // "this account really has no shop yet" indistinguishable from "the
  // query broke" — both collapsed into this function returning null,
  // which is exactly how a second device could silently treat an existing
  // shop as brand-new and re-onboard with blank data instead of pulling
  // the real thing.
  //
  // Now: a real query error is THROWN (never silently swallowed here), and
  // only a genuinely empty result (no error, no row) returns null. Callers
  // that need to tell "definitely no shop" apart from "couldn't check
  // right now" — see attemptInitialSync() in app.js — depend on this.
  const { data, error } = await supabase
    .from('shop_members')
    .select('shop_id')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not verify shop membership: ${error.message}`);
  }
  if (!data) return null; // genuinely not linked to any shop yet

  _cachedShopId = data.shop_id;
  localStorage.setItem('myshop:shopId', data.shop_id);
  return data.shop_id;
}

export function clearShopIdCache() {
  _cachedShopId = null;
  localStorage.removeItem('myshop:shopId');
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
window.MyShopAuth = {
  supabase, signUp, signIn, signOut, getSession, getShopId, onAuthChange,
  resetPasswordForEmail, updatePassword
};
