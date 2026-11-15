#!/usr/bin/env python3
"""Reads one public HTTPS page with Scrapling and prints one JSON object.

Started by src/scrapling.js as `<venv python> -I py/scrapling_worker.py`. The request comes on stdin as JSON:

    {"op": "read", "url": "https://...", "timeout_s": 25, "max_bytes": 2097152, "max_chars": 30000,
     "max_redirects": 5, "proxy": ""}
    {"op": "version"}

The answer is exactly one JSON object on stdout. Anything Scrapling or curl print goes to stderr, never stdout.

Safety, in this file (the Node side only does a quick first check):
- https only, port 443 only, no user:password in the URL.
- Every hostname is resolved here, and every address it resolves to must be on the public internet (IPv4 and IPv6,
  including IPv4 hidden inside IPv6). One private answer refuses the whole name.
- The connection is pinned to the address that was checked (curl RESOLVE), so a second DNS answer cannot move it.
- Redirects are not followed by curl. Each Location is checked again from scratch, at most max_redirects times.
- The body is counted while it downloads and the transfer is cut at max_bytes.
- robots.txt is honoured for the page's path.
- 401/403, login forms and CAPTCHA pages are reported as such, not returned as page text.
"""

import ipaddress
import json
import logging
import re
import socket
import sys
import time
from urllib.parse import urljoin, urlsplit

REAL_STDOUT = sys.stdout
# Libraries that print must not corrupt the one JSON line.
sys.stdout = sys.stderr
# Scrapling logs every URL it fetches. Those are the user's links: keep them out of logs.
logging.getLogger("scrapling").setLevel(logging.CRITICAL)

ALLOWED_PORTS = {443}
MAX_URL = 2048
ROBOTS_MAX_BYTES = 256 * 1024
HTML_TYPES = ("text/html", "application/xhtml+xml")
ROBOTS_AGENT = "Helper"
# Certificate check. Always on; the self-test points it at its own fixture certificate.
VERIFY = True

