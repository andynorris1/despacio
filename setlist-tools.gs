/**
 * Setlist tools — runs in YOUR OWN Google Sheet (the "links sheet"), not the
 * community sheet. It reads the community sheet, mirrors every setlist into a
 * Tracks tab here, and adds YouTube links. The community sheet is never edited.
 *
 * Setup:
 *   1. Create a new Google Sheet. Extensions → Apps Script, paste this file.
 *   2. Put the community sheet's ID in SOURCE_ID below (the long string between
 *      /d/ and /edit in its URL). You need at least view access to it.
 *   3. Services (+) → YouTube Data API v3 → Add. Save, reload the sheet.
 *   4. Setlist tools → Set up automatic updates.
 */

const CONFIG = {
  SOURCE_ID: '13JSLgoeB9lnosv_R2m4ZqYSlqM5A9y8hb4b2v_KaW7U', // Despacio Song IDs (TSOT)
  // Only tabs named like "21-Miami" are setlists: a number, a dash, then the city.
  // Every other tab in the community sheet is ignored and never appears on the site.
  CITY_TAB: /^\s*(\d+)\s*[-–—]\s*(.+?)\s*$/,
  // Accepted column names in the community sheet. Case, punctuation and anything in
  // parentheses are ignored, so "Artist(s)" matches "artist" and "Unique ID #" matches "unique id".
  // The header row can be anywhere in the first 15 rows of a tab.
  SOURCE_HEADERS: {
    id: ['unique id', 'uniqueid', 'unique', 'uid', 'track id', 'id'],
    artist: ['artist', 'artists', 'artist name'],
    title: ['title', 'song title', 'track title', 'song', 'track', 'song name', 'track name', 'name'],
    youtube: ['youtube'],                       // links fans have already added
    idStatus: ['identification status'],
    date: ['date'],
  },
  TRACKS: 'Tracks',
  APPEARANCES: 'Appearances',
  TRACK_HEADERS: ['Appearance', 'gid', 'Unique ID', 'Artist', 'Song Title', 'Status', 'YouTube', 'Date', 'Position'],
  APPEARANCE_HEADERS: ['Tab', 'gid', 'City', 'Year', 'Event', 'Order', 'Slug'],

  // Which gig each city tab is, by the number at the start of the tab name.
  // A tab not listed here (e.g. a new "22-..." tab) uses the city from its name
  // and the year from its Date column, so new gigs still appear automatically.
  GIGS: {
    1:  { city: 'Manchester', year: 2013, event: 'Manchester International Festival (New Century Hall), July 18–20, 2013' },
    2:  { city: 'London',     year: 2013, event: 'Hammersmith Town Hall, December 19–21, 2013' },
    3:  { city: 'London',     year: 2014, event: 'Camden Roundhouse, March 7–8, 2014' },
    4:  { city: 'Barcelona',  year: 2014, event: 'Sónar Festival, June 12–14, 2014' },
    5:  { city: 'Pilton',     year: 2014, event: 'Glastonbury Festival, June 25–29, 2014' },
    9:  { city: 'Indio',      year: 2016, event: 'Coachella, April 15–17 & 22–24, 2016' },
    10: { city: 'New York',   year: 2016, event: 'Panorama Festival, July 22–24, 2016' },
    13: { city: 'Barcelona',  year: 2018, event: 'Sónar Festival, June 14–16, 2018' },
    15: { city: 'Pasadena',   year: 2022, event: "This Ain't No Picnic, August 27–28, 2022" },
    16: { city: 'Miami',      year: 2022, event: 'III Points Festival, October 21–22, 2022' },
    17: { city: 'Indio',      year: 2023, event: 'Coachella, April 2023' },
    18: { city: 'Miami',      year: 2023, event: 'III Points Festival, October 20–21, 2023' },
    19: { city: 'Ghent',      year: 2024, event: 'Zebrastraat, March 2024' },
    20: { city: 'San Francisco', year: 2025, event: 'Portola Festival, September 20 & 21, 2025' },
    21: { city: 'Miami',      year: 2025, event: 'III Points Festival, October 2025' },
  },

  // Upcoming gigs whose tab number isn't known yet, recognized by the dates in the
  // tab's Date column (MM/DD/YYYY). Once the tab exists you can move the entry into
  // GIGS above by its number, but it works from here too.
  GIGS_BY_DATE: [
    { dates: ['09/26/2026', '09/27/2026'], city: 'San Francisco', year: 2026, event: 'Portola Festival, September 26 & 27, 2026' },
  ],
  YT_SEARCHES_PER_RUN: 90,   // 100 quota units each; free quota is 10,000/day
  STATUS: { UNKNOWN: 'Unknown', NO_MATCH: 'No match', FOUND: 'Found', SUBMITTED: 'Submitted' },
  SUBMISSIONS: 'Submissions',          // log of every link visitors submit, for undoing
  MAX_SUBMISSIONS_PER_HOUR: 100,       // simple brake on spam
};

