/**
 * Mariam & Chris — wedding site backend.
 *
 * This script lives inside the RSVP Google Sheet (Extensions → Apps Script).
 * It does three jobs for the website:
 *   1. saves each RSVP as a row in the "RSVPs" tab
 *   2. gives the admin dashboard the guest list (password protected)
 *   3. sends email blasts from your Gmail, and text blasts through Twilio
 *
 * Setup is in README.md. Settings live in Project Settings → Script properties:
 *   ADMIN_PASSWORD   (required)  password for the admin dashboard, 8+ characters
 *   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM   (optional)  only needed for texts
 */

var RSVP_SHEET = 'RSVPs';
var GUEST_SHEET = 'Guests';
var LOG_SHEET = 'Blast log';
var RSVP_HEADERS = ['Timestamp', 'Name', 'Email', 'Phone', 'Address', 'Attending', 'Party size', 'Note'];
var GUEST_HEADERS = ['Name', 'Email', 'Phone'];
var LOG_HEADERS = ['Timestamp', 'Channel', 'Audience', 'Subject', 'Sent', 'Failed'];
var SENDER_NAME = 'Mariam & Chris';
var MAX_PARTY = 2;

/** Run this once from the editor: it creates the tabs and headers. */
function setup() {
  sheet_(RSVP_SHEET, RSVP_HEADERS);
  sheet_(GUEST_SHEET, GUEST_HEADERS);
  sheet_(LOG_SHEET, LOG_HEADERS);
}

function doGet() {
  return json_({ ok: true, service: 'mariam-and-chris' });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = route_(req);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return json_(out);
}

function route_(req) {
  switch (req.action) {
    case 'rsvp':
      return saveRsvp_(req);
    case 'login':
      requireAdmin_(req);
      return { ok: true };
    case 'guests':
      requireAdmin_(req);
      return listAll_();
    case 'blast':
      requireAdmin_(req);
      return sendBlast_(req);
    default:
      throw new Error('Unknown action');
  }
}

/* ---------- RSVP ---------- */

function saveRsvp_(req) {
  // Hidden field real people never fill in; bots do. Pretend it worked.
  if (req.website) return { ok: true };

  var name = clean_(req.name, 120);
  var email = clean_(req.email, 200).toLowerCase();
  var phone = clean_(req.phone, 40);
  var address = clean_(req.address, 500);
  var attending = String(req.attending || '').toLowerCase();
  var note = clean_(req.note, 1000);
  var party = Math.round(Number(req.party) || 1);

  if (!name) throw new Error('Please tell us your name.');
  if (!isEmail_(email)) throw new Error('Please enter a valid email address.');
  if (attending !== 'yes' && attending !== 'no') throw new Error('Please let us know if you can make it.');
  if (!address) throw new Error('Please add your mailing address.');
  if (party < 1 || party > MAX_PARTY) party = 1;
  if (attending === 'no') party = 0;

  var row = [new Date(), name, email, phone, address, attending === 'yes' ? 'Yes' : 'No', party, note].map(safeCell_);

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  var updated = false;
  try {
    var sh = sheet_(RSVP_SHEET, RSVP_HEADERS);
    var last = sh.getLastRow();
    if (last > 1) {
      var emails = sh.getRange(2, 3, last - 1, 1).getValues();
      for (var i = 0; i < emails.length; i++) {
        if (String(emails[i][0]).toLowerCase().trim() === email) {
          sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
          updated = true;
          break;
        }
      }
    }
    if (!updated) sh.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, updated: updated };
}

/* ---------- Admin ---------- */

function requireAdmin_(req) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('ADMIN_PASSWORD') || '';
  if (expected.length < 8) throw new Error('Admin is not set up yet: add ADMIN_PASSWORD (8+ characters) in Script properties.');

  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('admin_fails') || 0);
  if (fails >= 10) throw new Error('Too many wrong passwords. Try again in 10 minutes.');

  if (String(req.password || '') !== expected) {
    cache.put('admin_fails', String(fails + 1), 600);
    Utilities.sleep(700);
    throw new Error('Wrong password.');
  }
}

function listAll_() {
  var props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    rsvps: readRows_(RSVP_SHEET, RSVP_HEADERS).map(function (r) {
      return {
        when: r[0] instanceof Date ? r[0].toISOString() : String(r[0] || ''),
        name: String(r[1] || ''),
        email: String(r[2] || ''),
        phone: String(r[3] || ''),
        address: String(r[4] || ''),
        attending: String(r[5] || '').toLowerCase() === 'yes' ? 'yes' : 'no',
        party: Number(r[6]) || 0,
        note: String(r[7] || '')
      };
    }),
    guests: readRows_(GUEST_SHEET, GUEST_HEADERS).map(function (r) {
      return { name: String(r[0] || ''), email: String(r[1] || ''), phone: String(r[2] || '') };
    }),
    emailQuota: MailApp.getRemainingDailyQuota(),
    smsReady: !!(props.getProperty('TWILIO_SID') && props.getProperty('TWILIO_TOKEN') && props.getProperty('TWILIO_FROM'))
  };
}

