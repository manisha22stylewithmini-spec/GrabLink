// Video downloader server — no npm dependencies. Requires yt-dlp (and ffmpeg for merging) on PATH.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const TIMEOUT_MS = 5 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Only allow public http(s) URLs so the server can't be pointed at local/internal services.
function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'That does not look like a valid link.'; }
  if (!/^https?:$/.test(u.protocol)) return 'Only http(s) links are supported.';
  const h = u.hostname.replace(/^\[|\]$/g, '');
  const ipv = net.isIP(h);
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return 'Local addresses are not allowed.';
  if (ipv === 4 && /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return 'Private addresses are not allowed.';
  if (ipv === 6 && /^(::1?$|f[cd]|fe80)/i.test(h)) return 'Private addresses are not allowed.';
  return null;
}

// Optional: GRAB_COOKIES_BROWSER=chrome npm start  -> use that browser's login, so private/login-only posts (Instagram etc.) work on your own computer.
const COOKIES = process.env.GRAB_COOKIES_BROWSER ? ['--cookies-from-browser', process.env.GRAB_COOKIES_BROWSER] : [];

function run(args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', [...COOKIES, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? 'yt-dlp is not installed on the server.' : e.message)); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(friendlyError(err)));
    });
  });
}

function friendlyError(stderr) {
  const line = stderr.split('\n').reverse().find(l => l.startsWith('ERROR')) || stderr.trim().split('\n').pop() || 'Download failed.';
  const msg = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').trim();
  if (/login|private|sign in|cookies/i.test(msg)) return 'This video is private or requires a login, so it cannot be downloaded.';
  if (/no video formats|no video could be found/i.test(msg)) return 'No video was found at that link. GrabLink saves videos, and this looks like a photo or text post.';
  if (/unsupported url/i.test(msg)) return 'No downloadable video was found at that link.';
  return msg.slice(0, 300);
}


// Photo pins: a Pinterest pin with no video is a photo, so offer the photo instead of an error.
const meta = (html, prop) => {
  for (const tag of html.match(/<meta\b[^>]*>/g) || []) {
    if (new RegExp(`(?:property|name)="${prop}"`).test(tag)) { const m = /content="([^"]*)"/.exec(tag); if (m) return m[1].replace(/&amp;/g, '&'); }
  }
  return '';
};
async function pinterestPhoto(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    const host = new URL(r.url).hostname.toLowerCase();
    if (!(host === 'pinterest.com' || host.endsWith('.pinterest.com'))) return null;
    const html = await r.text();
    const img = meta(html, 'og:image');
    if (!/^https:\/\/[\w.-]*pinimg\.com\//.test(img)) return null;
    const big = img.replace(/\/\d+x\//, '/originals/');
    const ok = (await fetch(big, { method: 'HEAD' }).catch(() => null))?.ok;
    const title = (meta(html, 'og:title').split('|')[0].trim().split('\n')[0].trim().slice(0, 80)) || 'Pinterest photo';
    return { title, uploader: '', thumbnail: img, duration: null, source: 'Pinterest', options: [{ label: ok ? 'Photo (original size)' : 'Photo', url: ok ? big : img, ext: 'jpg', kind: 'image' }] };
  } catch { return null; }
}

// Streams a media file from a known media host through this server (same job as api/dl.js on the live site).
const DL_ALLOWED = ['pinimg.com', 'twimg.com', 'cdninstagram.com', 'fbcdn.net', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com', 'googlevideo.com', 'vimeocdn.com', 'redd.it'];
const dlOk = raw => { try { const u = new URL(raw); const h = u.hostname.toLowerCase(); return u.protocol === 'https:' && DL_ALLOWED.some(d => h === d || h.endsWith('.' + d)) ? u : null; } catch { return null; } };
async function handleDl(req, res, p) {
  let target = dlOk(p.get('u') || '');
  if (!target) return json(res, 400, { error: 'That file is not on a supported site.' });
  let up;
  for (let i = 0; i < 4; i++) {
    up = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: dlOk(p.get('r') || '')?.href || target.origin + '/' }, redirect: 'manual' }).catch(() => null);
    if (!up) return json(res, 502, { error: 'Could not reach the video host.' });
    if (up.status >= 300 && up.status < 400 && up.headers.get('location')) { target = dlOk(new URL(up.headers.get('location'), target).href); if (!target) return json(res, 400, { error: 'The video moved somewhere we cannot fetch from.' }); continue; }
    break;
  }
  if (!up.ok || !up.body) return json(res, 403, { error: 'The site refused the download.' });
  const ext = (p.get('e') || 'mp4').replace(/[^\w]/g, '').slice(0, 5) || 'mp4';
  const name = (p.get('n') || 'video').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'video';
  const headers = { 'Content-Type': { jpg: 'image/jpeg', mp4: 'video/mp4', mp3: 'audio/mpeg', m4a: 'audio/mp4' }[ext] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}.${ext}"` };
  if (up.headers.get('content-length')) headers['Content-Length'] = up.headers.get('content-length');
  res.writeHead(200, headers);
  require('stream').Readable.fromWeb(up.body).pipe(res);
}

