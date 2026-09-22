# Despacio Tracklists

A setlist site for every Despacio gig, built from the community's
[Despacio Song IDs spreadsheet (TSOT)](https://docs.google.com/spreadsheets/d/13JSLgoeB9lnosv_R2m4ZqYSlqM5A9y8hb4b2v_KaW7U/edit),
assembled by the song ID heroes of discord.gg/despacio and r/despacio. Each gig gets its own
page, with a YouTube player for every identified track.

## How it works

```
Community sheet (TSOT)  →  Links sheet (yours)  →  GitHub build  →  Website
     read only            hourly sync + nightly     hourly            GitHub Pages
                          YouTube search
```

- **Community sheet**: the source of truth for setlists. Never edited by this project.
- **Links sheet**: a Google Sheet you own. Its Apps Script copies every city tab
  (named like `21-Miami`) into a **Tracks** tab every hour, finds YouTube links nightly,
  and receives links that visitors submit on the site.
- **GitHub Actions**: every hour, `build.mjs` reads the published links sheet and writes
  one page per gig to GitHub Pages.

## Setup

Do these in order. Steps 1–4 happen in Google; steps 5–7 in this repo.

### 1. Create the links sheet

1. Create a new, empty Google Sheet (for example, "DESPACIO links").
2. Go to **Extensions → Apps Script**. Select everything in `Code.gs` (including
   `function myFunction()`) and delete it.
3. In this repo on GitHub, open `apps-script/setlist-tools.gs` and click **Copy raw file**
   (the two-squares icon above the code). Paste the whole file into `Code.gs` and save.
   It should start with `/**` followed by `* Setlist tools — runs in YOUR OWN Google Sheet`.
4. In the Apps Script editor, click the **+** next to **Services**, choose **YouTube Data API v3**,
   and click **Add**. If the dialog won't open (common when signed into several Google
   accounts), use the manifest instead: **Project Settings (gear) → Show "appsscript.json"
   manifest file in editor**. Open `appsscript.json` (not `Code.gs`), replace everything in it
   with the following, and save:
   ```json
   {
     "timeZone": "America/Los_Angeles",
     "dependencies": {
       "enabledAdvancedServices": [
         {
           "userSymbol": "YouTube",
           "serviceId": "youtube",
           "version": "v3"
         }
       ]
     },
     "exceptionLogging": "STACKDRIVER",
     "runtimeVersion": "V8"
   }
   ```
5. In the function dropdown next to **Run**, choose **onOpen** and click **Run**. Approve the
   permissions (**Advanced → Go to … (unsafe) → Allow**; this warning is normal for your own
   script). Switch to the Google Sheet's tab: a **Setlist tools** menu is now in the menu bar.
   From now on it appears automatically whenever the sheet opens.

`SOURCE_ID` at the top of the script already points at the community sheet.

### 2. Run the first sync

1. Choose **Setlist tools → Set up automatic updates**.
2. Approve the permissions Google asks for (reading the community sheet, YouTube, running on a schedule).

This runs the first sync right away and creates two tabs:

- **Appearances**: one row per gig (city, year, event, page address).
- **Tracks**: every track from every city tab, ordered by Unique ID.

From then on, it syncs every hour and searches YouTube every night around 3am.
To get links sooner, choose **Setlist tools → Find YouTube links now**
(about 90 tracks per run, because of YouTube's free daily quota).

### 3. Publish the links sheet

1. Go to **File → Share → Publish to web**.
2. Choose **Entire document** and **Comma-separated values (.csv)**, then click **Publish**.
3. From the link it shows, copy the long ID between `/d/e/` and `/pub`. This is your `pubId`.
4. Open the **Appearances** tab and copy the number after `gid=` in the browser's address bar.
   Do the same for the **Tracks** tab. These are `appearancesGid` and `tracksGid`.

### 4. Turn on link submissions

1. In the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon, choose **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone
3. Click **Deploy** and approve the permissions.
4. Copy the **Web app URL** (starts with `https://script.google.com/macros/s/`). This is your `submitUrl`.

### 5. Fill in `config.json`

```json
{
  "pubId": "from step 3",
  "appearancesGid": "from step 3",
  "tracksGid": "from step 3",
  "submitUrl": "from step 4",
  "siteTitle": "Despacio Tracklists",
  "minTracks": 25
}
```

Commit and push.

### 6. Turn on GitHub Pages

1. In this repo, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

### 7. Run the first build

1. Go to the **Actions** tab, choose **Build setlist pages**, and click **Run workflow**.
2. When it finishes (about a minute), the site is live at
   `https://<your-username>.github.io/<repo-name>/`.

After this, the site rebuilds every hour and on every push.

## Day-to-day

Most things happen on their own:

- **New tracks or corrections in the community sheet** reach the site within about two hours
  (hourly sync, then hourly build).
- **New gigs** appear automatically when the community adds a tab named like `22-City`.
  The year comes from the tab's Date column. To add the event name and dates under the
  heading, add the gig to `GIGS` at the top of the Apps Script (by tab number). For an
  upcoming gig whose tab doesn't exist yet, add it to `GIGS_BY_DATE` instead: it's matched
  by the dates in the new tab's Date column, whatever the tab is called.
- **Visitors fix wrong links** with **Wrong link? → Replace this link** on the site.
  Every change is logged in the **Submissions** tab of the links sheet. To undo one,
  paste the old link back into the Tracks tab.

## Rules the site follows

- Only tabs named `number-city` (like `21-Miami`) become pages. All other tabs are ignored.
- Gigs with fewer than 25 tracks don't appear (`minTracks` in `config.json`).
- Tracks titled as a 2manydjs Edit, Despacio Edit, Unknown Version or Unknown Edit are searched as the original song.
- Gigs appear newest first. Each city expands to show its dates (MM/DD/YYYY).
- Tracks are ordered by Unique ID. Rows without a Unique ID, and notes rows, are left out.
- Tracks marked Unknown for both artist and title show as "Unknown - Unknown" and are never searched.
- Once a track has a YouTube link, it is never searched again.
- A song played at several gigs shares one link.
- Link priority: a visitor's submitted link, then a link fans added in the community sheet,
  then the automatic search.

## Troubleshooting

- **Build fails with "Fill in pubId…"**: `config.json` still has placeholders (step 5).
- **Build fails with "returned a web page, not CSV"**: the links sheet isn't published,
  or a gid is wrong (step 3).
- **The site stopped updating**: GitHub pauses scheduled builds after 60 days with no
  commits. Click **Run workflow** or push any change.
- **Link submissions stopped working after a script change**: in Apps Script, go to
  **Deploy → Manage deployments → Edit**, choose **New version**, and click **Deploy**.
- **A city tab is missing from the site**: the sync message lists tabs it skipped for
  missing Unique ID, Artist or Title columns.

## Preview locally

```bash
node build.mjs --serve
```

Then open http://localhost:8080. Requires Node 20 or later; nothing to install.

## Files

| File | What it does |
|---|---|
| `apps-script/setlist-tools.gs` | Runs in the links sheet: sync, YouTube search, link submissions |
| `build.mjs` | Builds the site from the published links sheet |
| `config.json` | Sheet IDs, submission URL, site title |
| `assets/site.css` | Page styles |
| `assets/player.js` | YouTube player and the link replacement form |
| `.github/workflows/build.yml` | Hourly build and deploy to GitHub Pages |
