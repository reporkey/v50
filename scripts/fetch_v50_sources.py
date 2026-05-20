#!/usr/bin/env python3
"""Download raw online V50 reference sources into samples/snapshots."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple


DOUBAN_URL = "https://www.douban.com/group/topic/253838719/?_i=91097156LOakHz"
GITHUB_V50_URL = "https://raw.githubusercontent.com/vikiboss/v50/refs/heads/main/static/v50.json"
CRAZY_BASE = "https://www.crazy-thursday.com"
CRAZY_SITEMAP_URL = f"{CRAZY_BASE}/sitemap.xml"
CRAZY_COLLECTIONS_URL = f"{CRAZY_BASE}/text-collections"
CRAZY_REQUIRED_COLLECTIONS = [
    f"{CRAZY_BASE}/text-collections/486",
]
VME_JOKES_URL = "https://vme.im/jokes"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_timestamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_name(value: str, suffix: str = ".html") -> str:
    parsed = urllib.parse.urlparse(value)
    path = parsed.path.strip("/") or "index"
    if parsed.query:
        path += "_" + parsed.query
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", path).strip("_")
    if not name.endswith(suffix):
        name += suffix
    return name


def path_id(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    return parts[-1] if parts else "index"


def normalize_vme_page_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.netloc != "vme.im" or parsed.path != "/jokes":
        return url
    page = urllib.parse.parse_qs(parsed.query).get("page", ["1"])[0] or "1"
    if page == "1":
        return VME_JOKES_URL
    return f"{VME_JOKES_URL}?page={page}"


def request_url(url: str, timeout: int = 30) -> Tuple[int, Dict[str, str], bytes, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    }
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", 200)
            response_headers = {key.lower(): value for key, value in response.headers.items()}
            return status, response_headers, response.read(), response.geturl()
    except urllib.error.HTTPError as exc:
        data = exc.read()
        headers_out = {key.lower(): value for key, value in exc.headers.items()}
        return exc.code, headers_out, data, exc.geturl()


def fetch_to_file(
    *,
    url: str,
    destination: Path,
    source: str,
    snapshot_root: Path,
    project_root_path: Path,
    timeout: int = 30,
    retries: int = 2,
) -> Tuple[Dict[str, Any], Optional[bytes]]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fetched_at = now_iso()
    last_error = None
    for attempt in range(retries + 1):
        try:
            status, headers, data, final_url = request_url(url, timeout=timeout)
            destination.write_bytes(data)
            record = {
                "source": source,
                "url": url,
                "final_url": final_url,
                "local_file": str(destination.relative_to(project_root_path)),
                "http_status": status,
                "content_type": headers.get("content-type", ""),
                "size_bytes": len(data),
                "sha256": sha256_bytes(data),
                "fetched_at": fetched_at,
                "attempts": attempt + 1,
                "error": None if 200 <= status < 400 else f"HTTP {status}",
            }
            return record, data
        except Exception as exc:  # noqa: BLE001 - manifest should preserve fetch failure detail.
            last_error = str(exc)
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))

    record = {
        "source": source,
        "url": url,
        "final_url": None,
        "local_file": str(destination.relative_to(project_root_path)),
        "http_status": None,
        "content_type": "",
        "size_bytes": 0,
        "sha256": None,
        "fetched_at": fetched_at,
        "attempts": retries + 1,
        "error": last_error or "unknown fetch error",
    }
    return record, None


def decode_text(data: Optional[bytes]) -> str:
    if not data:
        return ""
    return data.decode("utf-8", errors="ignore")


def html_links(data: bytes, base_url: str) -> Set[str]:
    text = decode_text(data)
    urls: Set[str] = set()
    for raw in re.findall(r"""href=["']([^"']+)["']""", text):
        clean = html.unescape(raw)
        if clean.startswith("#") or clean.startswith("javascript:"):
            continue
        urls.add(urllib.parse.urljoin(base_url, clean))
    return urls


def parse_sitemap_locs(data: bytes) -> List[str]:
    text = decode_text(data)
    try:
        root = ET.fromstring(data)
        locs = []
        for element in root.iter():
            if element.tag.endswith("loc") and element.text:
                locs.append(element.text.strip())
        return locs
    except ET.ParseError:
        return [html.unescape(item.strip()) for item in re.findall(r"<loc>(.*?)</loc>", text, flags=re.I | re.S)]


def register_local_zhihu(root: Path) -> List[Dict[str, Any]]:
    records = []
    for path in sorted((root / "samples").glob("*.mhtml")):
        records.append(
            {
                "source": "zhihu_samples",
                "url": None,
                "local_file": str(path.relative_to(root)),
                "http_status": None,
                "content_type": "multipart/related; source=mhtml",
                "size_bytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "registered_at": now_iso(),
                "error": None,
            }
        )
    return records


def successful(record: Dict[str, Any]) -> bool:
    status = record.get("http_status")
    return isinstance(status, int) and 200 <= status < 400 and record.get("size_bytes", 0) > 0 and not record.get("error")


def add_record(manifest: Dict[str, Any], record: Dict[str, Any]) -> None:
    manifest["records"].append(record)
    if record.get("error"):
        manifest["fetch_errors"].append(
            {
                "source": record.get("source"),
                "url": record.get("url"),
                "local_file": record.get("local_file"),
                "http_status": record.get("http_status"),
                "error": record.get("error"),
            }
        )


def fetch_many(
    *,
    urls: Sequence[str],
    destination_for_url,
    source: str,
    snapshot_root: Path,
    project_root_path: Path,
    workers: int,
    timeout: int,
    retries: int,
) -> List[Dict[str, Any]]:
    def fetch_one(url: str) -> Dict[str, Any]:
        destination = destination_for_url(url)
        record, _ = fetch_to_file(
            url=url,
            destination=destination,
            source=source,
            snapshot_root=snapshot_root,
            project_root_path=project_root_path,
            timeout=timeout,
            retries=retries,
        )
        return record

    records: List[Dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_url = {executor.submit(fetch_one, url): url for url in urls}
        for future in concurrent.futures.as_completed(future_to_url):
            records.append(future.result())
    return sorted(records, key=lambda item: item.get("url") or "")


def discover_crazy_sources(
    *,
    root: Path,
    snapshot_root: Path,
    manifest: Dict[str, Any],
    timeout: int,
    retries: int,
) -> Tuple[List[str], List[str]]:
    sitemap_records: List[Dict[str, Any]] = []
    post_urls: Set[str] = set()
    collection_urls: Set[str] = set(CRAZY_REQUIRED_COLLECTIONS)
    sitemap_queue = [CRAZY_SITEMAP_URL]
    seen_sitemaps: Set[str] = set()

    while sitemap_queue:
        sitemap_url = sitemap_queue.pop(0)
        if sitemap_url in seen_sitemaps:
            continue
        seen_sitemaps.add(sitemap_url)
        destination = snapshot_root / "crazy_thursday" / "sitemaps" / safe_name(sitemap_url, ".xml")
        record, data = fetch_to_file(
            url=sitemap_url,
            destination=destination,
            source="crazy_thursday_sitemap",
            snapshot_root=snapshot_root,
            project_root_path=root,
            timeout=timeout,
            retries=retries,
        )
        add_record(manifest, record)
        sitemap_records.append(record)
        if not data or not successful(record):
            continue
        for loc in parse_sitemap_locs(data):
            parsed = urllib.parse.urlparse(loc)
            if parsed.netloc != "www.crazy-thursday.com":
                continue
            if parsed.path.endswith(".xml"):
                sitemap_queue.append(loc)
            elif parsed.path.startswith("/post/"):
                post_urls.add(loc)
            elif parsed.path.startswith("/text-collections/"):
                collection_urls.add(loc)

    collection_index_path = snapshot_root / "crazy_thursday" / "collections_index.html"
    record, data = fetch_to_file(
        url=CRAZY_COLLECTIONS_URL,
        destination=collection_index_path,
        source="crazy_thursday_collections_index",
        snapshot_root=snapshot_root,
        project_root_path=root,
        timeout=timeout,
        retries=retries,
    )
    add_record(manifest, record)
    if data and successful(record):
        for link in html_links(data, CRAZY_COLLECTIONS_URL):
            parsed = urllib.parse.urlparse(link)
            if parsed.netloc == "www.crazy-thursday.com" and parsed.path.startswith("/text-collections/"):
                collection_urls.add(urllib.parse.urlunparse(parsed._replace(query="", fragment="")))

    manifest["sources"]["crazy_thursday"] = {
        "sitemap_urls": sorted(seen_sitemaps),
        "sitemap_record_count": len(sitemap_records),
        "post_urls_count": len(post_urls),
        "collection_urls_count": len(collection_urls),
        "required_collection_urls": CRAZY_REQUIRED_COLLECTIONS,
    }
    return sorted(post_urls), sorted(collection_urls, key=lambda url: int(path_id(url)) if path_id(url).isdigit() else path_id(url))


def discover_vme_sources(
    *,
    root: Path,
    snapshot_root: Path,
    manifest: Dict[str, Any],
    timeout: int,
    retries: int,
    max_pages: int,
) -> Tuple[List[str], List[str]]:
    pages_seen: Set[str] = set()
    pages_queue = [VME_JOKES_URL]
    detail_urls: Set[str] = set()
    page_urls: Set[str] = set()

    while pages_queue and len(pages_seen) < max_pages:
        page_url = normalize_vme_page_url(pages_queue.pop(0))
        parsed_page = urllib.parse.urlparse(page_url)
        page_num = urllib.parse.parse_qs(parsed_page.query).get("page", ["1"])[0]
        destination = snapshot_root / "vme" / "pages" / f"page_{page_num}.html"
        if page_url in pages_seen:
            continue
        pages_seen.add(page_url)
        page_urls.add(page_url)
        record, data = fetch_to_file(
            url=page_url,
            destination=destination,
            source="vme_jokes_page",
            snapshot_root=snapshot_root,
            project_root_path=root,
            timeout=timeout,
            retries=retries,
        )
        add_record(manifest, record)
        if not data or not successful(record):
            continue

        links = html_links(data, page_url)
        for link in links:
            parsed = urllib.parse.urlparse(link)
            if parsed.netloc != "vme.im":
                continue
            if parsed.path == "/jokes":
                page_qs = urllib.parse.parse_qs(parsed.query)
                normalized = normalize_vme_page_url(urllib.parse.urlunparse(parsed._replace(fragment="")))
                if "page" in page_qs and normalized not in pages_seen and normalized not in pages_queue:
                    pages_queue.append(normalized)
            elif re.match(r"^/jokes/[^/?#]+$", parsed.path):
                detail_urls.add(urllib.parse.urlunparse(parsed._replace(query="", fragment="")))

        text = decode_text(data)
        match = re.search(r"Page\s+\d+\s*/\s*(\d+)", text, flags=re.I)
        if match:
            page_count = int(match.group(1))
            for page in range(1, min(page_count, max_pages) + 1):
                url = normalize_vme_page_url(VME_JOKES_URL if page == 1 else f"{VME_JOKES_URL}?page={page}")
                if url not in pages_seen and url not in pages_queue:
                    pages_queue.append(url)

    manifest["sources"]["vme"] = {
        "page_urls_count": len(page_urls),
        "detail_urls_count": len(detail_urls),
        "max_pages": max_pages,
    }
    return sorted(page_urls), sorted(detail_urls)


def write_latest(root: Path, timestamp: str, snapshot_dir: Path, manifest_path: Path) -> None:
    latest = {
        "snapshot_id": timestamp,
        "snapshot_dir": str(snapshot_dir.relative_to(root)),
        "manifest": str(manifest_path.relative_to(root)),
        "updated_at": now_iso(),
    }
    (root / "samples").mkdir(parents=True, exist_ok=True)
    (root / "samples" / "latest.json").write_text(
        json.dumps(latest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def fetch_snapshot(args: argparse.Namespace) -> Dict[str, Any]:
    root = args.root.resolve()
    snapshot_dir = root / "samples" / "snapshots" / args.timestamp
    if snapshot_dir.exists() and not args.resume:
        raise SystemExit(f"snapshot directory already exists: {snapshot_dir}")
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    manifest: Dict[str, Any] = {
        "schema_version": 1,
        "snapshot_id": args.timestamp,
        "created_at": now_iso(),
        "snapshot_dir": str(snapshot_dir.relative_to(root)),
        "records": [],
        "fetch_errors": [],
        "sources": {
            "douban": {"url": DOUBAN_URL},
            "github_v50": {"url": GITHUB_V50_URL},
            "zhihu_samples": {"registered_local_files": 0},
        },
        "notes": [
            "Raw online source snapshot only; no copy segmentation, extraction, classification, or prompt generation is performed.",
            "Manifests intentionally avoid API keys and other sensitive tokens.",
        ],
    }

    for record in register_local_zhihu(root):
        manifest["records"].append(record)
    manifest["sources"]["zhihu_samples"]["registered_local_files"] = len(
        [record for record in manifest["records"] if record.get("source") == "zhihu_samples"]
    )

    base_fetches = [
        (DOUBAN_URL, snapshot_dir / "douban" / "topic_253838719.html", "douban"),
        (GITHUB_V50_URL, snapshot_dir / "github" / "vikiboss_v50.json", "github_v50"),
    ]
    for url, destination, source in base_fetches:
        record, _ = fetch_to_file(
            url=url,
            destination=destination,
            source=source,
            snapshot_root=snapshot_dir,
            project_root_path=root,
            timeout=args.timeout,
            retries=args.retries,
        )
        add_record(manifest, record)

    post_urls, collection_urls = discover_crazy_sources(
        root=root,
        snapshot_root=snapshot_dir,
        manifest=manifest,
        timeout=args.timeout,
        retries=args.retries,
    )

    post_records = fetch_many(
        urls=post_urls,
        destination_for_url=lambda url: snapshot_dir / "crazy_thursday" / "posts" / f"{path_id(url)}.html",
        source="crazy_thursday_post",
        snapshot_root=snapshot_dir,
        project_root_path=root,
        workers=args.workers,
        timeout=args.timeout,
        retries=args.retries,
    )
    for record in post_records:
        add_record(manifest, record)

    collection_records = fetch_many(
        urls=collection_urls,
        destination_for_url=lambda url: snapshot_dir / "crazy_thursday" / "collections" / f"{path_id(url)}.html",
        source="crazy_thursday_collection",
        snapshot_root=snapshot_dir,
        project_root_path=root,
        workers=args.workers,
        timeout=args.timeout,
        retries=args.retries,
    )
    for record in collection_records:
        add_record(manifest, record)

    page_urls, detail_urls = discover_vme_sources(
        root=root,
        snapshot_root=snapshot_dir,
        manifest=manifest,
        timeout=args.timeout,
        retries=args.retries,
        max_pages=args.vme_max_pages,
    )
    # Page records are added during discovery. Detail pages are downloaded here.
    detail_records = fetch_many(
        urls=detail_urls,
        destination_for_url=lambda url: snapshot_dir / "vme" / "details" / f"{path_id(url)}.html",
        source="vme_jokes_detail",
        snapshot_root=snapshot_dir,
        project_root_path=root,
        workers=args.workers,
        timeout=args.timeout,
        retries=args.retries,
    )
    for record in detail_records:
        add_record(manifest, record)

    manifest["sources"]["vme"]["page_urls"] = page_urls
    manifest["sources"]["vme"]["detail_urls_count"] = len(detail_urls)
    manifest["record_count"] = len(manifest["records"])
    manifest["successful_download_count"] = len(
        [record for record in manifest["records"] if record.get("url") and successful(record)]
    )
    manifest["local_registration_count"] = len(
        [record for record in manifest["records"] if not record.get("url") and not record.get("error")]
    )
    manifest["fetch_error_count"] = len(manifest["fetch_errors"])

    manifest_path = snapshot_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_latest(root, args.timestamp, snapshot_dir, manifest_path)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=project_root())
    parser.add_argument("--timestamp", default=default_timestamp())
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--vme-max-pages", type=int, default=50)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    manifest = fetch_snapshot(args)
    print(json.dumps(
        {
            "snapshot_id": manifest["snapshot_id"],
            "snapshot_dir": manifest["snapshot_dir"],
            "record_count": manifest["record_count"],
            "successful_download_count": manifest["successful_download_count"],
            "fetch_error_count": manifest["fetch_error_count"],
            "crazy_post_urls_count": manifest["sources"]["crazy_thursday"]["post_urls_count"],
            "crazy_collection_urls_count": manifest["sources"]["crazy_thursday"]["collection_urls_count"],
            "vme_detail_urls_count": manifest["sources"]["vme"]["detail_urls_count"],
        },
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
