from __future__ import annotations

import io
from collections.abc import Mapping
from typing import Any
from unittest.mock import patch
from urllib import error as urllib_error
from uuid import uuid4

import pytest
from temporal.src.activities import samsara

# ---------------------------------------------------------------------------
# Fake persistence client (mirrors the one in test_mulesoft_activity.py)
# ---------------------------------------------------------------------------


class _FakePersistenceClient:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "integration_config": [
                {
                    "id": str(uuid4()),
                    "tenant_id": "tenant-a",
                    "connector_key": "samsara",
                    "enabled": True,
                    "settings": {
                        "api_base_url": "https://api.samsara.com",
                        "enabled_scopes": ["gps", "hours", "eld", "dashcam_events"],
                        "fleet_targeting": {"group_ids": ["group-1"]},
                        "healthcheck_timeout_seconds": 5,
                    },
                    "mappings": {
                        "gps_mapping_profile": {"asset_id_field": "vehicleId"},
                        "hours_mapping_profile": {"driver_id_field": "driverId"},
                        "eld_profile": {"hos_mode": "property"},
                        "dashcam_event_profile": {"event_types": ["harsh_braking"]},
                    },
                    "secret_refs": {"api_secret_ref": "secret://integrations/samsara/api_key"},
                }
            ],
            "integration_sync_state": [],
            "integration_delivery_log": [],
            "external_id_map": [],
        }

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: Mapping[str, Any] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        del columns, order_by, descending
        rows = [dict(row) for row in self.tables.get(resource, [])]
        result: list[dict[str, Any]] = []
        for row in rows:
            keep = True
            for key, value in (filters or {}).items():
                if str(row.get(key)).lower() != str(value).lower():
                    keep = False
                    break
            if keep:
                result.append(row)
        if limit is not None:
            result = result[:limit]
        return result

    def upsert(self, resource: str, payload: Mapping[str, Any], *, on_conflict: str) -> dict[str, Any]:
        row = dict(payload)
        row.setdefault("id", str(uuid4()))
        keys = [k.strip() for k in on_conflict.split(",")]
        table = self.tables.setdefault(resource, [])
        for idx, existing in enumerate(table):
            if all(str(existing.get(k)) == str(row.get(k)) for k in keys):
                merged = {**existing, **row}
                merged["id"] = existing.get("id") or row["id"]
                table[idx] = merged
                return merged
        table.append(row)
        return row

    def update(self, resource: str, payload: Mapping[str, Any], *, filters: Mapping[str, Any]) -> list[dict[str, Any]]:
        updated: list[dict[str, Any]] = []
        table = self.tables.setdefault(resource, [])
        for idx, row in enumerate(table):
            if all(str(row.get(k)) == str(v) for k, v in filters.items()):
                merged = {**row, **dict(payload)}
                table[idx] = merged
                updated.append(merged)
        return updated


@pytest.fixture()
def fake_client(monkeypatch: pytest.MonkeyPatch) -> _FakePersistenceClient:
    client = _FakePersistenceClient()
    monkeypatch.setattr(samsara, "_persistence_client", client)
    return client


# ---------------------------------------------------------------------------
# samsara_load_sync_config
# ---------------------------------------------------------------------------


def test_load_sync_config_returns_enabled_scopes(fake_client: _FakePersistenceClient) -> None:
    result = samsara.samsara_load_sync_config("tenant-a", "gps")

    assert result["tenant_id"] == "tenant-a"
    assert result["scope"] == "gps"
    assert "gps" in result["enabled_scopes"]
    assert result["cursor"] is None


def test_load_sync_config_returns_stored_cursor(fake_client: _FakePersistenceClient) -> None:
    fake_client.tables["integration_sync_state"].append({
        "tenant_id": "tenant-a",
        "connector_key": "samsara",
        "scope_key": "gps",
        "cursor_value": "cursor-abc",
        "cursor": "cursor-abc",
    })

    result = samsara.samsara_load_sync_config("tenant-a", "gps")

    assert result["cursor"] == "cursor-abc"


def test_load_sync_config_raises_when_config_missing(fake_client: _FakePersistenceClient) -> None:
    fake_client.tables["integration_config"] = []

    with pytest.raises(ValueError, match="integration_config not found"):
        samsara.samsara_load_sync_config("tenant-missing", "gps")


