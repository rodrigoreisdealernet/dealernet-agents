from __future__ import annotations

import pytest
from temporal.src.agents.tools import (
    AgentToolConfig,
    AppScope,
    InMemoryRentalReadModel,
    PostgrestReadClient,
    RentalDataStore,
    SqlRentalReadModel,
    SupabaseRentalReadModel,
    build_agent_tool_registry,
    build_service_role_rental_store,
    get_invoice_detail,
    get_rate_card,
    get_telematics,
    query_entity,
    query_facts,
    query_relationships,
    query_time_series,
)
from temporal.src.agents.tools.rental_data import ToolValidationError

TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
BRANCH_A = "11111111-1111-4111-8111-111111111111"
BRANCH_B = "22222222-2222-4222-8222-222222222222"
ASSET_A = "33333333-3333-4333-8333-333333333333"
ASSET_B = "44444444-4444-4444-8444-444444444444"
INVOICE_A = "55555555-5555-4555-8555-555555555555"
INVOICE_B = "66666666-6666-4666-8666-666666666666"
CATEGORY_A = "77777777-7777-4777-8777-777777777777"
CATEGORY_B = "88888888-8888-4888-8888-888888888888"


@pytest.fixture()
def store() -> RentalDataStore:
    return RentalDataStore(
        read_model=InMemoryRentalReadModel(
            entity_rows=[
            {
                "entity_id": ASSET_A,
                "entity_type": "asset",
                "version_id": "aaaaaaaa-0000-4000-8000-000000000001",
                "version_number": 3,
                "tenant_id": TENANT_A,
                "branch_id": BRANCH_A,
                "data": {"name": "Forklift A", "tenant_id": TENANT_A, "branch_id": BRANCH_A},
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-06-01T00:00:00Z",
            },
            {
                "entity_id": ASSET_B,
                "entity_type": "asset",
                "version_id": "bbbbbbbb-0000-4000-8000-000000000001",
                "version_number": 1,
                "tenant_id": TENANT_B,
                "branch_id": BRANCH_B,
                "data": {"name": "Forklift B", "tenant_id": TENANT_B, "branch_id": BRANCH_B},
                "created_at": "2026-01-02T00:00:00Z",
                "updated_at": "2026-06-02T00:00:00Z",
            },
            {
                "entity_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                "entity_type": "customer",
                "version_id": "cccccccc-0000-4000-8000-000000000001",
                "version_number": 1,
                "tenant_id": TENANT_A,
                "branch_id": None,
                "data": {"name": "Branchless Customer", "tenant_id": TENANT_A},
                "created_at": "2026-01-03T00:00:00Z",
                "updated_at": "2026-06-03T00:00:00Z",
            },
        ],
            relationship_rows=[
            {
                "relationship_id": "99999999-9999-4999-8999-999999999991",
                "relationship_type": "branch_has_asset",
                "parent_id": BRANCH_A,
                "child_id": ASSET_A,
                "tenant_id": TENANT_A,
                "metadata": {"tenant_id": TENANT_A, "branch_id": BRANCH_A},
                "valid_from": "2026-01-01T00:00:00Z",
                "valid_to": None,
            },
            {
                "relationship_id": "99999999-9999-4999-8999-999999999992",
                "relationship_type": "branch_has_asset",
                "parent_id": BRANCH_B,
                "child_id": ASSET_B,
                "tenant_id": TENANT_B,
                "metadata": {"tenant_id": TENANT_B, "branch_id": BRANCH_B},
                "valid_from": "2026-01-01T00:00:00Z",
                "valid_to": None,
            },
        ],
            fact_rows=[
            {
                "fact_id": "12121212-1212-4121-8121-121212121212",
                "entity_id": ASSET_A,
                "fact_key": "invoice_total",
                "value": 1500,
                "unit": "USD",
                "tenant_id": TENANT_A,
                "metadata": {"branch_id": BRANCH_A},
                "created_at": "2026-06-01T00:00:00Z",
                "updated_at": "2026-06-01T00:00:00Z",
            },
            {
                "fact_id": "34343434-3434-4343-8343-343434343434",
                "entity_id": ASSET_B,
                "fact_key": "invoice_total",
                "value": 2500,
                "unit": "USD",
                "tenant_id": TENANT_B,
                "metadata": {"branch_id": BRANCH_B},
                "created_at": "2026-06-02T00:00:00Z",
                "updated_at": "2026-06-02T00:00:00Z",
            },
        ],
            time_series_rows=[
            {
                "point_id": "13131313-1313-4131-8131-131313131313",
                "entity_id": ASSET_A,
                "fact_key": "asset_meter_reading",
                "observed_at": "2026-06-01T01:00:00Z",
                "data_payload": {"reading_value": 10.5, "reading_unit": "hours"},
                "tenant_id": TENANT_A,
                "metadata": {"branch_id": BRANCH_A},
                "created_at": "2026-06-01T01:01:00Z",
            },
            {
                "point_id": "24242424-2424-4242-8242-242424242424",
                "entity_id": ASSET_B,
                "fact_key": "asset_meter_reading",
                "observed_at": "2026-06-01T01:00:00Z",
                "data_payload": {"reading_value": 20.5, "reading_unit": "hours"},
                "tenant_id": TENANT_B,
                "metadata": {"branch_id": BRANCH_B},
                "created_at": "2026-06-01T01:01:00Z",
            },
        ],
            invoice_rows=[
            {
                "invoice_id": INVOICE_A,
                "contract_id": "abababab-abab-4aba-8aba-abababababab",
                "status": "pending",
                "customer_id": "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd",
                "billing_account_id": "efefefef-efef-4efe-8efe-efefefefefef",
                "currency": "USD",
                "subtotal": 1000,
                "tax": 200,
                "total": 1200,
                "line_items": [{"line_id": "l-1", "amount": 1200}],
                "issued_at": "2026-06-01T00:00:00Z",
                "due_at": "2026-06-30T00:00:00Z",
                "tenant_id": TENANT_A,
                "branch_id": BRANCH_A,
            },
            {
                "invoice_id": INVOICE_B,
                "contract_id": "abababab-abab-4aba-8aba-abababababac",
                "status": "pending",
                "currency": "USD",
                "subtotal": 2000,
                "tax": 400,
                "total": 2400,
                "line_items": [{"line_id": "l-2", "amount": 2400}],
                "issued_at": "2026-06-01T00:00:00Z",
                "due_at": "2026-06-30T00:00:00Z",
                "tenant_id": TENANT_B,
                "branch_id": BRANCH_B,
            },
        ],
            rate_card_rows=[
            {
                "rate_card_id": "51515151-5151-4515-8515-515151515151",
                "tenant_id": TENANT_A,
                "branch_id": BRANCH_A,
                "asset_category_id": CATEGORY_A,
                "rate_type": "daily",
                "rate_amount": 100,
                "currency": "USD",
                "effective_from": "2026-01-01T00:00:00Z",
                "effective_to": None,
            },
            {
                "rate_card_id": "61616161-6161-4616-8616-616161616161",
                "tenant_id": TENANT_B,
                "branch_id": BRANCH_B,
                "asset_category_id": CATEGORY_B,
                "rate_type": "daily",
                "rate_amount": 250,
                "currency": "USD",
                "effective_from": "2026-01-01T00:00:00Z",
                "effective_to": None,
            },
        ],
            telematics_rows=[
            {
                "asset_id": ASSET_A,
                "tenant_id": TENANT_A,
                "branch_id": BRANCH_A,
                "captured_at": "2026-06-01T00:00:00Z",
                "meter_hours": 121.5,
                "engine_on": False,
                "lat": 51.5074,
                "lon": -0.1278,
            },
            {
                "asset_id": ASSET_B,
                "tenant_id": TENANT_B,
                "branch_id": BRANCH_B,
                "captured_at": "2026-06-01T00:00:00Z",
                "meter_hours": 99.0,
                "engine_on": True,
                "lat": 40.7128,
                "lon": -74.0060,
            },
        ],
        ),
    )


