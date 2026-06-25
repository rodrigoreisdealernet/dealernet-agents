from __future__ import annotations

import datetime
from unittest.mock import patch

from temporal.src.activities.ops_dispatch_snapshot import (
    SOURCE_GAP_CONFLICTED_TIME_WINDOW,
    SOURCE_GAP_MISSING_ASSET_READINESS,
    SOURCE_GAP_MISSING_DRIVER_HOS,
    SOURCE_GAP_MISSING_ROUTE,
    SOURCE_GAP_MISSING_TELEMATICS,
    SOURCE_GAP_STALE_DRIVER_HOS,
    SOURCE_GAP_STALE_TELEMATICS,
    _detect_source_gaps,
    _is_stale,
    _item_finding_for_storage,
    build_dispatch_scope_fingerprint,
    ops_dispatch_snapshot_scope,
)

_TENANT_ID = 'tenant-1'
_BRANCH_ID = 'branch-1'
_ORDER_ID = 'order-1'
_ASSET_ID = 'asset-1'
_DRIVER_ID = 'driver-1'
_VEHICLE_ID = 'vehicle-1'
_ROUTE_ID = 'route-1'
_NOW = datetime.datetime.now(datetime.UTC)
_RECENT = (_NOW - datetime.timedelta(minutes=20)).isoformat()
_STALE_TELEMATICS = (_NOW - datetime.timedelta(hours=3)).isoformat()
_STALE_HOS = (_NOW - datetime.timedelta(hours=5)).isoformat()


def _dispatch_row(*, asset_id: str = _ASSET_ID, driver_id: str = _DRIVER_ID, route_id: str = _ROUTE_ID, status: str = 'open') -> dict:
    return {
        'entity_id': 'dispatch-1',
        'name': 'Dispatch 1',
        'entity_type': 'dispatch_record',
        'data': {
            'status': status,
            'dispatch_type': 'delivery',
            'order_id': _ORDER_ID,
            'contract_id': 'contract-1',
            'asset_id': asset_id,
            'driver_id': driver_id,
            'route_id': route_id,
            'time_window_start': '2026-06-20T09:00:00+00:00',
            'time_window_end': '2026-06-20T12:00:00+00:00',
        },
        'updated_at': _RECENT,
    }


def _asset_row(*, operational_status: str = 'ready_for_dispatch') -> dict:
    return {
        'entity_id': _ASSET_ID,
        'name': 'Asset 1',
        'entity_type': 'asset',
        'data': {'operational_status': operational_status},
        'updated_at': _RECENT,
    }


def _driver_row() -> dict:
    return {
        'entity_id': _DRIVER_ID,
        'name': 'Driver 1',
        'entity_type': 'driver',
        'data': {'availability_status': 'available'},
        'updated_at': _RECENT,
    }


def _vehicle_row() -> dict:
    return {
        'entity_id': _VEHICLE_ID,
        'name': 'Truck 1',
        'entity_type': 'vehicle',
        'data': {'operational_status': 'available'},
        'updated_at': _RECENT,
    }


def _branch_row() -> dict:
    return {
        'entity_id': _BRANCH_ID,
        'name': 'Branch staging',
        'entity_type': 'branch_staging',
        'data': {'staging_status': 'ready'},
        'updated_at': _RECENT,
    }


def _telemetry_row(*, recorded_at: str = _RECENT) -> dict:
    return {
        'asset_id': _ASSET_ID,
        'lat': 32.7767,
        'lon': -96.797,
        'recorded_at': recorded_at,
        'updated_at': recorded_at,
    }


def _fact_row(entity_id: str, fact_type: str, value: dict, *, recorded_at: str = _RECENT) -> dict:
    return {
        'entity_id': entity_id,
        'fact_type': fact_type,
        'value': value,
        'recorded_at': recorded_at,
        'updated_at': recorded_at,
    }


