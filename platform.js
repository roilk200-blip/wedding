/* Platform layer for the standalone app.
   The app was first built inside Claude, where it talked to `window.claude` (db, user, mcp, assets, permissions).
   This module provides the same surface on top of Firebase (login + Firestore) and Google APIs
   (Calendar, Drive), so the app code stays almost unchanged. */
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let fs;
try { fs = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { fs = initializeFirestore(app, { ignoreUndefinedProperties: true }); }

/* ---------- login gate ---------- */
const gate = document.getElementById('gate');
const gateMsg = document.getElementById('gateMsg');
const gateBtn = document.getElementById('gateBtn');
const gateOut = document.getElementById('gateOut');
const showGate = (msg, opts = {}) => {
  gate.hidden = false;
  gateMsg.textContent = msg || '';
  gateBtn.hidden = !!opts.noButton;
  gateOut.hidden = !opts.signOut;
};
const hideGate = () => { gate.hidden = true; };

let resolveUser;
const userReady = new Promise(r => { resolveUser = r; });
let currentUser = null;

async function login() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  gateMsg.textContent = 'מתחברים…';
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    const c = e && e.code || '';
    if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment' || c === 'auth/cancelled-popup-request') {
      try { await signInWithRedirect(auth, provider); return; } catch (_) {}
    }
    if (c === 'auth/popup-closed-by-user') { gateMsg.textContent = ''; return; }
    gateMsg.textContent = 'ההתחברות לא הצליחה. נסו שוב.';
  }
}
gateBtn.addEventListener('click', login);
gateOut.addEventListener('click', () => signOut(auth));

setPersistence(auth, browserLocalPersistence).catch(() => {});
getRedirectResult(auth).catch(() => {});
let firstAuth = true;
onAuthStateChanged(auth, u => {
  if (u) {
    currentUser = u;
    hideGate();
    resolveUser(u);
    document.dispatchEvent(new CustomEvent('wedding:user', { detail: { name: u.displayName || '', email: u.email || '', photo: u.photoURL || '' } }));
  } else {
    if (!firstAuth && currentUser) { location.reload(); return; }
    showGate('');
  }
  firstAuth = false;
});

/* Firestore denies anyone who is not Roi or Neta: show that clearly instead of an empty app. */
let deniedShown = false;
function onDenied() {
  if (deniedShown) return; deniedShown = true;
  showGate(`החשבון ${currentUser && currentUser.email || ''} לא מורשה להיכנס לאפליקציה הזו. מתחברים עם החשבון של רועי או של נטע.`, { noButton: true, signOut: true });
}

/* ---------- db adapter (same shape the app already uses) ---------- */
const mapErr = e => {
  const c = e && e.code || '';
  const code = c === 'permission-denied' ? 'invalid_argument' : c === 'resource-exhausted' ? 'resource_exhausted' : c.replace(/-/g, '_') || 'unknown';
  if (c === 'permission-denied') onDenied();
  const err = new Error(e && e.message || code); err.code = code; return err;
};
const wrapDoc = (d, metadata) => ({ id: d.id, exists: d.exists(), data: () => d.data(), metadata: { fromCache: metadata.fromCache } });
const docRef = path => { const [c, id] = path.split('/'); return doc(fs, c, id); };
const docApi = ref => ({
  id: ref.id,
  onSnapshot(next, err) { return onSnapshot(ref, { includeMetadataChanges: true }, s => next(wrapDoc(s, s.metadata)), e => err && err(mapErr(e))); },
  set: d => setDoc(ref, d).catch(e => { throw mapErr(e); }),
  update: d => updateDoc(ref, d).catch(e => { throw mapErr(e); }),
  delete: () => deleteDoc(ref).catch(e => { throw mapErr(e); }),
});
const db = {
  collection(c) {
    const col = collection(fs, c);
    return {
      onSnapshot(next, err) {
        return onSnapshot(col, { includeMetadataChanges: true }, s => next({ docs: s.docs.map(d => wrapDoc(d, s.metadata)), size: s.size, metadata: { fromCache: s.metadata.fromCache } }), e => err && err(mapErr(e)));
      },
      add: d => addDoc(col, d).then(r => ({ id: r.id })).catch(e => { throw mapErr(e); }),
      doc: id => docApi(id ? doc(fs, c, id) : doc(col)),
    };
  },
  doc: path => docApi(docRef(path)),
};