# NAT64 and other prefixes that carry an IPv4 address inside an IPv6 one.
EMBEDS_V4 = [ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48")]


class Fail(Exception):
    def __init__(self, kind, message, **extra):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.extra = extra


def is_public_ip(value):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    if ip.version == 6:
        if ip.ipv4_mapped:
            return is_public_ip(str(ip.ipv4_mapped))
        if ip.sixtofour:
            return is_public_ip(str(ip.sixtofour))
        if ip.teredo:
            return False
        if any(ip in net for net in EMBEDS_V4):
            return False
    return ip.is_global and not ip.is_multicast and not ip.is_reserved and not ip.is_unspecified


def check_url(url):
    """Returns (host, port) for an allowed URL or raises Fail('forbidden_url')."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL:
        raise Fail("forbidden_url", "כתובת חסרה או ארוכה מדי")
    if any(c in url for c in "\r\n\t\0 "):
        raise Fail("forbidden_url", "תווים אסורים בכתובת")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise Fail("forbidden_url", "כתובת לא תקינה")
    if parts.scheme.lower() != "https":
        raise Fail("forbidden_url", "רק כתובות https")
    if parts.username is not None or parts.password is not None:
        raise Fail("forbidden_url", "כתובת עם שם משתמש או סיסמה אסורה")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise Fail("forbidden_url", "אין שם אתר בכתובת")
    port = port or 443
    if port not in ALLOWED_PORTS:
        raise Fail("forbidden_url", f"פורט {port} חסום, רק 443")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan", ".home.arpa")):
        raise Fail("forbidden_url", "כתובת פנימית חסומה")
    try:
        ipaddress.ip_address(host)
        literal = True
    except ValueError:
        literal = False
    if literal and not is_public_ip(host):
        raise Fail("forbidden_url", "כתובת IP פרטית או שמורה חסומה")
    if not literal and "." not in host:
        raise Fail("forbidden_url", "שם מחשב בלי דומיין חסום")
    return host, port


def resolve(host, port, resolver, proxied):
    """All addresses for host, each checked. Returns the address to connect to, or None when a proxy resolves."""
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass
    try:
        infos = resolver(host, port, 0, socket.SOCK_STREAM)
    except socket.gaierror:
        # Behind a declared egress proxy the proxy resolves names; locally there may be no DNS at all.
        if proxied:
            return None
        raise Fail("network", "שם האתר לא נמצא ב-DNS")
    addresses = []
    for info in infos:
        addr = info[4][0].split("%")[0]
        if addr not in addresses:
            addresses.append(addr)
    if not addresses:
        raise Fail("network", "שם האתר לא נמצא ב-DNS")
    bad = [a for a in addresses if not is_public_ip(a)]
    if bad:
        raise Fail("forbidden_url", "שם האתר מצביע לכתובת פרטית או שמורה")
    return addresses[0]


def charset_of(content_type, head):
    m = re.search(r"charset=([\w.-]+)", content_type or "", re.I)
    if not m:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w.-]+)", head, re.I)
        name = m.group(1).decode("ascii", "ignore") if m else "utf-8"
    else:
        name = m.group(1)
    try:
        "".encode(name)
        return name
    except LookupError:
        return "utf-8"


def default_session_factory():
    from scrapling.fetchers import FetcherSession

    return FetcherSession


def http_get(url, ip, deadline, max_bytes, proxy, session_factory):
    """One GET, no redirects followed. Returns dict(status, headers, url, body, truncated)."""
    from curl_cffi import CurlOpt
    from curl_cffi.curl import CURL_WRITEFUNC_ERROR

    remaining = deadline - time.monotonic()
    if remaining <= 1:
        raise Fail("timeout", "נגמר הזמן לקריאת הדף")
    host, port = urlsplit(url).hostname, urlsplit(url).port or 443
    chunks = []
    state = {"size": 0, "cut": False}

    def on_chunk(data):
        if state["size"] + len(data) > max_bytes:
            chunks.append(data[: max_bytes - state["size"]])
            state["size"] = max_bytes
            state["cut"] = True
            return CURL_WRITEFUNC_ERROR
        chunks.append(data)
        state["size"] += len(data)
        return len(data)

    options = {CurlOpt.PROTOCOLS_STR: b"https", CurlOpt.REDIR_PROTOCOLS_STR: b"https"}
    if ip and not proxy:
        target = f"[{ip}]" if ":" in ip else ip
        options[CurlOpt.RESOLVE] = [f"{host}:{port}:{target}"]

    Session = session_factory()
    try:
        with Session(retries=1, timeout=remaining, follow_redirects=False, stealthy_headers=False, verify=VERIFY) as session:
            # Scrapling 0.5 builds its curl_cffi session without extra curl options; set them on that session.
            # Pinned version (py/requirements-scrapling.txt): checked in py/scrapling_worker_test.py.
            curl_session = session._curl_session
            curl_session.curl_options = {**(getattr(curl_session, "curl_options", None) or {}), **options}
            kwargs = {"content_callback": on_chunk, "headers": {"Accept-Language": "he,en;q=0.8"}}
            if proxy:
                kwargs["proxy"] = proxy
            else:
                # No proxy from the environment: the pin above only holds on a direct connection.
                kwargs["proxies"] = {"http": "", "https": ""}
            response = session.get(url, **kwargs)
    except Fail:
        raise
    except Exception as e:
        if not state["cut"]:
            text = str(e)
            if "timed out" in text.lower() or "timeout" in text.lower():
                raise Fail("timeout", "נגמר הזמן לקריאת הדף")
            raise Fail("network", "החיבור לאתר נכשל: " + text[:200])
        # The transfer was cut on purpose at max_bytes: keep what arrived. curl_cffi attaches the response
        # (status and headers) to the error it raises for an aborted transfer.
        partial = getattr(e, "response", None)
        if partial is None:
            raise Fail("too_large", "הדף גדול מדי")
        headers = {k.lower(): v for k, v in dict(partial.headers or {}).items()}
        return {"status": int(partial.status_code), "headers": headers, "url": str(partial.url or url), "body": b"".join(chunks), "truncated": True}
    headers = {k.lower(): v for k, v in dict(response.headers or {}).items()}
    return {"status": int(response.status), "headers": headers, "url": str(response.url or url), "body": b"".join(chunks), "truncated": state["cut"]}


def robots_allows(page_url, ip, deadline, proxy, session_factory, getter):
    from protego import Protego

    parts = urlsplit(page_url)
    robots_url = f"https://{parts.netloc}/robots.txt"
    try:
        got = getter(robots_url, ip, min(deadline, time.monotonic() + 8), ROBOTS_MAX_BYTES, proxy, session_factory)
    except Fail as e:
        if e.kind == "timeout":
            raise Fail("robots_unavailable", "robots.txt של האתר לא ענה; לא נקרא הדף")
        raise Fail("robots_unavailable", "robots.txt של האתר לא נגיש; לא נקרא הדף")
    status = got["status"]
    # RFC 9309: 4xx means no rules; 5xx means the site is unreachable and nothing may be read.
    if 400 <= status < 500 or 300 <= status < 400:
        return True
    if status >= 500:
        raise Fail("robots_unavailable", "robots.txt של האתר החזיר שגיאת שרת; לא נקרא הדף")
    rules = Protego.parse(got["body"].decode("utf-8", "replace"))
    return rules.can_fetch(page_url, ROBOTS_AGENT)


BLOCK_MARKERS = re.compile(r"g-recaptcha|h-captcha|cf-turnstile|cf-challenge|challenge-platform|captcha-delivery|px-captcha", re.I)
BLOCK_TITLES = re.compile(r"^(just a moment|attention required|access denied|are you a robot|robot check)", re.I)


def extract(html, url, max_chars):
    from scrapling.parser import Selector

    page = Selector(content=html, url=url, huge_tree=False)
    title = (page.css("title::text").get() or "").strip()
    if BLOCK_MARKERS.search(html) or BLOCK_TITLES.search(title):
        raise Fail("blocked", "האתר הציג בדיקת רובוט (CAPTCHA) או חסימה; לא עוקפים את זה")
    if page.css('input[type="password"]'):
        raise Fail("login_required", "הדף מבקש התחברות; קוראים רק דפים ציבוריים")
    body = page.css("body")
    root = body[0] if body else page
    text = root.get_all_text(separator="\n", strip=True, ignore_tags=("script", "style", "noscript", "template", "svg"))
    text = re.sub(r"[ \t]+", " ", str(text))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    truncated = len(text) > max_chars
    return title, text[:max_chars], truncated


def read(req, resolver=socket.getaddrinfo, session_factory=default_session_factory, getter=http_get):
    # Fail early and plainly when the fetchers extra is missing, before any DNS or network work.
    import scrapling.fetchers  # noqa: F401

    url = req.get("url")
    clamp = lambda v, lo, hi: max(lo, min(hi, v))  # noqa: E731
    timeout_s = clamp(float(req.get("timeout_s") or 25), 1, 60)
    max_bytes = clamp(int(req.get("max_bytes") or 2 * 1024 * 1024), 1024, 10 * 1024 * 1024)
    max_chars = clamp(int(req.get("max_chars") or 30000), 100, 100000)
    max_redirects = clamp(int(req.get("max_redirects") if req.get("max_redirects") is not None else 5), 0, 10)
    proxy = str(req.get("proxy") or "")
    deadline = time.monotonic() + timeout_s

    current = url
    checked_robots = set()
    for hop in range(max_redirects + 1):
        host, port = check_url(current)
        ip = resolve(host, port, resolver, bool(proxy))
        if host not in checked_robots:
            checked_robots.add(host)
            if not robots_allows(current, ip, deadline, proxy, session_factory, getter):
                raise Fail("robots_disallowed", "robots.txt של האתר לא מתיר לקרוא את הדף הזה")
        got = getter(current, ip, deadline, max_bytes, proxy, session_factory)
        status = got["status"]
        if 300 <= status < 400:
            location = got["headers"].get("location")
            if not location:
                raise Fail("http_error", f"הפניה בלי יעד (HTTP {status})", http_status=status)
            current = urljoin(current, location)
            continue
        if status in (401, 407):
            raise Fail("login_required", "האתר דורש התחברות (HTTP %d)" % status, http_status=status)
        if status == 403:
            raise Fail("blocked", "האתר חסם את הגישה (HTTP 403)", http_status=status)
        if status == 429:
            raise Fail("rate_limited", "האתר ביקש להאט (HTTP 429)", http_status=status)
        if status >= 400:
            raise Fail("http_error", f"האתר החזיר HTTP {status}", http_status=status)
        ctype = (got["headers"].get("content-type") or "").lower()
        body = got["body"]
        if ctype and not ctype.startswith(HTML_TYPES):
            raise Fail("unsupported_content", f"זה לא דף HTML ({ctype.split(';')[0]})", http_status=status)
        if not ctype and b"<html" not in body[:2048].lower():
            raise Fail("unsupported_content", "זה לא נראה כמו דף HTML", http_status=status)
        html = body.decode(charset_of(ctype, body[:2048]), "replace")
        title, text, cut = extract(html, got["url"], max_chars)
        if not text and not title:
            raise Fail("empty", "הדף ריק", http_status=status)
        return {
            "ok": True,
            "url": url,
            "final_url": got["url"],
            "title": title,
            "text": text,
            "http_status": status,
            "truncated": bool(cut or got["truncated"]),
        }
    raise Fail("too_many_redirects", f"יותר מ-{max_redirects} הפניות")


def main():
    raw = sys.stdin.buffer.read(65536 + 1)
    try:
        if len(raw) > 65536:
            raise ValueError("too big")
        req = json.loads(raw.decode("utf-8"))
        if not isinstance(req, dict):
            raise ValueError("not an object")
    except Exception:
        out = {"ok": False, "kind": "bad_request", "error": "בקשה לא תקינה"}
    else:
        try:
            if req.get("op") == "version":
                from importlib.metadata import version

                from scrapling.fetchers import FetcherSession  # noqa: F401  (the fetchers extra is installed)

                out = {"ok": True, "scrapling": version("scrapling"), "curl_cffi": version("curl_cffi"), "python": sys.version.split()[0]}
            else:
                out = read(req)
        except ImportError as e:
            out = {"ok": False, "kind": "missing_dependency", "error": f"Scrapling לא מותקן: {e.name or e}"}
        except Fail as e:
            out = {"ok": False, "kind": e.kind, "error": e.message, "url": req.get("url"), **e.extra}
        except Exception as e:  # anything unexpected is still one JSON answer, never a traceback on stdout
            out = {"ok": False, "kind": "internal", "error": type(e).__name__}
    REAL_STDOUT.write(json.dumps(out, ensure_ascii=False) + "\n")
    REAL_STDOUT.flush()


if __name__ == "__main__":
    main()