// Column positions in the Tracks tab (0-based)
const T = Object.fromEntries(CONFIG.TRACK_HEADERS.map((h, i) => [h, i]));

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Setlist tools')
    .addItem('Sync from community sheet now', 'syncFromSource')
    .addItem('Show last sync result', 'showLastSync')
    .addItem('Find YouTube links now', 'fillYouTubeLinks')
    .addSeparator()
    .addItem('Set up automatic updates', 'setUpTriggers')
    .addItem('Stop automatic updates', 'removeTriggers')
    .addToUi();
}

/* ---------- helpers ---------- */

const isUnknown_ = v => /^unknown$/i.test(String(v).trim());
const byId_ = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_(sh) {
  const n = sh.getLastRow() - 1;
  return n < 1 ? [] : sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
}

const normHeader_ = h => String(h).replace(/\(.*?\)/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findCol_(headers, aliases) {
  const norm = headers.map(normHeader_);
  for (const a of aliases) { const i = norm.indexOf(a); if (i >= 0) return i; }
  return -1;
}

// Finds the first row (within the top 15) that has Unique ID, Artist and Title columns.
function findHeaderRow_(values) {
  for (let r = 0; r < Math.min(values.length, 15); r++) {
    const h = values[r];
    if (findCol_(h, CONFIG.SOURCE_HEADERS.id) >= 0 &&
        findCol_(h, CONFIG.SOURCE_HEADERS.artist) >= 0 &&
        findCol_(h, CONFIG.SOURCE_HEADERS.title) >= 0) return r;
  }
  return -1;
}

function interactive_() {
  try { SpreadsheetApp.getUi(); return true; } catch (e) { return false; }
}

function notify_(msg) {
  if (interactive_()) SpreadsheetApp.getActive().toast(msg, 'Setlist tools', 6);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // another run is busy; the next trigger will catch up
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- 1. Sync ---------- */

// Mirrors every community tab into Tracks, matched by tab + Unique ID.
// A YouTube URL, once found, is kept for good: the track is never searched again,
// even if fans later edit its artist or title. Tracks without a URL are searched
// again only if their artist or title changes (e.g. an Unknown gets identified).
function syncFromSource() {
  withLock_(() => {
    const src = SpreadsheetApp.openById(CONFIG.SOURCE_ID);
    const tracks = sheet_(CONFIG.TRACKS, CONFIG.TRACK_HEADERS);

    const prev = {};
    rows_(tracks).forEach(r => { prev[`${r[T.gid]}|${r[T['Unique ID']]}`] = r; });

    const out = [];
    const tabs = [];
    const skipped = [];
    const years = {};   // gid → year from the tab's Date column
    const tabDates = {}; // gid → the tab's dates, to recognize gigs in GIGS_BY_DATE
    src.getSheets().forEach(s => {
      if (!CONFIG.CITY_TAB.test(s.getName())) return; // not a city tab
      const values = s.getDataRange().getDisplayValues(); // exactly as fans see it
      const hr = findHeaderRow_(values);
      if (hr < 0) { skipped.push(s.getName()); return; } // no Unique ID / Artist / Title columns
      const h = values[hr];
      const body = values.slice(hr + 1);
      const cId = findCol_(h, CONFIG.SOURCE_HEADERS.id);
      const cA = findCol_(h, CONFIG.SOURCE_HEADERS.artist);
      const cT = findCol_(h, CONFIG.SOURCE_HEADERS.title);
      const cYT = findCol_(h, CONFIG.SOURCE_HEADERS.youtube);
      const cSt = findCol_(h, CONFIG.SOURCE_HEADERS.idStatus);
      const cDate = findCol_(h, CONFIG.SOURCE_HEADERS.date);
      tabs.push(s);
      if (cDate >= 0) {
        years[s.getSheetId()] = commonYear_(body.map(r => r[cDate]));
        tabDates[s.getSheetId()] = body.map(r => formatDate_(r[cDate])).filter(Boolean);
      }
      let lastDate = ''; // rows with a blank Date take the date of the row above

      const gid = s.getSheetId();
      // Tabs with Unique IDs are ordered by them, and rows without one are left out
      // (tracks fans couldn't place). Older tabs with no Unique IDs at all use the
      // order of their rows instead.
      const hasIds = body.some(r => String(r[cId]).trim());
      const seen = {};
      const tabRows = [];
      body.forEach(r => {
        const artist = String(r[cA]).trim();
        const title = String(r[cT]).trim();
        const date = cDate >= 0 ? formatDate_(r[cDate]) : '';
        if (date) lastDate = date;
        // Skip notes rows like "GAP IN RECORDING", and blank rows.
        if (!artist && !title) return;
        if (cSt >= 0 && /^administrative$/i.test(String(r[cSt]).trim())) return;
        let id = String(r[cId]).trim();
        if (!id) {
          if (hasIds) return;
          // No Unique IDs in this tab: make one from the song, so links stay with
          // the right track even if fans insert or move rows.
          const base = slugify_(`${artist} ${title}`) || 'track';
          seen[base] = (seen[base] || 0) + 1;
          id = `auto-${base}-${seen[base]}`;
        }
        const p = prev[`${gid}|${id}`];
        const same = p && String(p[T.Artist]) === artist && String(p[T['Song Title']]) === title;
        // Which link to use: one a visitor submitted on the site, then one fans added
        // in the community sheet, then the one the search found earlier.
        const community = cYT >= 0 && /youtu\.?be/.test(String(r[cYT])) ? String(r[cYT]).trim() : '';
        const prevUrl = p ? String(p[T.YouTube]).trim() : '';
        const submitted = p && p[T.Status] === CONFIG.STATUS.SUBMITTED && prevUrl;
        const url = submitted ? prevUrl : (community || prevUrl);

        const row = new Array(CONFIG.TRACK_HEADERS.length).fill('');
        row[T.Appearance] = s.getName();
        row[T.gid] = gid;
        row[T['Unique ID']] = id;
        row[T.Artist] = artist;
        row[T['Song Title']] = title;
        row[T.YouTube] = url;
        row.community = !submitted && !!community && url === community;
        row.submitted = !!submitted;
        row[T.Date] = date || lastDate;
        if (submitted) row[T.Status] = CONFIG.STATUS.SUBMITTED;
        else if (url) row[T.Status] = CONFIG.STATUS.FOUND;
        else if (isUnknown_(artist) && isUnknown_(title)) row[T.Status] = CONFIG.STATUS.UNKNOWN;
        else if (same && p[T.Status] === CONFIG.STATUS.NO_MATCH) row[T.Status] = CONFIG.STATUS.NO_MATCH;
        tabRows.push(row);
      });
      if (hasIds) tabRows.sort((a, b) => byId_(a[T['Unique ID']], b[T['Unique ID']]));
      tabRows.forEach((row, i) => { row[T.Position] = i + 1; out.push(row); });
    });

    shareLinks_(out);
    tabs.sort((a, b) => tabNumber_(a) - tabNumber_(b));
    const tabOrder = Object.fromEntries(tabs.map((s, i) => [s.getSheetId(), i]));
    out.sort((a, b) => (tabOrder[a[T.gid]] - tabOrder[b[T.gid]]) || (a[T.Position] - b[T.Position]));

    tracks.clear(); // also drops any columns left over from older versions
    const H = CONFIG.TRACK_HEADERS;
    tracks.getRange(1, 1, 1, H.length).setValues([H]).setFontWeight('bold');
    tracks.setFrozenRows(1);
    if (out.length) {
      // Plain text, so IDs like "007" and titles like "3/5" aren't turned into numbers or dates
      tracks.getRange(2, 1, out.length, H.length).setNumberFormat('@').setValues(out);
    }

    rebuildAppearances_(tabs, years, tabDates);
    PropertiesService.getScriptProperties().setProperty('lastSync',
      JSON.stringify({ when: new Date().toISOString(), tracks: out.length, cities: tabs.length, skipped }));
    notify_(`Synced ${out.length} tracks from ${tabs.length} cities.` +
      (skipped.length ? ` Skipped (no Unique ID / Artist / Title columns): ${skipped.join(', ')}` : ''));
  });
}

// One row per city tab. City, year and event come from GIGS (by tab number) or
// GIGS_BY_DATE (by the tab's dates); otherwise the city comes from the tab name and
// the year from its Date column. The page address is city + year, e.g. sets/miami-2025/.
function rebuildAppearances_(tabs, years, tabDates) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.APPEARANCES) || SpreadsheetApp.getActive().insertSheet(CONFIG.APPEARANCES);
  const used = new Set();
  const rows = tabs.map(s => {
    const n = tabNumber_(s);
    const dates = tabDates[s.getSheetId()] || [];
    const gig = CONFIG.GIGS[n] ||
      CONFIG.GIGS_BY_DATE.find(g => g.dates.some(d => dates.indexOf(d) >= 0)) || {};
    const city = gig.city || tabCity_(s);
    const year = gig.year || years[s.getSheetId()] || '';
    let slug = slugify_(`${city} ${year}`) || String(s.getSheetId());
    if (used.has(slug)) slug = `${slug}-${n}`; // e.g. two Miami gigs in one year
    used.add(slug);
    return [s.getName(), s.getSheetId(), city, year, gig.event || '', n, slug];
  });

  sh.clear();
  const H = CONFIG.APPEARANCE_HEADERS;
  sh.getRange(1, 1, 1, H.length).setValues([H]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, H.length).setNumberFormat('@').setValues(rows);
}

