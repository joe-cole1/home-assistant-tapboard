#!/usr/bin/env python3
"""Validate the frozen v1 reuse manifest without third-party dependencies."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = REPOSITORY_ROOT / "docs/rebuild/v1-reuse-manifest.json"
CLASSIFICATIONS = {
    "PORT_LARGELY_AS_IS",
    "PORT_ALGORITHM_ONLY",
    "REFERENCE_ONLY",
    "DO_NOT_REPRODUCE",
}
V2_REQUIREMENTS = {"KEEP", "MODIFY", "REMOVE"}
FROZEN_V1_COMMIT = "429cf07e451b64ca1713655a34ffa5ebd376efae"
REQUIRED_ENTRY_FIELDS = {
    "id",
    "subsystem",
    "approximate_size",
    "responsibilities",
    "coupling",
    "v2_requirement",
    "source_paths",
    "classification",
    "evidence_tests",
    "proposed_v2_destination_or_purpose",
    "rationale",
    "preservation",
    "confidence",
    "risks",
}


def git(*arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise ValueError(f"git {' '.join(arguments)} failed: {detail}")
    return completed.stdout.strip()


def validate_reference(commit: str, entry_id: str, reference: object) -> None:
    if not isinstance(reference, dict):
        raise ValueError(f"{entry_id}: reference must be an object")
    path = reference.get("path")
    expected_oid = reference.get("git_blob_oid")
    if not isinstance(path, str) or not path or not isinstance(expected_oid, str) or not expected_oid:
        raise ValueError(f"{entry_id}: reference requires non-empty path and git_blob_oid")
    actual_oid = git("rev-parse", f"{commit}:{path}")
    if actual_oid != expected_oid:
        raise ValueError(f"{entry_id}: blob mismatch for {path}: expected {expected_oid}, found {actual_oid}")


def main() -> int:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        if manifest.get("schema_version") != 1:
            raise ValueError("schema_version must be 1")
        if set(manifest.get("classifications", [])) != CLASSIFICATIONS:
            raise ValueError("classifications must contain exactly the four approved values")
        if set(manifest.get("v2_requirement_values", [])) != V2_REQUIREMENTS:
            raise ValueError("v2_requirement_values must contain exactly KEEP, MODIFY, and REMOVE")

        commit = manifest.get("generated_from_commit")
        if not isinstance(commit, str) or re.fullmatch(r"[0-9a-f]{40}", commit) is None:
            raise ValueError("generated_from_commit must be a lowercase 40-hex immutable commit ID")
        if commit != FROZEN_V1_COMMIT:
            raise ValueError(f"generated_from_commit must equal the frozen v1 base {FROZEN_V1_COMMIT}")
        git("cat-file", "-e", f"{commit}^{{commit}}")

        entries = manifest.get("entries")
        if not isinstance(entries, list) or not entries:
            raise ValueError("entries must be a non-empty array")

        entry_ids: set[str] = set()
        references = 0
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("every entry must be an object")
            missing = REQUIRED_ENTRY_FIELDS - entry.keys()
            if missing:
                raise ValueError(f"entry is missing required fields: {', '.join(sorted(missing))}")
            entry_id = entry["id"]
            if not isinstance(entry_id, str) or not entry_id or entry_id in entry_ids:
                raise ValueError(f"entry id is empty or duplicated: {entry_id!r}")
            entry_ids.add(entry_id)
            if entry["classification"] not in CLASSIFICATIONS:
                raise ValueError(f"{entry_id}: invalid classification")
            if entry["v2_requirement"] not in V2_REQUIREMENTS:
                raise ValueError(f"{entry_id}: invalid v2_requirement")
            for field in ("source_paths", "evidence_tests"):
                values = entry[field]
                if not isinstance(values, list) or not values:
                    raise ValueError(f"{entry_id}: {field} must be a non-empty array")
                for reference in values:
                    validate_reference(commit, entry_id, reference)
                    references += 1

        print(f"Reuse manifest passed: {len(entries)} entries, {references} frozen references.")
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"reuse manifest violation: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