# ---------------------------------------------------------------------------
# samsara_persist_telemetry_batch
# ---------------------------------------------------------------------------


def _gps_record(vehicle_id: str = "veh-1", ts: str = "2026-06-01T00:00:00Z") -> dict[str, Any]:
    return {"vehicleId": vehicle_id, "time": ts, "latitude": 37.7, "longitude": -122.4}


def _hours_record(driver_id: str = "drv-1", period: str = "2026-05-31") -> dict[str, Any]:
    return {"driverId": driver_id, "period": period, "hoursWorked": 8.5}


def _eld_record(log_id: str = "log-1", start_time: str = "2026-06-01T06:00:00Z") -> dict[str, Any]:
    return {"logId": log_id, "startTime": start_time, "status": "D"}


def _dashcam_record(event_id: str = "evt-1", ts: str = "2026-06-01T12:00:00Z") -> dict[str, Any]:
    return {"eventId": event_id, "eventMs": ts, "type": "harsh_braking"}


def test_persist_gps_batch_writes_external_id_map(fake_client: _FakePersistenceClient) -> None:
    result = samsara.samsara_persist_telemetry_batch(
        "tenant-a", "gps", [_gps_record()], "2026-06-01T00:00:00Z"
    )

    assert result["upserted"] == 1
    assert result["duplicates"] == 0
    ext_rows = fake_client.tables["external_id_map"]
    assert len(ext_rows) == 1
    assert ext_rows[0]["external_id"] == "veh-1"
    assert ext_rows[0]["connector_key"] == "samsara"
    assert ext_rows[0]["exchange_key"] == "gps"


def test_persist_hours_batch_writes_delivery_log(fake_client: _FakePersistenceClient) -> None:
    samsara.samsara_persist_telemetry_batch(
        "tenant-a", "hours", [_hours_record()], "2026-06-01T00:00:00Z"
    )

    log_rows = fake_client.tables["integration_delivery_log"]
    assert len(log_rows) == 1
    assert log_rows[0]["status"] == "received"
    assert log_rows[0]["direction"] == "inbound"
    assert log_rows[0]["source_of_truth"] == "samsara"


def test_persist_eld_batch_deduplicates_same_idempotency_key(fake_client: _FakePersistenceClient) -> None:
    record = _eld_record()
    samsara.samsara_persist_telemetry_batch("tenant-a", "eld", [record], "2026-06-01T00:00:00Z")
    # Second call with same record should be a duplicate
    result = samsara.samsara_persist_telemetry_batch("tenant-a", "eld", [record], "2026-06-01T00:00:00Z")

    assert result["duplicates"] == 1
    assert result["upserted"] == 0
    # Only one log row should exist
    assert len(fake_client.tables["integration_delivery_log"]) == 1


def test_persist_dashcam_batch_multiple_records(fake_client: _FakePersistenceClient) -> None:
    records = [
        _dashcam_record("evt-1", "2026-06-01T12:00:00Z"),
        _dashcam_record("evt-2", "2026-06-01T12:05:00Z"),
    ]
    result = samsara.samsara_persist_telemetry_batch("tenant-a", "dashcam_events", records, "2026-06-01T12:10:00Z")

    assert result["upserted"] == 2
    assert result["total"] == 2


def test_persist_batch_skips_records_with_no_external_id(fake_client: _FakePersistenceClient) -> None:
    record = {"latitude": 37.7, "longitude": -122.4}  # no vehicleId / id
    result = samsara.samsara_persist_telemetry_batch("tenant-a", "gps", [record], "2026-06-01T00:00:00Z")

    assert result["upserted"] == 0


# ---------------------------------------------------------------------------
# samsara_advance_sync_cursor
# ---------------------------------------------------------------------------


def test_advance_sync_cursor_writes_integration_sync_state(fake_client: _FakePersistenceClient) -> None:
    result = samsara.samsara_advance_sync_cursor(
        "tenant-a", "gps", "cursor-xyz", "2026-06-01T00:00:00Z"
    )

    assert result["cursor"] == "cursor-xyz"
    state_rows = fake_client.tables["integration_sync_state"]
    assert len(state_rows) == 1
    assert state_rows[0]["cursor"] == "cursor-xyz"
    assert state_rows[0]["connector_key"] == "samsara"
    assert state_rows[0]["scope_key"] == "gps"