/* ---------- Google APIs (Calendar + Drive) with a short-lived token ---------- */
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'wed-gtoken';
let token = null;
try { const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null'); if (t && t.exp > Date.now() + 60e3) token = t; } catch (_) {}
let gisReady = null;
function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.oauth2) return res();
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(); s.onerror = () => { gisReady = null; rej(new Error('gis')); };
    document.head.appendChild(s);
  });
  return gisReady;
}
const toolErr = (code, message) => { const e = new Error(message || code); e.code = code; return e; };
async function getToken(interactive) {
  if (token && token.exp > Date.now() + 60e3) return token.value;
  if (!interactive) throw toolErr('consent_required');
  const cid = firebaseConfig.oauthClientId;
  if (!cid) throw toolErr('server_not_connected', 'החיבור לגוגל עוד לא הוגדר');
  await loadGis();
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: cid, scope: SCOPES, hint: currentUser && currentUser.email || undefined,
      callback: r => {
        if (r.error || !r.access_token) return rej(toolErr('consent_required', r.error));
        token = { value: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch (_) {}
        res(token.value);
      },
      error_callback: () => rej(toolErr('consent_required')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}
let lastGesture = 0;
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, () => { lastGesture = Date.now(); }, true));
async function gfetch(url, opts = {}, raw = false) {
  const t = await getToken(Date.now() - lastGesture < 5000);
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
  if (r.status === 401) { token = null; try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) {} throw toolErr('needs_reauth'); }
  if (!r.ok) { let m = ''; try { m = (await r.json()).error.message; } catch (_) {} throw toolErr('tool_error', m || ('HTTP ' + r.status)); }
  if (raw) return r;
  return r.status === 204 ? {} : r.json();
}
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TZ = 'Asia/Jerusalem';
const calBody = a => {
  const b = {};
  if (a.summary !== undefined) b.summary = a.summary;
  if (a.description !== undefined) b.description = a.description;
  if (a.location !== undefined) b.location = a.location;
  if (a.startTime) b.start = { dateTime: a.startTime, timeZone: TZ };
  if (a.endTime) b.end = { dateTime: a.endTime, timeZone: TZ };
  if (a.overrideReminders) b.reminders = { useDefault: false, overrides: a.overrideReminders };
  if (a.attendees) b.attendees = a.attendees;
  return b;
};
const b64 = buf => { const u8 = new Uint8Array(buf); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
/* The app speaks the Drive connector's query dialect; translate it to the Drive v3 API. */
const driveQ = q => String(q || '').replace(/\btitle\s*=/g, 'name =').replace(/parentId\s*=\s*'([^']+)'/g, "'$1' in parents");
const TOOLS = {
  'Google Calendar': {
    async create_event(a) { const r = await gfetch(CAL + '?sendUpdates=all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calBody(a)) }); return { payload: { id: r.id, htmlLink: r.htmlLink } }; },
    async update_event(a) {
      const b = calBody(a);
      if (a.addedAttendees || a.removedAttendeeEmails) {
        const cur = await gfetch(CAL + '/' + encodeURIComponent(a.eventId));
        let list = (cur.attendees || []).filter(x => !(a.removedAttendeeEmails || []).includes(x.email));
        (a.addedAttendees || []).forEach(x => { if (!list.some(y => y.email === x.email)) list.push(x); });
        b.attendees = list;
      }
      const r = await gfetch(CAL + '/' + encodeURIComponent(a.eventId) + '?sendUpdates=all', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return { payload: { id: r.id, htmlLink: r.htmlLink } };
    },
    async delete_event(a) { await gfetch(CAL + '/' + encodeURIComponent(a.eventId) + '?sendUpdates=all', { method: 'DELETE' }); return { payload: {} }; },
  },
  'Google Drive': {
    async search_files(a) {
      const p = new URLSearchParams({ q: driveQ(a.query), pageSize: String(a.pageSize || 10), fields: 'files(id,name,mimeType,modifiedTime)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      if (a.orderBy) p.set('orderBy', a.orderBy);
      const r = await gfetch('https://www.googleapis.com/drive/v3/files?' + p);
      return { payload: { files: (r.files || []).map(f => ({ id: f.id, title: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime })) } };
    },
    async download_file_content(a) {
      const id = encodeURIComponent(a.fileId);
      const url = a.exportMimeType ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(a.exportMimeType)}` : `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
      const r = await gfetch(url, {}, true);
      return { payload: { content: b64(await r.arrayBuffer()), mimeType: r.headers.get('Content-Type') || '' } };
    },
  },
};
const mcp = {
  async callTool(server, tool, args) {
    const fn = TOOLS[server] && TOOLS[server][tool];
    if (!fn) throw toolErr('not_in_manifest');
    return fn(args || {});
  },
};
const permissions = { state: async () => (token && token.exp > Date.now() + 60e3 ? 'granted' : 'prompt') };

/* ---------- file attachments: kept in the couple's Google Drive ---------- */
const FOLDER_KEY = 'wed-files-folder';
async function filesFolder() {
  try { const f = localStorage.getItem(FOLDER_KEY); if (f) return f; } catch (_) {}
  const q = new URLSearchParams({ q: "name = 'חתונה - קבצים מהאפליקציה' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", fields: 'files(id)' });
  const r = await gfetch('https://www.googleapis.com/drive/v3/files?' + q);
  let id = r.files && r.files[0] && r.files[0].id;
  if (!id) id = (await gfetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'חתונה - קבצים מהאפליקציה', mimeType: 'application/vnd.google-apps.folder' }) })).id;
  try { localStorage.setItem(FOLDER_KEY, id); } catch (_) {}
  return id;
}
const assets = {
  async upload(file) {
    if (file.size > 20 * 1024 * 1024) throw toolErr('too_large');
    const parent = await filesFolder();
    const meta = { name: file.name, parents: [parent] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', file);
    const r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,mimeType,webViewLink', { method: 'POST', body: form });
    return { id: r.id, contentType: r.mimeType, link: r.webViewLink };
  },
};

window.claude = {
  async use(name) {
    if (name === 'db') { await userReady; return db; }
    if (name === 'user') { await userReady; return { can: async () => true }; }
    if (name === 'mcp') { await userReady; return mcp; }
    if (name === 'assets') { await userReady; return assets; }
    if (name === 'permissions') return permissions;
    return null;
  },
};
window.weddingPlatform = { signOut: () => signOut(auth), user: () => currentUser && { name: currentUser.displayName || '', email: currentUser.email || '' } };