@pytest.fixture()
def tenant_scope() -> AppScope:
    return AppScope(tenant_id=TENANT_A, branch_id=BRANCH_A)


def test_query_entity_happy_path_and_scope_enforcement(store: RentalDataStore, tenant_scope: AppScope) -> None:
    response = query_entity(store, tenant_scope, entity_type="asset")
    assert response["count"] == 1
    assert response["evidence"][0]["entity_id"] == ASSET_A


def test_query_entity_branch_scope_excludes_branchless_rows(store: RentalDataStore) -> None:
    branch_scoped = query_entity(
        store,
        AppScope(tenant_id=TENANT_A, branch_id=BRANCH_A),
        entity_type="customer",
    )
    assert branch_scoped["count"] == 0

    tenant_only = query_entity(store, AppScope(tenant_id=TENANT_A), entity_type="customer")
    assert tenant_only["count"] == 1


def test_query_entity_validation_failure(store: RentalDataStore, tenant_scope: AppScope) -> None:
    with pytest.raises(ToolValidationError):
        query_entity(store, tenant_scope, entity_type="unsupported")


def test_query_time_series_happy_path_and_empty_result(store: RentalDataStore, tenant_scope: AppScope) -> None:
    response = query_time_series(store, tenant_scope, fact_key="asset_meter_reading")
    assert response["count"] == 1
    assert response["evidence"][0]["entity_id"] == ASSET_A

    empty = query_time_series(
        store,
        tenant_scope,
        fact_key="asset_meter_reading",
        start_at="2030-01-01T00:00:00Z",
    )
    assert empty["count"] == 0


