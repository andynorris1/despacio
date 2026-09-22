// Builds the site into _site/: a home page plus sets/<slug>/index.html for each
// appearance. Reads the published CSVs of your links sheet. No dependencies; Node 20+.
//
//   node build.mjs            build from the live sheet
//   node build.mjs --serve    build, then preview at http://localhost:8080

import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';

const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
const OUT = '_site';

/* ---------- data ---------- */

const csvUrl = gid =>
  `https://docs.google.com/spreadsheets/d/e/${config.pubId}/pub?gid=${gid}&single=true&output=csv`;

function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

function toObjects(rows) {
  const keys = (rows[0] || []).map(h => h.trim().toLowerCase());
  return rows.slice(1)
    .filter(r => r.some(v => v.trim()))
    .map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
}

async function loadCSV(gid, label) {
  const res = await fetch(csvUrl(gid));
  if (!res.ok) throw new Error(`${label} tab returned HTTP ${res.status}. Is the sheet published, and is the gid right?`);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) throw new Error(`${label} tab returned a web page, not CSV. Check pubId and gid.`);
  return toObjects(parseCSV(text));
}

const isUnknown = v => /^unknown$/i.test((v || '').trim());
const byId = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const slugify = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function ytId(url) {
  const m = (url || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/);
  return m ? m[1] : '';
}

/* ---------- templates ---------- */

const canSubmit = /^https:\/\/script\.google\.com\//.test(config.submitUrl || '');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ title, description, root, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=League+Spartan:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${root}assets/site.css">
</head>
<body${canSubmit ? ` data-submit="${esc(config.submitUrl)}"` : ''}>
<div class="site" id="top">
${body}
<p class="updated">Updated ${new Date().toUTCString()}</p>
</div>
<script src="${root}assets/player.js" defer></script>
</body>
</html>
`;
}

// Tab "21-Miami" → "Miami". The sheet script already does this; this is a fallback.
const cityName = tab => (tab || '').replace(/^\s*\d+\s*[-–—]\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim();

// Left-hand list. Clicking a gig opens its page, where it's expanded with its dates and
// the day you're reading highlighted (assets/player.js keeps that in step as you scroll).
// On the home page every gig starts collapsed.
function cityNav(list, current, root, isHome) {
  return `<nav class="cities" aria-label="Gigs">
