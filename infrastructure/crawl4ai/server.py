"""
The page reader: crawl4ai and a headless browser behind one HTTP endpoint.

POST /read {url} -> {finalUrl, status, title, description, markdown, html, links, ms}

The worker owns the crawl - which URLs, in what order, how many, robots.txt, the site's own
hosts. This service reads one page the way a visitor's browser would (JavaScript run, overlays
removed) and hands back what the assistant should learn from it: markdown with the page's
headings and lists kept and its navigation, footers and forms dropped, plus the links the page
carries so the crawl can go on. It is a browser pointed at a customer's website, so it is built
like the crawler: only http(s), every hostname resolved here and refused when it is a private,
loopback, link-local, CGNAT or metadata address - the page's own sub-requests included - images,
media and fonts never fetched, a deadline on everything, and a shared secret so nothing but the
worker can ask. One browser, a fresh page per request, a few at once.
"""

from __future__ import annotations

import asyncio
import ipaddress
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import json
import os
import socket
import sys
import time
from typing import Any
from urllib.parse import urlsplit, urljoin

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.content_filter_strategy import PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

PORT = int(os.environ.get("PORT", "3000"))
TOKEN = os.environ.get("CRAWL4AI_TOKEN", "")
ALLOW_PRIVATE = os.environ.get("CRAWL4AI_ALLOW_PRIVATE") == "true"
CONCURRENCY = max(1, int(os.environ.get("CRAWL4AI_CONCURRENCY", "2")))
PAGE_TIMEOUT_MS = int(os.environ.get("CRAWL4AI_TIMEOUT_MS", "20000"))
# Everything, including queueing for a browser slot: the worker gives up at 45 s.
REQUEST_DEADLINE_S = PAGE_TIMEOUT_MS / 1000 + 20
SETTLE_S = 0.8
MAX_HTML_BYTES = 3 * 1024 * 1024
MAX_MARKDOWN_CHARS = 400_000
MAX_LINKS = 2_000
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 "
    "GetChatBot/1.0 (+https://getchat.site/bot)"
)

if not TOKEN:
    print("crawl4ai: CRAWL4AI_TOKEN is required", file=sys.stderr)
    sys.exit(1)

# --- address rules, the same as the crawler's ---------------------------------------------------

PRIVATE_NETWORKS = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
        "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3",
        "::/128", "::1/128", "fe80::/10", "fc00::/7", "ff00::/8",
    )
]


def is_private_address(raw: str) -> bool:
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        return True
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return any(address in network for network in PRIVATE_NETWORKS)


_host_cache: dict[str, tuple[float, bool]] = {}


async def host_is_allowed(hostname: str) -> bool:
    if ALLOW_PRIVATE:
        return True
    key = hostname.lower().strip("[]")
    cached = _host_cache.get(key)
    if cached and time.monotonic() - cached[0] < 60:
        return cached[1]
    ok = False
    try:
        try:
            ipaddress.ip_address(key)
            addresses = [key]
        except ValueError:
            loop = asyncio.get_running_loop()
            infos = await loop.getaddrinfo(key, None, type=socket.SOCK_STREAM)
            addresses = [info[4][0] for info in infos]
        ok = len(addresses) > 0 and all(not is_private_address(a) for a in addresses)
    except Exception:
        ok = False
    _host_cache[key] = (time.monotonic(), ok)
    return ok


def plausible_url(raw: str) -> str | None:
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    if parts.username or parts.password:
        return None
    return raw


# --- the browser ------------------------------------------------------------------------------------

MARKDOWN = DefaultMarkdownGenerator(
    content_filter=PruningContentFilter(threshold=0.45, threshold_type="dynamic", min_word_threshold=5),
    # Links are returned separately; inside the text they are noise to an embedding.
    options={"ignore_links": True, "ignore_images": True, "escape_html": False, "body_width": 0},
)

# The page chrome, dropped before the markdown is made. What is left reads like the page's main
# column with its headings, which is what the chunker wants.
EXCLUDED_TAGS = ["script", "style", "noscript", "template", "iframe", "svg", "canvas", "nav", "footer", "header", "aside", "form"]
EXCLUDED_SELECTOR = '[role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], .cookie, .cookies, #cookie-banner'


def run_config(timeout_ms: int) -> CrawlerRunConfig:
    return CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        markdown_generator=MARKDOWN,
        page_timeout=timeout_ms,
        wait_until="domcontentloaded",
        delay_before_return_html=SETTLE_S,
        remove_overlay_elements=True,
        excluded_tags=EXCLUDED_TAGS,
        excluded_selector=EXCLUDED_SELECTOR,
        word_count_threshold=1,
        exclude_external_links=False,
        verbose=False,
    )