def test_advance_sync_cursor_upserts_on_repeated_call(fake_client: _FakePersistenceClient) -> None:
    samsara.samsara_advance_sync_cursor("tenant-a", "gps", "cursor-1", "2026-06-01T00:00:00Z")
    samsara.samsara_advance_sync_cursor("tenant-a", "gps", "cursor-2", "2026-06-01T01:00:00Z")

    state_rows = fake_client.tables["integration_sync_state"]
    # Should upsert, not insert twice
    assert len(state_rows) == 1
    assert state_rows[0]["cursor"] == "cursor-2"


# ---------------------------------------------------------------------------
# Error classification helpers
# ---------------------------------------------------------------------------


def test_classify_http_error_for_auth_statuses() -> None:
    assert samsara._classify_http_error(401) == "auth"
    assert samsara._classify_http_error(403) == "auth"


def test_classify_http_error_for_rate_limit() -> None:
    assert samsara._classify_http_error(429) == "rate_limit"


def test_classify_http_error_for_config_errors() -> None:
    assert samsara._classify_http_error(404) == "configuration"
    assert samsara._classify_http_error(422) == "configuration"


def test_classify_http_error_for_server_errors() -> None:
    assert samsara._classify_http_error(500) == "connectivity"
    assert samsara._classify_http_error(503) == "connectivity"


def test_classify_http_error_for_permanent_client_error() -> None:
    assert samsara._classify_http_error(400) == "permanent"


# ---------------------------------------------------------------------------
# Idempotency key helpers
# ---------------------------------------------------------------------------


def test_idempotency_key_for_gps_includes_timestamp() -> None:
    key = samsara._idempotency_key_for_record("gps", "veh-1", {"time": "2026-06-01T00:00:00Z"})
    assert key == "samsara:gps:veh-1:2026-06-01T00:00:00Z"


def test_idempotency_key_for_hours_includes_period() -> None:
    key = samsara._idempotency_key_for_record("hours", "drv-1", {"period": "2026-05-31"})
    assert key == "samsara:hours:drv-1:2026-05-31"


def test_idempotency_key_for_eld_includes_start_time() -> None:
    key = samsara._idempotency_key_for_record("eld", "log-1", {"startTime": "2026-06-01T06:00:00Z"})
    assert key == "samsara:eld:log-1:2026-06-01T06:00:00Z"


def test_idempotency_key_for_dashcam_events_includes_event_ms() -> None:
    key = samsara._idempotency_key_for_record("dashcam_events", "evt-1", {"eventMs": "2026-06-01T12:00:00Z"})
    assert key == "samsara:dashcam_events:evt-1:2026-06-01T12:00:00Z"


# ---------------------------------------------------------------------------
# External ID extraction helpers
# ---------------------------------------------------------------------------


def test_external_id_for_gps_uses_vehicle_id() -> None:
    assert samsara._external_id_for_record("gps", {"vehicleId": "veh-42"}) == "veh-42"


def test_external_id_for_gps_falls_back_to_id() -> None:
    assert samsara._external_id_for_record("gps", {"id": "veh-99"}) == "veh-99"


def test_external_id_for_hours_uses_driver_id() -> None:
    assert samsara._external_id_for_record("hours", {"driverId": "drv-10"}) == "drv-10"


def test_external_id_for_eld_uses_log_id() -> None:
    assert samsara._external_id_for_record("eld", {"logId": "log-7"}) == "log-7"


def test_external_id_for_dashcam_uses_event_id() -> None:
    assert samsara._external_id_for_record("dashcam_events", {"eventId": "evt-3"}) == "evt-3"


# ---------------------------------------------------------------------------
# Error sanitization regression tests
#
# Each test is specifically crafted to FAIL if the old secret-bearing error
# strings are reintroduced:
#   - _samsara_token previously raised SamsaraAuthError(f"... (secret_ref={api_secret_ref})")
#   - _fetch_page_from_samsara previously embedded `detail` (raw HTTP response body) and
#     raw `URLError` string in raised exceptions for rate-limit, mapping, and connectivity errors
#   - PostgrestServiceRoleClient._request previously embedded raw Supabase response bodies
#     and raw URLError strings
# ---------------------------------------------------------------------------


