"""Pure Python camera discovery using nmap and RTSP DESCRIBE probes."""

from __future__ import annotations

import logging
import os
import socket
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable, List, Optional, Sequence

from app.services.base import BaseCameraDiscoveryService

try:
    import nmap
except ImportError:  # pragma: no cover - exercised only when dependency is missing.
    class _MissingNmap:
        def PortScanner(self):
            raise RuntimeError("python-nmap is not installed. Run 'pip3 install python-nmap'.")

    nmap = _MissingNmap()

logger = logging.getLogger(__name__)

SCAN_PORTS = [554, 7447, 8554]
PING_SWEEP_ARGUMENTS = "-sn -n -T5"
# python-nmap expects full paths to the nmap *binary*, not directories.
NMAP_SEARCH_PATH = [
    "nmap",
    "/opt/homebrew/bin/nmap",
    "/usr/local/bin/nmap",
    "/usr/bin/nmap",
]

RTSP_ROUTES = [
    "/stream1",
    "/stream2",
    "/live",
    "/live.sdp",
    "/h264/ch1/main/av_stream",
    "/Streaming/Channels/1",
    "/cam/realmonitor?channel=1&subtype=0",
    "/h264Preview_01_main",
    "/onvif/device_service",
    "/MediaInput/h264",
    "/video.h264",
]

DEFAULT_CREDENTIALS = [
    ("admin", "admin"),
    ("admin", "12345"),
    ("admin", ""),
    ("root", "root"),
    ("admin", "admin123"),
]


@dataclass
class CameraDiscoveryConfig:
    timeout_seconds: int = 300
    scan_ports: List[int] = field(default_factory=lambda: SCAN_PORTS.copy())
    rtsp_routes: List[str] = field(default_factory=lambda: RTSP_ROUTES.copy())
    credentials: List[tuple[str, str]] = field(default_factory=lambda: DEFAULT_CREDENTIALS.copy())
    probe_timeout_seconds: float = 1.0
    probe_rtsp: bool = False


@dataclass
class DiscoveredCamera:
    host: str
    port: int
    rtsp_url: str
    path: str = ""
    username: Optional[str] = None
    password: Optional[str] = None
    raw_entry: Optional[str] = None
    model: str = "Unknown"
    rtsp_route: Optional[str] = None
    is_accessible: bool = False


@dataclass
class CameraDiscoveryError:
    code: str
    message: str
    detail: Optional[str] = None


@dataclass
class CameraDiscoveryResult:
    cameras: List[DiscoveredCamera] = field(default_factory=list)
    errors: List[CameraDiscoveryError] = field(default_factory=list)
    raw_output: str = ""
    scan_duration_seconds: float = 0.0
    target_subnet: str = ""
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return not self.errors and self.error is None


DiscoveryResult = CameraDiscoveryResult