def test_query_time_series_validation_failure(store: RentalDataStore, tenant_scope: AppScope) -> None:
    with pytest.raises(ToolValidationError):
        query_time_series(store, tenant_scope, fact_key="unknown_fact")


def test_query_relationships_happy_path_and_scope_enforcement(store: RentalDataStore, tenant_scope: AppScope) -> None:
    response = query_relationships(store, tenant_scope, relationship_type="branch_has_asset")
    assert response["count"] == 1
    assert response["evidence"][0]["child_id"] == ASSET_A


def test_query_relationships_validation_failure(store: RentalDataStore, tenant_scope: AppScope) -> None:
    with pytest.raises(ToolValidationError):
        query_relationships(store, tenant_scope, relationship_type="made_up")


def test_query_facts_happy_path_and_scope_enforcement(store: RentalDataStore, tenant_scope: AppScope) -> None:
    response = query_facts(store, tenant_scope, fact_keys=["invoice_total"])
    assert response["count"] == 1
    assert response["evidence"][0]["entity_id"] == ASSET_A


def test_query_facts_validation_failure(store: RentalDataStore, tenant_scope: AppScope) -> None:
    with pytest.raises(ToolValidationError):
        query_facts(store, tenant_scope, fact_keys=["unsupported_fact"])


def test_get_invoice_detail_happy_path_and_tenant_scope(store: RentalDataStore, tenant_scope: AppScope) -> None:
    response = get_invoice_detail(store, tenant_scope, invoice_id=INVOICE_A)
    assert response["found"] is True
    assert response["evidence"]["total"] == 1200

    cross_tenant = get_invoice_detail(store, tenant_scope, invoice_id=INVOICE_B)
    assert cross_tenant["found"] is False


def test_get_invoice_detail_validation_failure(store: RentalDataStore, tenant_scope: AppScope) -> None:
    with pytest.raises(ToolValidationError):
        get_invoice_detail(store, tenant_scope, invoice_id="not-a-uuid")


def test_get_rate_card_happy_path_empty_and_scope(store: RentalDataStore, tenant_scope: AppScope) -> None:
    response = get_rate_card(store, tenant_scope, branch_id=BRANCH_A, asset_category_id=CATEGORY_A)
    assert response["count"] == 1
    assert response["evidence"][0]["rate_amount"] == 100

    cross_tenant_empty = get_rate_card(store, tenant_scope, branch_id=BRANCH_B, asset_category_id=CATEGORY_B)
    assert cross_tenant_empty["count"] == 0


def test_get_rate_card_validation_failure(store: RentalDataStore, tenant_scope: AppScope) -> None:
    with pytest.raises(ToolValidationError):
        get_rate_card(store, tenant_scope, branch_id=BRANCH_A, asset_category_id=CATEGORY_A, rate_type="hourly")


def test_get_telematics_uses_synthetic_seeded_path_and_url_safety(store: RentalDataStore, tenant_scope: AppScope) -> None:
    response = get_telematics(
        store,
        tenant_scope,
        asset_id=ASSET_A,
        external_urls=[
            "https://example.com/feed",
            "http://unsafe.example.com/feed",
            "https://localhost/feed",
            "https://169.254.169.254/latest/meta-data",
            "https://10.0.0.12/feed",
        ],
    )
    assert response["count"] == 1
    assert response["evidence"][0]["source"] == "synthetic_v1"
    assert response["external_lookups"]["allowed"] == ["https://example.com/feed"]
    assert len(response["external_lookups"]["rejected"]) == 4


def test_get_telematics_validation_failure(store: RentalDataStore, tenant_scope: AppScope) -> None:
    with pytest.raises(ToolValidationError):
        get_telematics(store, tenant_scope, asset_id="not-a-uuid")


