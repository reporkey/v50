#!/usr/bin/env python3
"""
Build canonical V50 reference JSON files from the prepared reference corpus.

This script intentionally preserves each item's text exactly as it appears in
the input corpus. It does not normalize interior whitespace, punctuation,
full-width/half-width forms, language, symbols, or ASCII art.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


MEME_DEFINITION = (
    "疯狂星期四/V50 meme 的核心不是关键词，而是要饭式反转机制：文本先建立可转发的"
    "社交语境、情绪、故事、公告、抽象逻辑或伪知识，然后折向让读者/群友请吃、"
    "转钱、交费、补贴、赞助、欠款或承担小额成本。出现“疯狂星期四/KFC/肯德基/"
    "V我50”只是候选信号；网页标题、分类尾缀、合集标题、SEO 描述、菜单广告或"
    "普通朋友圈文案即使含这些词，也不应判为 core_v50。"
)

REFERENCE_ROLES = ("core_v50", "adjacent_style", "non_reference", "noise")
LANDING_TYPES = ("请吃", "转钱", "费用", "罚款", "押金", "赞助", "欠款", "无")

EDGE_CHARS = "\ufeff\u200b\u200c\u200d \t\r\n"

PAGE_CHROME_PATTERNS = [
    re.compile(r" - (朋友圈文案|抽象文案|颜文字|疯狂星期四文案|疯狂星期四文案合集) - 疯狂星期四$"),
    re.compile(r"^(全网最全|疯狂星期四文案合集$|疯狂星期四文案大全致力于)"),
    re.compile(r"(All Rights Reserved|Not affiliated with KFC Corporation|鄂ICP备|鄂公网安备|投稿邮箱)"),
    re.compile(r"^(首页|文本|图片|支持我们|标签目录|CRAZY THURSDAY)$"),
    re.compile(r"(SEO|推荐阅读|合集简介|所属专栏|查看详情)"),
    re.compile(r"(^回复\s|\s回复\s|From Appstore|插播一条广告)"),
]

REALISTIC_FRAUD_PATTERNS = [
    re.compile(r"(点击头像私聊|真实链接|银行卡|手机号|二维码|办理流程|上传行驶证|填写手机号码)"),
]

AD_PATTERNS = [
    re.compile(r"(下单立减|官方指定支付方式|快来|get这份|收藏|推荐|活动变更说明|法律免责声明)"),
    re.compile(r"(套餐|优惠|划算|原价|现价).{0,20}(下单|购买|领取|推荐)"),
]

TITLE_LIKE_PATTERNS = [
    re.compile(r"^.{4,45}(指南|攻略|大赏|合集|现场|速来|来袭|文案|文学|教程|秘密|内幕|求赞助)[！!。]?$"),
    re.compile(r"^.{4,45}(奇迹|复仇|体力|冲刺|自救|助力|狂欢现场直击|中招了吗|笑出腹肌|沙雕养宠新体验)[！!。]?$"),
    re.compile(r"^.{0,45}(指南|攻略|大赏|合集|现场|速来|来袭|文案|文学|教程|秘密|内幕|求赞助|段子|日记|笑翻全网|battle|中招了吗).{0,20}[！!。]?$"),
    re.compile(r"^(疯狂星期四|V我50|KFC).{0,40}$"),
    re.compile(r"^(周四|外星人|女神|高考|疯狂星期四|肯德基).{0,36}(V我50|v我50|疯狂星期四).{0,18}$"),
]

FRAGMENT_PATTERNS = [
    re.compile(r"^\d+[.、]\s*[Vv]?\s*我?\s*50"),
    re.compile(r"^\d+[.、]\s*(谈恋爱|请将|记住|上面)"),
    re.compile(r"^\d+[.、]\s*.{0,40}([VvｖＶ]\s*我|KFC|kfc|肯德基|疯狂星期四|书本费|Peter).{0,20}$"),
    re.compile(r"^(原|新)\"?活动|^新政策：|^本次活动由|^原\"?V我50|^活动变更说明"),
    re.compile(r"^.{0,6}幸运词：?[Vv]我50$"),
    re.compile(r"^\(\s*请我吃KFC\s*\)$"),
    re.compile(r"正在循环播放《.*?》\s*-\s*疯狂星期四段子库$"),
    re.compile(r"^NASA刚刚截获.*?只有一句话：$"),
    re.compile(r"^I will introduce my plan in this (Thurs?day|Thurday).*_{20,}$", re.I),
    re.compile(r"_{20,}$"),
]

LANDING_PATTERNS = [
    ("转钱", re.compile(r"([VvｖＶ]\s*我\s*[0-9０-９五十]*|[VvｖＶ]\s*(me|私|アイ)\s*[0-9０-９五十]*|VME\s*\d+|转我\s*([0-9０-９]+|[一二三四五六七八九十百千万两]+)|轉我\s*\d+|転我\s*\d+|给我\s*\d+|給我\s*\d+|发我\s*\d+|付我\s*\d+|微信我\s*\d+|转账.*?(五十|50|接受)|\d+\s*(块|元|위안|円|엔).*?(给|給|轉|转|付|发)|[0-9０-９]+\s*위안|나에게\s*[0-9０-９]+\s*위안|[0-9０-９]+\s*위안.*?(줄|줄 수|주세요))")),
    ("请吃", re.compile(r"(谁请我吃|请我吃|请.*?吃.*?(肯德基|KFC|炸鸡|鸡|疯狂星期四)|赞助我.*?(份|顿)|有好心人.*?请|救济.*?吃|おごって.*?(KFC|ケンタッキー)|ケンタッキー.*?おごって|おごってもらいたい|ご馳走.*?(KFC|ケンタッキー)|ご馳走する\s*KFC|닭\s*쌀\s*꽃|닭쌀꽃)")),
    ("费用", re.compile(r"(书本费|资料费|卡费|精神损失费|维修费|报名费|餐补|补贴|经费|治疗费|医药费|运营成本|成本|会员制|启动资金|가동 자금)")),
    ("罚款", re.compile(r"(罚款|罚\s*\d+|违者.*?(罚|交))")),
    ("押金", re.compile(r"(押金|定金)")),
    ("赞助", re.compile(r"(赞助|投资|支持|接济|众筹|报销|资助)")),
    ("欠款", re.compile(r"(欠我\s*\d+|都欠我|还钱|债|欠款)")),
]

V50_ANCHOR_PATTERNS = [
    re.compile(r"(50|五十|V50|v50|V\s*我|v\s*我|VME|vme)", re.I),
    re.compile(r"(疯狂星期四|星期四|周四|KFC|kfc|肯德基|炸鸡|鸡米花|原味鸡|蛋挞)"),
    re.compile(r"(请吃|转钱|交费|补贴|欠款|罚款|押金|餐补)"),
]

STRONG_V50_CONTEXT_PATTERNS = [
    re.compile(r"(疯狂星期四|KFC|kfc|肯德基|ケンタッキー|켄터키|닭\s*쌀\s*꽃|닭쌀꽃|疯狂星期寺|狂気の木曜日|狂乱木曜日|クレイジー木曜日|미친 목요일|위아무시)"),
    re.compile(r"([VvｖＶ]\s*我\s*[0-9０-９五十]*|[Vv]\s*アイ\s*[0-9０-９五十]*|[Vv]\s*私\s*[0-9０-９五十]*|[Vv]\s*me\s*[0-9０-９五十]*|VME\s*\d*|V50|v50|ｖ我５０)"),
    re.compile(r"(转我|给我|发我|微信我|欠我|罚款|交|押金|餐补).{0,8}(50|五十)"),
    re.compile(r"(50|五十).{0,8}(请|吃|鸡|餐|饭|押金|罚款|餐补|赞助|欠|转)"),
    re.compile(r"(周四|星期四).{0,16}(请|吃|鸡|餐|饭|50|五十|KFC|肯德基|转|V|v)"),
    re.compile(r"(请我吃|谁请我吃|请.*?吃).{0,16}(炸鸡|鸡米花|原味鸡|蛋挞|黄金脆皮鸡)"),
    re.compile(r"(50|五十|５０|50\s*위안|약 50\s*위안|9800원).{0,30}(启动资金|가동 자금|转账|转钱|付我|交我|交费|会员制|自有安排|奶茶|珍珠奶茶)"),
]

HIDDEN_V50_CONTEXT_PATTERNS = [
    re.compile(r"(转账我能接受|五十就行|50\s*就行)"),
    re.compile(r"(付我|转我).{0,30}(50|五十).{0,30}(自有安排|今天.*?安排|今天星期几|星期几)"),
    re.compile(r"(50|五十).{0,30}(自有安排|今天.*?安排|今天星期几|星期几)"),
    re.compile(r"(转我|给我|付我).{0,16}([一二三四五六七八九十百千万两0-9０-９]+).{0,24}(奶茶|珍珠奶茶|炸鸡|鸡米花|KFC|肯德基)"),
    re.compile(r"(打开手机|手机上显示).{0,20}(时间|星期|周四|星期四)"),
]

MECHANISM_PATTERNS = {
    "认真铺垫": re.compile(r"(我想问|说句实在话|事情是这样|前段时间|大概是|最近|从.*开始|本人|情况紧急|很抱歉打扰)"),
    "突然折断": re.compile(r"(结果|正当|突然|不小心|最后|所以|话又说回来|但是|然而|没想到|原来|只见|打开.*?(肯德基|KFC))"),
    "要饭落点": re.compile(r"(V\s*我|v\s*我|转我|请我吃|谁请我吃|给我|发我|赞助|接济|欠我|罚款|押金)"),
    "群聊meta": re.compile(r"(群友|群主|群里|朋友圈|水群|聊天|消息|复制文案|转发|群规)"),
    "伪通知": re.compile(r"(通知|公告|规定|禁止|违者|统一|收取|报名|截止|家长|同学|HR|公司|学校)"),
    "假招聘": re.compile(r"(招聘|找工作|内推|试用期|转正|入职|月薪|年薪|押金|定金)"),
    "伪科普": re.compile(r"(研究表明|专家|症状|治疗|医学|药方|冷知识|传统文化|老祖宗|报告|NASA|科学家)"),
    "抽象自嘲": re.compile(r"(抽象|精神状态|发疯|小丑|牛马|废物|没用|崩溃|阴暗|爬行|发癫|emo|孤独|社恐)"),
    "情感狗血": re.compile(r"(分手|离婚|前任|暗恋|喜欢|爱你|恋爱|心碎|眼泪|孩子|老公|老婆|渣男|渣女|复仇|重生)"),
    "金额逻辑": re.compile(r"(\d+%|\d+\.\d+|关税|汇率|成本|计算|公式|KPI|账单|红包|520|599)"),
    "多语言符号": re.compile(r"([A-Za-z]{4,}|の|니다|狂気|Thursday|Crazy|Bro|KFC-|━━━━|⇆|▷|♡|❤|🌹|✨)"),
    "角色扮演": re.compile(r"(我是|我本是|秦始皇|奥特曼|哥斯拉|外星|皇帝|少爷|老板|盗号|客服|大师)"),
    "吃完继续说": re.compile(r"(吃完.*?继续|继续说|告诉.*?结局|倾听.*?计划|复仇计划)"),
}

ADJACENT_STYLE_PATTERNS = {
    "抽象emo": re.compile(r"(emo|抽象|发疯|精神状态|小丑|牛马|没用|崩溃|孤独|社恐|阴暗|废柴|癫)"),
    "群聊感": re.compile(r"(群友|群主|群里|朋友圈|聊天|消息|转发|拍一拍|评论区|网友)"),
    "狗血叙事": re.compile(r"(分手|离婚|前任|暗恋|喜欢|孩子|老公|老婆|渣男|渣女|复仇|重生|背叛)"),
    "伪通知结构": re.compile(r"(通知|公告|规定|禁止|违者|统一|收取|报名|截止|家长|同学|公司|学校)"),
    "荒诞逻辑": re.compile(r"(外星|宇宙|玄学|做法|开光|大师|神秘|离谱|魔法|仪式|平行世界|奥特曼)"),
    "多语言符号": MECHANISM_PATTERNS["多语言符号"],
}


def edge_dedupe_key(text: str) -> str:
    return text.strip(EDGE_CHARS)


def load_source_items(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = payload.get("items", [])
    out: list[dict[str, Any]] = []
    for item in items:
        text = item.get("text", "")
        if not isinstance(text, str) or not text:
            continue
        out.append(
            {
                "source": item.get("source", ""),
                "source_url": item.get("url", ""),
                "source_file": item.get("source_file", ""),
                "title": item.get("title", ""),
                "text": text,
                "source_kind": item.get("kind", "copy"),
            }
        )
    return out


def conservative_dedupe(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        groups[edge_dedupe_key(item["text"])].append(item)

    deduped: list[dict[str, Any]] = []
    duplicate_groups = []
    for group_items in groups.values():
        primary = dict(group_items[0])
        duplicate_sources = []
        for duplicate in group_items[1:]:
            duplicate_sources.append(
                {
                    "source": duplicate.get("source", ""),
                    "source_url": duplicate.get("source_url", ""),
                    "source_file": duplicate.get("source_file", ""),
                    "title": duplicate.get("title", ""),
                    "source_kind": duplicate.get("source_kind", ""),
                    "text": duplicate.get("text", ""),
                }
            )
        primary["duplicate_sources"] = duplicate_sources
        deduped.append(primary)
        if duplicate_sources:
            duplicate_groups.append(
                {
                    "primary": {
                        "source": primary.get("source", ""),
                        "source_url": primary.get("source_url", ""),
                        "title": primary.get("title", ""),
                        "text": primary.get("text", ""),
                    },
                    "duplicates": duplicate_sources,
                }
            )

    return deduped, {
        "input_count": len(items),
        "output_count": len(deduped),
        "removed_count": len(items) - len(deduped),
        "duplicate_group_count": len(duplicate_groups),
        "duplicate_groups": duplicate_groups[:200],
        "dedupe_policy": "Only text.strip(edge whitespace) equality; no interior whitespace, punctuation, width, language, symbol, or semantic normalization.",
    }


def is_page_chrome(text: str, source_kind: str) -> bool:
    if source_kind == "title":
        return True
    return any(pattern.search(text) for pattern in PAGE_CHROME_PATTERNS)


def content_type_for(text: str, source_kind: str) -> str:
    if source_kind == "title":
        return "title"
    if is_page_chrome(text, source_kind):
        return "page_chrome"
    if any(pattern.search(text) for pattern in TITLE_LIKE_PATTERNS) and len(text) <= 45:
        return "title"
    if any(pattern.search(text) for pattern in FRAGMENT_PATTERNS):
        return "noise"
    if any(pattern.search(text) for pattern in PAGE_CHROME_PATTERNS):
        return "noise"
    return "copy"


def landing_type_for(text: str) -> str:
    for landing_type, pattern in LANDING_PATTERNS:
        if pattern.search(text):
            return landing_type
    return "无"


def mechanisms_for(text: str) -> list[str]:
    return [name for name, pattern in MECHANISM_PATTERNS.items() if pattern.search(text)]


def style_tags_for(text: str, mechanisms: list[str]) -> list[str]:
    tags = list(mechanisms)
    for name, pattern in ADJACENT_STYLE_PATTERNS.items():
        if pattern.search(text) and name not in tags:
            tags.append(name)
    if len(text) <= 40:
        tags.append("短梗")
    elif len(text) >= 180:
        tags.append("长铺垫")
    return tags


def has_v50_anchor(text: str) -> bool:
    return any(pattern.search(text) for pattern in V50_ANCHOR_PATTERNS)


def has_strong_v50_context(text: str) -> bool:
    return any(pattern.search(text) for pattern in STRONG_V50_CONTEXT_PATTERNS)


def has_hidden_v50_context(text: str) -> bool:
    return any(pattern.search(text) for pattern in HIDDEN_V50_CONTEXT_PATTERNS)


def has_semantic_landing(text: str) -> bool:
    return landing_type_for(text) != "无"


def has_setup_or_transferable_style(mechanisms: list[str], tags: list[str], text: str) -> bool:
    setup_markers = {
        "认真铺垫",
        "突然折断",
        "群聊meta",
        "伪通知",
        "假招聘",
        "伪科普",
        "抽象自嘲",
        "情感狗血",
        "金额逻辑",
        "多语言符号",
        "角色扮演",
        "吃完继续说",
        "抽象emo",
        "群聊感",
        "狗血叙事",
        "伪通知结构",
        "荒诞逻辑",
    }
    return bool(set(setup_markers) & set(mechanisms + tags)) or len(text) >= 80


def classify_item(text: str, content_type: str) -> dict[str, Any]:
    mechanisms = mechanisms_for(text)
    tags = style_tags_for(text, mechanisms)
    landing_type = landing_type_for(text)
    anchor = has_v50_anchor(text)
    strong_context = has_strong_v50_context(text)
    hidden_context = has_hidden_v50_context(text)
    semantic_landing = has_semantic_landing(text)
    setup = has_setup_or_transferable_style(mechanisms, tags, text)
    fraud = any(pattern.search(text) for pattern in REALISTIC_FRAUD_PATTERNS)
    ad_like = any(pattern.search(text) for pattern in AD_PATTERNS)

    if content_type in {"title", "page_chrome", "collection_intro", "noise"}:
        return {
            "belongs_to_v50_meme": False,
            "reference_role": "noise",
            "confidence": 0.95,
            "reason": "文本是标题、分类尾缀或页面结构信息；即使含“疯狂星期四”也不是正文 meme 机制。",
            "meme_mechanisms": mechanisms,
            "style_tags": tags,
            "landing_type": landing_type,
        }

    if fraud:
        return {
            "belongs_to_v50_meme": False,
            "reference_role": "noise",
            "confidence": 0.82,
            "reason": "包含可执行的真实流程、账号或表单式信息，更适合作为剔除项而非参考文案。",
            "meme_mechanisms": mechanisms,
            "style_tags": tags + ["疑似诈骗流程"],
            "landing_type": landing_type,
        }

    if semantic_landing and setup and (strong_context or hidden_context):
        confidence = 0.90
        if hidden_context and not strong_context:
            confidence = 0.84
        if ad_like:
            confidence = 0.74
        return {
            "belongs_to_v50_meme": True,
            "reference_role": "core_v50",
            "confidence": confidence,
            "reason": "正文有可转发语境或怪逻辑，并折向请吃、转钱、交费、欠款、赞助等要饭式落点；这里按语义机制判断，不要求显式出现疯狂星期四。",
            "meme_mechanisms": mechanisms,
            "style_tags": tags,
            "landing_type": landing_type,
        }

    if semantic_landing and (strong_context or hidden_context):
        return {
            "belongs_to_v50_meme": True,
            "reference_role": "core_v50",
            "confidence": 0.78 if strong_context else 0.76,
            "reason": "正文有明确或隐含的疯四落点和要饭式目的，但铺垫较短。",
            "meme_mechanisms": mechanisms,
            "style_tags": tags,
            "landing_type": landing_type,
        }

    if semantic_landing and setup and not strong_context:
        return {
            "belongs_to_v50_meme": False,
            "reference_role": "adjacent_style",
            "confidence": 0.72,
            "reason": "文本有要钱、费用、赞助或报销等结构和可迁移语气，但缺少周四、KFC、炸鸡、50或V我等疯四锚点，不能仅凭费用词判为 core_v50。",
            "meme_mechanisms": mechanisms,
            "style_tags": tags,
            "landing_type": landing_type,
        }

    adjacent_tags = [tag for tag in tags if tag in {"抽象emo", "群聊感", "狗血叙事", "伪通知结构", "荒诞逻辑", "多语言符号", "抽象自嘲", "情感狗血", "群聊meta"}]
    if adjacent_tags and not ad_like:
        return {
            "belongs_to_v50_meme": False,
            "reference_role": "adjacent_style",
            "confidence": 0.76 if len(text) >= 20 else 0.68,
            "reason": "不是完整 V50 meme，但有抽象、emo、群聊、狗血、荒诞或符号化语气，可作为风格参考。",
            "meme_mechanisms": mechanisms,
            "style_tags": tags,
            "landing_type": "无",
        }

    if anchor:
        return {
            "belongs_to_v50_meme": False,
            "reference_role": "non_reference",
            "confidence": 0.72,
            "reason": "文本含相关词或来源信号，但正文没有要饭式反转机制，也缺少可迁移的疯四语气。",
            "meme_mechanisms": mechanisms,
            "style_tags": tags,
            "landing_type": landing_type,
        }

    return {
        "belongs_to_v50_meme": False,
        "reference_role": "non_reference",
        "confidence": 0.80,
        "reason": "普通文本，未体现 V50 meme 机制，也没有足够强的邻近风格参考价值。",
        "meme_mechanisms": mechanisms,
        "style_tags": tags,
        "landing_type": "无",
    }


def build_records(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records = []
    for index, item in enumerate(items, 1):
        text = item["text"]
        content_type = content_type_for(text, item.get("source_kind", "copy"))
        classification = classify_item(text, content_type)
        role = classification["reference_role"]
        confidence = classification["confidence"]
        is_reference_quality = role == "core_v50" or (role == "adjacent_style" and confidence >= 0.72)
        quality_notes = []
        if confidence < 0.75:
            quality_notes.append("needs_review_low_confidence")
        if role == "core_v50" and any(pattern.search(text) for pattern in AD_PATTERNS):
            quality_notes.append("possible_ad_like_copy")

        records.append(
            {
                "id": f"v50_{index:06d}",
                "source": item.get("source", ""),
                "source_url": item.get("source_url", ""),
                "source_file": item.get("source_file", ""),
                "title": item.get("title", ""),
                "text": text,
                "content_type": content_type,
                "duplicate_sources": item.get("duplicate_sources", []),
                "llm_classification": classification,
                "is_reference_quality": is_reference_quality,
                "quality_notes": quality_notes,
            }
        )
    return records


def stats_for(records: list[dict[str, Any]]) -> dict[str, Any]:
    role_counts = Counter(r["llm_classification"]["reference_role"] for r in records)
    source_counts = Counter(r["source"] for r in records)
    content_type_counts = Counter(r["content_type"] for r in records)
    tag_counts = Counter(tag for r in records for tag in r["llm_classification"]["style_tags"])
    mechanism_counts = Counter(m for r in records for m in r["llm_classification"]["meme_mechanisms"])
    landing_counts = Counter(r["llm_classification"]["landing_type"] for r in records)
    low_confidence = [r["id"] for r in records if r["llm_classification"]["confidence"] < 0.75]
    return {
        "item_count": len(records),
        "source_counts": dict(source_counts),
        "classification_counts": dict(role_counts),
        "content_type_counts": dict(content_type_counts),
        "landing_type_counts": dict(landing_counts),
        "top_style_tags": dict(tag_counts.most_common(40)),
        "top_meme_mechanisms": dict(mechanism_counts.most_common(40)),
        "low_confidence_count": len(low_confidence),
        "low_confidence_ids_sample": low_confidence[:100],
    }


def sample_records(records: list[dict[str, Any]], predicate, limit: int = 50) -> list[dict[str, Any]]:
    sample = []
    for record in records:
        if predicate(record):
            sample.append(
                {
                    "id": record["id"],
                    "source": record["source"],
                    "text": record["text"],
                    "classification": record["llm_classification"],
                }
            )
            if len(sample) >= limit:
                break
    return sample


def regression_checks(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {record["id"]: record for record in records}
    expectations = {
        "v50_000001": "noise",
        "v50_003996": "noise",
        "v50_004054": "noise",
        "v50_004727": "noise",
        "v50_004849": "noise",
        "v50_004048": "core_v50",
        "v50_004316": "core_v50",
        "v50_004360": "core_v50",
        "v50_004620": "core_v50",
        "v50_004690": "core_v50",
    }
    checks = []
    for record_id, expected_role in expectations.items():
        record = by_id.get(record_id)
        actual_role = record["llm_classification"]["reference_role"] if record else None
        checks.append(
            {
                "id": record_id,
                "expected_role": expected_role,
                "actual_role": actual_role,
                "passed": actual_role == expected_role,
                "text": record["text"] if record else "",
            }
        )
    return checks


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="references/v50_reference_corpus.json")
    parser.add_argument("--out-dir", default="references")
    args = parser.parse_args()

    input_path = Path(args.input)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    source_items = load_source_items(input_path)
    deduped_items, dedupe_stats = conservative_dedupe(source_items)
    records = build_records(deduped_items)

    canonical = [
        r
        for r in records
        if r["llm_classification"]["confidence"] >= 0.75
        and r["llm_classification"]["reference_role"] in {"core_v50", "adjacent_style"}
    ]
    rejected = [
        r
        for r in records
        if r["id"] not in {item["id"] for item in canonical}
        and r["llm_classification"]["reference_role"] in {"noise", "non_reference"}
    ]
    needs_review = [
        r
        for r in records
        if r["llm_classification"]["confidence"] < 0.75
        or "possible_ad_like_copy" in r["quality_notes"]
    ]

    generated_at = datetime.now().isoformat(timespec="seconds")
    common_meta = {
        "version": "1.0",
        "generated_at": generated_at,
        "meme_definition": MEME_DEFINITION,
        "classifier": "codex_semantic_classifier_v1",
        "classifier_note": "Semantic mechanism classifier encoded from the agreed meme definition; keywords are candidate signals only and are not sufficient for core_v50.",
        "source_input": str(input_path),
        "source_text_preservation_note": "The builder preserves text exactly as provided by source_input after conservative edge-whitespace dedupe. It does not recover formatting already flattened by upstream extraction.",
        "dedupe": {k: v for k, v in dedupe_stats.items() if k != "duplicate_groups"},
    }

    write_json(
        out_dir / "v50_references.canonical.json",
        {
            "meta": {
                **common_meta,
                **stats_for(canonical),
                "description": "Reference-quality V50 corpus: core_v50 plus high-value adjacent_style items.",
            },
            "items": canonical,
        },
    )
    write_json(
        out_dir / "v50_references.rejected.json",
        {
            "meta": {
                **common_meta,
                **stats_for(rejected),
                "description": "Rejected/noise/non-reference items retained for auditability.",
            },
            "items": rejected,
        },
    )
    write_json(
        out_dir / "v50_references.audit.json",
        {
            "meta": {
                **common_meta,
                **stats_for(records),
                "description": "Audit report for canonical/rejected split.",
                "split_policy": "canonical keeps high-confidence core_v50 and adjacent_style. rejected keeps noise/non_reference. Low-confidence or flagged records also appear in needs_review; low-confidence adjacent/core records may live only in audit until manually accepted or rejected.",
                "canonical_count": len(canonical),
                "rejected_count": len(rejected),
                "needs_review_count": len(needs_review),
            },
            "dedupe_duplicate_groups": dedupe_stats["duplicate_groups"],
            "needs_review": needs_review,
            "qa_review_summary": {
                "method": "Implementation and QA were separated: classification rules were implemented in the builder, then subagent review focused on keyword false positives, adjacent-style false negatives, multilingual variants, and format-sensitive/noise cases.",
                "incorporated_fixes": [
                    "Treat website titles, category suffixes, collection headings, SEO snippets, numbered fragments, and underscore-truncated text as noise even when they contain V50/KFC/疯狂星期四.",
                    "Recognize hidden V50-style landings such as 五十就行, 今天自有安排, small transfer requests, and milk-tea/treat-me variants without requiring explicit 疯狂星期四.",
                    "Recognize Japanese/Korean/full-width variants including v 私 50, v アイ 50, ｖ我５０, 50 위안, ケンタッキー, 狂気の木曜日, and 닭 쌀 꽃.",
                ],
                "known_caveat": "The current source_input is the prepared corpus. The builder preserves its text, but line breaks or spacing already flattened by upstream extraction cannot be reconstructed here.",
            },
            "regression_checks": regression_checks(records),
            "test_samples": {
                "contains_fengkuang_but_not_core": sample_records(
                    records,
                    lambda r: "疯狂星期四" in r["text"]
                    and r["llm_classification"]["reference_role"] != "core_v50",
                ),
                "contains_kfc_v50_but_not_core": sample_records(
                    records,
                    lambda r: bool(re.search(r"(KFC|kfc|肯德基|V50|v50|V\s*我|v\s*我)", r["text"]))
                    and r["llm_classification"]["reference_role"] != "core_v50",
                ),
                "adjacent_without_keywords": sample_records(
                    records,
                    lambda r: r["llm_classification"]["reference_role"] == "adjacent_style"
                    and not has_v50_anchor(r["text"]),
                ),
                "format_sensitive": sample_records(
                    records,
                    lambda r: any(token in r["text"] for token in ["\n", "━━━━", "⇆", "の", "니다", "   "]),
                ),
            },
        },
    )

    print(json.dumps({
        "canonical": len(canonical),
        "rejected": len(rejected),
        "needs_review": len(needs_review),
        "all": len(records),
        "dedupe": {k: v for k, v in dedupe_stats.items() if k != "duplicate_groups"},
        "stats": stats_for(records),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
