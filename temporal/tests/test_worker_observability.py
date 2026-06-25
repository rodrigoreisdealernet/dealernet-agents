"""Regression tests for Temporal worker Prometheus observability wiring.

These tests guard the alignment between the worker's Prometheus bind address
and the Helm chart values so that metrics exposure / config drift is caught
before merge (issue #828 follow-up).
"""
from __future__ import annotations

import inspect

from temporal.src import worker

# ---------------------------------------------------------------------------
# Metrics bind-address alignment
# ---------------------------------------------------------------------------

# The chart value `observability.metrics.workerPort` is set to 9000 in
# values.yaml and is used for the temporal-worker-metrics Service and
# ServiceMonitor.  The worker must expose Prometheus on the same port.
_EXPECTED_WORKER_METRICS_PORT = 9000


def test_metrics_bind_address_is_nonempty_string() -> None:
    """_METRICS_BIND_ADDRESS must be a non-empty string."""
    assert isinstance(worker._METRICS_BIND_ADDRESS, str)
    assert worker._METRICS_BIND_ADDRESS, "_METRICS_BIND_ADDRESS must not be empty"


def test_metrics_bind_address_contains_expected_port() -> None:
    """Worker metrics must be exposed on port 9000 to match chart values.

    Keep in sync with `observability.metrics.workerPort` in charts/app/values.yaml.
    """
    host, _, port_str = worker._METRICS_BIND_ADDRESS.rpartition(":")
    assert host, f"Expected '<host>:<port>' format, got: {worker._METRICS_BIND_ADDRESS!r}"
    assert port_str.isdigit(), (
        f"Port segment must be numeric, got: {port_str!r} from {worker._METRICS_BIND_ADDRESS!r}"
    )
    actual_port = int(port_str)
    assert actual_port == _EXPECTED_WORKER_METRICS_PORT, (
        f"Worker metrics port {actual_port} does not match chart value "
        f"observability.metrics.workerPort={_EXPECTED_WORKER_METRICS_PORT}. "
        "Update worker._METRICS_BIND_ADDRESS or the chart values to re-align."
    )


def test_metrics_bind_address_listens_on_all_interfaces() -> None:
    """Worker must bind on 0.0.0.0 so Prometheus can scrape from any pod IP."""
    host, _, _ = worker._METRICS_BIND_ADDRESS.rpartition(":")
    assert host == "0.0.0.0", (
        f"Worker metrics must bind on 0.0.0.0 (got {host!r}) so the "
        "temporal-worker-metrics Service can route scrape traffic."
    )


def test_main_wires_prometheus_config_with_metrics_bind_address() -> None:
    """worker.main() must pass _METRICS_BIND_ADDRESS into PrometheusConfig.

    This guards against the bind address constant being defined but not actually
    threaded through to the Temporal SDK Runtime telemetry configuration.
    """
    source = inspect.getsource(worker.main)
    assert "PrometheusConfig" in source, (
        "worker.main() must instantiate PrometheusConfig to expose metrics"
    )
    assert "TelemetryConfig" in source, (
        "worker.main() must pass TelemetryConfig to Runtime"
    )
    assert "_METRICS_BIND_ADDRESS" in source, (
        "worker.main() must use _METRICS_BIND_ADDRESS when constructing PrometheusConfig"
    )

