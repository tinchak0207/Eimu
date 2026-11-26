#!/usr/bin/env python3
"""Create a safe project skeleton for a detailed Blender education video."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil


SKILL_DIR = Path(__file__).resolve().parent.parent
ASSETS_DIR = SKILL_DIR / "assets"
DIRECTORIES = (
    "brief",
    "sources",
    "scene",
    "renders",
    "audio",
    "overlays",
    "review",
    "qa",
    "deliverables",
)
TEMPLATES = {
    "timeline_manifest.template.json": "timeline_manifest.json",
    "narration_plan.template.json": "brief/narration_plan.json",
    "github_resource_review.template.json": "brief/github_resource_review.json",
    "motion_qa.template.json": "qa/motion_qa.json",
    "subtitle.template.ass": "overlays/subtitles.ass",
    "teaching_overlay.template.ass": "overlays/teaching_overlay.ass",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Initialize a non-destructive Blender education-video project."
    )
    parser.add_argument("project_dir", type=Path)
    parser.add_argument(
        "--force-templates",
        action="store_true",
        help="Replace only the copied template files; never delete project content.",
    )
    return parser.parse_args()


def copy_template(source: Path, destination: Path, *, force: bool) -> str:
    if destination.exists() and not force:
        return f"SKIP existing {destination}"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return f"CREATE {destination}"


def main() -> int:
    args = parse_args()
    project = args.project_dir.expanduser().resolve()
    project.mkdir(parents=True, exist_ok=True)
    for directory in DIRECTORIES:
        (project / directory).mkdir(parents=True, exist_ok=True)

    messages: list[str] = []
    for source_name, relative_destination in TEMPLATES.items():
        source = ASSETS_DIR / source_name
        if not source.is_file():
            raise SystemExit(f"Missing bundled template: {source}")
        messages.append(
            copy_template(
                source,
                project / relative_destination,
                force=args.force_templates,
            )
        )

    ledger_path = project / "brief" / "claim_ledger.json"
    if not ledger_path.exists() or args.force_templates:
        ledger = {
            "project": project.name,
            "claims": [
                {
                    "id": "claim_001",
                    "statement": "Replace with a sourced factual claim.",
                    "status": "verified",
                    "source": "Replace with a primary-source URL or local source path.",
                    "source_locator": "Replace with page, section, figure, table, or quoted passage.",
                    "visual_treatment": "literal",
                    "notes": "",
                },
                {
                    "id": "claim_002",
                    "statement": "Replace with a conceptual teaching abstraction.",
                    "status": "conceptual",
                    "source": "",
                    "source_locator": "",
                    "visual_treatment": "disclose through narration/subtitles and distinct visual treatment",
                    "notes": "",
                },
            ],
        }
        ledger_path.write_text(
            json.dumps(ledger, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        messages.append(f"CREATE {ledger_path}")
    else:
        messages.append(f"SKIP existing {ledger_path}")

    print(f"Initialized Blender education-video project: {project}")
    for message in messages:
        print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