def test_tool_registry_only_exposes_configured_tools(store: RentalDataStore, tenant_scope: AppScope) -> None:
    registry = build_agent_tool_registry(
        AgentToolConfig(tools=["query_entity", "get_telematics"]),
        store=store,
        scope=tenant_scope,
    )
    assert sorted(registry) == ["get_telematics", "query_entity"]

    payload = registry["query_entity"](entity_type="asset")
    assert payload["count"] == 1

    with pytest.raises(ToolValidationError):
        build_agent_tool_registry(
            AgentToolConfig(tools=["query_entity", "not_real"]),
            store=store,
            scope=tenant_scope,
        )


def test_sql_read_model_projects_scope_fields_for_scope_helper() -> None:
    executed_sql: dict[str, str] = {}

    def _query(sql: str) -> list[dict[str, object]]:
        normalized = " ".join(sql.split())
        if "from rental_current_relationships" in normalized:
            executed_sql["relationships"] = normalized
        if "from entity_facts" in normalized:
            executed_sql["facts"] = normalized
        if "from time_series_points" in normalized:
            executed_sql["time_series_points"] = normalized
        return []

    read_model = SqlRentalReadModel(query=_query)
    list(read_model.relationships())
    list(read_model.facts())
    list(read_model.time_series_points())

    assert sorted(executed_sql) == ["facts", "relationships", "time_series_points"]
    for sql in executed_sql.values():
        assert " as tenant_id" in sql
        assert " as branch_id" in sql
        assert "join rental_current_entity_state" in sql
        assert "coalesce(" in sql
        assert "nullif(" in sql

    assert "join rental_current_entity_state as parent_entities" in executed_sql["relationships"]
    assert "join rental_current_entity_state as child_entities" in executed_sql["relationships"]
    assert "join rental_current_entity_state as scoped_entities" in executed_sql["facts"]
    assert "left join rental_current_assets as scoped_assets" in executed_sql["facts"]
    assert "join rental_current_entity_state as scoped_entities" in executed_sql["time_series_points"]
    assert "left join rental_current_assets as scoped_assets" in executed_sql["time_series_points"]


def test_sql_read_model_scope_projection_supports_tool_scope_filtering() -> None:
    def _query(sql: str) -> list[dict[str, object]]:
        normalized = " ".join(sql.split())
        if "from entity_facts" in normalized:
            return [
                {"fact_id": "f-a", "entity_id": ASSET_A, "fact_key": "invoice_total", "value": 10, "tenant_id": TENANT_A, "branch_id": BRANCH_A},
                {"fact_id": "f-b", "entity_id": ASSET_B, "fact_key": "invoice_total", "value": 20, "tenant_id": TENANT_B, "branch_id": BRANCH_B},
            ]
        if "from time_series_points" in normalized:
            return [
                {"point_id": "p-a", "entity_id": ASSET_A, "fact_key": "asset_meter_reading", "observed_at": "2026-06-01T00:00:00Z", "tenant_id": TENANT_A, "branch_id": BRANCH_A},
                {"point_id": "p-b", "entity_id": ASSET_B, "fact_key": "asset_meter_reading", "observed_at": "2026-06-01T00:00:00Z", "tenant_id": TENANT_B, "branch_id": BRANCH_B},
            ]
        if "from rental_current_relationships" in normalized:
            return [
                {"relationship_id": "r-a", "relationship_type": "branch_has_asset", "parent_id": BRANCH_A, "child_id": ASSET_A, "tenant_id": TENANT_A, "branch_id": BRANCH_A},
                {"relationship_id": "r-b", "relationship_type": "branch_has_asset", "parent_id": BRANCH_B, "child_id": ASSET_B, "tenant_id": TENANT_B, "branch_id": BRANCH_B},
            ]
        return []

    store = RentalDataStore(read_model=SqlRentalReadModel(query=_query))
    scope = AppScope(tenant_id=TENANT_A, branch_id=BRANCH_A)

    fact_payload = query_facts(store, scope, fact_keys=["invoice_total"])
    time_series_payload = query_time_series(store, scope, fact_key="asset_meter_reading")
    relationship_payload = query_relationships(store, scope, relationship_type="branch_has_asset")

    assert [item["entity_id"] for item in fact_payload["evidence"]] == [ASSET_A]
    assert [item["entity_id"] for item in time_series_payload["evidence"]] == [ASSET_A]
    assert [item["child_id"] for item in relationship_payload["evidence"]] == [ASSET_A]


