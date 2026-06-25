"""Vendored shared URL-safety behavior used by ma-app agent tools."""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse


def _is_unsafe_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return any(
        (
            ip.is_private,
            ip.is_loopback,
            ip.is_link_local,
            ip.is_multicast,
            ip.is_reserved,
            ip.is_unspecified,
        )
    )


UNSAFE_HOST_SUFFIXES = (
    ".localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".home.arpa",
)


def is_safe_external_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    if not parsed.netloc:
        return False
    if parsed.username or parsed.password:
        return False
    try:
        _ = parsed.port
    except ValueError:
        return False

    hostname = parsed.hostname
    if hostname is None:
        return False

    normalized_hostname = hostname.rstrip(".").lower()
    if not normalized_hostname:
        return False
    if normalized_hostname.startswith("."):
        return False
    if ".." in normalized_hostname:
        return False
    if normalized_hostname in {"localhost", "127.0.0.1", "::1"}:
        return False
    if normalized_hostname.endswith(UNSAFE_HOST_SUFFIXES):
        return False

    try:
        ip = ipaddress.ip_address(normalized_hostname)
    except ValueError:
        return len(normalized_hostname.split(".")) >= 2
    return not _is_unsafe_ip(ip)
