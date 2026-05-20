#!/usr/bin/env python3
"""Merge cleaned V50 sample JSON files into one flat de-duplicated corpus."""

from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"
INPUT_PATHS = [
    SAMPLES_DIR / "crazy_thursday_v50.json",
    SAMPLES_DIR / "zhihu_v50.json",
    SAMPLES_DIR / "vikiboss_v50.json",
    SAMPLES_DIR / "douban_v50.json",
]
OUTPUT_PATH = SAMPLES_DIR / "v50_corpus.json"
SOURCE_LINKS = {
    "crazy_thursday": "https://www.crazy-thursday.com/",
    "zhihu": "https://zhuanlan.zhihu.com/",
    "vikiboss_v50": "https://github.com/vikiboss/v50",
    "douban": "https://www.douban.com/group/topic/253838719/",
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def normalize_text(text: str) -> str:
    text = text.replace("\u200b", "").replace("\u00a0", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def duplicate_key(text: str) -> str:
    key = normalize_text(text).lower()
    key = re.sub(r"\s+", "", key)
    key = re.sub(r"[，。、：:；;！!？?（）()【】\[\]《》“”\"'‘’·…—_\-]", "", key)
    return key


def load_items(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ValueError(f"{path} must be an object with an items array")
    return data, data["items"]


def source_ref(item: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "source",
        "source_url",
        "tags",
        "likes",
    ]
    ref: dict[str, Any] = {}
    for key in keys:
        if key in item:
            ref[key] = item[key]
    return ref


def source_summary(source_name: str, item_count: int) -> dict[str, Any]:
    return {
        "source_name": source_name,
        "source": SOURCE_LINKS.get(source_name, ""),
        "item_count": item_count,
    }


def main() -> None:
    source_summaries: list[dict[str, Any]] = []
    merged: list[dict[str, Any]] = []
    duplicate_count = 0
    seen: dict[str, dict[str, Any]] = {}
    input_item_count = 0

    for path in INPUT_PATHS:
        data, items = load_items(path)
        source_summaries.append(source_summary(str(data.get("source")), len(items)))
        input_item_count += len(items)

        for item in items:
            text = normalize_text(str(item.get("text", "")))
            if not text:
                raise ValueError(f"empty text in {path}: {item.get('id')}")

            ref = source_ref(item)
            key = duplicate_key(text)
            if key in seen:
                duplicate_count += 1
                continue

            corpus_item = {
                "id": f"v50_{len(merged) + 1:06d}",
                "text": text,
            }
            corpus_item.update(ref)
            seen[key] = corpus_item
            merged.append(corpus_item)

    output = {
        "source": "merged_v50_samples",
        "created_at": now_iso(),
        "item_count": len(merged),
        "source_summaries": source_summaries,
        "items": merged,
    }

    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"input items: {input_item_count}")
    print(f"merged items: {len(merged)}")
    print(f"duplicates skipped: {duplicate_count}")
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