def _make_http_error(code: int, body: bytes) -> urllib_error.HTTPError:
    """Construct a urllib HTTPError with a readable response body for test injection."""
    return urllib_error.HTTPError(
        url="https://api.samsara.com/test",
        code=code,
        msg="",
        hdrs=None,  # type: ignore[arg-type]
        fp=io.BytesIO(body),
    )


def test_samsara_token_error_omits_secret_ref_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """SamsaraAuthError must not expose the secret_ref path or any env-var names.

    Regression: old code raised SamsaraAuthError(f"... (secret_ref={api_secret_ref})")
    which leaked the full path "secret://integrations/samsara/api_key".
    """
    config = {"secret_refs": {"api_secret_ref": "secret://integrations/samsara/api_key"}}
    monkeypatch.delenv("SAMSARA_API_TOKEN", raising=False)
    monkeypatch.delenv("SAMSARA_API_KEY", raising=False)
    # Derived env name from secret_ref path via replace("secret://","").replace("/","_").upper()
    monkeypatch.delenv("INTEGRATIONS_SAMSARA_API_KEY", raising=False)

    with pytest.raises(samsara.SamsaraAuthError) as exc_info:
        samsara._samsara_token(config)

    msg = str(exc_info.value)
    assert "secret://" not in msg
    assert "integrations/samsara/api_key" not in msg
    assert "INTEGRATIONS_SAMSARA_API_KEY" not in msg
    assert "SAMSARA_API_TOKEN" not in msg
    assert "SAMSARA_API_KEY" not in msg


def test_fetch_page_rate_limit_error_omits_response_body() -> None:
    """HTTP 429 must not include the raw provider response body in the raised error.

    Regression: old code did detail = exc.read()... raise SamsaraRateLimitError(f"... {detail}")
    """
    sensitive_body = b'{"error": "rate_limit_exceeded", "token": "sk-real-secret-token"}'
    err = _make_http_error(429, sensitive_body)

    with patch.object(samsara.urllib_request, "urlopen", side_effect=err), pytest.raises(
        samsara.SamsaraRateLimitError
    ) as exc_info:
        samsara._fetch_page_from_samsara(
            url="https://api.samsara.com/v1/fleet/vehicles/stats",
            token="test-token",
            params={},
            timeout_seconds=5,
        )

    msg = str(exc_info.value)
    assert "sk-real-secret-token" not in msg
    assert "rate_limit_exceeded" not in msg
    assert sensitive_body.decode() not in msg


def test_fetch_page_mapping_error_omits_response_body() -> None:
    """HTTP 404 must not include the raw provider response body in the raised error.

    Regression: old code did detail = exc.read()... raise SamsaraMappingError(f"... {detail}")
    """
    sensitive_body = b'{"error": "not_found", "internal_path": "/secret/fleet/key"}'
    err = _make_http_error(404, sensitive_body)

    with patch.object(samsara.urllib_request, "urlopen", side_effect=err), pytest.raises(
        samsara.SamsaraMappingError
    ) as exc_info:
        samsara._fetch_page_from_samsara(
            url="https://api.samsara.com/v1/fleet/vehicles/stats",
            token="test-token",
            params={},
            timeout_seconds=5,
        )

    msg = str(exc_info.value)
    assert "/secret/fleet/key" not in msg
    assert "internal_path" not in msg
    assert sensitive_body.decode() not in msg


def test_fetch_page_connectivity_error_omits_response_body() -> None:
    """HTTP 5xx must not include the raw provider response body in the raised error.

    Regression: old code did detail = exc.read()... raise RuntimeError(f"... {detail}")
    """
    sensitive_body = b'{"error": "internal_server_error", "debug": "db_password=hunter2"}'
    err = _make_http_error(500, sensitive_body)

    with patch.object(samsara.urllib_request, "urlopen", side_effect=err), pytest.raises(RuntimeError) as exc_info:
        samsara._fetch_page_from_samsara(
            url="https://api.samsara.com/v1/fleet/vehicles/stats",
            token="test-token",
            params={},
            timeout_seconds=5,
        )

    msg = str(exc_info.value)
    assert "hunter2" not in msg
    assert "db_password" not in msg
    assert sensitive_body.decode() not in msg