// "9/20/2025" or "2025-09-20" → "09/20/2025". Anything else (e.g. "??") → ''.
function formatDate_(v) {
  const t = String(v).trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}/${m[1]}`;
  return '';
}

// Most common 4-digit year in a tab's Date column ("9/20/2025" → 2025).
function commonYear_(dates) {
  const count = {};
  dates.forEach(d => { const m = String(d).match(/\b(19|20)\d{2}\b/); if (m) count[m[0]] = (count[m[0]] || 0) + 1; });
  const best = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  return best ? Number(best) : '';
}

const tabNumber_ = s => Number(s.getName().match(CONFIG.CITY_TAB)[1]);
// "15-Pasadena (TANP)" → "Pasadena"
const tabCity_ = s => s.getName().match(CONFIG.CITY_TAB)[2].replace(/\s*\(.*\)\s*$/, '').trim();

function slugify_(name) {
  return String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function showLastSync() {
  const raw = PropertiesService.getScriptProperties().getProperty('lastSync');
  const r = raw ? JSON.parse(raw) : null;
  SpreadsheetApp.getUi().alert(!r ? 'No sync has run yet.' :
    `Last sync: ${new Date(r.when).toLocaleString()}\n${r.tracks} tracks from ${r.cities} cities.` +
    (r.skipped.length ? `\n\nSkipped (couldn't find Unique ID, Artist and Title columns):\n${r.skipped.join('\n')}` : '\n\nNo tabs skipped.'));
}

