#!/usr/bin/env python3
"""Extract clean V50 copy samples from saved Zhihu MHTML files.

The input MHTML files are kept immutable in samples/. This script only reads
them and writes the cleaned corpus plus a small audit file.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"
OUTPUT_PATH = SAMPLES_DIR / "zhihu_v50.json"
AUDIT_PATH = SAMPLES_DIR / "zhihu_v50.audit.json"


NOISE_PATTERNS = (
    "wenanmen.com",
    "更多文案",
    "求一波关注",
    "送礼物",
    "所属专栏",
    "赞同",
    "申请转载",
    "理性发言",
    "默认最新",
    "关于作者",
    "大家都在搜",
    "推荐阅读",
    "PostItem",
    "查看全部评论",
    "点击查看全部评论",
    "广告",
    "查看详情",
)

REFERENCE_SIGNALS = (
    "肯德基",
    "KFC",
    "kfc",
    "疯狂星期四",
    "Crazy Thursday",
    "crazy Thursday",
    "v我",
    "V我",
    "v50",
    "V50",
    "VWO50",
    "请我吃",
    "谁请我吃",
    "五十",
    "50",
    "星期四",
)


@dataclass
class Block:
    tag: str
    attrs: dict[str, str]
    text: str


class BlockParser(HTMLParser):
    """Collect textual block tags in document order."""

    block_tags = {"p", "li", "h1", "h2", "h3", "blockquote"}
    skip_tags = {"script", "style", "svg"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[Block] = []
        self._current: tuple[str, dict[str, str]] | None = None
        self._buffer: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.skip_tags:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in self.block_tags and self._current is None:
            self._current = (tag, {k: v or "" for k, v in attrs})
            self._buffer = []
        elif self._current and tag == "br":
            self._buffer.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.skip_tags and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if self._current and tag == self._current[0]:
            text = normalize_text("".join(self._buffer))
            if text:
                block_tag, attrs = self._current
                self.blocks.append(Block(block_tag, attrs, text))
            self._current = None
            self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._current and not self._skip_depth:
            self._buffer.append(data)


def normalize_text(text: str) -> str:
    text = text.replace("\u200b", "")
    text = text.replace("\u202a", "").replace("\u202b", "").replace("\u202c", "")
    text = text.replace("\u200d", "")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def read_mhtml_html(path: Path) -> str:
    msg = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
    html_parts: list[str] = []
    for part in msg.walk():
        if part.get_content_type() != "text/html":
            continue
        payload = part.get_payload(decode=True) or b""
        html_parts.append(payload.decode("utf-8", "replace"))
    if not html_parts:
        raise ValueError(f"No text/html part found in {path}")
    return max(html_parts, key=len)


def article_html_only(html: str) -> str:
    """Keep the saved article body area and drop comments/recommendations."""
    start = html.find("Post-Title")
    if start == -1:
        start = 0
    end_candidates = [idx for token in ("ContentItem-time", "Recommendations-Main") if (idx := html.find(token)) != -1]
    end = min(end_candidates) if end_candidates else len(html)
    return html[start:end]


def parse_blocks(html: str) -> list[Block]:
    parser = BlockParser()
    parser.feed(article_html_only(html))
    return parser.blocks


def is_number_marker(text: str) -> bool:
    return bool(re.fullmatch(r"\d+[.．]", text))


def looks_like_noise(text: str) -> bool:
    return any(pattern in text for pattern in NOISE_PATTERNS)


def has_reference_signal(text: str) -> bool:
    return any(signal in text for signal in REFERENCE_SIGNALS)


def is_qualified_copy(text: str) -> tuple[bool, str]:
    if looks_like_noise(text):
        return False, "page_noise_or_source_promo"
    if len(text) < 10:
        return False, "too_short"
    if not has_reference_signal(text):
        return False, "missing_v50_or_kfc_signal"
    if re.search(r"^\d{4}-\d{2}-\d{2}.*回复", text):
        return False, "comment_metadata"
    return True, "passed"


def flush_segment(
    segments: list[dict[str, str]],
    rejected: list[dict[str, str]],
    source_method: str,
    lines: list[str],
    reject_context: str,
) -> None:
    text = normalize_text("\n".join(line for line in lines if line.strip()))
    if not text:
        return
    ok, reason = is_qualified_copy(text)
    if ok:
        segments.append({"text": text, "segmentation_method": source_method})
    else:
        rejected.append({"text": text, "reason": reason, "context": reject_context})


def segment_numbered(blocks: list[Block]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    segments: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    current: list[str] = []
    seen_first_marker = False

    for block in blocks:
        text = block.text
        if block.tag == "h1":
            continue
        if not seen_first_marker:
            if is_number_marker(text):
                seen_first_marker = True
            continue
        if is_number_marker(text):
            flush_segment(segments, rejected, "zhihu_numbered_blocks", current, "before_next_number")
            current = []
            continue
        if block.tag == "h2" and current:
            flush_segment(segments, rejected, "zhihu_numbered_blocks", current, "before_heading_copy")
            current = []
            flush_segment(segments, rejected, "zhihu_heading_copy", [text], "heading_copy")
            continue
        current.append(text)

    flush_segment(segments, rejected, "zhihu_numbered_blocks", current, "end_of_article")
    return segments, rejected


def split_joined_copy(text: str) -> list[str]:
    """Split a known Zhihu paragraph that glues multiple independent copies."""
    if not text.startswith("肯德基这逼养的"):
        return [text]

    parts: list[str] = []
    first_anchor = text.find("我本是显赫世家的少爷")
    second_anchor = text.find("家人们，别他妈垂头丧气了")
    if first_anchor != -1 and second_anchor != -1:
        prefix = text[:first_anchor].strip(" ，。")
        if prefix and "谁请我吃" in prefix:
            parts.append(prefix)
        parts.append(text[first_anchor:second_anchor].strip(" ，。"))
        parts.append(text[second_anchor:].strip(" ，。"))
        return parts
    return [text]


def segment_freeform(blocks: list[Block]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    segments: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    texts = [block.text for block in blocks if block.tag != "h1"]
    skipped_indexes: set[int] = set()
    i = 0
    while i < len(texts):
        if i in skipped_indexes:
            i += 1
            continue

        text = texts[i]
        if text == "✨疯狂星期四✨":
            i += 1
            continue

        if text.startswith("❤️活力周四") and i + 2 < len(texts):
            bundle = texts[i : i + 3]
            if any("肯德基" in line for line in bundle):
                flush_segment(
                    segments,
                    rejected,
                    "zhihu_freeform_short_line_bundle",
                    bundle,
                    "heart_short_line_bundle",
                )
                i += 3
                continue

        if text == "今天是疯狂星期四":
            bundle = texts[i : i + 8]
            if bundle and bundle[-1] == "不如挨顿骂":
                flush_segment(
                    segments,
                    rejected,
                    "zhihu_freeform_short_line_bundle",
                    bundle,
                    "short_line_bundle",
                )
                i += 8
                continue

        if text.startswith("正在循环播放《群主") and i + 2 < len(texts):
            bundle = texts[i : i + 3]
            if bundle[-1] == "⇆ ◁ ❚❚ ▷ ↻":
                flush_segment(
                    segments,
                    rejected,
                    "zhihu_freeform_short_line_bundle",
                    bundle,
                    "music_player_bundle",
                )
                i += 3
                continue

        if text.startswith("男朋友跟我分手了，我心碎了决定见她一面"):
            continuation_prefixes = (
                "吃完后，她下决心去打掉这个负心汉的孩子",
                "我有时候会觉得大家并不喜欢那个真正的我",
            )
            bundle = [text]
            for prefix in continuation_prefixes:
                match_index = next(
                    (idx for idx in range(i + 1, len(texts)) if texts[idx].startswith(prefix)),
                    None,
                )
                if match_index is not None:
                    bundle.append(texts[match_index])
                    skipped_indexes.add(match_index)
            flush_segment(
                segments,
                rejected,
                "zhihu_freeform_cross_paragraph_bundle",
                bundle,
                "cross_paragraph_story_bundle",
            )
            i += 1
            continue

        if text == "你觉得这个群有什么问题？":
            bundle = [text]
            i += 1
            while i < len(texts):
                bundle.append(texts[i])
                if texts[i] == "○有其他问题":
                    break
                i += 1
            flush_segment(segments, rejected, "zhihu_freeform_poll", bundle, "poll_bundle")
            i += 1
            continue

        for part in split_joined_copy(text):
            flush_segment(segments, rejected, "zhihu_freeform_paragraph", [part], "paragraph")
        i += 1

    return segments, rejected


def extract_source_url(html: str) -> str:
    match = re.search(r"https://zhuanlan\.zhihu\.com/p/(\d+)", html)
    return match.group(0) if match else ""


def extract_title(blocks: Iterable[Block], html: str) -> str:
    for block in blocks:
        if block.tag == "h1" and "Post-Title" in block.attrs.get("class", ""):
            return block.text
    match = re.search(r"<title>(.*?)</title>", html, re.S)
    if not match:
        return ""
    title = re.sub(r"\s+-\s+知乎\s*$", "", match.group(1))
    title = re.sub(r"^\(1 封私信\)\s*", "", title)
    return normalize_text(title)


def source_id_from_url(source_url: str, fallback: str) -> str:
    match = re.search(r"/p/(\d+)", source_url)
    if match:
        return match.group(1)
    return fallback


def dedupe_items(items: list[dict[str, object]]) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    seen: dict[str, dict[str, object]] = {}
    kept: list[dict[str, object]] = []
    duplicates: list[dict[str, object]] = []
    for item in items:
        key = normalize_text(str(item["text"]))
        if key in seen:
            duplicates.append(
                {
                    "duplicate_id": item["id"],
                    "kept_id": seen[key]["id"],
                    "text": item["text"],
                    "source_url": item["source_url"],
                }
            )
            continue
        seen[key] = item
        kept.append(item)
    return kept, duplicates


def main() -> None:
    mhtml_files = sorted(SAMPLES_DIR.glob("*.mhtml"))
    if not mhtml_files:
        raise SystemExit("No .mhtml files found in samples/")

    raw_items: list[dict[str, object]] = []
    source_summaries: list[dict[str, object]] = []
    rejected: list[dict[str, object]] = []

    for path in mhtml_files:
        html = read_mhtml_html(path)
        blocks = parse_blocks(html)
        source_url = extract_source_url(html)
        source_id = source_id_from_url(source_url, path.stem)
        title = extract_title(blocks, html)

        if source_id in {"632097424", "715926417"}:
            segments, local_rejected = segment_numbered(blocks)
            default_method = "zhihu_numbered_blocks"
        else:
            segments, local_rejected = segment_freeform(blocks)
            default_method = "zhihu_freeform_paragraph"

        before_count = len(raw_items)
        for order, segment in enumerate(segments, 1):
            item_id = f"zhihu_{source_id}_{order:03d}"
            raw_items.append(
                {
                    "id": item_id,
                    "source": "zhihu",
                    "source_id": source_id,
                    "source_url": source_url,
                    "source_file": str(path.relative_to(ROOT)),
                    "title": title,
                    "text": segment["text"],
                    "source_order": order,
                    "segmentation_method": segment.get("segmentation_method", default_method),
                }
            )

        for reject in local_rejected:
            reject.update(
                {
                    "source": "zhihu",
                    "source_id": source_id,
                    "source_url": source_url,
                    "source_file": str(path.relative_to(ROOT)),
                    "title": title,
                }
            )
            rejected.append(reject)

        source_summaries.append(
            {
                "source_file": str(path.relative_to(ROOT)),
                "source_url": source_url,
                "title": title,
                "segmentation_method": default_method,
                "extracted_count": len(raw_items) - before_count,
                "rejected_count": len(local_rejected),
            }
        )

    items, duplicates = dedupe_items(raw_items)
    for idx, item in enumerate(items, 1):
        item["corpus_order"] = idx

    output = {
        "source": "zhihu",
        "item_count": len(items),
        "sources": source_summaries,
        "items": items,
    }
    audit = {
        "source": "zhihu",
        "raw_item_count": len(raw_items),
        "kept_item_count": len(items),
        "duplicate_count": len(duplicates),
        "rejected_count": len(rejected),
        "duplicates": duplicates,
        "rejected": rejected,
    }

    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    AUDIT_PATH.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT_PATH} ({len(items)} items)")
    print(f"wrote {AUDIT_PATH} ({len(rejected)} rejected, {len(duplicates)} duplicates)")


if __name__ == "__main__":
    main()