def test_fetch_page_url_error_omits_raw_exception_detail() -> None:
    """URLError must not include the raw urllib exception string in the raised error.

    Regression: old code did raise RuntimeError(f"Samsara unavailable: {exc}") which
    embedded the full urllib.error.URLError string including OS-level socket detail.
    """
    raw_url_error = urllib_error.URLError(
        "nodename nor servname provided: SAMSARA_API_TOKEN=sk-leaked"
    )

    with patch.object(samsara.urllib_request, "urlopen", side_effect=raw_url_error), pytest.raises(
        RuntimeError
    ) as exc_info:
        samsara._fetch_page_from_samsara(
            url="https://api.samsara.com/v1/fleet/vehicles/stats",
            token="test-token",
            params={},
            timeout_seconds=5,
        )

    msg = str(exc_info.value)
    assert "sk-leaked" not in msg
    assert "SAMSARA_API_TOKEN" not in msg
    assert "nodename nor servname" not in msg


def test_postgrest_client_http_error_omits_response_body() -> None:
    """Supabase HTTP errors must not include the raw response body in the raised RuntimeError.

    Regression: old code did detail = exc.read()... raise RuntimeError(f"... {exc.code} {detail}")
    """
    sensitive_body = b'{"message": "JWT expired", "hint": "service_key=eyJsecret.xyz"}'
    err = _make_http_error(401, sensitive_body)

    client = samsara.PostgrestServiceRoleClient(
        base_url="https://fake.supabase.example.com",
        service_role_key="service-role-key-must-not-leak",
    )

    with patch.object(samsara.urllib_request, "urlopen", side_effect=err), pytest.raises(RuntimeError) as exc_info:
        client.select("integration_config")

    msg = str(exc_info.value)
    assert "eyJsecret.xyz" not in msg
    assert "service_key=" not in msg
    assert sensitive_body.decode() not in msg
    assert "service-role-key-must-not-leak" not in msg


def test_postgrest_client_url_error_omits_raw_exception_detail() -> None:
    """Supabase URLError must not include the raw urllib exception string in the raised RuntimeError.

    Regression: old code did raise RuntimeError(f"Supabase request failed (...): {exc}") which
    embedded the full urllib.error.URLError detail including OS-level connection strings.
    """
    raw_url_error = urllib_error.URLError(
        "connection refused: host=db.supabase.co ******"
    )

    client = samsara.PostgrestServiceRoleClient(
        base_url="https://fake.supabase.example.com",
        service_role_key="service-role-key-must-not-leak",
    )

    with patch.object(samsara.urllib_request, "urlopen", side_effect=raw_url_error), pytest.raises(
        RuntimeError
    ) as exc_info:
        client.select("integration_config")

    msg = str(exc_info.value)
    # The raw URLError reason string must not appear in the raised message
    assert "connection refused" not in msg
    assert "db.supabase.co" not in msg
    assert "service-role-key-must-not-leak" not in msg


# ---------------------------------------------------------------------------
# Field mapping: _apply_samsara_mapping
#
# Each test uses a non-default profile field to prove the profile is actively
# consulted. A test that passes with an empty profile or ignores the profile
# would fail here because the asserted value only exists under the non-default
# source field name.
# ---------------------------------------------------------------------------


def test_apply_gps_mapping_uses_profile_asset_id_field() -> None:
    """GPS profile asset_id_field must redirect where asset_id is read from.

    Regression guard: if _apply_samsara_mapping ignores the profile entirely,
    it would pull from the default 'vehicleId' field and return 'DEFAULT-ID'
    instead of 'SERIAL-001', causing this assertion to fail.
    """
    profile = {"asset_id_field": "assetSerialNumber"}
    record = {"vehicleId": "DEFAULT-ID", "assetSerialNumber": "SERIAL-001", "latitude": 37.7, "longitude": -122.4, "time": "2026-06-01T00:00:00Z"}

    result = samsara._apply_samsara_mapping(record, "gps", profile)

    assert result["asset_id"] == "SERIAL-001", (
        f"Expected 'SERIAL-001' from profile-specified 'assetSerialNumber', got {result['asset_id']!r}. "
        "Profile was not applied."
    )
    assert result["lat"] == 37.7
    assert result["lon"] == -122.4
    assert result["ts"] == "2026-06-01T00:00:00Z"