/* ---------- Sharing links between gigs ---------- */

// Versions that aren't on YouTube are searched as the original song:
//   "Vaudou (2manydjs Edit)"                → "Vaudou"
//   "Need You Tonight (Despacio Edit)"      → "Need You Tonight"
//   "When We're Dancing Close and Slow (Unknown Version)" → "When We're Dancing Close and Slow"
//   "Dance, Dance, Dance (Unknown Edit)"    → "Dance, Dance, Dance"
// Only the search uses this; the site shows the title as the community wrote it.
const VERSION_WORDS = "(?:(?:2\\s*many\\s*dj'?s|despacio)\\s+(?:re-?)?edit|unknown\\s+(?:version|edit))";
const EDIT_TAG = new RegExp(
  "\\s*[(\\[][^)\\]]*\\b" + VERSION_WORDS + "\\b[^)\\]]*[)\\]]" +   // "(… Despacio Edit …)"
  "|\\s+[-–—]\\s*" + VERSION_WORDS + "\\s*$", "gi");                 // "… - Despacio Edit" at the end
const searchTitle_ = title => String(title).replace(EDIT_TAG, '').trim() || String(title).trim();

// Same artist + title (ignoring case, extra spaces, and the version tags above) = same song,
// so an edit or unknown version shares its link with the original.
const songKey_ = (artist, title) =>
  [artist, searchTitle_(title)].map(v => String(v).trim().toLowerCase().replace(/\s+/g, ' ')).join('|');

