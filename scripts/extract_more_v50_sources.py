#!/usr/bin/env python3
"""Extract additional V50 copy sources into reviewable local JSON files."""

from __future__ import annotations

import html
import json
import math
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"

GITHUB_URL = "https://raw.githubusercontent.com/vikiboss/v50/refs/heads/main/static/v50.json"
VME_URL = "https://vme.im/jokes?type=text"
DOUBAN_URL = "https://www.douban.com/group/topic/253838719/?_i=91097156LOakHz"

GITHUB_OUTPUT = SAMPLES_DIR / "vikiboss_v50.json"
VME_OUTPUT = SAMPLES_DIR / "vme_v50.json"
DOUBAN_OUTPUT = SAMPLES_DIR / "douban_v50.json"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

BODY_SIGNALS = re.compile(
    r"疯狂星期四|疯四|肯德基|KFC|kfc|v\s*我|V\s*我|v\s*50|V\s*50|"
    r"请我吃|转我|五十|50|星期四|周四|炸鸡|原味鸡|鸡米花|全家桶"
)


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"br", "p", "div", "li"} and self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"p", "div", "li"} and self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def handle_entityref(self, name: str) -> None:
        self.parts.append(html.unescape(f"&{name};"))

    def handle_charref(self, name: str) -> None:
        self.parts.append(html.unescape(f"&#{name};"))

    def text(self) -> str:
        return "".join(self.parts)


class VmeCopyContentExtractor(HTMLParser):
    """Extract the complete VME detail-page copy card, including lists."""

    def __init__(self) -> None:
        super().__init__()
        self.depth = 0
        self.parts: list[str] = []

    @staticmethod
    def _attrs(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
        return {key: value or "" for key, value in attrs}

    def _append_break(self) -> None:
        if self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = self._attrs(attrs)
        class_name = attrs_map.get("class", "")
        if self.depth == 0:
            if tag == "div" and "min-h-[120px]" in class_name and "bg-kfc-cream" in class_name:
                self.depth = 1
            return

        if tag in {"br", "p", "div", "ol", "ul", "li", "blockquote"}:
            self._append_break()
        if tag not in {"br", "img", "input", "meta", "link"}:
            self.depth += 1

    def handle_endtag(self, tag: str) -> None:
        if self.depth == 0:
            return
        if tag in {"p", "div", "ol", "ul", "li", "blockquote"}:
            self._append_break()
        self.depth -= 1

    def handle_data(self, data: str) -> None:
        if self.depth > 0:
            self.parts.append(data)

    def handle_entityref(self, name: str) -> None:
        if self.depth > 0:
            self.parts.append(html.unescape(f"&{name};"))

    def handle_charref(self, name: str) -> None:
        if self.depth > 0:
            self.parts.append(html.unescape(f"&#{name};"))

    def text(self) -> str:
        return "".join(self.parts)


def fetch_text(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="ignore")


def normalize_text(text: str) -> str:
    text = html.unescape(text)
    text = text.replace("\u200b", "").replace("\u00a0", " ")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def normalize_vme_copy_text(text: str) -> str:
    text = html.unescape(text)
    text = text.replace("\u200b", "").replace("\u00a0", " ")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t\f\v]+$", "", line) for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def html_to_text(markup: str) -> str:
    parser = TextExtractor()
    parser.feed(markup.replace("<!-- -->", ""))
    return normalize_text(parser.text())


def duplicate_key(text: str) -> str:
    key = normalize_text(text).lower()
    key = re.sub(r"\s+", "", key)
    key = re.sub(r"[，。、：:；;！!？?（）()【】\[\]《》“”\"'‘’·…—_\-]", "", key)
    return key


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def extract_github() -> dict[str, Any]:
    raw = json.loads(fetch_text(GITHUB_URL))
    if not isinstance(raw, list):
        raise ValueError("vikiboss/v50 JSON is expected to be an array")

    items = []
    for index, text in enumerate(raw, 1):
        clean = normalize_text(str(text))
        if not clean:
            continue
        items.append(
            {
                "id": f"vikiboss_v50_{index:03d}",
                "source": "vikiboss_v50",
                "source_id": index,
                "source_url": GITHUB_URL,
                "title": "vikiboss/v50 static v50.json",
                "text": clean,
                "source_order": index,
                "segmentation_method": "github_raw_json_array_item",
            }
        )

    return {
        "source": "vikiboss_v50",
        "source_url": GITHUB_URL,
        "item_count": len(items),
        "items": items,
    }


def vme_page_url(page: int) -> str:
    if page <= 1:
        return VME_URL
    return f"{VME_URL}&page={page}"


