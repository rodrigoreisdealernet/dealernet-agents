from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from temporalio import workflow

_HIGH_DAMAGE_KEYWORDS = {
    "broken",
    "cracked",
    "crush",
    "leak",
    "leaking",
    "unsafe",
    "failed",
    "damage",
    "damaged",
}
_MEDIUM_DAMAGE_KEYWORDS = {
    "dent",
    "dented",
    "scratch",
    "scratched",
    "wear",
    "worn",
    "issue",
}


@dataclass
class AssetUpdateEvidence:
    file_name: str
    path: str
    url: str


@dataclass
class AssetUpdateWorkflowInput:
    asset_id: str
    current_data: dict[str, Any]
    comments: str | None = None
    report_damage: bool = False
    damage_summary: str | None = None
    evidence: list[AssetUpdateEvidence] = field(default_factory=list)


@workflow.defn
class AssetUpdateWorkflow:
    @workflow.run
    async def run(self, inp: AssetUpdateWorkflowInput) -> dict[str, Any]:
        current_data = dict(inp.current_data)
        proposed_data = dict(current_data)
        comment_text = (inp.comments or "").strip()
        damage_summary = (inp.damage_summary or "").strip()
        evidence = [
            {
                "file_name": item.file_name,
                "path": item.path,
                "url": item.url,
            }
            for item in inp.evidence
            if item.url or item.path
        ]
        analysis_text = " ".join(part for part in [comment_text, damage_summary] if part).lower()
        proposed_status = str(
            current_data.get("status")
            or current_data.get("operational_status")
            or "available"
        )
        updated_fields: list[str] = []

        if evidence:
            image_urls = [item["url"] for item in evidence if item.get("url")]
            if image_urls:
                proposed_data["image_url"] = image_urls[0]
                proposed_data["image_gallery"] = image_urls
                updated_fields.extend(["image_url", "image_gallery"])
            proposed_data["latest_evidence_uploads"] = evidence
            updated_fields.append("latest_evidence_uploads")

        if comment_text:
            proposed_data["latest_condition_notes"] = comment_text
            updated_fields.append("latest_condition_notes")

        damage_severity = "none"
        if inp.report_damage or damage_summary:
            proposed_data["damage_reported"] = True
            proposed_data["damage_report_summary"] = damage_summary or comment_text or "Damage report submitted"
            updated_fields.extend(["damage_reported", "damage_report_summary"])
            damage_severity = _classify_damage_severity(analysis_text)
            proposed_status = "in_maintenance" if damage_severity == "high" else "on_inspection_hold"

        status_key = "status" if "status" in current_data or "operational_status" not in current_data else "operational_status"
        if proposed_status != str(current_data.get(status_key) or ""):
            proposed_data[status_key] = proposed_status
            updated_fields.append(status_key)

        unique_updated_fields = list(dict.fromkeys(updated_fields))
        summary_parts = []
        if evidence:
            summary_parts.append(f"attached {len(evidence)} image(s)")
        if comment_text:
            summary_parts.append("captured operator comments")
        if inp.report_damage or damage_summary:
            summary_parts.append(f"flagged damage severity as {damage_severity}")
        summary = "Agentic asset review completed"
        if summary_parts:
            summary += ": " + ", ".join(summary_parts) + "."
        else:
            summary += "."

        return {
            "asset_id": inp.asset_id,
            "proposed_data": proposed_data,
            "updated_fields": unique_updated_fields,
            "recommended_status": proposed_status,
            "damage_severity": damage_severity,
            "summary": summary,
        }


def _classify_damage_severity(text: str) -> str:
    words = {token.strip(".,!?:;()[]{}") for token in text.split() if token}
    if words & _HIGH_DAMAGE_KEYWORDS:
        return "high"
    if words & _MEDIUM_DAMAGE_KEYWORDS:
        return "medium"
    return "low"