// Tracks without a link borrow one from the same song at another gig, so each song
// is only ever searched once. Priority: visitor-submitted, then community, then found.
function shareLinks_(rows) {
  const known = {};
  [rows.filter(r => r.submitted), rows.filter(r => r.community), rows].forEach(set => set.forEach(r => {
    const url = String(r[T.YouTube]).trim();
    const k = songKey_(r[T.Artist], r[T['Song Title']]);
    if (url && !known[k]) known[k] = url;
  }));
  rows.forEach(r => {
    if (String(r[T.YouTube]).trim() || isUnknown_(r[T['Song Title']])) return;
    const url = known[songKey_(r[T.Artist], r[T['Song Title']])];
    if (url) { r[T.YouTube] = url; r[T.Status] = CONFIG.STATUS.FOUND; }
  });
}

/* ---------- 2. YouTube ---------- */

// Searches only tracks that have no URL and no status, newest gig first. Skips Unknown tracks
// (both columns "Unknown") and any track whose title is Unknown.
function fillYouTubeLinks() {
  withLock_(() => {
    const tracks = sheet_(CONFIG.TRACKS, CONFIG.TRACK_HEADERS);
    const data = rows_(tracks);
    let searched = 0, found = 0, reused = 0;
    const known = {};
    data.forEach(r => {
      const u = String(r[T.YouTube]).trim();
      const key = songKey_(r[T.Artist], r[T['Song Title']]);
      if (u && !known[key]) known[key] = u;
    });

    // Newest gig first (the top of the site), then down each setlist in order.
    // A song found here also covers the same song at older gigs.
    const gigNumber = r => { const m = String(r[T.Appearance]).match(CONFIG.CITY_TAB); return m ? Number(m[1]) : 0; };
    const order = data.map((r, i) => i).sort((a, b) =>
      (gigNumber(data[b]) - gigNumber(data[a])) || (Number(data[a][T.Position]) - Number(data[b][T.Position])));
    const missed = {}; // songs YouTube had nothing for in this run: don't search them twice

    for (let n = 0; n < order.length && searched < CONFIG.YT_SEARCHES_PER_RUN; n++) {
      const i = order[n];
      const r = data[i];
      const artist = String(r[T.Artist]).trim();
      const title = String(r[T['Song Title']]).trim();
      if (String(r[T.YouTube]).trim() || r[T.Status]) continue; // has a URL, or already searched/skipped
      if (!title || isUnknown_(title)) continue;

      const k = songKey_(artist, title);
      if (missed[k]) {
        tracks.getRange(i + 2, T.Status + 1).setValue(CONFIG.STATUS.NO_MATCH);
        continue;
      }
      if (known[k]) { // same song already has a link: no API call
        tracks.getRange(i + 2, T.Status + 1, 1, 2).setValues([[CONFIG.STATUS.FOUND, known[k]]]);
        reused++;
        continue;
      }

      let url;
      try {
        url = searchYouTube_(isUnknown_(artist) ? '' : artist, searchTitle_(title));
      } catch (e) {
        if (interactive_()) SpreadsheetApp.getUi().alert(`YouTube search stopped: ${e.message}\n\nIf this mentions quota, the daily limit is used up. It resets at midnight Pacific time.`);
        break;
      }
      searched++;
      if (url) { found++; known[k] = url; } else missed[k] = true;
      tracks.getRange(i + 2, T.Status + 1, 1, 2).setValues([[url ? CONFIG.STATUS.FOUND : CONFIG.STATUS.NO_MATCH, url]]);
    }
    notify_(`Searched ${searched} tracks, found ${found} YouTube links, reused ${reused}.`);
  });
}