<ul>
<li><a class="city about-link" href="${root}about/"${current === 'about' ? ' aria-current="page"' : ''}>About</a></li>
${list.map(a => {
    const href = `${root}sets/${a.slug}/`;
    if (a !== current) return `<li><a class="city" href="${href}">${esc(a.label)}</a></li>`;
    // A page with no dates (Despacio Classics) is a plain link, not an expander.
    if (!a.dates.length) return `<li><a class="city" href="${href}" aria-current="page">${esc(a.label)}</a></li>`;
    const multi = a.dates.length > 1;
    const dates = (a.dates.length ? a.dates : ['Setlist'])
      .map((d, i) => `<li><a href="${multi ? `#${dayId(d)}` : '#top'}"${!isHome && i === 0 ? ' class="active" aria-current="location"' : ''}>${esc(d)}</a></li>`)
      .join('');
    return `<li><details${isHome ? '' : ' open'}><summary aria-current="page">${esc(a.label)}</summary><ul class="dates">${dates}</ul></details></li>`;
  }).join('\n')}
</ul>
</nav>`;
}

const dayId = d => `d-${d.replace(/\//g, '-')}`;

function trackItem(t, i) {
  const artist = t['artist'];
  const title = t['song title'];
  const id = t['unique id'];
  const unknown = isUnknown(artist) && isUnknown(title);
  const yt = unknown ? '' : ytId(t['youtube']);

  const song = unknown
    ? '<span class="title">Unknown - Unknown</span>'
    : `<span class="title">${esc(title || 'Untitled')}</span>${artist ? `<span class="artist">${esc(artist)}</span>` : ''}`;

  // Tracks without a URL are still listed, just with no Play button.
  const play = yt
    ? `<button type="button" class="play" data-yt="${yt}" aria-expanded="false" aria-label="Play ${esc(title || 'track')} on YouTube">Play</button>`
    : '';
  // Anyone can submit a YouTube link for an identified track (only the link, never artist/title).
  const fix = canSubmit && !unknown && !isUnknown(title)
    ? `<button type="button" class="fix">${yt ? 'Wrong link?' : 'Add link'}</button>`
    : '';

  return `<li class="track${unknown ? ' unidentified' : ''}" id="t-${esc(slugify(id) || String(i + 1))}" data-gid="${esc(t['gid'])}" data-id="${esc(id)}">
  <span class="pos">${String(i + 1).padStart(2, '0')}</span>
  <span class="song">${song}</span>
  <span class="sources">${play}${fix}</span>
  <div class="player" hidden></div>
</li>`;
}

function page({ list, current, root, main, title, description, isHome }) {
  return layout({
    title, description, root,
    body: `<a class="site-title" href="${root || './'}">${esc(config.siteTitle)}</a>
<div class="layout">
${cityNav(list, current, root, isHome)}
<main>
${main}
</main>
</div>`,
  });
}

// One list per day. Multi-day gigs get a date heading before each day's tracks,
// which the date links in the left-hand list jump to.
// Player bar above each setlist: Previous, Play/Pause, Next, what's playing, and an
// Autoplay switch (off by default). assets/player.js makes it work.
const icon = d => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
const playerBar = `<div class="controls" role="group" aria-label="Player">
  <div class="transport">
    <button type="button" class="btn" data-action="prev" aria-label="Previous track">${icon('M6 5h2v14H6zM20 5v14L9 12z')}</button>
    <button type="button" class="btn toggle" data-action="toggle" data-state="paused" aria-label="Play">${icon('M8 5v14l11-7z').replace('<svg', '<svg class="i-play"')}${icon('M7 5h4v14H7zM13 5h4v14h-4z').replace('<svg', '<svg class="i-pause"')}</button>
    <button type="button" class="btn" data-action="next" aria-label="Next track">${icon('M16 5h2v14h-2zM4 5v14l11-7z')}</button>
  </div>
  <p class="now" aria-live="polite"></p>
  <label class="autoplay"><input type="checkbox" role="switch"> Autoplay</label>
</div>
`;

function tracklist(a) {
  const days = [];
  a.tracks.forEach((t, i) => {
    const d = t['date'] || '';
    if (!days.length || days[days.length - 1].date !== d) days.push({ date: d, items: [] });
    days[days.length - 1].items.push(trackItem(t, i));
  });
  const multi = a.dates.length > 1;
  return days.map(day => `${multi && day.date ? `<h2 class="day" id="${dayId(day.date)}">${esc(day.date)}</h2>\n` : ''}<ol class="tracks">
${day.items.join('\n')}
</ol>`).join('\n');
}

function setPage(a, list, root = '../../', isHome = false) {
  const count = a.tracks.length;
  return page({
    list, current: a, root, isHome,
    title: `${a.label} | ${config.siteTitle}`,
    description: `${a.year ? `${config.siteTitle} setlist, ${a.city}` : `${config.siteTitle}: ${a.city}`}${a.event ? `, ${a.event}` : ''}. ${count} track${count === 1 ? '' : 's'}.`,
    main: `<h1>${esc(a.label)}</h1>
${a.event ? `<p class="event">${esc(a.event)}</p>` : ''}
${count ? playerBar + tracklist(a) : '<p class="empty">No tracks on this setlist yet.</p>'}`,
  });
}

// The home page is the most recent gig's setlist.
const homePage = list => setPage(list[0], list, '', true);

// About page. Edit the text here; it rebuilds with the site.
function aboutPage(list) {
  const root = '../';
  return page({
    list, current: 'about', root,
    title: `About | ${config.siteTitle}`,
    description: `About ${config.siteTitle}: how these setlists are built from the Despacio community spreadsheet.`,
    main: `<h1>About</h1>
<div class="prose">
<p>This website is built off of the
<a href="https://docs.google.com/spreadsheets/d/13JSLgoeB9lnosv_R2m4ZqYSlqM5A9y8hb4b2v_KaW7U/edit">Despacio community spreadsheet of truth</a>. This is only possible thanks to
your contributions. Thank you!</p>

<p>Setlists come from the song ID heroes of
<a href="https://discord.gg/despacio">discord.gg/despacio</a> and
<a href="https://www.reddit.com/r/despacio/">r/despacio</a>, who identify these tracks by ear in
the <a href="https://docs.google.com/spreadsheets/d/13JSLgoeB9lnosv_R2m4ZqYSlqM5A9y8hb4b2v_KaW7U/edit">spreadsheet of truth</a>.
This is a fan project, not affiliated with Despacio, Soulwax, 2manydjs or James Murphy.</p>

<h2>Which residencies appear</h2>
<p>If you do not see a residency, it's because it has less than 25 identified tracks. Once the
community spreadsheet has reached that threshold, the residency will appear on the site.</p>

<h2>Edits and versions</h2>
<p>If a song is labeled a "2manydjs Edit", "Despacio Edit", or "Unknown Version" the site
defaults to the original song. The tracklist still shows the title exactly as the community
wrote it.</p>

<h2>Tracks marked Unknown</h2>
<p>Tracks the community hasn't identified yet are listed in their place in the set as
"Unknown - Unknown", so the running order stays true to the night. When someone identifies one
in the spreadsheet, it appears here with its title, and a link follows soon after.</p>

<h2>Where the links come from</h2>
<p>Links are found automatically by searching YouTube for each song, and shared between gigs
when the same song is played more than once. Some tracks have no link yet, and some songs
simply aren't on YouTube.</p>

<h2>Fixing a link</h2>
<p>If a link is wrong or broken, use <strong>Wrong link?</strong> next to the track and paste a
better one. Tracks with no link have <strong>Add link</strong> instead. Your change appears for
everyone within the hour, and it also fixes the same song at other gigs. Only the link can be
changed here; artists and titles come from the spreadsheet.</p>

<h2>Playing a set</h2>
<p>Each track plays its own YouTube video. Turn on <strong>Autoplay</strong> in the player bar
and the next track with a link starts when one ends, so a set can keep playing in the
background. Playback stops after the last track with a link.</p>

<h2>How often this updates</h2>
<p>The spreadsheet is read every hour, so new tracks and corrections appear the same day.
New links are found overnight.</p>

</div>`,
  });
}

/* ---------- build ---------- */

async function build() {
  if (config.pubId.startsWith('PASTE')) throw new Error('Fill in pubId, appearancesGid and tracksGid in config.json.');

  const [apps, tracks] = await Promise.all([
    loadCSV(config.appearancesGid, 'Appearances'),
    loadCSV(config.tracksGid, 'Tracks'),
  ]);

  const byGid = {};
  tracks.forEach(t => { (byGid[t['gid']] ||= []).push(t); });

  const used = new Set();
  const list = apps
    .filter(r => r['gid'] && (r['city'] || cityName(r['tab'])))
    .map(r => {
      let slug = slugify(r['slug'] || r['tab'] || '') || r['gid'];
      if (used.has(slug)) slug = `${slug}-${r['gid']}`;
      used.add(slug);
      return {
        gid: r['gid'], slug,
        city: r['city'] || cityName(r['tab']),
        label: [r['city'] || cityName(r['tab']), r['year']].filter(Boolean).join(' '),
        event: r['event'],
        order: parseFloat(r['order']) || 0,
        // Order comes from the sheet script's Position column (Unique ID order, or row
        // order for older tabs without IDs); Unique ID is the fallback.
        tracks: (byGid[r['gid']] || []).sort((a, b) =>
          (parseFloat(a['position']) - parseFloat(b['position'])) || byId(a['unique id'], b['unique id'])),
      };
    })
    .map(a => ({ ...a, dates: [...new Set(a.tracks.map(t => t['date']).filter(Boolean))] }))
    // Gigs with fewer than minTracks tracks (default 25) don't appear.
    .filter(a => a.tracks.length >= (Number(config.minTracks) || 1))
    .sort((a, b) => b.order - a.order); // newest first

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, 'sets'), { recursive: true });
  await cp('assets', join(OUT, 'assets'), { recursive: true });
  await writeFile(join(OUT, '.nojekyll'), '');
  if (!list.length) throw new Error(`No gigs with at least ${config.minTracks || 1} tracks found in the Tracks tab.`);
  await writeFile(join(OUT, 'index.html'), homePage(list));

  await mkdir(join(OUT, 'about'), { recursive: true });
  await writeFile(join(OUT, 'about', 'index.html'), aboutPage(list));

  for (let i = 0; i < list.length; i++) {
    const dir = join(OUT, 'sets', list[i].slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), setPage(list[i], list));
  }
  console.log(`Built ${list.length} appearance pages and ${tracks.length} tracks into ${OUT}/`);
}

function serve() {
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
  createServer(async (req, res) => {
    let path = join(OUT, decodeURIComponent(req.url.split('?')[0]));
    if (path.endsWith('/')) path = join(path, 'index.html');
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end('Not found'); }
  }).listen(8080, () => console.log('Preview at http://localhost:8080'));
}

try {
  await build();
  if (process.argv.includes('--serve')) serve();
} catch (e) {
  console.error(`Build failed: ${e.message}`);
  process.exit(1); // a failed build leaves the last good version of the site online
}
