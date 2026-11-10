"""Vercel serverless function: resolve a page link to direct, downloadable media URLs with yt-dlp."""
import json
import ipaddress
import re
from http.server import BaseHTTPRequestHandler
import urllib.request
from urllib.parse import urlparse, parse_qs, urljoin

import yt_dlp


def validate(raw):
    try:
        u = urlparse(raw)
    except Exception:
        return "That does not look like a valid link."
    if u.scheme not in ("http", "https") or not u.hostname:
        return "Only http(s) links are supported."
    h = u.hostname.lower()
    if h == "localhost" or h.endswith((".localhost", ".local", ".internal")):
        return "Local addresses are not allowed."
    try:
        ip = ipaddress.ip_address(h)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return "Private addresses are not allowed."
    except ValueError:
        pass
    return None


def friendly(msg):
    msg = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", msg.strip())
    low = msg.lower()
    if any(k in low for k in ("login", "private", "sign in", "cookies", "confirm you")):
        return "This video is private, needs a login, or the site is blocking this server, so it cannot be downloaded."
    if "no video formats" in low or "no video could be found" in low:
        return "No video was found at that link. GrabLink saves videos, and this looks like a photo or text post."
    if "unsupported url" in low:
        return "No downloadable video was found at that link."
    return msg[:300] or "Could not read that link."


def _get(url, method="GET", timeout=8):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=timeout)


def pinterest_file(playlist_url):
    """Pinterest lists HLS playlists, but when a quality is one fragmented-MP4 file the playlist names it.
    Read the real file name from the playlist (it is not always the playlist name with a new ending) and check it exists."""
    if not re.match(r"https://[\w.-]*pinimg\.com/", playlist_url):
        return None
    try:
        text = _get(playlist_url).read(200000).decode("utf-8", "ignore")
        segs = {l.strip() for l in text.splitlines() if l.strip() and not l.startswith("#")}
        init = re.search(r'#EXT-X-MAP:URI="([^"]+)"', text)
        if len(segs) != 1 or (init and init.group(1) not in segs):
            return None  # several separate pieces: needs merging, which the hosted site cannot do
        url = urljoin(playlist_url, segs.pop())
        if not re.match(r"https://[\w.-]*pinimg\.com/", url):
            return None
        return url if _get(url, "HEAD").status == 200 else None
    except Exception:
        return None


def pinterest_streams(formats):
    best = {}
    for f in formats:
        u = f.get("url") or ""
        if f.get("protocol") == "m3u8_native" and u.endswith(".m3u8") and f.get("vcodec") not in (None, "none"):
            h = f.get("height") or 0
            if h not in best or (f.get("tbr") or 0) > (best[h].get("tbr") or 0):
                best[h] = f
    options = []
    for h in sorted(best, reverse=True):
        file_url = pinterest_file(best[h]["url"])
        if file_url:
            options.append({"label": f"{h}p" if h else "Video", "url": file_url, "ext": "mp4", "kind": "video"})
    if options:
        options[0]["label"] = "Best quality" + (f" ({options[0]['label']})" if options[0]["label"] != "Video" else "")
    return options


def _meta(html, prop):
    for tag in re.findall(r"<meta\b[^>]*>", html):
        if re.search(r'(?:property|name)="' + re.escape(prop) + '"', tag):
            m = re.search(r'content="([^"]*)"', tag)
            if m:
                return m.group(1).replace("&amp;", "&")
    return ""


def pinterest_photo(url):
    """A Pinterest pin with no video is a photo. Offer the photo instead of a confusing error."""
    try:
        resp = _get(url, timeout=10)
        host = (urlparse(resp.geturl()).hostname or "").lower()
        if not (host == "pinterest.com" or host.endswith(".pinterest.com")):
            return None
        html = resp.read(2_000_000).decode("utf-8", "ignore")
        img = _meta(html, "og:image")
        if not re.match(r"https://[\w.-]*pinimg\.com/", img):
            return None
        big = re.sub(r"/\d+x/", "/originals/", img)
        try:
            ok = _get(big, "HEAD").status == 200
        except Exception:
            ok = False
        title = (_meta(html, "og:title").split("|")[0].strip().splitlines() or [""])[0].strip()[:80] or "Pinterest photo"
        return {
            "title": title, "uploader": "", "thumbnail": img, "duration": None, "source": "Pinterest",
            "options": [{"label": "Photo (original size)" if ok else "Photo", "url": big if ok else img, "ext": "jpg", "kind": "image"}],
        }
    except Exception:
        return None


def build(info):
    formats = info.get("formats") or [info]
    direct = lambda f: f.get("url") and f.get("protocol") in ("https", "http")
    both = [f for f in formats if direct(f) and f.get("vcodec") not in (None, "none") and f.get("acodec") not in (None, "none")]
    by_height = {}
    for f in both:
        h = f.get("height") or 0
        cur = by_height.get(h)
        if not cur or (f.get("tbr") or 0) > (cur.get("tbr") or 0):
            by_height[h] = f
    options = []
    for h in sorted(by_height, reverse=True):
        f = by_height[h]
        options.append({"label": f"{h}p" if h else "Video", "url": f["url"], "ext": f.get("ext") or "mp4", "kind": "video"})
    if options:
        options[0]["label"] = "Best quality" + (f" ({options[0]['label']})" if options[0]["label"] != "Video" else "")
    if not options:
        options = pinterest_streams(formats)
    audio = [f for f in formats if direct(f) and f.get("vcodec") in (None, "none") and f.get("acodec") not in (None, "none")]
    if audio:
        a = max(audio, key=lambda f: f.get("abr") or 0)
        options.append({"label": "Audio only", "url": a["url"], "ext": a.get("ext") or "m4a", "kind": "audio"})
    return options


class handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = (parse_qs(urlparse(self.path).query).get("url") or [""])[0].strip()
        bad = validate(url)
        if bad:
            return self._send(400, {"error": bad})
        try:
            with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True, "socket_timeout": 15}) as ydl:
                info = ydl.extract_info(url, download=False)
            options = build(info)
            if not options:
                return self._send(422, {"error": "No directly downloadable video file was found at that link."})
            self._send(200, {
                "title": info.get("title") or "video",
                "uploader": info.get("uploader") or info.get("channel") or "",
                "thumbnail": info.get("thumbnail") or "",
                "duration": info.get("duration"),
                "source": info.get("extractor_key") or "",
                "options": options,
            })
        except Exception as e:
            if "no video formats" in str(e).lower():
                photo = pinterest_photo(url)
                if photo:
                    return self._send(200, photo)
            self._send(422, {"error": friendly(str(e)), "detail": re.sub(r"\x1b\[[0-9;]*m", "", str(e))[:300]})