class Reader:
    def __init__(self) -> None:
        self.crawler: AsyncWebCrawler | None = None
        self.slots = asyncio.Semaphore(CONCURRENCY)
        self.in_flight = 0
        self.lock = asyncio.Lock()

    async def start(self) -> None:
        config = BrowserConfig(
            headless=True,
            browser_type="chromium",
            user_agent=USER_AGENT,
            text_mode=True,
            light_mode=True,
            ignore_https_errors=False,
            java_script_enabled=True,
            viewport_width=1280,
            viewport_height=900,
            verbose=False,
            extra_args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        crawler = AsyncWebCrawler(config=config)
        await crawler.start()
        crawler.crawler_strategy.set_hook("on_page_context_created", self._guard_context)
        self.crawler = crawler

    async def stop(self) -> None:
        if self.crawler:
            await self.crawler.close()
            self.crawler = None

    async def _guard_context(self, page: Any, context: Any = None, **_: Any) -> Any:
        """
        Every request the page makes goes through the same address rules as the page itself,
        and the heavy resource types are never fetched. The browser context is reused between
        reads, so the route is installed once per context.
        """
        if context is None or getattr(context, "_getchat_guarded", False):
            return page
        context._getchat_guarded = True

        async def route(handler: Any) -> None:
            request = handler.request
            if request.resource_type in ("image", "media", "font", "websocket", "manifest"):
                await handler.abort()
                return
            target = plausible_url(request.url)
            if not target or not await host_is_allowed(urlsplit(target).hostname or ""):
                await handler.abort()
                return
            await handler.continue_()

        await context.route("**/*", route)
        return page

    async def read(self, url: str, timeout_ms: int) -> tuple[int, dict[str, Any]]:
        target = plausible_url(url)
        if not target:
            return 400, {"error": "not an http(s) URL"}
        if not await host_is_allowed(urlsplit(target).hostname or ""):
            return 403, {"error": "address refused"}
        if not self.crawler:
            return 503, {"error": "browser not ready"}

        async with self.slots:
            self.in_flight += 1
            try:
                result = await self.crawler.arun(target, config=run_config(timeout_ms))
            except Exception as error:  # noqa: BLE001 - the browser's failure is the answer
                return 502, {"error": str(error)[:300]}
            finally:
                self.in_flight -= 1

        html = result.html or ""
        if not html and not result.success:
            message = (result.error_message or "page could not be read")[:300]
            if "timeout" in message.lower():
                return 504, {"error": message}
            return 502, {"error": message}
        if len(html.encode("utf-8", errors="ignore")) > MAX_HTML_BYTES:
            return 413, {"error": "rendered page too large"}

        final_url = getattr(result, "redirected_url", None) or result.url or target
        markdown_result = result.markdown
        raw = getattr(markdown_result, "raw_markdown", None) if markdown_result is not None else None
        if raw is None:
            raw = str(markdown_result or "")
        fit = getattr(markdown_result, "fit_markdown", None) or ""
        metadata = result.metadata or {}
        links: list[str] = []
        seen: set[str] = set()
        for entry in (result.links or {}).get("internal", []) + (result.links or {}).get("external", []):
            href = entry.get("href") if isinstance(entry, dict) else None
            if not href:
                continue
            absolute = urljoin(final_url, href)
            if absolute in seen or not plausible_url(absolute):
                continue
            seen.add(absolute)
            links.append(absolute)
            if len(links) >= MAX_LINKS:
                break

        status = result.status_code if isinstance(result.status_code, int) else (200 if result.success else 502)
        return 200, {
            "finalUrl": final_url,
            "status": status,
            "title": (metadata.get("title") or "").strip() or None,
            "description": (metadata.get("description") or "").strip() or None,
            "markdown": raw[:MAX_MARKDOWN_CHARS],
            "fitMarkdown": fit[:MAX_MARKDOWN_CHARS],
            "html": html,
            "links": links,
        }


reader = Reader()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await reader.start()
    print(f"crawl4ai reader listening on :{PORT} (concurrency {CONCURRENCY})", flush=True)
    try:
        yield
    finally:
        await reader.stop()


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": reader.crawler is not None, "inFlight": reader.in_flight})


@app.post("/read")
async def read(request: Request, x_crawl_token: str | None = Header(default=None)) -> JSONResponse:
    if x_crawl_token != TOKEN:
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    raw = await request.body()
    if len(raw) > 16_384:
        return JSONResponse({"error": "body too large"}, status_code=413)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        return JSONResponse({"error": "expected JSON"}, status_code=400)
    url = body.get("url") if isinstance(body, dict) else None
    if not isinstance(url, str) or not url or len(url) > 2_048:
        return JSONResponse({"error": "expected {url}"}, status_code=400)
    timeout_ms = body.get("timeoutMs") if isinstance(body, dict) else None
    timeout_ms = int(timeout_ms) if isinstance(timeout_ms, (int, float)) and 1_000 <= timeout_ms <= 60_000 else PAGE_TIMEOUT_MS

    started = time.monotonic()
    try:
        status, payload = await asyncio.wait_for(reader.read(url, timeout_ms), timeout=REQUEST_DEADLINE_S)
    except asyncio.TimeoutError:
        status, payload = 504, {"error": "deadline exceeded"}
    ms = int((time.monotonic() - started) * 1000)
    print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "url": url, "status": status, "page": payload.get("status"), "ms": ms}), flush=True)
    if status == 200:
        payload["ms"] = ms
    return JSONResponse(payload, status_code=status)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning", access_log=False)