class _FakeReadClient:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.rows: dict[str, list[dict[str, object]]] = {
            "rental_current_entity_state": [
                {
                    "entity_id": ASSET_A,
                    "entity_type": "asset",
                    "entity_version_id": "v-1",
                    "version_number": 1,
                    "data": {"tenant_id": TENANT_A, "branch_id": BRANCH_A, "name": "Asset A"},
                    "created_at": "2026-06-01T00:00:00Z",
                    "updated_at": "2026-06-01T00:00:00Z",
                },
                {
                    "entity_id": ASSET_B,
                    "entity_type": "asset",
                    "entity_version_id": "v-2",
                    "version_number": 1,
                    "data": {"tenant_id": TENANT_B, "branch_id": BRANCH_B, "name": "Asset B"},
                    "created_at": "2026-06-01T00:00:00Z",
                    "updated_at": "2026-06-01T00:00:00Z",
                },
            ],
            "rental_current_assets": [
                {"entity_id": ASSET_A, "current_branch_id": BRANCH_A},
                {"entity_id": ASSET_B, "current_branch_id": BRANCH_B},
            ],
            "rental_current_relationships": [
                {
                    "relationship_id": "rel-1",
                    "relationship_type": "branch_has_asset",
                    "parent_id": BRANCH_A,
                    "child_id": ASSET_A,
                    "metadata": {"tenant_id": TENANT_A, "branch_id": BRANCH_A},
                    "valid_from": "2026-06-01T00:00:00Z",
                    "valid_to": None,
                }
            ],
            "fact_types": [{"id": "ft-1", "key": "invoice_total"}],
            "entity_facts": [
                {
                    "id": "fact-1",
                    "entity_id": ASSET_A,
                    "fact_type_id": "ft-1",
                    "value": 99,
                    "unit": "USD",
                    "metadata": {"tenant_id": TENANT_A, "branch_id": BRANCH_A},
                    "created_at": "2026-06-01T00:00:00Z",
                    "updated_at": "2026-06-01T00:00:00Z",
                }
            ],
            "time_series_points": [
                {
                    "id": "ts-1",
                    "entity_id": ASSET_A,
                    "fact_type_id": "ft-1",
                    "observed_at": "2026-06-01T00:00:00Z",
                    "data_payload": {"reading_value": 12.5},
                    "metadata": {"tenant_id": TENANT_A, "branch_id": BRANCH_A},
                    "created_at": "2026-06-01T00:00:00Z",
                }
            ],
        }

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: dict[str, object] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        del columns, order_by, descending
        self.calls.append(resource)
        rows = [dict(row) for row in self.rows.get(resource, [])]
        for key, value in (filters or {}).items():
            rows = [row for row in rows if row.get(key) == value]
        return rows[:limit] if limit is not None else rows


def test_supabase_read_model_keeps_tools_tenant_branch_scoped() -> None:
    client = _FakeReadClient()
    store = RentalDataStore(read_model=SupabaseRentalReadModel(client=client))
    scope = AppScope(tenant_id=TENANT_A, branch_id=BRANCH_A)

    entity_payload = query_entity(store, scope, entity_type="asset")
    fact_payload = query_facts(store, scope, fact_keys=["invoice_total"])
    ts_payload = query_time_series(store, scope, fact_key="invoice_total")
    rel_payload = query_relationships(store, scope, relationship_type="branch_has_asset")

    assert [row["entity_id"] for row in entity_payload["evidence"]] == [ASSET_A]
    assert [row["entity_id"] for row in fact_payload["evidence"]] == [ASSET_A]
    assert [row["entity_id"] for row in ts_payload["evidence"]] == [ASSET_A]
    assert [row["child_id"] for row in rel_payload["evidence"]] == [ASSET_A]
    assert "entity_facts" in client.calls
    assert "time_series_points" in client.calls


def test_build_service_role_rental_store_uses_supabase_read_model() -> None:
    client = _FakeReadClient()
    store = build_service_role_rental_store(client)
    assert isinstance(store.read_model, SupabaseRentalReadModel)


def test_postgrest_read_client_does_not_expose_write_methods() -> None:
    client = PostgrestReadClient(base_url="https://example.invalid", service_role_key="test-key", timeout_seconds=1)
    assert hasattr(client, "select")
    assert not hasattr(client, "insert")
    assert not hasattr(client, "update")