def parse_vme_page(page_html: str, page: int) -> tuple[int | None, list[dict[str, Any]]]:
    html_before_flight = page_html.split("<script>self.__next_f", 1)[0]
    total_match = re.search(r"Total / 共计:\s*<span[^>]*>(\d+)</span>", html_before_flight)
    total = int(total_match.group(1)) if total_match else None
    blocks = re.findall(
        r'<div class="group relative border-3 border-black bg-white p-4 shadow-neo.*?'
        r'(?=<div class="group relative border-3 border-black bg-white p-4 shadow-neo|<nav|</section>)',
        html_before_flight,
        flags=re.S,
    )

    page_items: list[dict[str, Any]] = []
    for block in blocks:
        href_match = re.search(r'href="(/jokes/[^"]+)"', block)
        text_match = re.search(r'<p class="whitespace-pre-wrap[^>]*>(.*?)</p>', block, flags=re.S)
        if not href_match or not text_match:
            continue

        detail_path = html.unescape(href_match.group(1))
        source_id = detail_path.rsplit("/", 1)[-1]
        tags = [
            html_to_text(tag)
            for tag in re.findall(r'href="/jokes\?tag=[^"]+">#(?:<!-- -->)?(.*?)</a>', block, flags=re.S)
        ]
        author_match = re.search(
            r'href="/authors/[^"]+".*?<span[^>]*>@(?:<!-- -->)?(.*?)</span>',
            block,
            flags=re.S,
        )
        date_match = re.search(r'<time dateTime="([^"]+)"', block)
        preview_text = html_to_text(text_match.group(1))

        item: dict[str, Any] = {
            "id": f"vme_{source_id}",
            "source": "vme",
            "source_id": source_id,
            "source_url": urllib.parse.urljoin("https://vme.im", detail_path),
            "title": "",
            "list_preview_text": preview_text,
            "source_order": (page - 1) * 10 + len(page_items) + 1,
        }
        if tags:
            item["tags"] = tags
        if author_match:
            item["author"] = html_to_text(author_match.group(1))
        if date_match:
            item["date"] = date_match.group(1)
        page_items.append(item)

    return total, page_items


def extract_vme_detail_copy(page_html: str) -> str:
    html_before_flight = page_html.split("<script>self.__next_f", 1)[0]
    article_match = re.search(r"<article[^>]*>(.*?)</article>", html_before_flight, flags=re.S)
    search_area = article_match.group(1) if article_match else html_before_flight
    parser = VmeCopyContentExtractor()
    parser.feed(search_area.replace("<!-- -->", ""))
    return normalize_vme_copy_text(parser.text())


def extract_vme_title(page_html: str) -> str:
    title_match = re.search(r"<title>(.*?)</title>", page_html, flags=re.S)
    return html_to_text(title_match.group(1)) if title_match else ""


def extract_vme() -> dict[str, Any]:
    first_html = fetch_text(VME_URL)
    total, first_items = parse_vme_page(first_html, 1)
    if total is None:
        raise ValueError("could not find VME total count")
    total_pages = math.ceil(total / 10)

    indexed_items = first_items
    for page in range(2, total_pages + 1):
        _, page_items = parse_vme_page(fetch_text(vme_page_url(page)), page)
        indexed_items.extend(page_items)

    seen_ids: set[str] = set()
    id_unique_items: list[dict[str, Any]] = []
    for item in indexed_items:
        source_id = str(item["source_id"])
        if source_id in seen_ids:
            continue
        seen_ids.add(source_id)
        id_unique_items.append(item)

    detail_errors: list[dict[str, Any]] = []
    for item in id_unique_items:
        detail_html = ""
        try:
            detail_html = fetch_text(str(item["source_url"]))
        except Exception as exc:  # noqa: BLE001 - keep failed source visible in audit.
            detail_errors.append(
                {
                    "source_id": item["source_id"],
                    "source_url": item["source_url"],
                    "reason": f"{type(exc).__name__}: {exc}",
                }
            )
        detail_text = extract_vme_detail_copy(detail_html) if detail_html else ""
        if detail_text:
            item["text"] = detail_text
            item["title"] = extract_vme_title(detail_html)
            item["segmentation_method"] = "vme_text_detail_copy_card"
        else:
            item["text"] = item.pop("list_preview_text", "")
            item["segmentation_method"] = "vme_text_list_card_fallback"
        item.pop("list_preview_text", None)

    seen_texts: dict[str, dict[str, Any]] = {}
    unique_items: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    for item in id_unique_items:
        key = duplicate_key(str(item["text"]))
        if key in seen_texts:
            primary = seen_texts[key]
            duplicate_ref = {
                "source_id": item["source_id"],
                "source_url": item["source_url"],
                "source_order": item["source_order"],
            }
            if "date" in item:
                duplicate_ref["date"] = item["date"]
            if "author" in item:
                duplicate_ref["author"] = item["author"]
            primary.setdefault("duplicate_sources", []).append(duplicate_ref)
            duplicates.append(
                {
                    "duplicate_source_id": item["source_id"],
                    "duplicate_source_url": item["source_url"],
                    "kept_source_id": primary["source_id"],
                    "kept_source_url": primary["source_url"],
                    "text": item["text"],
                    "reason": "normalized_text_duplicate",
                }
            )
            continue
        item["source_order"] = len(unique_items) + 1
        seen_texts[key] = item
        unique_items.append(item)

    return {
        "source": "vme",
        "source_url": VME_URL,
        "total_available": total,
        "indexed_item_count": len(indexed_items),
        "id_unique_count": len(id_unique_items),
        "item_count": len(unique_items),
        "duplicate_count": len(duplicates),
        "detail_error_count": len(detail_errors),
        "detail_errors": detail_errors,
        "items": unique_items,
        "duplicates": duplicates,
    }


