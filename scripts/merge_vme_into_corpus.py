#!/usr/bin/env python3
"""Incrementally merge accepted VME samples into the main flat V50 corpus."""

from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"
CORPUS_PATH = SAMPLES_DIR / "v50_corpus.json"
VME_PATH = SAMPLES_DIR / "vme_v50.json"
VME_AUDIT_PATH = SAMPLES_DIR / "vme_v50.audit.json"

ACCEPTED_DECISIONS = {"gold", "silver", "edge"}
SOURCE_LINKS = {
    "crazy_thursday": "https://www.crazy-thursday.com/",
    "zhihu": "https://zhuanlan.zhihu.com/",
    "vikiboss_v50": "https://github.com/vikiboss/v50",
    "douban": "https://www.douban.com/group/topic/253838719/",
    "vme": "https://vme.im/jokes?type=text",
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


def source_ref(source_item: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "source",
        "source_url",
        "tags",
        "likes",
    ]
    ref: dict[str, Any] = {}
    for key in keys:
        if key in source_item:
            ref[key] = source_item[key]
    return ref


def source_summary(source_name: str, item_count: int, **extra: Any) -> dict[str, Any]:
    summary = {
        "source_name": source_name,
        "source": SOURCE_LINKS.get(source_name, ""),
        "item_count": item_count,
    }
    summary.update({key: value for key, value in extra.items() if value is not None})
    return summary


def flatten_corpus_item(item: dict[str, Any]) -> dict[str, Any]:
    if "primary_source" not in item:
        return dict(item)

    flat = {
        "id": item["id"],
        "text": item["text"],
    }
    flat.update(item.get("primary_source", {}))
    return flat


def normalize_source_summaries(corpus: dict[str, Any]) -> None:
    normalized: list[dict[str, Any]] = []
    for summary in corpus.get("source_summaries", []):
        source_name = summary.get("source_name") or summary.get("source")
        if source_name not in SOURCE_LINKS:
            for candidate_name, candidate_url in SOURCE_LINKS.items():
                if summary.get("source") == candidate_url:
                    source_name = candidate_name
                    break
        if source_name not in SOURCE_LINKS:
            continue
        extra = {
            key: summary[key]
            for key in ("raw_item_count", "excluded_item_count")
            if key in summary
        }
        normalized.append(source_summary(source_name, int(summary.get("item_count", 0)), **extra))
    corpus["source_summaries"] = normalized


def remove_existing_vme(corpus: dict[str, Any]) -> dict[str, Any]:
    """Remove prior VME merge data so this script is repeatable."""

    kept_items: list[dict[str, Any]] = []
    for item in corpus["items"]:
        flat_item = flatten_corpus_item(item)
        if flat_item.get("source") == "vme":
            continue
        kept_items.append(flat_item)

    corpus["items"] = kept_items
    corpus["source_summaries"] = [
        summary
        for summary in corpus.get("source_summaries", [])
        if (summary.get("source_name") or summary.get("source")) != "vme"
        and summary.get("source") != SOURCE_LINKS["vme"]
    ]
    return corpus


def renumber_corpus(corpus: dict[str, Any]) -> None:
    for index, item in enumerate(corpus["items"], 1):
        item["id"] = f"v50_{index:06d}"


def main() -> None:
    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    vme = json.loads(VME_PATH.read_text(encoding="utf-8"))
    audit = json.loads(VME_AUDIT_PATH.read_text(encoding="utf-8"))

    normalize_source_summaries(corpus)
    corpus = remove_existing_vme(corpus)
    renumber_corpus(corpus)

    audit_by_source_id = {
        str(item["source_id"]): item
        for item in audit["items"]
        if item.get("decision") in ACCEPTED_DECISIONS
    }
    vme_by_source_id = {str(item["source_id"]): item for item in vme["items"]}

    missing = sorted(set(audit_by_source_id) - set(vme_by_source_id))
    if missing:
        raise ValueError(f"accepted VME audit ids missing from source JSON: {missing[:5]}")

    accepted_items: list[dict[str, Any]] = []
    for audit_item in sorted(audit_by_source_id.values(), key=lambda item: item["source_order"]):
        source_item = dict(vme_by_source_id[str(audit_item["source_id"])])
        source_item["text"] = normalize_text(str(audit_item["text"]))
        accepted_items.append(source_item)

    seen: dict[str, dict[str, Any]] = {
        duplicate_key(str(item["text"])): item for item in corpus["items"]
    }

    added_count = 0
    duplicate_count = 0
    for source_item in accepted_items:
        text = normalize_text(str(source_item.get("text", "")))
        if not text:
            raise ValueError(f"empty accepted VME text: {source_item.get('id')}")
        ref = source_ref(source_item)
        key = duplicate_key(text)
        if key in seen:
            duplicate_count += 1
            continue

        corpus_item = {
            "id": f"v50_{len(corpus['items']) + 1:06d}",
            "text": text,
        }
        corpus_item.update(ref)
        seen[key] = corpus_item
        corpus["items"].append(corpus_item)
        added_count += 1

    corpus["source_summaries"].append(
        source_summary(
            "vme",
            len(accepted_items),
            raw_item_count=len(vme["items"]),
            excluded_item_count=audit.get("needs_review_count", 0)
            + audit.get("non_reference_count", 0),
        )
    )

    corpus["created_at"] = now_iso()
    corpus["input_item_count"] = sum(
        int(summary.get("item_count", 0)) for summary in corpus["source_summaries"]
    )
    corpus["item_count"] = len(corpus["items"])
    corpus.pop("input_files", None)
    corpus.pop("input_item_count", None)
    corpus.pop("duplicate_count", None)
    corpus.pop("duplicates", None)

    CORPUS_PATH.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"accepted VME items: {len(accepted_items)}")
    print(f"added unique VME items: {added_count}")
    print(f"VME duplicates skipped: {duplicate_count}")
    print(f"merged corpus items: {corpus['item_count']}")
    print(f"wrote {CORPUS_PATH}")


if __name__ == "__main__":
    main()
