#!/usr/bin/env python3
"""Archive generated V50 corpus artifacts with a checksum manifest."""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List


ARCHIVE_PATTERNS = [
    "references/v50_reference_corpus*",
    "references/v50_references.*",
    "references/v50_corpus_findings.md",
    "prompts/kimi_v50_prompts.md",
    "scripts/build_v50_references.py",
]


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_timestamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_status(root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "status", "--short"],
            cwd=root,
            check=False,
            text=True,
            capture_output=True,
        )
    except OSError as exc:
        return f"git status unavailable: {exc}"
    if result.returncode != 0:
        return (result.stderr or result.stdout).strip()
    return result.stdout.strip()


def resolve_files(root: Path, patterns: Iterable[str]) -> List[Path]:
    seen = set()
    files: List[Path] = []
    for pattern in patterns:
        for raw_path in glob.glob(str(root / pattern)):
            path = Path(raw_path)
            if not path.is_file():
                continue
            rel = path.relative_to(root)
            if rel in seen:
                continue
            seen.add(rel)
            files.append(path)
    return sorted(files, key=lambda item: str(item.relative_to(root)))


def archive_outputs(root: Path, timestamp: str, reason: str, dry_run: bool = False) -> Dict[str, Any]:
    archive_dir = root / "archive" / timestamp
    if archive_dir.exists() and not dry_run:
        raise SystemExit(f"archive directory already exists: {archive_dir}")

    files = resolve_files(root, ARCHIVE_PATTERNS)
    archived_at = now_iso()

    manifest: Dict[str, Any] = {
        "schema_version": 1,
        "archive_id": timestamp,
        "archived_at": archived_at,
        "archive_dir": str(archive_dir.relative_to(root)),
        "reason": reason,
        "patterns": ARCHIVE_PATTERNS,
        "git_status_short": git_status(root),
        "files": [],
        "missing_patterns": [],
        "dry_run": dry_run,
    }

    for pattern in ARCHIVE_PATTERNS:
        if not glob.glob(str(root / pattern)):
            manifest["missing_patterns"].append(pattern)

    for source in files:
        rel = source.relative_to(root)
        destination = archive_dir / rel
        record = {
            "original_path": str(rel),
            "archive_path": str(destination.relative_to(root)),
            "size_bytes": source.stat().st_size,
            "sha256": sha256_file(source),
        }
        manifest["files"].append(record)

        if not dry_run:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))

    manifest["file_count"] = len(manifest["files"])
    manifest_path = archive_dir / "manifest.json"
    if not dry_run:
        archive_dir.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=project_root())
    parser.add_argument("--timestamp", default=default_timestamp())
    parser.add_argument(
        "--reason",
        default="Freeze generated V50 prompt/corpus artifacts before rebuilding source snapshots.",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    manifest = archive_outputs(root, args.timestamp, args.reason, args.dry_run)
    print(json.dumps(
        {
            "archive_id": manifest["archive_id"],
            "archive_dir": manifest["archive_dir"],
            "file_count": manifest["file_count"],
            "dry_run": manifest["dry_run"],
        },
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
