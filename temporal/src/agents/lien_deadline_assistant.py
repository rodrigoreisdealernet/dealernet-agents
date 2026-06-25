from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import date, timedelta
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]

# Operating-model tag constants (t4, t5) for the credit & billing analyst role.
#   t4 — Send preliminary notices and maintain state-specific lien-right
#         deadline tracking for project-based contracts.
#   t5 — Issue and track lien waivers alongside incoming payments and confirm
#         supporting waivers are complete before receivables are closed.
OM_TAG_LIEN_DEADLINE = "credit-billing-analyst:t4"
OM_TAG_LIEN_WAIVER = "credit-billing-analyst:t5"

# ---------------------------------------------------------------------------
# Deterministic deadline calculation
# ---------------------------------------------------------------------------

# State-specific preliminary-notice deadline in calendar days after first
# furnishing materials or equipment.  Omitted states use the DEFAULT_PRELIM_DAYS
# fallback and should trigger a manual-review escalation so incomplete
# jurisdiction coverage is surfaced explicitly rather than silently applied.
#
# Sources:
#   Levelset state lien-law guides — https://www.levelset.com/mechanics-lien/
#   National Lien Law (NLL) summaries (public domain)
_PRELIM_NOTICE_DAYS: dict[str, int] = {
    "AL": 30,
    "AK": 10,
    "AZ": 20,
    "AR": 75,
    "CA": 20,
    "CO": 0,   # No preliminary notice required for direct contractors in CO
    "CT": 0,   # No preliminary notice required
    "DE": 0,   # No preliminary notice required
    "FL": 45,
    "GA": 30,
    "HI": 45,
    "ID": 0,   # No preliminary notice required
    "IL": 90,
    "IN": 90,
    "IA": 0,   # No preliminary notice required
    "KS": 0,   # No preliminary notice required
    "KY": 0,   # No preliminary notice required
    "LA": 75,
    "ME": 0,
    "MD": 0,
    "MA": 0,
    "MI": 20,
    "MN": 45,
    "MS": 0,
    "MO": 0,
    "MT": 0,
    "NE": 0,
    "NV": 31,
    "NH": 0,
    "NJ": 0,
    "NM": 60,
    "NY": 0,
    "NC": 0,
    "ND": 0,
    "OH": 21,
    "OK": 75,
    "OR": 8,
    "PA": 0,
    "RI": 0,
    "SC": 90,
    "SD": 0,
    "TN": 0,
    "TX": 15,   # For sub-contractors under general contracts
    "UT": 20,
    "VT": 0,
    "VA": 0,
    "WA": 60,
    "WV": 0,
    "WI": 60,
    "WY": 0,
}

# States where preliminary notice is not required (value == 0) and
# we should not surface a lien-deadline finding.
_NO_NOTICE_STATES = frozenset(
    abbr for abbr, days in _PRELIM_NOTICE_DAYS.items() if days == 0
)

DEFAULT_PRELIM_DAYS = 20
_UNKNOWN_STATE_SENTINEL = "__unknown__"

# Urgency thresholds (calendar days remaining):
_URGENCY_OVERDUE = 0      # past deadline
_URGENCY_CRITICAL = 5     # ≤ 5 days
_URGENCY_WARNING = 14     # ≤ 14 days


def calculate_prelim_notice_deadline(
    *,
    state: str,
    first_furnishing_date: date,
    reference_date: date | None = None,
) -> dict[str, Any]:
    """Calculate the preliminary-notice deadline for a given state and first
    furnishing date.

    Returns a dict with keys:
        state          — normalised two-letter state abbreviation
        deadline_date  — ISO-format deadline or None if no notice required
        days_window    — days from first furnishing to deadline (0 = not required)
        days_remaining — calendar days between reference_date and deadline_date
                         (negative = overdue)
        urgency        — one of: "not_required", "ok", "warning", "critical",
                         "overdue", "unknown_jurisdiction"
        notice_required — bool
        stale_inputs   — list of uncertainty strings if jurisdiction is unknown
    """
    ref = reference_date or date.today()
    abbr = state.strip().upper()

    if abbr == _UNKNOWN_STATE_SENTINEL or abbr not in _PRELIM_NOTICE_DAYS:
        return {
            "state": abbr,
            "deadline_date": None,
            "days_window": None,
            "days_remaining": None,
            "urgency": "unknown_jurisdiction",
            "notice_required": None,
            "stale_inputs": [
                f"State '{abbr}' is not in the jurisdiction table — manual compliance review required."
            ],
        }

    days_window = _PRELIM_NOTICE_DAYS[abbr]

    if days_window == 0:
        return {
            "state": abbr,
            "deadline_date": None,
            "days_window": 0,
            "days_remaining": None,
            "urgency": "not_required",
            "notice_required": False,
            "stale_inputs": [],
        }

    deadline = first_furnishing_date + timedelta(days=days_window)
    days_remaining = (deadline - ref).days

    if days_remaining < _URGENCY_OVERDUE:
        urgency = "overdue"
    elif days_remaining <= _URGENCY_CRITICAL:
        urgency = "critical"
    elif days_remaining <= _URGENCY_WARNING:
        urgency = "warning"
    else:
        urgency = "ok"

    return {
        "state": abbr,
        "deadline_date": deadline.isoformat(),
        "days_window": days_window,
        "days_remaining": days_remaining,
        "urgency": urgency,
        "notice_required": True,
        "stale_inputs": [],
    }


