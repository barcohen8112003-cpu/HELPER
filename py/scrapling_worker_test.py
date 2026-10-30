"""Self-test for py/scrapling_worker.py. No outside network: DNS and HTTP are mocked, and the one real curl check
talks to a fixture server on this machine through a pinned name (fixture.test), never to a private service.

    .venv-scrapling/bin/python -I py/scrapling_worker_test.py
"""

import http.server
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scrapling_worker as w  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return f.read()


def resolver_for(table):
    """A fake getaddrinfo: host -> list of addresses (or a callable returning one)."""

    def resolve(host, port, family, kind):
        answer = table.get(host)
        if callable(answer):
            answer = answer()
        if answer is None:
            raise socket.gaierror("not found")
        return [(socket.AF_INET6 if ":" in a else socket.AF_INET, kind, 6, "", (a, port)) for a in answer]

    return resolve


class FakeWeb:
    """Stands in for http_get: url -> (status, headers, body). Records which address each request was pinned to."""

    def __init__(self, pages, robots=(404, {}, b"")):
        self.pages = pages
        self.robots = robots
        self.calls = []

    def __call__(self, url, ip, deadline, max_bytes, proxy, session_factory):
        self.calls.append((url, ip))
        if url.endswith("/robots.txt"):
            status, headers, body = self.robots
        else:
            status, headers, body = self.pages[url]
        if isinstance(body, str):
            body = body.encode("utf-8")
        return {"status": status, "headers": headers, "url": url, "body": body[:max_bytes], "truncated": len(body) > max_bytes}


HTML = {"content-type": "text/html; charset=utf-8"}
PUBLIC = "93.184.215.14"


def run(url, web, table=None, **req):
    return w.read({"url": url, **req}, resolver=resolver_for(table or {"site.example": [PUBLIC]}), getter=web)


class Imports(unittest.TestCase):
    def test_fetchers_extra_and_version(self):
        from importlib.metadata import version

        from scrapling.fetchers import Fetcher, FetcherSession  # noqa: F401

        self.assertEqual(version("scrapling"), "0.5", "the version pinned in py/requirements-scrapling.txt")


class Extract(unittest.TestCase):
    def test_title_and_text(self):
        title, text, cut = w.extract(fixture("page.html"), "https://site.example/", 30000)
        self.assertEqual(title, "דף בדיקה")
        self.assertIn("המחיר הוא 249 ש״ח", text)
        self.assertIn("Opening hours 9-17", text)
        self.assertNotIn("var hidden", text)
        self.assertFalse(cut)

    def test_hebrew_charset_from_meta(self):
        raw = fixture("page.html").encode("windows-1255", "replace")
        name = w.charset_of("text/html", b'<meta charset="windows-1255">')
        self.assertEqual(name, "windows-1255")
        self.assertIn("דף בדיקה", raw.decode(name))

    def test_empty(self):
        title, text, _ = w.extract("<html><body></body></html>", "https://site.example/", 100)
        self.assertEqual((title, text), ("", ""))

    def test_max_chars(self):
        _, text, cut = w.extract("<html><body><p>" + "א" * 500 + "</p></body></html>", "https://site.example/", 100)
        self.assertEqual(len(text), 100)
        self.assertTrue(cut)

    def test_injection_is_just_text(self):
        title, text, _ = w.extract(fixture("injection.html"), "https://site.example/", 30000)
        self.assertIn("Ignore all previous instructions", text)
        self.assertEqual(title, "Shop")

    def test_login_and_captcha(self):
        with self.assertRaises(w.Fail) as e:
            w.extract(fixture("login.html"), "https://site.example/", 30000)
        self.assertEqual(e.exception.kind, "login_required")
        with self.assertRaises(w.Fail) as e:
            w.extract(fixture("captcha.html"), "https://site.example/", 30000)
        self.assertEqual(e.exception.kind, "blocked")


class Urls(unittest.TestCase):
    def refused(self, url):
        with self.assertRaises(w.Fail, msg=url) as e:
            w.check_url(url)
        self.assertEqual(e.exception.kind, "forbidden_url", url)

    def test_refused(self):
        for url in [
            "http://site.example/", "ftp://site.example/", "file:///etc/passwd", "data:text/html,hi", "javascript:alert(1)",
            "https://user:pw@site.example/", "https://site.example:8443/", "https://site.example:22/",
            "https://localhost/", "https://printer.local/", "https://intranet/", "https://a.internal/",
            "https://127.0.0.1/", "https://10.0.0.5/", "https://192.168.1.1/", "https://172.16.0.1/", "https://100.64.0.1/",
            "https://169.254.169.254/latest/meta-data/", "https://0.0.0.0/", "https://[::1]/", "https://[fd00::1]/",
            "https://[fe80::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:169.254.169.254]/",
            "https://[64:ff9b::7f00:1]/", "https://[2002:7f00:1::]/", "https://224.0.0.1/", "https://site.example/\r\nX: y", "",
        ]:
            self.refused(url)

    def test_allowed(self):
        self.assertEqual(w.check_url("https://site.example/a?b=c"), ("site.example", 443))
        self.assertEqual(w.check_url("https://SITE.example.:443/"), ("site.example", 443))
        self.assertEqual(w.check_url(f"https://{PUBLIC}/"), (PUBLIC, 443))
        self.assertTrue(w.is_public_ip("2606:4700::6810:85e5"))