def test_apply_gps_mapping_defaults_when_profile_is_empty() -> None:
    """Empty GPS profile falls back to default Samsara field names."""
    record = {"vehicleId": "veh-99", "latitude": 51.5, "longitude": -0.1, "time": "t1"}

    result = samsara._apply_samsara_mapping(record, "gps", {})

    assert result["asset_id"] == "veh-99"
    assert result["lat"] == 51.5


def test_apply_hours_mapping_uses_profile_driver_id_field() -> None:
    """Hours profile driver_id_field must redirect the driver_id source field.

    Regression guard: if the profile is ignored, 'driverId' is used by default
    (returning 'DEFAULT-DRV') rather than the profile-specified 'employeeId'
    (returning 'EMP-42'), causing the assertion to fail.
    """
    profile = {"driver_id_field": "employeeId", "hours_field": "totalHours"}
    record = {"driverId": "DEFAULT-DRV", "employeeId": "EMP-42", "totalHours": 9.5, "period": "2026-05-31"}

    result = samsara._apply_samsara_mapping(record, "hours", profile)

    assert result["driver_id"] == "EMP-42", (
        f"Expected 'EMP-42' from profile 'employeeId', got {result['driver_id']!r}."
    )
    assert result["hours"] == 9.5


def test_apply_eld_mapping_uses_profile_log_id_field_and_hos_mode() -> None:
    """ELD profile log_id_field and hos_mode must both be applied.

    Regression guard: if the profile is ignored, log_id comes from default
    'logId' ('DEFAULT-LOG') not the profile 'hosLogId' ('HOS-7'), and
    hos_mode would be absent from the result.
    """
    profile = {"log_id_field": "hosLogId", "hos_mode": "property", "status_field": "dutyStatus"}
    record = {"logId": "DEFAULT-LOG", "hosLogId": "HOS-7", "driverId": "drv-1", "dutyStatus": "D", "startTime": "t1"}

    result = samsara._apply_samsara_mapping(record, "eld", profile)

    assert result["log_id"] == "HOS-7", (
        f"Expected 'HOS-7' from profile 'hosLogId', got {result['log_id']!r}."
    )
    assert result["status"] == "D"
    assert result["hos_mode"] == "property", "hos_mode from profile must be included in mapped result"


def test_apply_dashcam_mapping_uses_profile_event_id_field_and_event_types_filter() -> None:
    """Dashcam profile event_id_field and event_types must both be applied.

    Regression guard: if the profile is ignored, event_id comes from default
    'eventId' ('DEFAULT-EVT') not the profile 'safetyEventId' ('SE-99'), and
    event_types_filter would be absent from the result.
    """
    profile = {"event_id_field": "safetyEventId", "event_types": ["harsh_braking", "collision"]}
    record = {"eventId": "DEFAULT-EVT", "safetyEventId": "SE-99", "type": "harsh_braking", "eventMs": "2026-06-01T12:00:00Z"}

    result = samsara._apply_samsara_mapping(record, "dashcam_events", profile)

    assert result["event_id"] == "SE-99", (
        f"Expected 'SE-99' from profile 'safetyEventId', got {result['event_id']!r}."
    )
    assert result["event_types_filter"] == ["harsh_braking", "collision"], (
        "event_types from profile must appear as event_types_filter in mapped result"
    )


# ---------------------------------------------------------------------------
# Field mapping via samsara_persist_telemetry_batch
#
# These tests verify that the mapping profiles materially affect what is stored
# in integration_delivery_log.response_payload. A test passes only if the
# non-default profile field is respected; reverting to ignore the profile would
# pull from the default field name and break the assertion.
# ---------------------------------------------------------------------------


def test_persist_gps_stores_mapped_payload_using_profile_field(fake_client: _FakePersistenceClient) -> None:
    """GPS persist must store the profile-mapped asset_id in response_payload.

    Regression guard: if the profile is ignored (falling back to 'vehicleId'),
    response_payload['asset_id'] would be 'DEFAULT-VEH' instead of 'SERIAL-XYZ',
    causing this assertion to fail.
    """
    mappings = {"gps_mapping_profile": {"asset_id_field": "assetSerialNumber"}}
    record = {
        "vehicleId": "DEFAULT-VEH",
        "assetSerialNumber": "SERIAL-XYZ",
        "latitude": 40.7,
        "longitude": -74.0,
        "time": "2026-06-01T00:00:00Z",
    }

    samsara.samsara_persist_telemetry_batch(
        "tenant-a", "gps", [record], "2026-06-01T00:00:00Z", mappings
    )

    log_rows = fake_client.tables["integration_delivery_log"]
    assert len(log_rows) == 1
    response = log_rows[0].get("response_payload", {})
    assert response.get("asset_id") == "SERIAL-XYZ", (
        f"response_payload['asset_id'] should be 'SERIAL-XYZ' (from profile 'assetSerialNumber'), "
        f"got {response.get('asset_id')!r}. Mapping profile was not applied."
    )
    # request_payload must still be the raw record
    raw = log_rows[0].get("request_payload", {})
    assert raw.get("vehicleId") == "DEFAULT-VEH"


