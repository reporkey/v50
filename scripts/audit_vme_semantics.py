#!/usr/bin/env python3
"""Build a semantic quality audit for the extracted VME text corpus.

This script reads samples/vme_v50.json and writes audit artifacts only. It
does not mutate the source JSON.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"
SOURCE_PATH = SAMPLES_DIR / "vme_v50.json"
AUDIT_PATH = SAMPLES_DIR / "vme_v50.audit.json"
AUDIT_TXT_PATH = SAMPLES_DIR / "vme_v50.audit.txt"


TEXT_ONLY_SOURCE_URL = "https://vme.im/jokes?type=text"

DIRECT_ASK_RE = re.compile(
    r"v\s*(我|me|私|私信)?\s*(50|52|57\.5|60|66|88|99|100|五十|五十二)|"
    r"V\s*(我|me)?\s*(50|52|57\.5|60|66|88|99|100|五十|五十二)|"
    r"V50|v50|VME50|vme50|"
    r"v_me50|v-me-50|vivo50|v私50|微我|薇，我50|V\s+me\s+50|"
    r"转我|转给|发我|借我|接济|资助|赞助|请我|谁请|谁能|有好心人|"
    r"欠我\s*50|要五十|找别人要五十|求助v50|"
    r"交\s*50|交50|交钱|罚款|押金|定金|随礼|书本费|医药费|封口费|台费|"
    r"50(?:元|块|刀|円|위안)?.{0,12}(到我|给我|发我|定金|押金|支持|赞助|融资|辛苦费|交)|"
    r"(52|57\.5|60|66|88|99|100|五十|五十二).{0,8}(发我|给我|借我|转我|支持)|"
    r"骗你\s*50|"
    r"(给我|帮我).{0,12}(买|点|请|带|50|五十|KFC|肯德基|吃)"
)
MONEY_RE = re.compile(r"50|五十|伍拾|５0|５０|52|五十二|25\.8|39\.9|49|57\.5|60|66|88|99|100|114\.5")
KFC_RE = re.compile(
    r"肯德基|KFC|kfc|Kentucky|炸鸡|原味鸡|鸡米花|全家桶|蛋挞|吮指|"
    r"黄金鸡块|脆皮鸡|汉堡|鸡翅|薯条|烤翅|小酥肉|FriedChicken"
)
THURSDAY_RE = re.compile(r"疯狂星期四|疯狂周四|疯四|星期四|周四|Thursday|THU|木曜日|星期寺|Crazy")
META_RE = re.compile(r"文案|复制|粘贴|段子|发朋友圈|每周四|周周|KFC到底|肯德基到底")
CODE_RE = re.compile(
    r"KFC[-_ ]?CRAZY|CRAZY[-_ ]?THURSDAY|v[_-]?me50|VME50|apikey|CDK|"
    r"密码|账号\s*[:：]|key",
    re.I,
)
HIDDEN_RE = re.compile(
    r"氟碳化钾|肯的姬封矿刑期死|峰旷星期四|疯狂星期寺|"
    r"疯语薄言|窗外高低辨翠微|至今思项羽|V~~~~5|肻徳樭|瘋誑暒剘"
)
SENSITIVE_RE = re.compile(
    r"高潮|灌肠|肛门|菊花|JJ|约炮|开房|合租女生|搞大我肚子|"
    r"女高中生|打胎|怀孕|验孕|结婚.*哥哥|她哥.*结婚|"
    r"不想活|跳楼|中毒|透她|嘎腰|卖越去南|家暴"
)


MANUAL_REJECTS: dict[str, tuple[str, str]] = {
    "I_kwDOLrzjj88AAAABCruIMQ": (
        "ordinary_group_notice_no_v50_mechanism",
        "Group-notice bait, but no KFC/Thursday/50 landing or transferable V50 mechanism.",
    ),
    "I_kwDOLrzjj87CydPB": (
        "ordinary_money_scam_no_v50_mechanism",
        "Fake scam format, but the money request is not tied to KFC/Thursday/V50.",
    ),
    "I_kwDOHp_P8c5vIA8o": (
        "ordinary_budget_list_no_v50_mechanism",
        "Budget/gacha joke without a V50 landing or KFC semantic turn.",
    ),
    "I_kwDOHp_P8c5nJOsT": (
        "generic_story_mentions_crazy_thursday_only",
        "Long generic adventure story; 'crazy Thursday' is literal scene setting, not the meme mechanism.",
    ),
    "I_kwDOHp_P8c5lgobE": (
        "unrelated_literary_excerpt",
        "Long literary excerpt with no V50/KFC mechanism after detail-page recovery.",
    ),
}

MANUAL_REVIEW: dict[str, tuple[str, str]] = {
    "I_kwDOLrzjj86nRHxC": (
        "self_harm_setup",
        "The V50 landing works, but the setup uses jumping-from-window ideation; keep out of gold.",
    ),
    "I_kwDOLrzjj86MEhRh": (
        "self_harm_or_poison_setup",
        "The V50 landing works, but the setup jokes about self-harm/poisoning; keep out of gold.",
    ),
    "I_kwDOLrzjj86FeSJA": (
        "self_harm_or_poison_setup",
        "The V50 landing works, but the setup jokes about poisoning; keep out of gold.",
    ),
    "I_kwDOLrzjj86FXTQn": (
        "pregnancy_or_coercive_relationship_setup",
        "The V50 landing works, but the setup includes pregnancy and coerced-marriage melodrama; keep out of gold.",
    ),
    "I_kwDOLrzjj86FWM_V": (
        "sexualized_kfc_pun",
        "Has KFC semantics, but the phrasing is sexualized and should not be gold reference material.",
    ),
    "I_kwDOLrzjj86FV697": (
        "sexual_or_minor_adjacency",
        "Contains dating-account bait with '女高中生'; keep out of gold unless explicitly wanted as boundary material.",
    ),
    "I_kwDOHp_P8c5g8Zgo": (
        "explicit_sexual_howto",
        "The V50 punchline exists, but the setup is graphic sexual instruction and unsuitable for prompt reference.",
    ),
    "I_kwDOLrzjj86FM8Un": (
        "violent_crime_setup",
        "The V50 landing works, but the setup leans on domestic violence, trafficking, and organ-harvesting imagery.",
    ),
    "I_kwDOHp_P8c5nVWcb": (
        "weak_v50_landing_non_money_extortion",
        "KFC Thursday appears, but the ask is to transfer all digital currency, making the V50 pattern semantically off.",
    ),
    "I_kwDOHp_P8c5OsuK8": (
        "sexualized_discount_pun",
        "KFC discount wordplay is present, but it is sexualized and has no real V50 request landing.",
    ),
    "I_kwDOHp_P8c5oIK4j": (
        "v50_not_addressed_to_reader",
        "The v我50 appears inside the story as someone else's red packet, so it is weaker as a direct V50 copy.",
    ),
    "I_kwDOHp_P8c5Oa4QC": (
        "sexualized_exam_setup",
        "The V50 landing works, but the exam-failure setup includes a sexualized aside; keep out of gold.",
    ),
    "I_kwDOHp_P8c5Oa6yN": (
        "coercive_or_blackmail_frame",
        "Has absurd V50-like coercion, but the blackmail/sexual frame makes it poor gold material.",
    ),
    "I_kwDOHp_P8c5TX2DG": (
        "sexualized_long_setup",
        "The final KFC ask is clear, but the setup is sexualized and long enough to be a risky reference.",
    ),
    "I_kwDOHp_P8c5OVhTh": (
        "manipulative_dating_howto",
        "Ends in a KFC ask, but most of the semantic content is manipulative dating advice.",
    ),
}

USER_ACCEPTED_EDGE_IDS = {
    # Accepted by human review after semantic audit. Keep these as edge
    # references so they are usable without promoting sensitive/boundary
    # material into gold.
    "I_kwDOLrzjj86nRHxC",
    "I_kwDOLrzjj86j3wp-",
    "I_kwDOLrzjj86blJco",
    "I_kwDOLrzjj86MEhRh",
    "I_kwDOLrzjj86LUihS",
    "I_kwDOLrzjj86FeSJA",
    "I_kwDOLrzjj86FXTQn",
    "I_kwDOLrzjj86FWM_V",
    "I_kwDOLrzjj86FV697",
    "I_kwDOLrzjj86FM8Un",
    "I_kwDOHp_P8c5uCVkq",
    "I_kwDOHp_P8c5qHvJe",
    "I_kwDOHp_P8c5oIK4j",
    "I_kwDOHp_P8c5g8Zgo",
    "I_kwDOHp_P8c5XpyCD",
    "I_kwDOHp_P8c5TX2DG",
    "I_kwDOHp_P8c5TXz5A",
    "I_kwDOHp_P8c5Oshhg",
    "I_kwDOHp_P8c5Oa7PU",
    "I_kwDOHp_P8c5Oa4QC",
    "I_kwDOHp_P8c5OWDwI",
    "I_kwDOHp_P8c5OVhTh",
}

MANUAL_SILVER: dict[str, tuple[str, str]] = {
    "I_kwDOLrzjj86oE-oi": (
        "reverse_thursday_ai_impersonation",
        "Clear fake-identity 50-yuan request with an inverted 'do not check weekday' Thursday cue.",
    ),
    "I_kwDOHp_P8c5TX4kA": (
        "classic_character_impersonation_v50",
        "Clear character-impersonation V50 request; not gold only because it is niche IP context.",
    ),
    "I_kwDOHp_P8c5PXhBg": (
        "decoded_unicode_v50_story",
        "Semantically clear KFC Thursday ask after Unicode decoding; source text still needs cleanup before merge.",
    ),
    "I_kwDOHp_P8c5OVk1F": (
        "encoded_text_v50_ask",
        "Fire-text style still clearly says KFC Crazy Thursday and asks to be treated.",
    ),
}

MANUAL_EDGE: dict[str, tuple[str, str]] = {
    "I_kwDOLrzjj86iG5AJ": (
        "foreign_language_v50_variant",
        "Korean political impersonation includes roughly-50-yuan support and a V50-like code name; keep as edge.",
    ),
    "I_kwDOLrzjj87UvClC": (
        "compressed_v5_wordplay",
        "Very compressed V5/V50 wordplay; useful as an edge form but not a core reference.",
    ),
    "I_kwDOLrzjj87m9UJf": (
        "v5_repetition_wordplay",
        "The V5 repeated-to-50 joke is semantically relevant, but too compressed for gold.",
    ),
    "I_kwDOLrzjj87COCqb": (
        "v5_repetition_wordplay",
        "The V5 repeated-to-50 joke is semantically relevant, but too compressed for gold.",
    ),
    "I_kwDOLrzjj87ZWa_v": (
        "meta_without_direct_landing",
        "Meta joke about copying Thursday texts; semantically relevant but has no request landing.",
    ),
    "I_kwDOLrzjj86ch_Ia": (
        "anti_kfc_social_turn",
        "Anti-KFC wording is the joke; relevant as boundary/meta material, not gold.",
    ),
    "I_kwDOLrzjj86al869": (
        "kfc_flex_no_request",
        "KFC/Thursday flex with no ask; source-flavored but weak as V50 copy.",
    ),
    "I_kwDOLrzjj86ZrzOe": (
        "dialogue_kfc_deflection",
        "Looks like a reply to a missing previous message; keep only as edge dialogue form.",
    ),
    "I_kwDOHp_P8c5tVfqK": (
        "topical_pun_product_only",
        "Topical KFC pun and product mention without money/request landing.",
    ),
    "I_kwDOHp_P8c5o2xZ_": (
        "foreign_language_v50_translation",
        "Korean text carries a recognizable KFC Thursday / 50-yuan request, but is less useful as Chinese prompt gold.",
    ),
    "I_kwDOHp_P8c5eoPv4": (
        "medical_menu_without_request",
        "KFC menu prescription setup, but no explicit V50/request landing.",
    ),
    "I_kwDOHp_P8c5gXoTJ": (
        "service_menu_kfc代吃",
        "KFC代吃 listing is a valid edge form but too list-like for gold.",
    ),
    "I_kwDOHp_P8c5ZRMK3": (
        "pun_without_request",
        "KFC/Thursday pun without a money ask; keep as boundary material.",
    ),
    "I_kwDOHp_P8c5TX3NT": (
        "service_menu_kfc代吃",
        "KFC代吃 listing is a valid edge form but too list-like for gold.",
    ),
    "I_kwDOHp_P8c5TX35F": (
        "motivational_kfc_reminder_only",
        "Only reminds the reader it is KFC Thursday; weak but relevant boundary sample.",
    ),
    "I_kwDOHp_P8c5S3wnj": (
        "hidden_homophone_v50",
        "The homophone points to KFC Crazy Thursday / V-me-50, but it is too indirect for core gold.",
    ),
    "I_kwDOHp_P8c5PEZ2q": (
        "fake_cve_kfc_thursday",
        "CVE notice format is a useful boundary form, but it lacks a direct transfer/treat-me landing.",
    ),
    "I_kwDOHp_P8c5SXlvo": (
        "weekday_kfc_wordplay",
        "Weekday replacement wordplay; relevant as a minimal edge sample.",
    ),
    "I_kwDOHp_P8c5RY4UK": (
        "price_list_v50_turn",
        "Price list ends in V我 50; valid but too skeletal for gold.",
    ),
    "I_kwDOHp_P8c5OVovl": (
        "symbolic_kfc_only",
        "KFC Crazy Thursday is the final symbol, but there is no transfer/meal ask.",
    ),
    "I_kwDOHp_P8c5U8ac_": (
        "character_art_requires_visual_decoding",
        "Character art is V50-adjacent but hard to use as text prompt gold.",
    ),
    "I_kwDOHp_P8c5Os5NW": (
        "character_art_requires_visual_decoding",
        "Character art is V50-adjacent but hard to use as text prompt gold.",
    ),
}


def normalize_for_audit(text: str) -> str:
    text = text.replace("\u200b", "").replace("\u00a0", " ")
    if re.search(r"\\u[0-9a-fA-F]{4}", text):
        try:
            text = text.encode("utf-8").decode("unicode_escape")
        except UnicodeDecodeError:
            pass
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def has_hidden_acrostic(text: str) -> bool:
    lines = []
    for raw_line in text.splitlines():
        line = raw_line.strip(" ，。,.!！?？：:；;、")
        line = re.sub(r"^\d+\s*[.、．]\s*", "", line)
        if line:
            lines.append(line)
    if len(lines) < 4:
        return False
    first_chars = "".join(line[:1] for line in lines if line)
    last_chars = "".join(line[-1:] for line in lines if line)
    joined = first_chars + last_chars
    return any(
        signal in joined
        for signal in (
            "疯狂星期四",
            "今天疯狂星期四",
            "请我五十",
            "微我五十",
            "我五十买肯德基",
            "V我50",
        )
    )


def detect_mechanisms(text: str, tags: list[str]) -> list[str]:
    mechanisms: list[str] = []
    if DIRECT_ASK_RE.search(text):
        mechanisms.append("direct_or_disguised_request")
    if MONEY_RE.search(text):
        mechanisms.append("money_amount")
    if KFC_RE.search(text):
        mechanisms.append("kfc_food_cue")
    if THURSDAY_RE.search(text):
        mechanisms.append("thursday_cue")
    if META_RE.search(text) or "元评论" in tags:
        mechanisms.append("meta_v50_commentary")
    if CODE_RE.search(text) or "账号密码" in tags:
        mechanisms.append("code_or_password_pun")
    if HIDDEN_RE.search(text) or has_hidden_acrostic(text):
        mechanisms.append("hidden_or_encoded_form")
    if "通知" in tags or re.search(r"通知|公告|声明|招聘|内推|水滴筹|邀请函", text):
        mechanisms.append("fake_notice_format")
    if "情感煽情" in tags or "恋爱" in tags or re.search(r"分手|暗恋|喜欢你|前任|网恋", text):
        mechanisms.append("melodrama_setup")
    if "字符画" in tags or re.search(r"[⢠⣀⢰⠤]{4,}|━━━━|╭|🀙", text):
        mechanisms.append("visual_text_form")
    if "谐音梗" in tags or re.search(r"谐音|闻鸡起舞|星期寺|峰旷|肯的姬", text):
        mechanisms.append("pun")
    return mechanisms


def landing_type(text: str, mechanisms: list[str]) -> str:
    if "code_or_password_pun" in mechanisms:
        return "code_or_password"
    if "hidden_or_encoded_form" in mechanisms and not DIRECT_ASK_RE.search(text):
        return "hidden_message"
    if re.search(r"罚款", text):
        return "fine"
    if re.search(r"押金|定金", text):
        return "deposit"
    if re.search(r"书本费|医药费|台费|随礼|封口费", text):
        return "fee_or_excuse"
    if re.search(r"请我|谁请|有好心人.*请", text):
        return "ask_to_treat_me"
    if DIRECT_ASK_RE.search(text):
        return "money_transfer"
    if "meta_v50_commentary" in mechanisms:
        return "meta"
    if KFC_RE.search(text) and THURSDAY_RE.search(text):
        return "kfc_thursday_reference"
    return "no_clear_landing"


def semantic_score(text: str, mechanisms: list[str], tags: list[str], landing: str) -> int:
    score = 35
    if landing in {"money_transfer", "ask_to_treat_me", "deposit", "fine", "fee_or_excuse"}:
        score += 25
    elif landing in {"code_or_password", "hidden_message", "meta"}:
        score += 12
    elif landing == "kfc_thursday_reference":
        score += 6
    if "kfc_food_cue" in mechanisms:
        score += 12
    if "thursday_cue" in mechanisms:
        score += 10
    if any(m in mechanisms for m in ("melodrama_setup", "fake_notice_format")):
        score += 8
    if any(m in mechanisms for m in ("pun", "hidden_or_encoded_form", "code_or_password_pun", "visual_text_form")):
        score += 6
    if "meta_v50_commentary" in mechanisms:
        score += 4
    if len(text) < 35:
        score -= 5
    if len(text) > 700:
        score -= 6
    if len(text) > 900:
        score -= 6
    if SENSITIVE_RE.search(text):
        score -= 15
    if not {"direct_or_disguised_request", "kfc_food_cue", "thursday_cue", "hidden_or_encoded_form", "code_or_password_pun"} & set(mechanisms):
        score -= 25
    return max(0, min(100, score))


def decide_item(item: dict[str, Any]) -> dict[str, Any]:
    source_id = str(item["source_id"])
    text = normalize_for_audit(str(item.get("text", "")))
    tags = [str(tag) for tag in item.get("tags", [])]
    mechanisms = detect_mechanisms(text, tags)
    landing = landing_type(text, mechanisms)
    score = semantic_score(text, mechanisms, tags, landing)
    notes: list[str] = []
    reason = ""

    if source_id in MANUAL_REJECTS:
        reject_reason, reason = MANUAL_REJECTS[source_id]
        decision = "reject"
        reference_role = "non_reference"
        notes.append(reject_reason)
        score = min(score, 35)
    elif source_id in USER_ACCEPTED_EDGE_IDS:
        decision = "edge"
        reference_role = "boundary_reference"
        reason = "Accepted by human review; kept as edge reference rather than gold."
        notes.append("user_accepted_after_review")
        score = min(max(score, 60), 72)
    elif source_id in MANUAL_REVIEW:
        review_reason, reason = MANUAL_REVIEW[source_id]
        decision = "review"
        reference_role = "boundary_or_exclude_from_gold"
        notes.append(review_reason)
        score = min(score, 65)
    elif source_id in MANUAL_SILVER:
        silver_reason, reason = MANUAL_SILVER[source_id]
        decision = "silver"
        reference_role = "valid_reference"
        notes.append(silver_reason)
        score = max(min(score, 79), 70)
    elif source_id in MANUAL_EDGE:
        edge_reason, reason = MANUAL_EDGE[source_id]
        decision = "edge"
        reference_role = "boundary_reference"
        notes.append(edge_reason)
        score = min(max(score, 55), 72)
    elif not text:
        decision = "reject"
        reference_role = "non_reference"
        reason = "Empty text."
        notes.append("empty_text")
        score = 0
    elif landing == "no_clear_landing" and not {"hidden_or_encoded_form", "code_or_password_pun", "meta_v50_commentary"} & set(mechanisms):
        decision = "reject"
        reference_role = "non_reference"
        reason = "No clear V50/KFC landing after semantic review."
        notes.append("missing_v50_mechanism")
        score = min(score, 40)
    elif SENSITIVE_RE.search(text) and len(text) > 120:
        decision = "review"
        reference_role = "boundary_or_exclude_from_gold"
        reason = "Valid V50 mechanism, but sensitive or explicit setup makes it poor prompt gold material."
        notes.append("sensitive_or_explicit_setup")
        score = min(score, 68)
    elif score >= 82:
        decision = "gold"
        reference_role = "gold_reference"
        reason = "Clear V50 mechanism with a coherent setup and usable punchline."
    elif score >= 70:
        decision = "silver"
        reference_role = "valid_reference"
        reason = "Valid V50 copy, but weaker, more formulaic, very short/long, or less fresh than gold samples."
    elif score >= 55:
        decision = "edge"
        reference_role = "boundary_reference"
        reason = "Semantically related to V50, useful for boundary or diversity, but not core gold material."
    else:
        decision = "review"
        reference_role = "needs_human_review"
        reason = "Ambiguous semantic fit; should be reviewed before use."

    if len(text) > 700:
        notes.append("very_long_setup")
    if re.search(r"\\u[0-9a-fA-F]{4}", str(item.get("text", ""))):
        notes.append("escaped_unicode_text")
    if landing in {"hidden_message", "code_or_password", "meta", "kfc_thursday_reference"}:
        notes.append("not_direct_v50_landing")
    if "visual_text_form" in mechanisms:
        notes.append("visual_or_character_art")

    return {
        "id": item.get("id"),
        "source_id": source_id,
        "source_url": item.get("source_url"),
        "source_order": item.get("source_order"),
        "title": item.get("title", ""),
        "tags": tags,
        "text": text,
        "decision": decision,
        "reference_role": reference_role,
        "semantic_score": score,
        "landing_type": landing,
        "meme_mechanisms": mechanisms,
        "reason": reason,
        "quality_notes": notes,
    }


def main() -> None:
    source = json.loads(SOURCE_PATH.read_text(encoding="utf-8"))
    items = source["items"]
    audited_items = [decide_item(item) for item in items]

    decision_counts = Counter(item["decision"] for item in audited_items)
    role_counts = Counter(item["reference_role"] for item in audited_items)
    landing_counts = Counter(item["landing_type"] for item in audited_items)
    mechanism_counts = Counter(mechanism for item in audited_items for mechanism in item["meme_mechanisms"])

    audit = {
        "source": "vme",
        "audit_type": "semantic_quality_audit",
        "source_file": str(SOURCE_PATH.relative_to(ROOT)),
        "source_url": source.get("source_url"),
        "audited_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "item_count": len(items),
        "decision_counts": dict(sorted(decision_counts.items())),
        "reference_role_counts": dict(sorted(role_counts.items())),
        "landing_type_counts": dict(sorted(landing_counts.items())),
        "meme_mechanism_counts": dict(mechanism_counts.most_common()),
        "accepted_reference_count": sum(
            decision_counts[key] for key in ("gold", "silver", "edge")
        ),
        "non_reference_count": decision_counts["reject"],
        "needs_review_count": decision_counts["review"],
        "rules": {
            "gold": "Strong, reusable V50 mechanism with setup and landing.",
            "silver": "Valid V50 copy, but weaker/formulaic/less fresh.",
            "edge": "Useful boundary or diversity sample; not core gold.",
            "review": "Semantically valid or near-valid but sensitive, malformed, or ambiguous.",
            "reject": "Not useful as V50 reference material.",
        },
        "notes": [
            "This is a semantic quality audit only; samples/vme_v50.json is not modified.",
            "Items do not need literal V50/KFC tokens to pass if the hidden or abstract V50 mechanism is clear.",
            "Sensitive or explicit setups are kept out of gold even when the V50 landing exists.",
        ],
        "items": audited_items,
        "review_items": [item for item in audited_items if item["decision"] == "review"],
        "rejected_items": [item for item in audited_items if item["decision"] == "reject"],
    }

    AUDIT_PATH.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        f"semantic_quality_audit source=vme items={len(items)} "
        f"counts={dict(sorted(decision_counts.items()))}",
        "",
    ]
    for item in audited_items:
        one_line_text = " ".join(item["text"].split())
        lines.append(
            f"{item['source_order']:03d}\t{item['decision']}\t{item['semantic_score']}\t"
            f"{item['landing_type']}\t{item['source_id']}\t{one_line_text}"
        )
    AUDIT_TXT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"wrote {AUDIT_PATH}: {dict(sorted(decision_counts.items()))}")
    print(f"wrote {AUDIT_TXT_PATH}")


if __name__ == "__main__":
    main()