class FakeClient:
    def __init__(self, *, dispatch=None, asset=None, telemetry=None, driver=None, vehicle=None, branch=None, facts=None):
        self.dispatch = dispatch or []
        self.asset = asset or []
        self.telemetry = telemetry or []
        self.driver = driver or []
        self.vehicle = vehicle or []
        self.branch = branch or []
        self.facts = facts or {}

    def select(self, resource: str, *, filters=None, **_kwargs):
        filters = filters or {}
        if resource == 'rental_current_entity_state':
            entity_type = filters.get('entity_type')
            entity_id = filters.get('entity_id')
            if entity_type == 'dispatch_record':
                return list(self.dispatch)
            if entity_type == 'asset':
                return [row for row in self.asset if row['entity_id'] == entity_id]
            if entity_type == 'driver':
                return list(self.driver)
            if entity_type == 'vehicle':
                return list(self.vehicle)
            if entity_type == 'branch_staging':
                if entity_id:
                    return [row for row in self.branch if row['entity_id'] == entity_id]
                return list(self.branch)
            if entity_type == 'branch':
                return [row for row in self.branch if row['entity_id'] == entity_id]
        if resource == 'rental_current_relationships':
            relationship_type = filters.get('relationship_type')
            parent_id = filters.get('parent_id')
            child_id = filters.get('child_id')
            valid = {
                ('branch_has_dispatch', _BRANCH_ID, 'dispatch-1'),
                ('branch_has_vehicle', _BRANCH_ID, _VEHICLE_ID),
                ('branch_has_driver', _BRANCH_ID, _DRIVER_ID),
            }
            return [{'parent_id': parent_id, 'child_id': child_id}] if (relationship_type, parent_id, child_id) in valid else []
        if resource == 'asset_telemetry_current':
            asset_id = filters.get('asset_id')
            return [row for row in self.telemetry if row['asset_id'] == asset_id]
        if resource == 'rental_current_facts':
            entity_id = filters.get('entity_id')
            return list(self.facts.get(entity_id, []))
        raise AssertionError(f'unexpected select call: {resource} {filters}')


def test_is_stale_handles_missing_old_and_recent_timestamps() -> None:
    assert _is_stale(None)
    assert _is_stale((_NOW - datetime.timedelta(hours=9)).isoformat())
    assert not _is_stale((_NOW - datetime.timedelta(minutes=30)).isoformat())


def test_detect_source_gaps_includes_missing_and_conflicted_inputs() -> None:
    gaps = _detect_source_gaps(
        has_telematics=False,
        telematics_updated_at=None,
        has_driver_hos=False,
        driver_hos_updated_at=None,
        has_route=False,
        has_asset_readiness=False,
        time_window_start='2026-06-20T12:00:00+00:00',
        time_window_end='2026-06-20T09:00:00+00:00',
    )
    assert set(gaps) == {
        SOURCE_GAP_MISSING_TELEMATICS,
        SOURCE_GAP_MISSING_DRIVER_HOS,
        SOURCE_GAP_MISSING_ROUTE,
        SOURCE_GAP_MISSING_ASSET_READINESS,
        SOURCE_GAP_CONFLICTED_TIME_WINDOW,
    }


def test_detect_source_gaps_includes_stale_markers() -> None:
    gaps = _detect_source_gaps(
        has_telematics=True,
        telematics_updated_at=_STALE_TELEMATICS,
        has_driver_hos=True,
        driver_hos_updated_at=_STALE_HOS,
        has_route=True,
        has_asset_readiness=True,
        time_window_start='2026-06-20T09:00:00+00:00',
        time_window_end='2026-06-20T12:00:00+00:00',
    )
    assert SOURCE_GAP_STALE_TELEMATICS in gaps
    assert SOURCE_GAP_STALE_DRIVER_HOS in gaps


def test_build_dispatch_scope_fingerprint_is_stable_and_order_independent() -> None:
    first = build_dispatch_scope_fingerprint(
        tenant_id=_TENANT_ID,
        branch_id=_BRANCH_ID,
        run_date='2026-06-20',
        order_ids=['b', 'a'],
        asset_ids=['truck-1', 'asset-1'],
        driver_ids=['driver-1', 'driver-2'],
    )
    second = build_dispatch_scope_fingerprint(
        tenant_id=_TENANT_ID,
        branch_id=_BRANCH_ID,
        run_date='2026-06-20',
        order_ids=['a', 'b', 'a'],
        asset_ids=['asset-1', 'truck-1'],
        driver_ids=['driver-2', 'driver-1'],
    )
    assert first == second
    assert len(first) == 16


def test_item_finding_for_storage_maps_dispatch_fields() -> None:
    finding = _item_finding_for_storage(
        {
            'item_id': 'dispatch-1',
            'item_type': 'open_delivery',
            'order_id': _ORDER_ID,
            'asset_id': _ASSET_ID,
            'priority': 'high',
            'recommendation': 'Call customer',
            'source_gaps': [SOURCE_GAP_MISSING_ROUTE],
        }
    )
    assert finding['contract_id'] == _ORDER_ID
    assert finding['line_item_id'] == _ASSET_ID
    assert finding['severity'] == 'high'
    assert finding['expected']['source_gaps'] == [SOURCE_GAP_MISSING_ROUTE]