def test_persist_hours_stores_mapped_payload_using_profile_field(fake_client: _FakePersistenceClient) -> None:
    """Hours persist must store the profile-mapped driver_id in response_payload."""
    mappings = {"hours_mapping_profile": {"driver_id_field": "employeeId", "hours_field": "totalHours"}}
    record = {"driverId": "DEFAULT-DRV", "employeeId": "EMP-55", "totalHours": 7.5, "period": "2026-05-31"}

    samsara.samsara_persist_telemetry_batch(
        "tenant-a", "hours", [record], "2026-06-01T00:00:00Z", mappings
    )

    log_rows = fake_client.tables["integration_delivery_log"]
    response = log_rows[0].get("response_payload", {})
    assert response.get("driver_id") == "EMP-55", (
        f"response_payload['driver_id'] must come from profile 'employeeId', got {response.get('driver_id')!r}."
    )
    assert response.get("hours") == 7.5


def test_persist_eld_stores_mapped_payload_with_hos_mode(fake_client: _FakePersistenceClient) -> None:
    """ELD persist must include hos_mode from profile in response_payload."""
    mappings = {"eld_profile": {"hos_mode": "property", "log_id_field": "hosLogId"}}
    record = {"logId": "DEFAULT-LOG", "hosLogId": "HOS-99", "driverId": "drv-1", "status": "D", "startTime": "2026-06-01T06:00:00Z"}

    samsara.samsara_persist_telemetry_batch(
        "tenant-a", "eld", [record], "2026-06-01T06:00:00Z", mappings
    )

    log_rows = fake_client.tables["integration_delivery_log"]
    response = log_rows[0].get("response_payload", {})
    assert response.get("log_id") == "HOS-99"
    assert response.get("hos_mode") == "property", "hos_mode from eld_profile must appear in response_payload"


def test_persist_dashcam_stores_mapped_payload_with_event_types_filter(fake_client: _FakePersistenceClient) -> None:
    """Dashcam persist must include event_types_filter from profile in response_payload."""
    mappings = {"dashcam_event_profile": {"event_types": ["harsh_braking"], "event_id_field": "safetyEventId"}}
    record = {"eventId": "DEFAULT-EVT", "safetyEventId": "SE-42", "type": "harsh_braking", "eventMs": "2026-06-01T12:00:00Z"}

    samsara.samsara_persist_telemetry_batch(
        "tenant-a", "dashcam_events", [record], "2026-06-01T12:00:00Z", mappings
    )

    log_rows = fake_client.tables["integration_delivery_log"]
    response = log_rows[0].get("response_payload", {})
    assert response.get("event_id") == "SE-42"
    assert response.get("event_types_filter") == ["harsh_braking"], (
        "event_types from dashcam_event_profile must appear as event_types_filter in response_payload"
    )


def test_persist_with_no_mappings_stores_default_mapped_payload(fake_client: _FakePersistenceClient) -> None:
    """persist with mappings=None must still apply default scope mappings (no raw passthrough)."""
    record = {"vehicleId": "veh-1", "latitude": 37.7, "longitude": -122.4, "time": "2026-06-01T00:00:00Z"}

    samsara.samsara_persist_telemetry_batch(
        "tenant-a", "gps", [record], "2026-06-01T00:00:00Z", None
    )

    log_rows = fake_client.tables["integration_delivery_log"]
    response = log_rows[0].get("response_payload", {})
    # Default GPS mapping: asset_id comes from 'vehicleId'
    assert response.get("asset_id") == "veh-1"
    assert "lat" in response
    assert "lon" in response
    assert "ts" in response
