// Player: each track plays its own YouTube video. The bar at the top has Previous,
// Play/Pause and Next, plus an Autoplay switch (off by default, remembered per browser).
// With Autoplay on, the next track with a link starts when a video ends, so the set can
// keep playing in a background tab. With it off, playback stops at the end of each video.
// Wrong link? / Add link: sends a new YouTube link to the sheet. Only the link can change.
(() => {
  const SUBMIT = document.body.dataset.submit;
  const bar = document.querySelector('.controls');
  const toggleBtn = bar && bar.querySelector('[data-action="toggle"]');
  const nowEl = bar && bar.querySelector('.now');
  const autoplayBox = bar && bar.querySelector('.autoplay input');

  let api = null;       // YouTube IFrame API, loaded on first play
  let player = null;    // the YT.Player for the current track
  let current = null;   // the .track element that's loaded
  let playing = false;

  // Autoplay preference, remembered in this browser only.
  try { if (autoplayBox) autoplayBox.checked = localStorage.getItem('autoplay') === 'on'; } catch (e) {}
  autoplayBox && autoplayBox.addEventListener('change', () => {
    try { localStorage.setItem('autoplay', autoplayBox.checked ? 'on' : 'off'); } catch (e) {}
  });
  const autoplayOn = () => !!(autoplayBox && autoplayBox.checked);

  // Every track with a link, in setlist order (re-read each time, since links can be added).
  const playlist = () => [...document.querySelectorAll('.track')].filter(t => t.querySelector('.sources .play'));

  function loadApi() {
    if (!api) {
      api = new Promise(resolve => {
        window.onYouTubeIframeAPIReady = resolve;
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.append(s);
      });
    }
    return api;
  }

  function updateUi() {
    document.querySelectorAll('.sources .play').forEach(b => {
      const isCurrent = current && b.closest('.track') === current;
      b.textContent = isCurrent && playing ? 'Pause' : 'Play';
      b.setAttribute('aria-expanded', String(!!isCurrent));
    });
    document.querySelectorAll('.track.current').forEach(t => t.classList.remove('current'));
    if (current) current.classList.add('current');
    if (!bar) return;
    toggleBtn.textContent = playing ? 'Pause' : 'Play';
    const list = playlist();
    const i = current ? list.indexOf(current) : -1;
    bar.querySelector('[data-action="prev"]').disabled = i <= 0;
    bar.querySelector('[data-action="next"]').disabled = i >= list.length - 1 && i !== -1;
    if (current) {
      const pos = current.querySelector('.pos').textContent;
      const title = current.querySelector('.title').textContent;
      const artist = current.querySelector('.artist');
      nowEl.textContent = `${pos}  ${title}${artist ? `, ${artist.textContent}` : ''}`;
    } else {
      nowEl.textContent = '';
    }
  }

  function stop() {
    if (player) { try { player.destroy(); } catch (e) {} player = null; }
    document.querySelectorAll('.player').forEach(p => { p.replaceChildren(); p.hidden = true; });
    current = null;
    playing = false;
    updateUi();
  }

  function play(track, { follow = false } = {}) {
    stop();
    current = track;
    const btn = track.querySelector('.sources .play');
    const box = track.querySelector('.player');
    const holder = document.createElement('div');
    box.append(holder);
    box.hidden = false;
    updateUi();
    history.replaceState(null, '', `#${track.id}`);
    if (follow && document.visibilityState === 'visible') {
      track.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    loadApi().then(() => {
      if (!holder.isConnected) return; // another track was chosen while loading
      player = new YT.Player(holder, {
        videoId: btn.dataset.yt,
        host: 'https://www.youtube-nocookie.com',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
        events: {
          onStateChange: e => {
            if (e.data === YT.PlayerState.PLAYING) { playing = true; updateUi(); }
            else if (e.data === YT.PlayerState.PAUSED) { playing = false; updateUi(); }
            else if (e.data === YT.PlayerState.ENDED) {
              playing = false;
              updateUi();
              if (autoplayOn()) step(1);
            }
          },
          // Video removed or can't be embedded: with Autoplay on, skip it.
          onError: () => { playing = false; updateUi(); if (autoplayOn()) step(1); },
        },
      });
    });
  }

  function step(dir) {
    const list = playlist();
    if (!list.length) return;
    const i = current ? list.indexOf(current) : -1;
    const next = list[i + dir];
    if (next) play(next, { follow: true });
    else if (dir > 0) stop(); // end of the set
  }

  function togglePlay() {
    if (!current || !player) {
      const list = playlist();
      if (list.length) play(current || list[0], { follow: true });
      return;
    }
    if (playing) player.pauseVideo(); else player.playVideo();
  }

  function trackButton(btn) {
    const track = btn.closest('.track');
    if (track === current && player) togglePlay();
    else play(track);
  }

  function setLink(track, yt) {
    let btn = track.querySelector('.sources .play');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'play';
      btn.textContent = 'Play';
      btn.setAttribute('aria-expanded', 'false');
      track.querySelector('.sources').prepend(btn);
    }
    btn.dataset.yt = yt;
    if (track === current) play(track); // reload with the new video
    track.querySelector('.sources .fix').textContent = 'Wrong link?';
    updateUi();
  }

  bar && bar.addEventListener('click', e => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    if (b.dataset.action === 'toggle') togglePlay();
    if (b.dataset.action === 'prev') step(-1);
    if (b.dataset.action === 'next') step(1);
  });
  updateUi();

  function toggleForm(fixBtn) {
    const track = fixBtn.closest('.track');
    const existing = track.querySelector('.fix-form');
    if (existing) { existing.remove(); return; }

    // When the track already has a link, show it so it's clear what's being replaced.
    const current = track.querySelector('.sources .play')?.dataset.yt;
    const currentUrl = current ? `https://www.youtube.com/watch?v=${current}` : '';

    const form = document.createElement('form');
    form.className = 'fix-form';
    form.innerHTML = `
      ${current ? `<p class="fix-current">Current link: <a href="${currentUrl}" target="_blank" rel="noopener">${currentUrl}</a></p>` : ''}
      <label>${current ? 'Correct YouTube link' : 'YouTube link for this track'}
        <input type="url" name="url" required autocomplete="off" placeholder="https://www.youtube.com/watch?v=...">
      </label>
      <div class="fix-actions"><button type="submit">${current ? 'Replace this link' : 'Save link'}</button><button type="button" class="cancel">Cancel</button></div>
      <p class="fix-msg" role="status"></p>`;
    track.append(form);
    const input = form.elements.url;
    const msg = form.querySelector('.fix-msg');
    const save = form.querySelector('[type="submit"]');
    input.focus();
    form.querySelector('.cancel').addEventListener('click', () => form.remove());

    form.addEventListener('submit', async e => {
      e.preventDefault();
      save.disabled = true;
      msg.textContent = 'Checking the link...';
      try {
        const res = await fetch(SUBMIT, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight
          body: JSON.stringify({ gid: track.dataset.gid, id: track.dataset.id, url: input.value }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "The link couldn't be saved.");
        setLink(track, data.yt);
        msg.textContent = current ? 'Link replaced. Thanks for fixing it.' : 'Link saved. Thanks for adding it.';
        input.disabled = true;
        setTimeout(() => form.remove(), 2500);
      } catch (err) {
        msg.textContent = err instanceof TypeError ? "Couldn't reach the sheet. Check your connection and try again." : err.message;
        save.disabled = false;
      }
    });
  }

  // Keeps the highlighted day in the left-hand list in step with the part of the
  // setlist on screen. A day becomes current once its heading passes the upper
  // third of the window, scrolling down or up.
  const dayLinks = [...document.querySelectorAll('.cities summary[aria-current="page"] + .dates a')];
  const dayHeads = [...document.querySelectorAll('h2.day')];
  if (dayLinks.length > 1 && dayHeads.length === dayLinks.length) {
    let ticking = false;
    const update = () => {
      ticking = false;
      const line = window.innerHeight / 3;
      let current = 0;
      dayHeads.forEach((h, i) => { if (h.getBoundingClientRect().top <= line) current = i; });
      dayLinks.forEach((a, i) => {
        a.classList.toggle('active', i === current);
        if (i === current) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      });
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  document.addEventListener('click', e => {
    const playBtn = e.target.closest('.sources .play');
    if (playBtn) return trackButton(playBtn);
    const fixBtn = e.target.closest('.sources .fix');
    if (fixBtn && SUBMIT) toggleForm(fixBtn);
  });
})();
