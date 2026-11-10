// "More info" dropdown, same behaviour as on the main site
(function () {
  const btn = document.getElementById('projBtn'), list = document.getElementById('projList'), menu = document.getElementById('projMenu');
  if (!btn || !list) return;
  const setOpen = open => { list.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', () => setOpen(list.hidden));
  document.addEventListener('click', e => { if (!menu.contains(e.target)) setOpen(false); });
  menu.addEventListener('keydown', e => { if (e.key === 'Escape') { setOpen(false); btn.focus(); } });
})();

// footer social icons come from site-config.js, the same list the main site uses
(function () {
  const list = document.getElementById('socialList'), S = window.SITE || {};
  if (!list) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  list.innerHTML = (S.socials || []).filter(s => s.url && s.url !== '#' && /^https?:\/\//i.test(s.url)).map(s =>
    `<li><a class="soc" href="${esc(s.url)}" target="_blank" rel="noopener" aria-label="${esc(s.label)}"><img src="/logos/${esc(s.key)}.png" alt="" width="36" height="36"></a></li>`).join('');
})();