async function handleInfo(req, res, url) {
  const bad = validateUrl(url);
  if (bad) return json(res, 400, { error: bad });
  try {
    const out = await run(['-J', '--no-playlist', '--no-warnings', url], { timeout: 60000 });
    const info = JSON.parse(out);
    const heights = [...new Set((info.formats || []).filter(f => f.vcodec && f.vcodec !== 'none' && f.height).map(f => f.height))].sort((a, b) => b - a);
    json(res, 200, {
      title: info.title || 'video',
      uploader: info.uploader || info.channel || '',
      thumbnail: info.thumbnail || '',
      duration: info.duration || null,
      source: info.extractor_key || '',
      heights,
      hasVideo: heights.length > 0 || (info.vcodec && info.vcodec !== 'none'),
    });
  } catch (e) {
    if (/no video formats|no video was found/i.test(e.message)) { const photo = await pinterestPhoto(url); if (photo) return json(res, 200, photo); }
    json(res, 422, { error: e.message });
  }
}

// Keyword search. YouTube is searchable with yt-dlp; the other platforms only allow search on their own site,
// so for those we hand back a link to their search page.
const EXTERNAL = {
  instagram: ['Instagram', 'https://www.instagram.com/explore/search/keyword/?q={q}'],
  tiktok: ['TikTok', 'https://www.tiktok.com/search/video?q={q}'],
  pinterest: ['Pinterest', 'https://www.pinterest.com/search/videos/?q={q}'],
  x: ['X', 'https://x.com/search?q={q}%20filter%3Avideos&f=live'],
  dribbble: ['Dribbble', 'https://dribbble.com/search/{q}'],
  facebook: ['Facebook', 'https://www.facebook.com/search/videos/?q={q}'],
  linkedin: ['LinkedIn', 'https://www.linkedin.com/search/results/content/?keywords={q}'],
};
const searchLinks = (q, only) => Object.entries(EXTERNAL)
  .filter(([k]) => !only || k === only)
  .map(([key, [platform, tpl]]) => ({ platform, key, url: tpl.replace('{q}', encodeURIComponent(q)) }));

async function handleSearch(req, res, params) {
  const q = (params.get('q') || '').trim().slice(0, 80);
  const platform = (params.get('platform') || 'all').toLowerCase();
  if (!q) return json(res, 400, { error: 'Type something to search for.' });
  if (EXTERNAL[platform]) return json(res, 200, { q, platform, items: [], external: searchLinks(q, platform) });
  let items = [];
  try {
    const info = JSON.parse(await run(['--flat-playlist', '-J', '--no-warnings', `ytsearch12:${q}`], { timeout: 40000 }));
    items = (info.entries || []).filter(e => e.id).map(e => ({
      title: e.title || 'Video',
      url: /^https?:/.test(e.url || '') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      channel: e.channel || e.uploader || '',
      duration: e.duration || null,
      platform: 'YouTube',
    }));
  } catch {}
  if (!items.length && platform === 'youtube') return json(res, 502, { error: 'Search is busy right now. Try again in a moment.' });
  json(res, 200, { q, platform, items, external: platform === 'all' ? searchLinks(q) : [] });
}

async function handleDownload(req, res, params) {
  const url = params.get('url') || '';
  const quality = params.get('quality') || 'best';
  const bad = validateUrl(url);
  if (bad) return json(res, 400, { error: bad });

  let fmt, ext;
  if (quality === 'audio') { fmt = 'bestaudio/best'; ext = 'mp3'; }
  else {
    const h = parseInt(quality, 10);
    fmt = Number.isFinite(h) ? `bv*[height<=${h}]+ba/b[height<=${h}]/b` : 'bv*+ba/b';
    ext = 'mp4';
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  const args = ['--no-playlist', '--no-warnings', '-f', fmt, '-o', path.join(dir, 'out.%(ext)s'), '--max-filesize', '2G'];
  if (ext === 'mp3') args.push('-x', '--audio-format', 'mp3');
  else args.push('--merge-output-format', 'mp4', '--remux-video', 'mp4');
  args.push(url);

  try {
    await run(args);
    const file = fs.readdirSync(dir).find(f => f.startsWith('out.'));
    if (!file) throw new Error('Download produced no file.');
    const full = path.join(dir, file);
    const size = fs.statSync(full).size;
    const title = (params.get('title') || 'video').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'video';
    res.writeHead(200, {
      'Content-Type': ext === 'mp3' ? 'audio/mpeg' : 'video/mp4',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${title}.${path.extname(file).slice(1)}"`,
    });
    const rs = fs.createReadStream(full);
    rs.pipe(res);
    res.on('close', cleanup);
  } catch (e) {
    cleanup();
    json(res, 422, { error: e.message });
  }
}

http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname === '/api/info') return handleInfo(req, res, u.searchParams.get('url') || '');
  if (u.pathname === '/api/download') return handleDownload(req, res, u.searchParams);
  if (u.pathname === '/api/search') return handleSearch(req, res, u.searchParams);
  if (u.pathname === '/api/dl') return handleDl(req, res, u.searchParams);

  const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`Already running: open http://${HOST}:${PORT}  (to restart it, stop the old one first)`); process.exit(0); }
  throw e;
}).listen(PORT, HOST, () => console.log(`Video downloader running at http://${HOST}:${PORT}`));
