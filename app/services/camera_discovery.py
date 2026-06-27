"""
Camera discovery service backed by Cameradar.

The service keeps Cameradar and Docker-specific behavior isolated so another
implementation, such as ONVIF discovery, can replace it behind the same shape.
"""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional
from urllib.parse import urlparse

from app.services.base import BaseCameraDiscoveryService

logger = logging.getLogger(__name__)


@dataclass
class CameraDiscoveryConfig:
    image: str = "ullaakut/cameradar:latest"
    output_filename: str = "cameradar-results.m3u"
    targets_filename: str = "cameradar-targets.txt"
    timeout_seconds: int = 300
    docker_network_mode: str = "host"
    docker_client: Optional[object] = None
    extra_args: List[str] = field(default_factory=list)


@dataclass
class DiscoveredCamera:
    host: str
    port: int
    rtsp_url: str
    path: str = ""
    username: Optional[str] = None
    password: Optional[str] = None
    raw_entry: Optional[str] = None


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

    @property
    def ok(self) -> bool:
        return not self.errors


class CameraDiscoveryService(BaseCameraDiscoveryService):
    def __init__(self, config: Optional[CameraDiscoveryConfig] = None):
        self.config = config or CameraDiscoveryConfig()

    def discover(self, targets: str | Iterable[str]) -> CameraDiscoveryResult:
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

        with tempfile.TemporaryDirectory(prefix="cameradar-") as output_dir:
            target_path = Path(output_dir) / self.config.targets_filename
            target_path.write_text("\n".join(normalized_targets))
            output_path = Path(output_dir) / self.config.output_filename
            try:
                raw_output = self._run_cameradar(output_dir)
            except Exception as exc:
                logger.warning("Camera discovery failed: %s", exc)
                return CameraDiscoveryResult(errors=[
                    CameraDiscoveryError(
                        code="docker_execution_failed",
                        message="Cameradar could not be executed through Docker.",
                        detail=str(exc),
                    )
                ])

            try:
                cameras = self._parse_output(output_path, raw_output)
            except ValueError as exc:
                logger.warning("Camera discovery parsing failed: %s", exc)
                return CameraDiscoveryResult(raw_output=raw_output, errors=[
                    CameraDiscoveryError(
                        code="parse_failed",
                        message="Cameradar output could not be parsed.",
                        detail=str(exc),
                    )
                ])

            return CameraDiscoveryResult(cameras=cameras, raw_output=raw_output)

    def _run_cameradar(self, output_dir: str) -> str:
        docker_module = None
        if self.config.docker_client is None:
            try:
                import docker as docker_module
            except ImportError as exc:
                raise RuntimeError(
                    "Docker Python SDK is not installed. Install the 'docker' package."
                ) from exc
            client = docker_module.from_env()
        else:
            client = self.config.docker_client

        container_output_path = f"/tmp/cameradar-output/{self.config.output_filename}"
        container_target_path = f"/tmp/cameradar-output/{self.config.targets_filename}"
        command = self._build_command(container_target_path, container_output_path)

        try:
            container = client.containers.run(
                self.config.image,
                command=command,
                stdout=True,
                stderr=True,
                detach=True,
                network_mode=self.config.docker_network_mode,
                volumes={
                    output_dir: {
                        "bind": "/tmp/cameradar-output",
                        "mode": "rw",
                    }
                },
            )
            wait_result = container.wait(timeout=self.config.timeout_seconds)
            output = container.logs(stdout=True, stderr=True)
            status_code = wait_result.get("StatusCode", 0)
            if status_code != 0:
                raise RuntimeError(
                    f"Cameradar exited with status {status_code}: {self._decode_bytes(output)}"
                )
        except Exception as exc:
            if docker_module and isinstance(exc, docker_module.errors.ContainerError):
                stderr = self._decode_bytes(getattr(exc, "stderr", b""))
                raise RuntimeError(stderr or str(exc)) from exc
            if docker_module and isinstance(exc, docker_module.errors.DockerException):
                raise RuntimeError(str(exc)) from exc
            raise
        finally:
            if "container" in locals():
                try:
                    container.remove(force=True)
                except Exception:
                    logger.debug("Could not remove Cameradar container", exc_info=True)

        return self._decode_bytes(output)

    def _build_command(self, target_path: str, output_path: str) -> List[str]:
        return [
            "--targets",
            target_path,
            "--output",
            output_path,
            *self.config.extra_args,
        ]

    def _parse_output(self, output_path: Path, raw_output: str) -> List[DiscoveredCamera]:
        text = output_path.read_text() if output_path.exists() else raw_output
        if not text.strip():
            return []

        cameras: List[DiscoveredCamera] = []
        for entry in self._extract_rtsp_entries(text):
            camera = self._parse_rtsp_url(entry)
            if camera is not None:
                cameras.append(camera)

        if "rtsp://" in text.lower() and not cameras:
            raise ValueError("RTSP entries were present but none were valid.")

        return cameras

    def _extract_rtsp_entries(self, text: str) -> List[str]:
        entries: List[str] = []
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            lower = stripped.lower()
            if lower.startswith("rtsp://"):
                entries.append(stripped)
            elif "rtsp://" in lower:
                entries.append(stripped[stripped.lower().index("rtsp://"):])
        return entries

    def _parse_rtsp_url(self, rtsp_url: str) -> Optional[DiscoveredCamera]:
        parsed = urlparse(rtsp_url)
        if parsed.scheme != "rtsp" or not parsed.hostname:
            return None

        try:
            port = parsed.port or 554
        except ValueError:
            return None

        path = parsed.path or ""
        if parsed.query:
            path = f"{path}?{parsed.query}"

        return DiscoveredCamera(
            host=parsed.hostname,
            port=port,
            rtsp_url=rtsp_url,
            path=path,
            username=parsed.username,
            password=parsed.password,
            raw_entry=rtsp_url,
        )

    def _normalize_targets(self, targets: str | Iterable[str]) -> List[str]:
        raw_targets = [targets] if isinstance(targets, str) else list(targets)
        normalized: List[str] = []
        for target in raw_targets:
            cleaned = str(target).strip()
            if not cleaned:
                continue
            normalized.append(cleaned)
        return normalized

    def _decode_bytes(self, value: bytes | str | None) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        return value.decode("utf-8", errors="replace")