/** Works out who a blast goes to. Shared by the preview count and the real send. */
function recipients_(audience, channel, data, testTo) {
  var key = channel === 'sms' ? 'phone' : 'email';
  var people = [];
  if (audience === 'test') {
    var p = { name: 'Test' };
    p[key] = String(testTo || '');
    people = [p];
  } else if (audience === 'yes' || audience === 'no') {
    people = data.rsvps.filter(function (r) { return r.attending === audience; });
  } else if (audience === 'pending') {
    var answered = {};
    data.rsvps.forEach(function (r) {
      if (r.email) answered['e:' + r.email.toLowerCase().trim()] = true;
      var ph = normalizePhone_(r.phone);
      if (ph) answered['p:' + ph] = true;
    });
    people = data.guests.filter(function (g) {
      var ph = normalizePhone_(g.phone);
      return !(g.email && answered['e:' + g.email.toLowerCase().trim()]) && !(ph && answered['p:' + ph]);
    });
  } else if (audience === 'all') {
    people = data.guests.concat(data.rsvps);
  } else {
    throw new Error('Unknown audience');
  }

  var seen = {};
  var out = [];
  people.forEach(function (p) {
    var to = channel === 'sms' ? normalizePhone_(p.phone) : String(p.email || '').toLowerCase().trim();
    if (!to || (channel === 'email' && !isEmail_(to)) || seen[to]) return;
    seen[to] = true;
    out.push({ to: to, name: String(p.name || '') });
  });
  return out;
}

function sendBlast_(req) {
  var channel = req.channel === 'sms' ? 'sms' : 'email';
  var audience = String(req.audience || '');
  var subject = clean_(req.subject, 200);
  var message = String(req.message || '').trim().slice(0, 5000);
  if (!message) throw new Error('Write a message first.');
  if (channel === 'email' && !subject) throw new Error('Add a subject line.');

  var list = recipients_(audience, channel, listAll_(), req.testTo);
  if (!list.length) throw new Error('Nobody in that group has ' + (channel === 'sms' ? 'a phone number' : 'an email address') + ' on file.');

  var sent = 0;
  var failed = [];

  if (channel === 'email') {
    var quota = MailApp.getRemainingDailyQuota();
    if (list.length > quota) {
      throw new Error('Gmail will only send ' + quota + ' more emails today and this group has ' + list.length + '. Send to a smaller group or finish tomorrow.');
    }
    list.forEach(function (p) {
      try {
        MailApp.sendEmail(p.to, subject, personalize_(message, p.name), { name: SENDER_NAME });
        sent++;
      } catch (err) {
        failed.push({ to: p.to, error: String((err && err.message) || err) });
      }
    });
  } else {
    var props = PropertiesService.getScriptProperties();
    var sid = props.getProperty('TWILIO_SID');
    var token = props.getProperty('TWILIO_TOKEN');
    var from = props.getProperty('TWILIO_FROM');
    if (!sid || !token || !from) throw new Error('Texting is not set up: add TWILIO_SID, TWILIO_TOKEN and TWILIO_FROM in Script properties.');
    var url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json';
    var auth = 'Basic ' + Utilities.base64Encode(sid + ':' + token);
    list.forEach(function (p) {
      try {
        var res = UrlFetchApp.fetch(url, {
          method: 'post',
          payload: { To: p.to, From: from, Body: personalize_(message, p.name) },
          headers: { Authorization: auth },
          muteHttpExceptions: true
        });
        var code = res.getResponseCode();
        if (code >= 200 && code < 300) sent++;
        else failed.push({ to: p.to, error: 'Twilio said ' + code });
      } catch (err) {
        failed.push({ to: p.to, error: String((err && err.message) || err) });
      }
    });
  }

  if (audience !== 'test') {
    sheet_(LOG_SHEET, LOG_HEADERS).appendRow([new Date(), channel, audience, safeCell_(subject), sent, failed.length]);
  }
  return { ok: true, sent: sent, failed: failed };
}

/* ---------- helpers ---------- */

function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    var phoneCol = headers.indexOf('Phone') + 1;
    if (phoneCol > 0) sh.getRange(1, phoneCol, sh.getMaxRows(), 1).setNumberFormat('@');
  }
  return sh;
}

function readRows_(name, headers) {
  var sh = sheet_(name, headers);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, headers.length).getValues().filter(function (r) {
    return r.some(function (c) { return String(c).trim() !== ''; });
  });
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

/** Stops a guest's text from being run as a spreadsheet formula. */
function safeCell_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || ''));
}

/** US numbers by default: 10 digits become +1XXXXXXXXXX. Returns '' when unusable. */
function normalizePhone_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  var plus = s.charAt(0) === '+';
  var digits = s.replace(/\D/g, '');
  if (plus && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return '';
}

/** {name} in a message becomes the guest's first name. */
function personalize_(message, name) {
  var first = String(name || '').trim().split(/\s+/)[0] || 'there';
  return message.replace(/\{name\}/gi, first);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
