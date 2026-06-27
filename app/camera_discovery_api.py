"""REST endpoints for asynchronous camera discovery."""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import subprocess
from pathlib import Path
from typing import List, Literal, Optional
from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services.camera_discovery_state import CameraDiscoveryScanManager

router = APIRouter(prefix="/api/cameras/discovery", tags=["Camera Discovery"])
scan_manager = CameraDiscoveryScanManager(timeout_seconds=300)


class DiscoveryStartRequest(BaseModel):
    targets: Optional[List[str]] = Field(
        default=None,
        description="Optional Cameradar targets such as IPs, CIDR ranges, hostnames, or ranges.",
    )


class DiscoveryStartResponse(BaseModel):
    scan_id: str
    status: Literal["running"]
    message: str


class DiscoverySubnetResponse(BaseModel):
    subnet: str


class DiscoveredCameraResponse(BaseModel):
    host: str
    port: int
    rtsp_url: str
    path: str = ""
    username: Optional[str] = None
    password: Optional[str] = None
    raw_entry: Optional[str] = None


class CameraDiscoveryErrorResponse(BaseModel):
    code: str
    message: str
    detail: Optional[str] = None


class DiscoveryResultsResponse(BaseModel):
    scan_id: Optional[str] = None
    status: Literal["running", "completed", "failed", "timeout"]
    discovered_cameras: List[DiscoveredCameraResponse] = Field(default_factory=list)
    errors: List[CameraDiscoveryErrorResponse] = Field(default_factory=list)
    started_at: Optional[str] = None
    finished_at: Optional[str] = None


@router.post(
    "/start",
    response_model=DiscoveryStartResponse,
    summary="Start an asynchronous camera discovery scan",
)
async def start_camera_discovery(
    request: Optional[DiscoveryStartRequest] = None,
) -> DiscoveryStartResponse:
    """
    Start a background camera discovery scan.

    If another scan is already running, this returns the existing running scan
    instead of starting a duplicate. Targets may be supplied in the request body;
    otherwise the API uses CAMERA_DISCOVERY_TARGETS or derives local /24 targets
    from configured camera hosts.
    """
    targets = _resolve_targets(request.targets if request else None)
    state = await scan_manager.start_scan(targets)
    return DiscoveryStartResponse(
        scan_id=state.scan_id or "",
        status="running",
        message="Camera discovery scan is running.",
    )


@router.get(
    "/subnet",
    response_model=DiscoverySubnetResponse,
    summary="Get the local network subnet",
)
async def get_camera_discovery_subnet() -> DiscoverySubnetResponse:
    """
    Detect the local network subnet used for camera discovery.
    """
    return DiscoverySubnetResponse(subnet=_detect_local_subnet())


@router.get(
    "/results",
    response_model=DiscoveryResultsResponse,
    summary="Get the latest camera discovery scan state",
)
async def get_camera_discovery_results() -> DiscoveryResultsResponse:
    """
    Return the latest scan state, including discovered RTSP cameras, structured
    errors, and scan timestamps when available.
    """
    state = await scan_manager.get_state()
    return DiscoveryResultsResponse(**state.to_dict())


def _resolve_targets(request_targets: Optional[List[str]]) -> List[str]:
    if request_targets:
        return request_targets

    env_targets = os.getenv("CAMERA_DISCOVERY_TARGETS")
    if env_targets:
        return [target.strip() for target in env_targets.split(",") if target.strip()]

    return _targets_from_camera_config()


def _targets_from_camera_config(path: str = "cameras.json") -> List[str]:
    config_path = Path(path)
    if not config_path.exists():
        return []

    try:
        config = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError):
        return []

    targets = set()
    for camera in config.get("cameras", []):
        host = camera.get("host") or camera.get("ip")
        if not host:
            continue
        try:
            network = ipaddress.ip_network(f"{host}/24", strict=False)
        except ValueError:
            continue
        targets.add(str(network))

    return sorted(targets)


def _detect_local_subnet() -> str:
    local_ip = _detect_local_ip()
    network = ipaddress.ip_network(f"{local_ip}/24", strict=False)
    return str(network)


def _detect_local_ip() -> str:
    local_ip = _detect_local_ip_from_default_route()
    if local_ip:
        return local_ip

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            local_ip = sock.getsockname()[0]
    except OSError:
        local_ip = socket.gethostbyname(socket.gethostname())

    if local_ip.startswith("127."):
        raise RuntimeError("Could not detect a non-loopback local IP address.")

    return local_ip


def _detect_local_ip_from_default_route() -> Optional[str]:
    try:
        route_output = subprocess.check_output(
            ["route", "-n", "get", "default"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None

    interface = None
    for line in route_output.splitlines():
        stripped = line.strip()
        if stripped.startswith("interface:"):
            interface = stripped.split(":", 1)[1].strip()
            break

    if not interface:
        return None

    try:
        local_ip = subprocess.check_output(
            ["ipconfig", "getifaddr", interface],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
        ).strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None

    if local_ip and not local_ip.startswith("127."):
        return local_ip

    return None
