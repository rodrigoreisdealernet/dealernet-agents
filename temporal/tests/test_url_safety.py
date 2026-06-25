from __future__ import annotations

import pytest
from temporal.src.agents.tools.url_safety import is_safe_external_url as is_safe_external_url_from_tools
from temporal.src.agents.url_safety import is_safe_external_url


def test_tools_url_safety_re_exports_shared_agent_path() -> None:
    assert is_safe_external_url_from_tools is is_safe_external_url


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/feed",
        "https:///feed",
        "https://user@example.com/feed",
        "https://localhost/feed",
        "https://localhost./feed",
        "https://localhost../feed",
        "https://LocalHost./feed",
        "https://LOCALHOST./feed",
        "https://api.localhost/feed",
        "https://api.localhost./feed",
        "https://asset.local/feed",
        "https://asset.internal/feed",
        "https://asset.home.arpa/feed",
        "https://.localhost/feed",
        "https://.example.com/feed",
        "https://local..host/feed",
        "https://example..com/feed",
        "https://example:99999/feed",
        "https://example/feed",
        "https://127.0.0.1/feed",
        "https://127.0.0.1./feed",
        "https://[::1]/feed",
        "https://[::1]./feed",
        "https://10.0.0.1/feed",
        "https://[fd00::1]/feed",
        "https://169.254.10.20/feed",
        "https://[fe80::1]/feed",
        "https://224.0.0.1/feed",
        "https://[ff02::1]/feed",
        "https://240.0.0.1/feed",
        "https://[::]/feed",
        "https://0.0.0.0/feed",
    ],
)
def test_is_safe_external_url_rejects_unsafe_urls(url: str) -> None:
    assert is_safe_external_url(url) is False


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/feed",
        "https://8.8.8.8/feed",
        "https://[2001:4860:4860::8888]/feed",
    ],
)
def test_is_safe_external_url_allows_safe_urls(url: str) -> None:
    assert is_safe_external_url(url) is True
