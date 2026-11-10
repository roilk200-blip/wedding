/**
 * Weekly wedding update — Google Apps Script.
 * Runs every Saturday evening from Roi's Google account, reads the app's data from Firestore
 * and emails a short summary to Roi and to the partner email saved in the app's settings.
 *
 * One-time setup (see weekly/README.md): paste this file and appsscript.json into a new
 * Apps Script project, run `setup` once and approve, then `sendNow` to see a sample.
 */
const PROJECT = 'wedding-roi-neta';
const APP_URL = 'https://roilk200-blip.github.io/wedding/';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/`;
const STAGES = [['m12', 365], ['m9', 273], ['m6', 182], ['m3', 91], ['m1', 30], ['w1', 7], ['d0', 0], ['after', -14]];
const DAY = 864e5;

/* Run once: creates the Saturday-evening trigger (and removes older copies). */
function setup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'weekly').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('weekly').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(20).nearMinute(40).inTimezone('Asia/Jerusalem').create();
  Logger.log('נוצר תזמון: כל מוצאי שבת בסביבות 20:40');
}
/* Sends the update right now (for testing). */
function sendNow() { weekly(); }

function weekly() {
  const D = loadAll();
  const html = buildEmail(D);
  const me = Session.getEffectiveUser().getEmail();
  const partner = String((D.settings.inviteEmail || '')).trim();
  const to = [me, /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(partner) && partner !== me ? partner : ''].filter(Boolean).join(',');
  MailApp.sendEmail({ to, subject: html.subject, htmlBody: html.body, name: 'החתונה שלנו' });
}

/* ---------- Firestore ---------- */
function fsGet(path) {
  const res = UrlFetchApp.fetch(BASE + path, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': PROJECT },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 404) return null;
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}
function val(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  if ('mapValue' in v) return obj(v.mapValue.fields || {});
  return null;
}
function obj(fields) { const o = {}; Object.keys(fields).forEach(k => { o[k] = val(fields[k]); }); return o; }
function list(coll) {
  const out = []; let token = '';
  do {
    const r = fsGet(coll + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    ((r && r.documents) || []).forEach(d => { const o = obj(d.fields || {}); o.id = d.name.split('/').pop(); if (!o.archived) out.push(o); });
    token = r && r.nextPageToken || '';
  } while (token);
  return out;
}
function loadAll() {
  const s = fsGet('settings/main');
  return {
    settings: s ? obj(s.fields || {}) : {},
    tasks: list('tasks'), expenses: list('expenses'), meetings: list('meetings'),
    venues: list('venues'), vendors: list('vendors'), guests: list('guests'),
  };
}

/* ---------- same rules as the app ---------- */
const num = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
function today() { const d = new Date(Utilities.formatDate(new Date(), 'Asia/Jerusalem', "yyyy-MM-dd'T'00:00:00")); return d; }
function parseD(s) { if (!s) return null; const d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? null : d; }
function schedule(settings) {
  const S = {}; const wd = parseD(settings.date); if (!wd) return S;
  const t0 = today();
  const norm = STAGES.map(([k, o]) => [k, new Date(wd.getTime() - o * DAY)]);
  const past = norm.filter(([, d]) => d < t0), ahead = norm.filter(([, d]) => d >= t0);
  const end = ahead.length ? ahead[0][1] : wd; const win = Math.max(0, end - t0);
  past.forEach(([k], i) => { const off = Math.round(win * (i + 1) / (past.length + 1) / DAY); S[k] = new Date(t0.getTime() + off * DAY); });
  ahead.forEach(([k, d]) => { S[k] = d; });
  return S;
}
const fmt = d => Utilities.formatDate(d, 'Asia/Jerusalem', 'd.M');
const ils = n => '₪' + Math.round(n).toLocaleString('en-US');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cost = e => num(e.actual) > 0 ? num(e.actual) : num(e.planned);
const insts = e => Array.isArray(e.installments) ? e.installments : [];

function buildEmail(D) {
  const st = D.settings, t0 = today(), wk = new Date(t0.getTime() + 7 * DAY), two = new Date(t0.getTime() + 14 * DAY);
  const S = schedule(st);
  const due = t => parseD(t.due) || (t.stage && S[t.stage]) || null;
  const open = D.tasks.filter(t => t.status !== 'done');
  const late = open.filter(t => { const d = due(t); return d && d < t0; }).sort((a, b) => due(a) - due(b));
  const week = open.filter(t => { const d = due(t); return d && d >= t0 && d < wk; }).sort((a, b) => due(a) - due(b));
  const meetName = m => { const v = m.vendorId ? D.vendors.find(x => x.id === m.vendorId) : D.venues.find(x => x.id === m.venueId); return (v && v.name) || m.withName || m.venueName || ''; };
  const meets = D.meetings.filter(m => { const d = parseD(m.date); return d && d >= t0 && d < wk; }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const pays = [];
  D.expenses.forEach(e => insts(e).forEach(i => { const d = parseD(i.date); if (!i.paid && d && d < two) pays.push({ name: e.name, amount: num(i.amount), d, late: d < t0 }); }));
  pays.sort((a, b) => a.d - b.d);
  const caps = st.caps || {}; const over = [];
  Object.keys(caps).forEach(c => { const exp = D.expenses.filter(e => e.cat === c).reduce((a, e) => a + cost(e), 0); if (num(caps[c]) && exp > num(caps[c])) over.push({ c, exp, cap: num(caps[c]) }); });
  const done = D.tasks.length - open.length;
  const people = D.guests.reduce((a, g) => a + (num(g.count) || 1), 0);
  const yes = D.guests.filter(g => g.rsvp === 'yes').reduce((a, g) => a + (num(g.coming) || num(g.count) || 1), 0);
  const pend = D.guests.filter(g => !g.rsvp || g.rsvp === 'pending').length;
  const wd = parseD(st.date); const days = wd ? Math.round((wd - t0) / DAY) : null;

  const sec = (title, rows, emptyText) => `<h3 style="margin:18px 0 6px;font-size:16px;color:#2E5E4C">${title}</h3>` +
    (rows.length ? `<ul style="margin:0;padding:0 18px 0 0">${rows.map(r => `<li style="margin:3px 0">${r}</li>`).join('')}</ul>` : `<p style="margin:0;color:#5C6A62">${emptyText}</p>`);
  const body = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1D2621;max-width:560px">
    <p style="margin:0 0 4px;font-size:20px"><b>העדכון השבועי לחתונה</b></p>
    <p style="margin:0;color:#5C6A62">${days != null ? (days > 0 ? `עוד <b>${days}</b> ימים לחתונה` : days === 0 ? 'היום החתונה!' : 'אחרי החתונה') : 'עוד לא נקבע תאריך'}</p>
    ${sec('באיחור', late.slice(0, 12).map(t => `${esc(t.title)} <span style="color:#B03224">(${fmt(due(t))})</span>`), 'אין משימות באיחור.')}
    ${sec('השבוע', week.map(t => `${esc(t.title)} <span style="color:#5C6A62">(${fmt(due(t))})</span>`), wd ? 'אין משימות שמתוכננות לשבוע הקרוב.' : 'בלי תאריך חתונה אין תאריכי יעד. אפשר לקבוע בהגדרות.')}
    ${meets.length ? sec('פגישות השבוע', meets.map(m => `${esc(meetName(m))}: ${fmt(parseD(m.date))} ב-${esc(m.time)}`), '') : ''}
    ${sec('תשלומים בשבועיים הקרובים', pays.map(p => `${esc(p.name)}: ${ils(p.amount)} · ${fmt(p.d)}${p.late ? ' <span style="color:#B03224">(עבר המועד)</span>' : ''}`), 'אין תשלומים קרובים.')}
    ${over.length ? sec('חריגות מתקרה', over.map(o => `${esc(o.c)}: ${ils(o.exp)} מתוך ${ils(o.cap)}`), '') : ''}
    <h3 style="margin:18px 0 6px;font-size:16px;color:#2E5E4C">התקדמות</h3>
    <p style="margin:0">משימות: ${done} מתוך ${D.tasks.length} בוצעו · מוזמנים: ${people}${yes ? ` · אישרו ${yes}` : ''} · ${pend} רשומות עוד לא ענו</p>
    <p style="margin:22px 0 0"><a href="${APP_URL}" style="background:#2E5E4C;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">לפתוח את האפליקציה</a></p>
  </div>`;
  const subject = `החתונה: ${late.length ? late.length + ' באיחור · ' : ''}${week.length} השבוע${pays.length ? ' · ' + pays.length + ' תשלומים קרובים' : ''}`;
  return { subject, body };
}
