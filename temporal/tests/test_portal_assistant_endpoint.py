from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from temporal.src.agents.portal_assistant_schema import AssistantAction, AssistantReplyV1
from temporal.src.ops_api import app as ops_app
from temporal.src.ops_api.app import _BEARER_PREFIX, Principal, create_app


class _FakeSupabaseAuth:
    def __init__(self, *, principal: Principal, tenant_id: str = "tenant-a-id") -> None:
        self._principal = principal
        self._tenant_id = tenant_id

    async def authenticate_user(self, *, user_jwt: str) -> Principal:
        return self._principal

    async def get_tenant_id_by_key(self, *, tenant_key: str) -> str | None:
        return self._tenant_id if tenant_key == self._principal.tenant else None


def _build_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    principal = Principal(sub="u-1", name="Dona", role="branch_manager", tenant="tenant-a", can_operate=True)
    supabase = _FakeSupabaseAuth(principal=principal)

    async def _fake_run(history: Any, context: Any, **_kwargs: Any) -> AssistantReplyV1:
        # Model proposes one allowed + one forbidden screen; endpoint must drop the forbidden.
        return AssistantReplyV1(
            reply="Vendas de R$ 1,2M no mês.",
            actions=[
                AssistantAction(type="open_screen", component_key="admin-users", title="Usuários"),
                AssistantAction(type="open_screen", component_key="dia-sales", title="Vendas"),
            ],
            suggestions=["E a margem?"],
        )

    monkeypatch.setattr(ops_app, "run_portal_assistant", _fake_run)
    app = create_app(supabase_client=supabase, temporal_client=object())
    return TestClient(app)


def _chat_body() -> dict[str, Any]:
    return {
        "messages": [{"role": "user", "content": "como estão minhas vendas?"}],
        "context": {
            "current_screen": "dia-overview",
            "empresa_id": "emp-1",
            "available_screens": [{"component_key": "dia-sales", "title": "Vendas", "solution": "Fast BI"}],
        },
    }


def test_assistant_chat_returns_reply_and_filters_navigation(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch)
    res = client.post(
        "/api/ops/assistant/chat",
        json=_chat_body(),
        headers={"Authorization": f"{_BEARER_PREFIX} test-token"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["reply"].startswith("Vendas")
    keys = [a["component_key"] for a in body["actions"]]
    assert keys == ["dia-sales"]  # admin-users dropped (not in available_screens)
    assert body["suggestions"] == ["E a margem?"]


def test_assistant_chat_forwards_resolved_context_locale(monkeypatch: pytest.MonkeyPatch) -> None:
    principal = Principal(sub="u-1", name="Dona", role="branch_manager", tenant="tenant-a", can_operate=True)
    supabase = _FakeSupabaseAuth(principal=principal)
    seen_contexts: list[dict[str, Any]] = []

    async def _fake_run(history: Any, context: Any, **_kwargs: Any) -> AssistantReplyV1:
        seen_contexts.append(dict(context))
        return AssistantReplyV1(reply="Sales are available.", actions=[], suggestions=[])

    monkeypatch.setattr(ops_app, "run_portal_assistant", _fake_run)
    app = create_app(supabase_client=supabase, temporal_client=object())
    client = TestClient(app)
    body = _chat_body()
    body["context"]["locale"] = "en-US"

    res = client.post(
        "/api/ops/assistant/chat",
        json=body,
        headers={"Authorization": f"{_BEARER_PREFIX} test-token"},
    )

    assert res.status_code == 200
    assert seen_contexts[0]["locale"] == "en-US"


def test_assistant_chat_falls_back_to_default_locale_for_unknown_context_locale(monkeypatch: pytest.MonkeyPatch) -> None:
    principal = Principal(sub="u-1", name="Dona", role="branch_manager", tenant="tenant-a", can_operate=True)
    supabase = _FakeSupabaseAuth(principal=principal)
    seen_contexts: list[dict[str, Any]] = []

    async def _fake_run(history: Any, context: Any, **_kwargs: Any) -> AssistantReplyV1:
        seen_contexts.append(dict(context))
        return AssistantReplyV1(reply="Vendas disponíveis.", actions=[], suggestions=[])

    monkeypatch.setattr(ops_app, "run_portal_assistant", _fake_run)
    app = create_app(supabase_client=supabase, temporal_client=object())
    client = TestClient(app)
    body = _chat_body()
    body["context"]["locale"] = "fr-FR"

    res = client.post(
        "/api/ops/assistant/chat",
        json=body,
        headers={"Authorization": f"{_BEARER_PREFIX} test-token"},
    )

    assert res.status_code == 200
    assert seen_contexts[0]["locale"] == "pt-BR"


def test_assistant_chat_requires_bearer_token(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch)
    res = client.post("/api/ops/assistant/chat", json=_chat_body())
    assert res.status_code == 401