def extract_topic_paragraphs(page_html: str) -> list[str]:
    match = re.search(r'<div class="rich-content topic-richtext">(.*?)</div>', page_html, flags=re.S)
    if not match:
        return []
    return [html_to_text(raw) for raw in re.findall(r"<p[^>]*>(.*?)</p>", match.group(1), flags=re.S)]


def split_douban_topic_copy(paragraphs: list[str]) -> list[str]:
    copies: list[str] = []
    for paragraph in paragraphs:
        text = normalize_text(paragraph)
        if not text:
            continue
        if text in {"更新一个自己改编的", "以下全部非原创，搬运自我的几个沙雕好友群！"}:
            continue
        if re.fullmatch(r"[—\-_\s]+", text):
            continue
        numbered = re.match(r"^\s*(\d+)[、.．]\s*(.+)$", text, flags=re.S)
        if numbered:
            text = normalize_text(numbered.group(2))
        if BODY_SIGNALS.search(text):
            copies.append(text)
    return copies


def extract_douban_comment_texts(page_html: str) -> list[tuple[str, str]]:
    comments: list[tuple[str, str]] = []
    blocks = re.findall(
        r'<li class="clearfix comment-item reply-item".*?(?=<li class="clearfix comment-item reply-item"|</ul>)',
        page_html,
        flags=re.S,
    )
    for block in blocks:
        cid_match = re.search(r'data-cid="(\d+)"', block)
        text_match = re.search(r'<div class="reply-doc content".*?<p[^>]*>(.*?)</p>', block, flags=re.S)
        if not cid_match or not text_match:
            continue
        text = html_to_text(text_match.group(1))
        if not text or text == "[内容不可见]":
            continue
        if len(text) < 10:
            continue
        if not BODY_SIGNALS.search(text):
            continue
        if re.fullmatch(r"[哈啊呵嘿嘻笑牛马住下了收藏码住\s!！。.，,]+", text):
            continue
        comments.append((cid_match.group(1), text))
    return comments


def extract_douban() -> dict[str, Any]:
    page_html = fetch_text(DOUBAN_URL)
    topic_texts = split_douban_topic_copy(extract_topic_paragraphs(page_html))
    comment_texts = extract_douban_comment_texts(page_html)

    title_match = re.search(r"<h1>\s*(.*?)\s*<div", page_html, flags=re.S)
    title = html_to_text(title_match.group(1)) if title_match else "整理一些肯德基疯狂星期四文案！"

    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_item(text: str, source_id: str, context: str, source_url: str) -> None:
        key = duplicate_key(text)
        if key in seen:
            return
        seen.add(key)
        items.append(
            {
                "id": f"douban_253838719_{len(items) + 1:03d}",
                "source": "douban",
                "source_id": source_id,
                "source_url": source_url,
                "title": title,
                "text": text,
                "source_order": len(items) + 1,
                "segmentation_method": "douban_topic_numbered_blocks_and_signal_comments",
                "context": context,
            }
        )

    for index, text in enumerate(topic_texts, 1):
        add_item(text, f"253838719_topic_{index:03d}", "topic_body", DOUBAN_URL)

    for cid, text in comment_texts:
        add_item(text, f"253838719_comment_{cid}", "comment", f"{DOUBAN_URL}#comments")

    return {
        "source": "douban",
        "source_url": DOUBAN_URL,
        "item_count": len(items),
        "items": items,
    }


def main() -> None:
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    outputs = [
        (GITHUB_OUTPUT, extract_github()),
        (VME_OUTPUT, extract_vme()),
        (DOUBAN_OUTPUT, extract_douban()),
    ]
    for path, data in outputs:
        write_json(path, data)
        print(f"wrote {path}: {data['item_count']} items")


if __name__ == "__main__":
    main()
