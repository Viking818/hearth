// Hearth's web page: the language a visitor reads, the download button for their computer, and the newest version.
(() => {
  const lang = document.body.dataset.lang;
  const remember = (v) => {
    try {
      localStorage.setItem('hearth-lang', v);
    } catch {}
  };
  const chosen = (() => {
    try {
      return localStorage.getItem('hearth-lang');
    } catch {
      return null;
    }
  })();

  // A visitor whose browser is in Russian gets the Russian page, unless they picked a language here before.
  if (lang === 'en' && !chosen && /^ru\b/i.test(navigator.language || '')) {
    location.replace('ru/' + location.hash);
    return;
  }
  for (const a of document.querySelectorAll('[data-lang-link]')) {
    a.addEventListener('click', () => remember(lang === 'en' ? 'ru' : 'en'));
  }

  // Which computer is this? Phones and tablets keep the plain "Download" button that leads to the list of files.
  const ua = navigator.userAgent || '';
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // an iPad says it is a Mac
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || touchMac;
  const os = mobile ? '' : /Windows/i.test(ua) ? 'win' : /Macintosh|Mac OS X/i.test(ua) ? 'mac' : '';

  const main = document.querySelector('[data-main-download]');
  const hint = document.querySelector('[data-hint]');
  const assetLink = (key) => document.querySelector(`[data-asset="${key}"]`);
  function pointMain() {
    if (!os || !main) return;
    const from = assetLink(os === 'win' ? 'setup' : 'mac');
    if (!from) return;
    main.href = from.href;
    main.querySelector('span').textContent = main.dataset[os];
    if (hint) hint.textContent = hint.dataset[os];
  }
  pointMain();
  if (os) {
    for (const card of document.querySelectorAll(`.file[data-os="${os}"]`)) card.classList.add('yours');
  }

  // The newest version, straight from GitHub. If that fails, the links written into the page still work.
  fetch('https://api.github.com/repos/Viking818/hearth/releases/latest', { headers: { accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel || !Array.isArray(rel.assets)) return;
      const pick = {
        setup: rel.assets.find((a) => /^Hearth-Setup-.*\.exe$/.test(a.name)),
        zip: rel.assets.find((a) => /^Hearth-Windows-.*\.zip$/.test(a.name)),
        mac: rel.assets.find((a) => /mac-arm64\.zip$/.test(a.name)),
      };
      for (const [key, a] of Object.entries(pick)) {
        if (!a || !/^https:\/\/github\.com\/Viking818\/hearth\/releases\/download\//.test(a.browser_download_url)) continue;
        const link = assetLink(key);
        if (link) link.href = a.browser_download_url;
        const size = document.querySelector(`[data-size="${key}"]`);
        if (size && a.size) size.textContent = String(Math.round(a.size / 1e6));
      }
      const version = String(rel.tag_name || '').replace(/^v/, '');
      if (/^\d+\.\d+\.\d+$/.test(version)) for (const el of document.querySelectorAll('[data-version]')) el.textContent = version;
      pointMain();
    })
    .catch(() => {});
})();