def test_ops_dispatch_snapshot_scope_assembles_bounded_snapshot() -> None:
    client = FakeClient(
        dispatch=[_dispatch_row()],
        asset=[_asset_row()],
        telemetry=[_telemetry_row()],
        driver=[_driver_row()],
        vehicle=[_vehicle_row()],
        branch=[_branch_row()],
        facts={
            _DRIVER_ID: [_fact_row(_DRIVER_ID, 'driver_hos', {'hours_remaining': 8})],
            _ROUTE_ID: [_fact_row(_ROUTE_ID, 'planned_route', {'waypoints': 3})],
            _VEHICLE_ID: [_fact_row(_VEHICLE_ID, 'truck_capacity_lbs', {'max_lbs': 40000})],
        },
    )

    with patch('temporal.src.activities.ops_dispatch_snapshot.ops_revrec._get_ops_persistence_client', return_value=client):
        snapshot = ops_dispatch_snapshot_scope(_TENANT_ID, _BRANCH_ID, '2026-06-20')

    item_types = {item['item_type'] for item in snapshot['items']}
    assert item_types == {
        'open_delivery',
        'asset_readiness',
        'truck_capacity',
        'driver_hos',
        'branch_staging',
    }
    dispatch_item = next(item for item in snapshot['items'] if item['item_type'] == 'open_delivery')
    assert dispatch_item['location_latitude'] == 32.7767
    assert dispatch_item['asset_operational_status'] == 'ready_for_dispatch'
    assert dispatch_item['source_gaps'] == []
    assert snapshot['source_gaps'] == []
    assert snapshot['order_ids'] == [_ORDER_ID]
    assert snapshot['driver_ids'] == [_DRIVER_ID]
    assert snapshot['asset_ids'] == sorted({_ASSET_ID, _VEHICLE_ID})
    assert len(snapshot['fingerprint']) == 16


def test_ops_dispatch_snapshot_scope_surfaces_missing_and_conflicted_source_gaps() -> None:
    bad_dispatch = _dispatch_row(asset_id='', driver_id='', route_id='')
    bad_dispatch['data']['time_window_start'] = '2026-06-20T12:00:00+00:00'
    bad_dispatch['data']['time_window_end'] = '2026-06-20T09:00:00+00:00'
    client = FakeClient(
        dispatch=[bad_dispatch],
        branch=[_branch_row()],
        vehicle=[_vehicle_row()],
        driver=[],
        telemetry=[],
        facts={_VEHICLE_ID: [_fact_row(_VEHICLE_ID, 'truck_capacity_lbs', {'max_lbs': 40000})]},
    )

    with patch('temporal.src.activities.ops_dispatch_snapshot.ops_revrec._get_ops_persistence_client', return_value=client):
        snapshot = ops_dispatch_snapshot_scope(_TENANT_ID, _BRANCH_ID, '2026-06-20')

    dispatch_item = next(item for item in snapshot['items'] if item['item_type'] == 'open_delivery')
    assert set(dispatch_item['source_gaps']) == {
        SOURCE_GAP_MISSING_TELEMATICS,
        SOURCE_GAP_MISSING_DRIVER_HOS,
        SOURCE_GAP_MISSING_ROUTE,
        SOURCE_GAP_MISSING_ASSET_READINESS,
        SOURCE_GAP_CONFLICTED_TIME_WINDOW,
    }
    assert any(gap['item_type'] == 'open_delivery' for gap in snapshot['source_gaps'])


def test_ops_dispatch_snapshot_scope_surfaces_stale_telematics_and_hos() -> None:
    client = FakeClient(
        dispatch=[_dispatch_row()],
        asset=[_asset_row()],
        telemetry=[_telemetry_row(recorded_at=_STALE_TELEMATICS)],
        driver=[_driver_row()],
        vehicle=[_vehicle_row()],
        branch=[_branch_row()],
        facts={
            _DRIVER_ID: [_fact_row(_DRIVER_ID, 'driver_hos', {'hours_remaining': 2}, recorded_at=_STALE_HOS)],
            _ROUTE_ID: [_fact_row(_ROUTE_ID, 'planned_route', {'waypoints': 3})],
            _VEHICLE_ID: [_fact_row(_VEHICLE_ID, 'truck_capacity_lbs', {'max_lbs': 40000})],
        },
    )

    with patch('temporal.src.activities.ops_dispatch_snapshot.ops_revrec._get_ops_persistence_client', return_value=client):
        snapshot = ops_dispatch_snapshot_scope(_TENANT_ID, _BRANCH_ID, '2026-06-20')

    dispatch_item = next(item for item in snapshot['items'] if item['item_type'] == 'open_delivery')
    driver_item = next(item for item in snapshot['items'] if item['item_type'] == 'driver_hos')
    asset_item = next(item for item in snapshot['items'] if item['item_type'] == 'asset_readiness')
    assert SOURCE_GAP_STALE_TELEMATICS in dispatch_item['source_gaps']
    assert SOURCE_GAP_STALE_DRIVER_HOS in dispatch_item['source_gaps']
    assert SOURCE_GAP_STALE_DRIVER_HOS in driver_item['source_gaps']
    assert SOURCE_GAP_STALE_TELEMATICS in asset_item['source_gaps']
