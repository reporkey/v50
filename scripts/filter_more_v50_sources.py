#!/usr/bin/env python3
"""Filter additional V50 sources into reviewable clean JSON and audits."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"

SOURCE_PATHS = [
    SAMPLES_DIR / "vikiboss_v50.json",
    SAMPLES_DIR / "vme_v50.json",
    SAMPLES_DIR / "douban_v50.json",
]


BODY_SIGNALS = re.compile(
    r"疯狂星期四|疯狂周四|疯四|肯德基|KFC|kfc|v\s*我|V\s*我|"
    r"v\s*50|V\s*50|V我50|v我50|vme|VME|fifty|FIFTY|"
    r"请我吃|谁请我吃|转我|五十|50|５０|５／０|"
    r"星期四|周四|木曜日|Thursday|THU|炸鸡|原味鸡|鸡米花|全家桶|"
    r"ケンタッキー|クレイジー木曜日|۵۰|肻徳樭|瘋誑暒剘|肻德基|暒剘④"
)

HIDDEN_FORM_SIGNALS = re.compile(
    r"疯狂星期寺|肯的姬封矿刑期死|肯 德 基|今 天 肯 德 基|"
    r"疯语薄言|窗外高低辨翠微|梅雪争春未|至今思项羽|"
    r"氟碳化钾|KFC代吃|𝗞𝗙𝗖代吃|V~~~~5~~~|"
    r"⢠⠤⠴⠤⠤⠄|⣀⣆⣰⣒⣒⡀"
)

TITLE_OR_FRAGMENT_PATTERNS = (
    re.compile(r"^对于近期发生的事情，我做一个总结[:：]?$"),
    re.compile(r"^《群主很加分的十种行为》$"),
    re.compile(r"^帮我看看这首诗$"),
    re.compile(r"^接下来我要赐予你六根法器$"),
    re.compile(r"^新赛季王者代打$"),
    re.compile(r"^个人副业，支持一下$"),
    re.compile(r"^我有朋友去 OpenAi 上班了。?$"),
    re.compile(r"^昨天公司新来一位女同事今天她找我聊天$"),
    re.compile(r"^爸❤妈💗不 ❤在💗家❤$"),
    re.compile(r"^❤囍•𝑰𝒕’𝒔 𝑻𝒉𝒖𝒓𝒔𝒅𝒂𝒚•囍❤$"),
)

KNOWN_REJECTS: dict[str, dict[str, str]] = {
    "vikiboss_v50": {
        "vikiboss_v50_166": "external_invitation_not_copy",
        "vikiboss_v50_237": "kfc_word_art_without_v50_landing",
        "vikiboss_v50_263": "ordinary_budget_list_no_v50_landing",
        "vikiboss_v50_422": "unrelated_literary_excerpt_no_v50_landing",
    },
    "vme": {
        "vme_I_kwDOLrzjj88AAAABCruIMQ": "ordinary_group_notice_no_v50_landing",
        "vme_I_kwDOLrzjj87CydPB": "ordinary_money_scam_no_50_or_kfc_landing",
        "vme_I_kwDOHp_P8c5vIA8o": "ordinary_budget_list_no_v50_landing",
        "vme_I_kwDOHp_P8c5ln9aM": "incomplete_story_no_v50_landing",
        "vme_I_kwDOHp_P8c5lgobE": "unrelated_literary_excerpt_no_v50_landing",
        "vme_I_kwDOHp_P8c5RYoGH": "incomplete_story_no_v50_landing",
        "vme_I_kwDOHp_P8c5PJsmH": "ordinary_service_ad_no_v50_landing",
        "vme_I_kwDOHp_P8c5PJsj2": "unrelated_fantasy_story_no_v50_landing",
        "vme_I_kwDOHp_P8c5Os5NW": "incomplete_character_art_fragment",
        "vme_I_kwDOHp_P8c5OViJ8": "incomplete_story_no_v50_landing",
        "vme_I_kwDOHp_P8c5OVhTh": "incomplete_howto_fragment_no_v50_landing",
    },
    "douban": {
        "douban_253838719_015": "orphan_continuation_fragment",
        "douban_253838719_023": "meta_comment_not_copy",
        "douban_253838719_026": "ordinary_product_comment_not_copy",
        "douban_253838719_036": "meta_comment_not_copy",
    },
}

KNOWN_KEEP_IDS: dict[str, set[str]] = {
    "vikiboss_v50": {
        "vikiboss_v50_384",
    },
    "vme": {
        "vme_I_kwDOLrzjj86LUihS",
    },
}


def normalize_text(text: str) -> str:
    text = text.replace("\u200b", "").replace("\u00a0", " ")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if re.search(r"\\u[0-9a-fA-F]{4}", text):
        try:
            text = text.encode("utf-8").decode("unicode_escape")
        except UnicodeDecodeError:
            pass
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def duplicate_key(text: str) -> str:
    key = normalize_text(text).lower()
    key = re.sub(r"\s+", "", key)
    key = re.sub(r"[，。、：:；;！!？?（）()【】\[\]《》“”\"'‘’·…—_\-]", "", key)
    return key


def has_v50_mechanism(text: str) -> bool:
    return bool(BODY_SIGNALS.search(text) or HIDDEN_FORM_SIGNALS.search(text))


def reject_reason(source: str, item: dict[str, Any]) -> str | None:
    item_id = str(item.get("id", ""))
    text = normalize_text(str(item.get("text", "")))

    if item_id in KNOWN_KEEP_IDS.get(source, set()):
        return None

    explicit_reason = KNOWN_REJECTS.get(source, {}).get(item_id)
    if explicit_reason:
        return explicit_reason

    if not text:
        return "empty_text"

    for pattern in TITLE_OR_FRAGMENT_PATTERNS:
        if pattern.fullmatch(text):
            return "title_or_fragment_not_copy"

    if len(text) < 10:
        return "too_short"

    if re.fullmatch(r"[哈啊呵嘿嘻笑牛马住下了收藏码住\s!！。.，,]+", text):
        return "plain_reaction_comment"

    if not has_v50_mechanism(text):
        return "missing_v50_or_hidden_mechanism"

    return None


def audit_ref(item: dict[str, Any], reason: str) -> dict[str, Any]:
    keys = [
        "id",
        "source_id",
        "source_url",
        "title",
        "text",
        "source_order",
        "segmentation_method",
        "context",
        "tags",
        "date",
        "author",
    ]
    out = {key: item[key] for key in keys if key in item}
    out["reason"] = reason
    return out


def filter_file(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    source = str(data["source"])
    raw_items = data["items"]

    kept: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    seen: dict[str, dict[str, Any]] = {}

    for raw_item in raw_items:
        item = dict(raw_item)
        item["text"] = normalize_text(str(item.get("text", "")))
        reason = reject_reason(source, item)
        if reason:
            rejected.append(audit_ref(item, reason))
            continue

        key = duplicate_key(item["text"])
        if key in seen:
            duplicates.append(
                {
                    "duplicate_id": item.get("id"),
                    "duplicate_source_id": item.get("source_id"),
                    "duplicate_source_url": item.get("source_url"),
                    "kept_id": seen[key].get("id"),
                    "kept_source_id": seen[key].get("source_id"),
                    "kept_source_url": seen[key].get("source_url"),
                    "text": item["text"],
                    "reason": "duplicate_text",
                }
            )
            continue

        item["corpus_order"] = len(kept) + 1
        seen[key] = item
        kept.append(item)

    output = {
        key: value
        for key, value in data.items()
        if key not in {"items", "item_count", "duplicates", "duplicate_count"}
    }
    output["raw_item_count"] = len(raw_items)
    output["item_count"] = len(kept)
    if "duplicate_count" in data:
        output["source_duplicate_count"] = data.get("duplicate_count", 0)
    output["items"] = kept

    audit = {
        "source": source,
        "source_file": str(path.relative_to(ROOT)),
        "raw_item_count": len(raw_items),
        "kept_item_count": len(kept),
        "rejected_count": len(rejected),
        "duplicate_count": len(duplicates),
        "source_duplicates": data.get("duplicates", []),
        "rejected": rejected,
        "duplicates": duplicates,
    }

    audit_path = path.with_suffix(".audit.json")
    txt_path = path.with_suffix(".txt")
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    txt_path.write_text("\n".join(item["text"].replace("\n", " ") for item in kept) + "\n", encoding="utf-8")

    print(f"{path.name}: raw={len(raw_items)} kept={len(kept)} rejected={len(rejected)} duplicates={len(duplicates)}")
    print(f"  wrote {audit_path}")
    print(f"  wrote {txt_path}")


def main() -> None:
    for path in SOURCE_PATHS:
        filter_file(path)


if __name__ == "__main__":
    main()