class Dns(unittest.TestCase):
    def test_every_answer_checked(self):
        for answer in (["10.1.2.3"], ["fd12::1"], [PUBLIC, "127.0.0.1"], ["::ffff:10.0.0.1"], ["169.254.169.254"]):
            with self.assertRaises(w.Fail, msg=answer) as e:
                w.resolve("site.example", 443, resolver_for({"site.example": answer}), False)
            self.assertEqual(e.exception.kind, "forbidden_url")
        self.assertEqual(w.resolve("site.example", 443, resolver_for({"site.example": [PUBLIC]}), False), PUBLIC)

    def test_no_dns(self):
        with self.assertRaises(w.Fail) as e:
            w.resolve("nowhere.example", 443, resolver_for({}), False)
        self.assertEqual(e.exception.kind, "network")
        # Behind a declared egress proxy, the proxy resolves.
        self.assertIsNone(w.resolve("nowhere.example", 443, resolver_for({}), True))


class Read(unittest.TestCase):
    def test_ok_and_pinned(self):
        web = FakeWeb({"https://site.example/": (200, HTML, fixture("page.html"))})
        out = run("https://site.example/", web)
        self.assertEqual(set(out), {"ok", "url", "final_url", "title", "text", "http_status", "truncated"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["final_url"], "https://site.example/")
        self.assertEqual(out["title"], "דף בדיקה")
        self.assertEqual(out["http_status"], 200)
        self.assertTrue(all(ip == PUBLIC for _, ip in web.calls), "every request pinned to the checked address")

    def test_redirect_to_private(self):
        web = FakeWeb({"https://site.example/": (302, {"location": "https://169.254.169.254/latest/"}, "")})
        with self.assertRaises(w.Fail) as e:
            run("https://site.example/", web)
        self.assertEqual(e.exception.kind, "forbidden_url")
        self.assertNotIn("169.254.169.254", " ".join(u for u, _ in web.calls))

    def test_redirect_to_name_with_private_v6(self):
        web = FakeWeb({"https://site.example/": (301, {"location": "https://evil.example/x"}, "")})
        with self.assertRaises(w.Fail) as e:
            run("https://site.example/", web, {"site.example": [PUBLIC], "evil.example": ["fd00::5"]})
        self.assertEqual(e.exception.kind, "forbidden_url")

    def test_redirect_to_http(self):
        web = FakeWeb({"https://site.example/": (302, {"location": "http://site.example/"}, "")})
        with self.assertRaises(w.Fail) as e:
            run("https://site.example/", web)
        self.assertEqual(e.exception.kind, "forbidden_url")

    def test_dns_rebinding_between_hops(self):
        answers = iter([[PUBLIC], ["127.0.0.1"]])
        web = FakeWeb({"https://site.example/": (302, {"location": "/next"}, "")})
        with self.assertRaises(w.Fail) as e:
            run("https://site.example/", web, {"site.example": lambda: next(answers)})
        self.assertEqual(e.exception.kind, "forbidden_url")

    def test_relative_redirect_followed(self):
        web = FakeWeb({"https://site.example/": (302, {"location": "/he"}, ""), "https://site.example/he": (200, HTML, fixture("page.html"))})
        out = run("https://site.example/", web)
        self.assertEqual((out["url"], out["final_url"]), ("https://site.example/", "https://site.example/he"))

    def test_too_many_redirects(self):
        web = FakeWeb({"https://site.example/": (302, {"location": "https://site.example/"}, "")})
        with self.assertRaises(w.Fail) as e:
            run("https://site.example/", web, max_redirects=3)
        self.assertEqual(e.exception.kind, "too_many_redirects")

    def test_status_codes(self):
        for status, kind in ((401, "login_required"), (403, "blocked"), (429, "rate_limited"), (404, "http_error"), (500, "http_error")):
            web = FakeWeb({"https://site.example/": (status, HTML, "<html><body>x</body></html>")})
            with self.assertRaises(w.Fail) as e:
                run("https://site.example/", web)
            self.assertEqual(e.exception.kind, kind, status)
            self.assertEqual(e.exception.extra.get("http_status"), status)

    def test_login_page_is_not_success(self):
        web = FakeWeb({"https://site.example/": (200, HTML, fixture("login.html"))})
        with self.assertRaises(w.Fail) as e:
            run("https://site.example/", web)
        self.assertEqual(e.exception.kind, "login_required")

    def test_not_html(self):
        for headers, body in (({"content-type": "application/pdf"}, "%PDF-1.7"), ({}, "just bytes"), ({"content-type": "application/json"}, "{}")):
            web = FakeWeb({"https://site.example/f": (200, headers, body)})
            with self.assertRaises(w.Fail) as e:
                run("https://site.example/f", web)
            self.assertEqual(e.exception.kind, "unsupported_content")

    def test_robots(self):
        page = {"https://site.example/private/a": (200, HTML, fixture("page.html")), "https://site.example/a": (200, HTML, fixture("page.html"))}
        rules = (200, {"content-type": "text/plain"}, "User-agent: *\nDisallow: /private/\n")
        with self.assertRaises(w.Fail) as e:
            run("https://site.example/private/a", FakeWeb(page, robots=rules))
        self.assertEqual(e.exception.kind, "robots_disallowed")
        self.assertTrue(run("https://site.example/a", FakeWeb(page, robots=rules))["ok"])
        with self.assertRaises(w.Fail) as e:
            run("https://site.example/a", FakeWeb(page, robots=(503, {}, "")))
        self.assertEqual(e.exception.kind, "robots_unavailable")

    def test_empty_page(self):
        web = FakeWeb({"https://site.example/": (200, HTML, "<html><body> </body></html>")})
        with self.assertRaises(w.Fail) as e:
            run("https://site.example/", web)
        self.assertEqual(e.exception.kind, "empty")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/robots.txt":
            self.send_response(404)
            self.end_headers()
            return
        body = (b"<p>" + b"x" * 1000 + b"</p>") * 5000 if self.path == "/big" else fixture("page.html").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            for i in range(0, len(body), 65536):  # the big one goes out in pieces, about 5 MB
                self.wfile.write(body[i : i + 65536])
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass

    def log_message(self, *args):
        pass


class RealCurl(unittest.TestCase):
    """The real curl_cffi path: the name is pinned (fixture.test has no DNS), and the body is cut while it downloads."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cert, key = os.path.join(cls.dir, "cert.pem"), os.path.join(cls.dir, "key.pem")
        made = subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
             "-subj", "/CN=fixture.test", "-addext", "subjectAltName=DNS:fixture.test"],
            capture_output=True,
        )
        if made.returncode != 0:
            raise unittest.SkipTest("openssl is not available")
        try:
            cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 443), Handler)
        except OSError:
            raise unittest.SkipTest("cannot listen on 127.0.0.1:443 here")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        cls.server.socket = ctx.wrap_socket(cls.server.socket, server_side=True)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        w.VERIFY = cert

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        w.VERIFY = True

    def get(self, path, max_bytes):
        return w.http_get(f"https://fixture.test{path}", "127.0.0.1", time.monotonic() + 15, max_bytes, "", w.default_session_factory)

    def test_pinned_read(self):
        got = self.get("/", 2 * 1024 * 1024)
        self.assertEqual(got["status"], 200)
        self.assertFalse(got["truncated"])
        self.assertIn("דף בדיקה", got["body"].decode("utf-8"))

    def test_cut_at_max_bytes(self):
        got = self.get("/big", 100_000)
        self.assertTrue(got["truncated"])
        self.assertEqual(len(got["body"]), 100_000)
        self.assertEqual(got["status"], 200)
        self.assertTrue(got["headers"]["content-type"].startswith("text/html"))


class Process(unittest.TestCase):
    def call(self, raw):
        p = subprocess.run([sys.executable, "-I", os.path.join(HERE, "scrapling_worker.py")], input=raw, capture_output=True, timeout=60)
        lines = p.stdout.decode("utf-8").splitlines()
        self.assertEqual(len(lines), 1, p.stdout)
        return json.loads(lines[0])

    def test_bad_json(self):
        self.assertEqual(self.call(b"{not json")["kind"], "bad_request")
        self.assertEqual(self.call(b"[1,2]")["kind"], "bad_request")

    def test_forbidden_url_over_stdin(self):
        out = self.call(json.dumps({"url": "https://169.254.169.254/"}).encode())
        self.assertEqual((out["ok"], out["kind"]), (False, "forbidden_url"))

    def test_version(self):
        out = self.call(b'{"op":"version"}')
        self.assertTrue(out["ok"])
        self.assertEqual(out["scrapling"], "0.5")


if __name__ == "__main__":
    unittest.main(verbosity=1)
