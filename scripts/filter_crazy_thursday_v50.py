#!/usr/bin/env python3
"""Filter Crazy Thursday API samples into a cleaner V50 reference corpus."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"
INPUT_PATH = SAMPLES_DIR / "crazy_thursday_type1.json"
OUTPUT_PATH = SAMPLES_DIR / "crazy_thursday_v50.json"
AUDIT_PATH = SAMPLES_DIR / "crazy_thursday_v50.audit.json"
TXT_PATH = SAMPLES_DIR / "crazy_thursday_v50.txt"


BODY_SIGNALS = re.compile(
    r"疯狂星期四|疯四|肯德基|KFC|kfc|v\s*我|V\s*我|v\s*50|V\s*50|"
    r"vme|VME|v\s*me|fifty|FIFTY|请我吃|谁请我吃|请.*吃|"
    r"转我|给我转|给他转|转\d+|押金|欠我|五十|50|星期四|周四|"
    r"炸鸡|原味鸡|鸡米花|鸡翅|鸡块|鸡桶|蛋挞|全家桶|薯条|"
    r"汉堡|至珍七虾堡|奥尔良|香辣|黄金脆皮|黄金鸡块|热辣鸡桶"
)

HIDDEN_OR_ABSTRACT_SIGNALS = re.compile(
    r"垦得基|肯的姬|德肯|基疯|星狂|期四|星期寺|无匙|"
    r"为我武士|为我务实|❺⓿|🅚🅕🅒|🅒🅡🅐🅩🅨|🅥|🅜🅔"
)

KNOWN_BODY_KEEP = {
    # Fill-in puzzle whose answers spell 肯德基疯狂星期四微我五十.
    210,
    # Edge forms the user confirmed are valid Crazy Thursday references even
    # when they look like ads, games, or "unrelated" 50-yuan jokes in isolation.
    283,
    533,
    671,
    387,
    4147,
    5849,
    5850,
    7214,
    11704,
    12968,
    17554,
}

NEAR_DUPLICATE_OF: dict[int, int] = {
    4108: 7215,
    255: 359,
    140: 359,
    383: 16007,
    300: 672,
    304: 1136,
    113: 203,
}

LOW_FRAGMENT_PATTERNS = (
    re.compile(r"^(突然|偷偷|立马|直接|蓦然|倏然)给我买\s*KFC$"),
)

DESCRIPTION_TEXT_IDS = {
    # For these posts the API `content`/card text is a loose story fragment, but
    # the same API record carries a complete Crazy Thursday `description`.
    108,
    362,
    503,
    504,
}

# These entries have SEO titles that mention Crazy Thursday, but the body is an
# unrelated ordinary joke or an incomplete story. Keep the raw API file; exclude
# them from the clean reference set.
KNOWN_BODY_NOISE: dict[int, str] = {
    20852: "plain_unrelated_joke",
    20851: "plain_unrelated_joke",
    20850: "plain_unrelated_joke",
    20849: "plain_unrelated_joke",
    20847: "plain_unrelated_joke",
    20844: "plain_unrelated_joke",
    20843: "plain_unrelated_joke",
    20842: "plain_unrelated_joke",
    20019: "plain_greeting_not_v50_copy",
    19800: "plain_unrelated_joke",
    18640: "plain_unrelated_sentence",
    18516: "plain_unrelated_sentence",
    16944: "plain_game_chat_not_v50_copy",
    16942: "plain_game_chat_not_v50_copy",
    16941: "plain_game_chat_not_v50_copy",
    16939: "plain_game_chat_not_v50_copy",
    16937: "plain_game_chat_not_v50_copy",
    15722: "plain_unrelated_joke",
    15721: "plain_unrelated_joke",
    13761: "plain_unrelated_joke",
    13381: "plain_unrelated_story",
    4138: "low_signal_fengsi_fragment",
    160: "plain_unrelated_joke",
    117: "plain_sound_joke_not_v50_copy",
}


def normalize_text(text: str) -> str:
    text = text.replace("\u200b", "").replace("\u00a0", " ")
    text = text.replace("\u202a", "").replace("\u202b", "").replace("\u202c", "")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def duplicate_key(text: str) -> str:
    key = normalize_text(text).lower()
    key = re.sub(r"\s+", "", key)
    key = re.sub(r"[，。、：:；;！!？?（）()【】\[\]《》“”\"'‘’·…—_\-]", "", key)
    return key


def select_reference_text(item: dict[str, Any]) -> tuple[str, str, str]:
    source_id = int(item["source_id"])
    body_text = normalize_text(str(item.get("text", "")))
    if source_id in DESCRIPTION_TEXT_IDS:
        description = normalize_text(str(item.get("description", "")))
        if description:
            return description, "description", body_text
        return "", "missing_description", body_text
    return body_text, "content", body_text


def classify_item(item: dict[str, Any]) -> tuple[bool, str]:
    source_id = int(item["source_id"])
    text = normalize_text(str(item.get("text", "")))
    if not text:
        return False, "empty_text"

    if source_id in KNOWN_BODY_KEEP:
        return True, "passed_known_hidden_form"

    if source_id in KNOWN_BODY_NOISE:
        return False, KNOWN_BODY_NOISE[source_id]

    for pattern in LOW_FRAGMENT_PATTERNS:
        if pattern.fullmatch(text):
            return False, "low_signal_fragment"

    if len(text) < 10:
        return False, "too_short"

    if "关注小编" in text:
        return False, "site_or_account_cta"

    if "复制链接" in text and "王者荣耀" in text:
        return False, "game_cta_noise"

    has_body_signal = bool(BODY_SIGNALS.search(text))
    has_hidden_signal = bool(HIDDEN_OR_ABSTRACT_SIGNALS.search(text))
    if not has_body_signal and not has_hidden_signal:
        return False, "missing_v50_or_crazy_thursday_body_signal"

    return True, "passed"


def main() -> None:
    data = json.loads(INPUT_PATH.read_text(encoding="utf-8"))
    raw_items = data["items"]

    kept: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    seen: dict[str, dict[str, Any]] = {}

    for raw_item in raw_items:
        item = dict(raw_item)
        selected_text, text_source, original_text = select_reference_text(item)
        item["text"] = selected_text
        # Keep descriptions in the raw API snapshot for reproducibility, but do
        # not duplicate them in the clean corpus unless selected as `text`.
        item.pop("description", None)
        if text_source != "content":
            item["text_source"] = text_source
            item["original_text"] = original_text
        ok, reason = classify_item(item)
        if not ok:
            audit_item = {
                "id": item["id"],
                "source_id": item["source_id"],
                "source_url": item.get("source_url", ""),
                "title": item.get("title", ""),
                "text": item["text"],
                "reason": reason,
            }
            if text_source != "content":
                audit_item["text_source"] = text_source
                audit_item["original_text"] = original_text
            rejected.append(audit_item)
            continue

        near_duplicate_of = NEAR_DUPLICATE_OF.get(int(item["source_id"]))
        if near_duplicate_of is not None:
            kept_match = next(
                (candidate for candidate in kept if int(candidate["source_id"]) == near_duplicate_of),
                None,
            )
            if kept_match is not None:
                duplicates.append(
                    {
                        "duplicate_id": item["id"],
                        "duplicate_source_id": item["source_id"],
                        "kept_id": kept_match["id"],
                        "kept_source_id": kept_match["source_id"],
                        "text": item["text"],
                        "reason": "near_duplicate_text",
                    }
                )
                continue

        key = duplicate_key(item["text"])
        if key in seen:
            duplicates.append(
                {
                    "duplicate_id": item["id"],
                    "duplicate_source_id": item["source_id"],
                    "kept_id": seen[key]["id"],
                    "kept_source_id": seen[key]["source_id"],
                    "text": item["text"],
                    "reason": "duplicate_text",
                }
            )
            continue

        seen[key] = item
        kept.append(item)

    for index, item in enumerate(kept, 1):
        item["corpus_order"] = index

    output = {
        "source": "crazy_thursday",
        "source_type": data.get("source_type"),
        "source_type_label": data.get("source_type_label"),
        "raw_item_count": len(raw_items),
        "item_count": len(kept),
        "items": kept,
    }
    audit = {
        "source": "crazy_thursday",
        "raw_item_count": len(raw_items),
        "kept_item_count": len(kept),
        "rejected_count": len(rejected),
        "duplicate_count": len(duplicates),
        "rejected": rejected,
        "duplicates": duplicates,
    }

    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    AUDIT_PATH.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    TXT_PATH.write_text("\n".join(item["text"].replace("\n", " ") for item in kept) + "\n", encoding="utf-8")

    print(f"raw items: {len(raw_items)}")
    print(f"kept: {len(kept)}")
    print(f"rejected: {len(rejected)}")
    print(f"duplicates: {len(duplicates)}")
    print(f"wrote {OUTPUT_PATH}")
    print(f"wrote {AUDIT_PATH}")
    print(f"wrote {TXT_PATH}")


if __name__ == "__main__":
    main()