def is_notice_required(state: str) -> bool:
    """Return True if a preliminary notice is required in this state."""
    abbr = state.strip().upper()
    if abbr not in _PRELIM_NOTICE_DAYS:
        return True   # Unknown states default to treat-as-required for safety
    return _PRELIM_NOTICE_DAYS[abbr] > 0


# ---------------------------------------------------------------------------
# Lien Deadline proposal model (t4)
# ---------------------------------------------------------------------------


class LienDeadlineProposalV1(BaseModel):
    """Single ranked lien-deadline thread for one project obligation.

    The deadline date and urgency are computed deterministically by
    calculate_prelim_notice_deadline(); the AI layer assembles evidence,
    surfaces uncertainty, and proposes the analyst's next action.  No notice
    is ever sent automatically — all send actions require human approval.
    """

    model_config = ConfigDict(extra="forbid")

    obligation_id: str = Field(min_length=1)
    project_id: str = Field(default="")
    account_id: str = Field(default="")
    state: str = Field(
        default="",
        description="Two-letter US state abbreviation for jurisdiction-specific rules.",
    )
    deadline_date: str | None = Field(
        default=None,
        description="ISO-format date by which preliminary notice must be sent, or null.",
    )
    days_remaining: int | None = Field(
        default=None,
        description="Calendar days until deadline; negative means overdue.",
    )
    deadline_type: str = Field(
        default="preliminary_notice",
        pattern="^(preliminary_notice|lien_filing|claim_on_bond|no_notice_required|unknown)$",
    )
    urgency: str = Field(
        pattern="^(overdue|critical|warning|ok|not_required|unknown_jurisdiction)$",
    )
    notice_sent: bool = Field(default=False)
    recommended_action: str = Field(
        pattern="^(send_notice|schedule_notice|acknowledge_no_action_required|manual_review|escalate_missing_data|no_op)$",
    )
    operating_model_tags: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    stale_inputs: list[str] = Field(default_factory=list)
    material_signal_key: str = Field(default="")
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str


def lien_deadline_proposal_v1_schema() -> dict[str, Any]:
    return LienDeadlineProposalV1.model_json_schema()


async def run_lien_deadline_assistant(
    obligation_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Agentic evidence-gathering and recommendation for a single lien-deadline obligation.

    The deterministic deadline is pre-computed by the caller and injected into
    the user_prompt_template so the LLM reasons from accurate dates rather than
    hallucinating them.  The LLM's job is evidence assembly, uncertainty
    surfacing, and proposed-action wording — not date arithmetic.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=LienDeadlineProposalV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


# ---------------------------------------------------------------------------
# Lien Waiver proposal model (t5)
# ---------------------------------------------------------------------------


class LienWaiverProposalV1(BaseModel):
    """Single waiver obligation thread for analyst review.

    Tracks whether the required waiver has been received, and surfaces the
    recommended action.  No waiver is closed or applied automatically — all
    waiver closeout actions require human approval.
    """

    model_config = ConfigDict(extra="forbid")

    obligation_id: str = Field(min_length=1)
    project_id: str = Field(default="")
    account_id: str = Field(default="")
    payment_id: str = Field(default="")
    waiver_type: str = Field(
        pattern="^(conditional_partial|unconditional_partial|conditional_final|unconditional_final|unknown)$",
    )
    payment_amount: float = Field(default=0.0, ge=0.0)
    waiver_status: str = Field(
        pattern="^(pending_receipt|received|missing|expired|sent_awaiting_return|not_required)$",
    )
    recommended_action: str = Field(
        pattern="^(request_waiver|confirm_waiver_received|close_obligation|manual_review|no_op)$",
    )
    operating_model_tags: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    stale_inputs: list[str] = Field(default_factory=list)
    material_signal_key: str = Field(default="")
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str


def lien_waiver_proposal_v1_schema() -> dict[str, Any]:
    return LienWaiverProposalV1.model_json_schema()


async def run_lien_waiver_assistant(
    obligation_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Agentic waiver evidence-gathering and closeout recommendation.

    Surfaces which waivers are still outstanding on a payment and proposes the
    analyst-approved next action.  Never closes obligations or sends documents
    automatically.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=LienWaiverProposalV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


__all__ = [
    "LienDeadlineProposalV1",
    "LienWaiverProposalV1",
    "OM_TAG_LIEN_DEADLINE",
    "OM_TAG_LIEN_WAIVER",
    "calculate_prelim_notice_deadline",
    "is_notice_required",
    "lien_deadline_proposal_v1_schema",
    "lien_waiver_proposal_v1_schema",
    "run_lien_deadline_assistant",
    "run_lien_waiver_assistant",
]