class CameraDiscoveryService(BaseCameraDiscoveryService):
    def __init__(self, config: Optional[CameraDiscoveryConfig] = None):
        self.config = config or CameraDiscoveryConfig()

    def discover(
        self,
        targets: str | Iterable[str],
        ports: Optional[Sequence[int]] = None,
        on_progress: Optional[Callable[[List[DiscoveredCamera]], None]] = None,
    ) -> CameraDiscoveryResult:
        start_time = time.time()
        try:
            normalized_targets = self._normalize_targets(targets)
        except ValueError as exc:
            return CameraDiscoveryResult(errors=[
                CameraDiscoveryError(
                    code="invalid_targets",
                    message="Discovery targets must be non-empty strings.",
                    detail=str(exc),
                )
            ])

        if not normalized_targets:
            return CameraDiscoveryResult(errors=[
                CameraDiscoveryError(
                    code="invalid_targets",
                    message="At least one discovery target is required.",
                )
            ])

        scan_ports = list(ports or self.config.scan_ports)
        cameras: List[DiscoveredCamera] = []
        raw_outputs: List[str] = []

        try:
            for target in normalized_targets:
                target_cameras, raw_output = self._scan_target(target, scan_ports)
                cameras.extend(target_cameras)
                if raw_output:
                    raw_outputs.append(raw_output)
                if on_progress:
                    on_progress(list(cameras))

            unifi_cameras = self._fetch_unifi_cameras()
            if unifi_cameras:
                cameras.extend(unifi_cameras)
                if on_progress:
                    on_progress(list(cameras))
        except Exception as exc:
            logger.warning("Camera discovery failed: %s", exc)
            message = str(exc)
            return CameraDiscoveryResult(
                errors=[
                    CameraDiscoveryError(
                        code="nmap_scan_failed",
                        message="Camera discovery scan failed.",
                        detail=message,
                    )
                ],
                raw_output="\n".join(raw_outputs),
                scan_duration_seconds=round(time.time() - start_time, 2),
                target_subnet=", ".join(normalized_targets),
                error=message,
            )

        return CameraDiscoveryResult(
            cameras=cameras,
            raw_output="\n".join(raw_outputs),
            scan_duration_seconds=round(time.time() - start_time, 2),
            target_subnet=", ".join(normalized_targets),
        )

    def _scan_target(
        self,
        target: str,
        ports: Sequence[int],
    ) -> tuple[List[DiscoveredCamera], str]:
        scanner = nmap.PortScanner(nmap_search_path=NMAP_SEARCH_PATH)
        port_str = ",".join(str(port) for port in ports)
        sweep_output = scanner.scan(hosts=target, arguments=PING_SWEEP_ARGUMENTS)
        live_hosts = scanner.all_hosts()
        logging.warning(f"Found hosts: {live_hosts}")
        if not live_hosts:
            return [], str(sweep_output)

        port_scan_arguments = f"-p {port_str} --open -n -sT"
        raw_output = scanner.scan(
            hosts=" ".join(live_hosts),
            arguments=port_scan_arguments,
        )
        port_scan_hosts = scanner.all_hosts()
        logging.warning(f"Port scan hosts: {port_scan_hosts}")

        cameras: List[DiscoveredCamera] = []
        for host in port_scan_hosts:
            host_entry = scanner[host]
            found_ports = [
                port
                for port in ports
                if host_entry.has_tcp(port) and host_entry["tcp"][port].get("state") == "open"
            ]
            logging.warning(f"Found ports for {host}: {found_ports}")
            for port in ports:
                if not host_entry.has_tcp(port):
                    continue

                tcp_entry = host_entry["tcp"][port]
                if tcp_entry.get("state") != "open":
                    continue

                if self.config.probe_rtsp:
                    route, username, password = self._probe_rtsp(host, port)
                else:
                    route, username, password = None, None, None

                rtsp_url = self._build_rtsp_url(host, port, route, username, password)
                cameras.append(
                    DiscoveredCamera(
                        host=host,
                        port=port,
                        rtsp_url=rtsp_url,
                        path=route or "",
                        username=username,
                        password=password,
                        raw_entry=rtsp_url,
                        model=tcp_entry.get("product") or "Unknown",
                        rtsp_route=route,
                        is_accessible=route is not None,
                    )
                )

        return cameras, "\n".join([str(sweep_output), str(raw_output)])

    def _fetch_unifi_cameras(self) -> List[DiscoveredCamera]:
        api_key = os.getenv("UNIFI_API_KEY")
        if not api_key:
            return []

        try:
            from app.services.unifi_api import UniFiApiService

            return UniFiApiService(api_key=api_key).fetch_cameras()
        except Exception as exc:
            logger.warning("UniFi camera discovery failed: %s", exc)
            return []

    def _probe_rtsp(
        self,
        host: str,
        port: int,
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        for route in self.config.rtsp_routes:
            for username, password in self.config.credentials:
                try:
                    with socket.create_connection(
                        (host, port),
                        timeout=self.config.probe_timeout_seconds,
                    ) as connection:
                        request = (
                            f"DESCRIBE rtsp://{username}:{password}@{host}:{port}{route} RTSP/1.0\r\n"
                            "CSeq: 1\r\n"
                            "User-Agent: PineQuest/1.0\r\n\r\n"
                        )
                        connection.sendall(request.encode("utf-8"))
                        response = connection.recv(1024).decode(errors="ignore")
                except OSError:
                    continue

                if "200 OK" in response:
                    return route, username, password

        return None, None, None

    def _build_rtsp_url(
        self,
        host: str,
        port: int,
        route: Optional[str],
        username: Optional[str],
        password: Optional[str],
    ) -> str:
        if route is None:
            return f"rtsp://{host}:{port}"

        credentials = ""
        if username is not None:
            credentials = f"{username}:{password or ''}@"

        return f"rtsp://{credentials}{host}:{port}{route}"

    def _normalize_targets(self, targets: str | Iterable[str]) -> List[str]:
        raw_targets = [targets] if isinstance(targets, str) else list(targets)
        normalized: List[str] = []
        for target in raw_targets:
            cleaned = str(target).strip()
            if not cleaned:
                continue
            normalized.append(cleaned)
        return normalized