// Prefers YouTube's auto-generated "Artist - Topic" uploads (official studio audio).
function searchYouTube_(artist, title) {
  const res = YouTube.Search.list('snippet', {
    q: `${artist} ${title}`.trim(), type: 'video', videoCategoryId: '10', maxResults: 5,
  });
  const items = (res.items || []).filter(it => it.id && it.id.videoId);
  if (!items.length) return '';
  const topic = items.find(it => / - Topic$/.test(it.snippet.channelTitle || ''));
  return `https://www.youtube.com/watch?v=${(topic || items[0]).id.videoId}`;
}

/* ---------- 3. Link submissions from the website ---------- */
// Deployed as a web app (Deploy → New deployment → Web app, Execute as: Me,
// Who has access: Anyone). The site sends { gid, id, url }. Only the YouTube link
// can change; artist and title are never touched.

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request.' }); }
  const gid = String(body.gid || '').trim();
  const id = String(body.id || '').trim();
  const vid = youTubeId_(String(body.url || ''));
  if (!gid || !id) return json_({ ok: false, error: 'Bad request.' });
  if (!vid) return json_({ ok: false, error: "That isn't a YouTube video link." });
  if (!underLimit_()) return json_({ ok: false, error: 'Too many links submitted this hour. Try again later.' });
  if (!embeddable_(vid)) return json_({ ok: false, error: "That video is unavailable or can't be played on other sites." });

  const result = withLock_(() => applySubmission_(gid, id, `https://www.youtube.com/watch?v=${vid}`));
  return json_(result || { ok: false, error: 'The sheet is busy. Try again in a moment.' });
}

function applySubmission_(gid, id, url) {
  const tracks = SpreadsheetApp.getActive().getSheetByName(CONFIG.TRACKS);
  const data = rows_(tracks);
  const i = data.findIndex(r => String(r[T.gid]) === gid && String(r[T['Unique ID']]) === id);
  if (i < 0) return { ok: false, error: 'That track no longer exists.' };
  const row = data[i];
  if (isUnknown_(row[T['Song Title']])) return { ok: false, error: "This track hasn't been identified yet." };

  // Update this track, plus the same song at other gigs if it had the same (wrong) link or none.
  const old = String(row[T.YouTube]).trim();
  const k = songKey_(row[T.Artist], row[T['Song Title']]);
  let updated = 0;
  data.forEach(r => {
    const u = String(r[T.YouTube]).trim();
    if (r === row || (songKey_(r[T.Artist], r[T['Song Title']]) === k && (!u || u === old))) {
      r[T.Status] = CONFIG.STATUS.SUBMITTED;
      r[T.YouTube] = url;
      updated++;
    }
  });
  tracks.getRange(2, T.Status + 1, data.length, 2).setValues(data.map(r => [r[T.Status], r[T.YouTube]]));

  const log = sheet_(CONFIG.SUBMISSIONS, ['When', 'Gig', 'Unique ID', 'Artist', 'Song Title', 'Old link', 'New link', 'Tracks updated']);
  log.appendRow([new Date(), row[T.Appearance], id, row[T.Artist], row[T['Song Title']], old, url, updated]);
  return { ok: true, yt: url.split('v=')[1], updated };
}

function youTubeId_(url) {
  const m = url.trim().match(/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : '';
}

// YouTube's oEmbed answers 200 only for public videos that allow embedding. No API quota used.
function embeddable_(vid) {
  const u = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}`;
  try { return UrlFetchApp.fetch(u, { muteHttpExceptions: true }).getResponseCode() === 200; }
  catch (e) { return false; }
}

function underLimit_() {
  const cache = CacheService.getScriptCache();
  const key = 'subs-' + Math.floor(Date.now() / 3600000);
  const n = Number(cache.get(key) || 0);
  if (n >= CONFIG.MAX_SUBMISSIONS_PER_HOUR) return false;
  cache.put(key, String(n + 1), 3700);
  return true;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 4. Triggers ---------- */

function setUpTriggers() {
  removeTriggers(true);
  ScriptApp.newTrigger('syncFromSource').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('fillYouTubeLinks').timeBased().everyDays(1).atHour(3).create();
  syncFromSource();
  notify_('Syncing every hour and searching YouTube every night around 3am.');
}

function removeTriggers(silent) {
  ScriptApp.getProjectTriggers()
    .filter(t => ['syncFromSource', 'fillYouTubeLinks'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  if (silent !== true) notify_('Automatic updates stopped.');
}
