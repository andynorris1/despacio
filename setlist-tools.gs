/**
 * Setlist tools — paste into Extensions → Apps Script in your Google Sheet.
 * Adds a "Setlist tools" menu to the sheet.
 *
 * Before using "Suggest YouTube links": in the Apps Script editor, click
 * Services (+) → YouTube Data API v3 → Add.
 */

const CONFIG = {
  INDEX_SHEET: 'Index',   // tab the web page reads to list appearances
  SKIP_PREFIX: '_',       // tabs starting with this are ignored (e.g. "_notes")
  HEADERS: {              // accepted header names, lowercase
    id: ['unique id', 'id', 'uid'],
    artist: ['artist'],
    title: ['song title', 'title', 'song', 'track'],
  },
  LINK_COLUMNS: ['YouTube', 'SoundCloud', 'Bandcamp', 'Bandcamp ID', 'Suggested YouTube', 'Links Verified'],
  YT_SEARCHES_PER_RUN: 40, // each search costs 100 of the 10,000 free daily quota units
  UNKNOWN_TITLE: /^(id|unknown|unreleased|\?+)$/i,
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Setlist tools')
    .addItem('Add link columns to all setlists', 'addLinkColumns')
    .addItem('Suggest YouTube links (this setlist)', 'suggestYouTubeThisSheet')
    .addItem('Look up Bandcamp IDs (all setlists)', 'fillBandcampIds')
    .addSeparator()
    .addItem('Rebuild Index tab', 'rebuildIndex')
    .addToUi();
}

/* ---------- helpers ---------- */

function setlistSheets_() {
  return SpreadsheetApp.getActive().getSheets().filter(s => {
    const n = s.getName();
    return n !== CONFIG.INDEX_SHEET && !n.startsWith(CONFIG.SKIP_PREFIX);
  });
}

function headerMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (!lastCol) return {};
  const map = {};
  sheet.getRange(1, 1, 1, lastCol).getValues()[0].forEach((h, i) => {
    map[String(h).trim().toLowerCase()] = i + 1;
  });
  return map;
}

function findCol_(map, aliases) {
  for (const a of aliases) if (map[a]) return map[a];
  return 0;
}

function toast_(msg) {
  SpreadsheetApp.getActive().toast(msg, 'Setlist tools', 6);
}

/* ---------- 1. columns ---------- */

function addLinkColumns() {
  setlistSheets_().forEach(sheet => {
    const map = headerMap_(sheet);
    CONFIG.LINK_COLUMNS.forEach(name => {
      if (!map[name.toLowerCase()]) {
        const col = sheet.getLastColumn() + 1;
        sheet.getRange(1, col).setValue(name).setFontWeight('bold');
        map[name.toLowerCase()] = col;
      }
    });
    const rows = Math.max(sheet.getLastRow() - 1, 1);
    sheet.getRange(2, map['links verified'], rows, 1).insertCheckboxes();
  });
  rebuildIndex();
  toast_('Link columns added to every setlist tab.');
}

/* ---------- 2. YouTube suggestions ---------- */

function suggestYouTubeThisSheet() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const map = headerMap_(sheet);
  const cArtist = findCol_(map, CONFIG.HEADERS.artist);
  const cTitle = findCol_(map, CONFIG.HEADERS.title);
  const cYT = map['youtube'];
  const cSug = map['suggested youtube'];
  if (!cArtist || !cTitle || !cYT || !cSug) {
    SpreadsheetApp.getUi().alert('This tab needs Artist, Song Title, YouTube and Suggested YouTube columns. Run "Add link columns" first.');
    return;
  }
  const n = sheet.getLastRow() - 1;
  if (n < 1) return;
  const data = sheet.getRange(2, 1, n, sheet.getLastColumn()).getValues();

  let searched = 0;
  for (let i = 0; i < n && searched < CONFIG.YT_SEARCHES_PER_RUN; i++) {
    const row = data[i];
    const artist = String(row[cArtist - 1]).trim();
    const title = String(row[cTitle - 1]).trim();
    if (!artist || !title || CONFIG.UNKNOWN_TITLE.test(title)) continue;
    if (row[cYT - 1] || row[cSug - 1]) continue; // already has a link or a suggestion

    try {
      const res = YouTube.Search.list('snippet', { q: `${artist} ${title}`, type: 'video', maxResults: 1 });
      searched++;
      const item = res.items && res.items[0];
      sheet.getRange(i + 2, cSug).setValue(item ? `https://www.youtube.com/watch?v=${item.id.videoId}` : 'no match');
    } catch (e) {
      SpreadsheetApp.getUi().alert(`YouTube search stopped: ${e.message}\n\nIf this mentions quota, the daily limit is used up. Try again tomorrow.`);
      break;
    }
  }
  toast_(`${searched} YouTube suggestions added. Check each one, then paste good ones into the YouTube column.`);
}

/* ---------- 3. Bandcamp IDs ---------- */

function fillBandcampIds() {
  let found = 0, missed = 0;
  setlistSheets_().forEach(sheet => {
    const map = headerMap_(sheet);
    const cBC = map['bandcamp'];
    const cID = map['bandcamp id'];
    const n = sheet.getLastRow() - 1;
    if (!cBC || !cID || n < 1) return;
    const urls = sheet.getRange(2, cBC, n, 1).getValues();
    const ids = sheet.getRange(2, cID, n, 1).getValues();
    for (let i = 0; i < n; i++) {
      const url = String(urls[i][0]).trim();
      if (!url || ids[i][0]) continue;
      const id = bandcampTrackId_(url);
      sheet.getRange(i + 2, cID).setValue(id || 'not found: copy from Share/Embed');
      id ? found++ : missed++;
      Utilities.sleep(500); // be polite to Bandcamp
    }
  });
  toast_(`Bandcamp IDs: ${found} found, ${missed} need manual entry.`);
}

function bandcampTrackId_(url) {
  if (!/\/track\//.test(url)) return ''; // album links can't embed a single track
  try {
    const html = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true }).getContentText();
    const meta = html.match(/<meta\s+name="bc-page-properties"\s+content="([^"]+)"/i);
    if (meta) {
      const props = JSON.parse(meta[1].replace(/&quot;/g, '"'));
      if (props.item_id && /^t/.test(String(props.item_type))) return String(props.item_id);
    }
    const embed = html.match(/EmbeddedPlayer\/[^"'\s]*track=(\d+)/);
    return embed ? embed[1] : '';
  } catch (e) {
    return '';
  }
}

/* ---------- 4. Index tab ---------- */

function rebuildIndex() {
  const ss = SpreadsheetApp.getActive();
  const idx = ss.getSheetByName(CONFIG.INDEX_SHEET) || ss.insertSheet(CONFIG.INDEX_SHEET, 0);

  // Keep anything already typed into Festival / Date / Location / Order.
  const prev = {};
  idx.getDataRange().getValues().slice(1).forEach(r => { if (r[0]) prev[r[0]] = r; });

  const header = ['Tab', 'gid', 'Festival', 'Date', 'Location', 'Order'];
  const rows = setlistSheets_().map((s, i) => {
    const p = prev[s.getName()];
    return [s.getName(), s.getSheetId(), p ? p[2] : s.getName(), p ? p[3] : '', p ? p[4] : '', p ? p[5] : i + 1];
  });

  idx.clearContents();
  idx.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) idx.getRange(2, 1, rows.length, header.length).setValues(rows);
  idx.setFrozenRows(1);
}
