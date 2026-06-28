"""UniFi Site Manager API camera discovery."""

from __future__ import annotations

import json
import logging
from typing import Any, List, Optional
from urllib import error, parse, request

from app.services.camera_discovery import DiscoveredCamera

logger = logging.getLogger(__name__)

UNIFI_API_BASE_URL = "https://api.ui.com/v1"
UNIFI_RTSP_PORT = 7447


class UniFiApiService:
    def __init__(
        self,
        api_key: str,
        base_url: str = UNIFI_API_BASE_URL,
        timeout_seconds: float = 10.0,
    ):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def fetch_cameras(self) -> List[DiscoveredCamera]:
        try:
            payload = self._fetch_hosts_payload()
        except (OSError, error.URLError, json.JSONDecodeError, ValueError) as exc:
            logger.warning("UniFi camera discovery failed: %s", exc)
            return []

        try:
            return self._parse_cameras(payload)
        except ValueError as exc:
            logger.warning("UniFi camera discovery failed: %s", exc)
            return []

    def _fetch_hosts_payload(self) -> Any:
        api_request = request.Request(
            f"{self.base_url}/hosts",
            headers={
                "Accept": "application/json",
                "X-API-Key": self.api_key,
            },
            method="GET",
        )
        with request.urlopen(api_request, timeout=self.timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))

    def _parse_cameras(self, payload: Any) -> List[DiscoveredCamera]:
        cameras: List[DiscoveredCamera] = []
        for host_entry in self._extract_hosts(payload):
            host_address = self._first_string(
                host_entry,
                "ip",
                "ipAddress",
                "address",
                "hostname",
                "name",
            )
            for device in self._extract_devices(host_entry):
                if not self._is_camera_device(device):
                    continue

                rtsp_url = self._first_string(device, "rtsp_url", "rtspUrl", "streamUrl")
                parsed_url = parse.urlparse(rtsp_url) if rtsp_url else None
                camera_address = self._first_string(
                    device,
                    "ip",
                    "ipAddress",
                    "address",
                    "host",
                    "hostname",
                    "name",
                ) or (parsed_url.hostname if parsed_url else None) or host_address
                if not camera_address:
                    continue

                port = UNIFI_RTSP_PORT
                path = ""
                if rtsp_url:
                    port = parsed_url.port or UNIFI_RTSP_PORT
                    path = parsed_url.path or ""
                    if parsed_url.query:
                        path = f"{path}?{parsed_url.query}"
                else:
                    rtsp_url = f"rtsp://{camera_address}:{UNIFI_RTSP_PORT}"

                cameras.append(
                    DiscoveredCamera(
                        host=camera_address,
                        port=port,
                        rtsp_url=rtsp_url,
                        path=path,
                        raw_entry=rtsp_url,
                        model=self._camera_model(device),
                        rtsp_route=path or None,
                        is_accessible=True,
                    )
                )

        return cameras

    def _extract_hosts(self, payload: Any) -> List[dict[str, Any]]:
        if isinstance(payload, list):
            return [entry for entry in payload if isinstance(entry, dict)]
        if not isinstance(payload, dict):
            return []

        for key in ("hosts", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                return [entry for entry in value if isinstance(entry, dict)]

        return []

    def _extract_devices(self, host_entry: dict[str, Any]) -> List[dict[str, Any]]:
        for key in ("devices", "protectDevices", "cameras"):
            value = host_entry.get(key)
            if isinstance(value, list):
                return [entry for entry in value if isinstance(entry, dict)]
        return []

    def _is_camera_device(self, device: dict[str, Any]) -> bool:
        searchable_values = [
            self._first_string(device, "type", "deviceType", "category", "productLine"),
            self._camera_model(device),
            self._first_string(device, "name", "displayName"),
        ]
        normalized_values = [value.lower() for value in searchable_values if value]
        return any(
            "camera" in value or value.startswith("uvc")
            for value in normalized_values
        )

    def _camera_model(self, device: dict[str, Any]) -> str:
        return (
            self._first_string(device, "model", "modelKey", "productName", "name")
            or "UniFi Camera"
        )

    def _first_string(self, entry: dict[str, Any], *keys: str) -> Optional[str]:
        for key in keys:
            value = entry.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None
