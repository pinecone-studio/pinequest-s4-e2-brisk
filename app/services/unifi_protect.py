"""UniFi Protect local API RTSP management."""

from __future__ import annotations

import json
import logging
import ssl
from http.cookies import SimpleCookie
from typing import Any, List, Optional
from urllib import error, request

logger = logging.getLogger(__name__)


class UniFiProtectService:
    def __init__(
        self,
        host: str,
        username: str,
        password: str,
        timeout_seconds: float = 10.0,
        verify_ssl: bool = False,
    ):
        self.base_url = self._build_base_url(host)
        self.username = username
        self.password = password
        self.timeout_seconds = timeout_seconds
        self.ssl_context = None if verify_ssl else ssl._create_unverified_context()

    def enable_rtsp_on_cameras(self) -> int:
        try:
            token = self._login()
            cameras = self._fetch_cameras(token)
        except (OSError, error.URLError, json.JSONDecodeError, ValueError) as exc:
            logger.warning("UniFi Protect RTSP enable failed: %s", exc)
            return 0

        enabled_count = 0
        for camera in cameras:
            camera_id = self._camera_id(camera)
            if not camera_id:
                continue
            try:
                self._enable_camera_rtsp(token, camera_id)
            except (OSError, error.URLError, json.JSONDecodeError, ValueError) as exc:
                logger.warning("UniFi Protect RTSP enable failed for camera %s: %s", camera_id, exc)
                continue
            enabled_count += 1

        return enabled_count

    def _login(self) -> str:
        login_payload = json.dumps({
            "username": self.username,
            "password": self.password,
        }).encode("utf-8")
        login_request = request.Request(
            f"{self.base_url}/api/auth/login",
            data=login_payload,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with request.urlopen(
            login_request,
            timeout=self.timeout_seconds,
            context=self.ssl_context,
        ) as response:
            cookie_header = response.headers.get("Set-Cookie")

        token = self._token_from_cookie(cookie_header)
        if not token:
            raise ValueError("UniFi Protect login did not return a TOKEN cookie.")
        return token

    def _fetch_cameras(self, token: str) -> List[dict[str, Any]]:
        cameras_request = request.Request(
            f"{self.base_url}/proxy/protect/api/cameras",
            headers=self._authenticated_headers(token),
            method="GET",
        )
        with request.urlopen(
            cameras_request,
            timeout=self.timeout_seconds,
            context=self.ssl_context,
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))

        if isinstance(payload, list):
            return [camera for camera in payload if isinstance(camera, dict)]
        if isinstance(payload, dict):
            data = payload.get("data")
            if isinstance(data, list):
                return [camera for camera in data if isinstance(camera, dict)]
        return []

    def _enable_camera_rtsp(self, token: str, camera_id: str) -> None:
        patch_payload = json.dumps({"rtspAlias": "enabled"}).encode("utf-8")
        patch_request = request.Request(
            f"{self.base_url}/proxy/protect/api/cameras/{camera_id}",
            data=patch_payload,
            headers=self._authenticated_headers(token),
            method="PATCH",
        )
        with request.urlopen(
            patch_request,
            timeout=self.timeout_seconds,
            context=self.ssl_context,
        ) as response:
            response.read()

    def _authenticated_headers(self, token: str) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Cookie": f"TOKEN={token}",
        }

    def _token_from_cookie(self, cookie_header: Optional[str]) -> Optional[str]:
        if not cookie_header:
            return None

        cookies = SimpleCookie()
        cookies.load(cookie_header)
        token = cookies.get("TOKEN")
        if not token:
            return None
        return token.value

    def _camera_id(self, camera: dict[str, Any]) -> Optional[str]:
        for key in ("id", "_id"):
            value = camera.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    def _build_base_url(self, host: str) -> str:
        cleaned_host = host.strip().rstrip("/")
        if cleaned_host.startswith("http://") or cleaned_host.startswith("https://"):
            return cleaned_host
        return f"https://{cleaned_host}"
