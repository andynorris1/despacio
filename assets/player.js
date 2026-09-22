// Play: loads that track's YouTube video. One plays at a time, and nothing starts on its own.
// Wrong link? / Add link: sends a new YouTube link to the sheet. Only the link can change.
(() => {
  const SUBMIT = document.body.dataset.submit;

  function closePlayers() {
    document.querySelectorAll('.player').forEach(p => { p.replaceChildren(); p.hidden = true; });
    document.querySelectorAll('.sources .play').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }

  function play(btn) {
    const track = btn.closest('.track');
    const wasOpen = btn.getAttribute('aria-expanded') === 'true';
    closePlayers();
    if (wasOpen) return;
    const f = document.createElement('iframe');
    f.src = `https://www.youtube-nocookie.com/embed/${btn.dataset.yt}?autoplay=1&rel=0`;
    f.title = 'YouTube player';
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.allowFullscreen = true;
    const box = track.querySelector('.player');
    box.append(f);
    box.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    history.replaceState(null, '', `#${track.id}`);
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
    const open = btn.getAttribute('aria-expanded') === 'true';
    if (open) { btn.setAttribute('aria-expanded', 'false'); play(btn); } // reload with the new video
    track.querySelector('.sources .fix').textContent = 'Wrong link?';
  }

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
    if (playBtn) return play(playBtn);
    const fixBtn = e.target.closest('.sources .fix');
    if (fixBtn && SUBMIT) toggleForm(fixBtn);
  });
})();
