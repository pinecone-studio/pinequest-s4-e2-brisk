"""In-memory state management for camera discovery scans."""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Iterable, List, Literal, Optional

from app.services.base import BaseCameraDiscoveryService
from app.services.camera_discovery import (
    CameraDiscoveryConfig,
    CameraDiscoveryError,
    CameraDiscoveryResult,
    CameraDiscoveryService,
    DiscoveredCamera,
)

logger = logging.getLogger(__name__)

ScanStatus = Literal["running", "completed", "failed", "timeout"]


@dataclass
class CameraDiscoveryScanState:
    scan_id: Optional[str] = None
    status: ScanStatus = "completed"
    discovered_cameras: List[DiscoveredCamera] = field(default_factory=list)
    errors: List[CameraDiscoveryError] = field(default_factory=list)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None

    def to_dict(self) -> dict:
        return {
            "scan_id": self.scan_id,
            "status": self.status,
            "discovered_cameras": [asdict(camera) for camera in self.discovered_cameras],
            "errors": [asdict(error) for error in self.errors],
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }


class CameraDiscoveryScanManager:
    def __init__(
        self,
        discovery_service: Optional[BaseCameraDiscoveryService] = None,
        timeout_seconds: Optional[int] = None,
    ):
        self.discovery_service = discovery_service or CameraDiscoveryService()
        self.timeout_seconds = (
            timeout_seconds
            if timeout_seconds is not None
            else getattr(self.discovery_service, "config", CameraDiscoveryConfig()).timeout_seconds
        )
        self._state = CameraDiscoveryScanState()
        self._lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None

    async def start_scan(self, targets: str | Iterable[str]) -> CameraDiscoveryScanState:
        async with self._lock:
            if self._state.status == "running" and self._task and not self._task.done():
                return self._state

            scan_id = str(uuid.uuid4())
            self._state = CameraDiscoveryScanState(
                scan_id=scan_id,
                status="running",
                started_at=self._now(),
            )
            self._task = asyncio.create_task(self._run_scan(scan_id, targets))
            return self._state

    async def get_state(self) -> CameraDiscoveryScanState:
        async with self._lock:
            return self._state

    async def _run_scan(self, scan_id: str, targets: str | Iterable[str]) -> None:
        loop = asyncio.get_running_loop()

        def on_progress(cameras: List[DiscoveredCamera]) -> None:
            asyncio.run_coroutine_threadsafe(
                self._update_running_results(scan_id, cameras),
                loop,
            )

        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    self.discovery_service.discover,
                    targets,
                    on_progress=on_progress,
                ),
                timeout=self.timeout_seconds,
            )
        except asyncio.TimeoutError:
            await self._finish(
                scan_id,
                "timeout",
                CameraDiscoveryResult(errors=[
                    CameraDiscoveryError(
                        code="scan_timeout",
                        message="Camera discovery scan timed out.",
                        detail=f"Exceeded {self.timeout_seconds} seconds.",
                    )
                ]),
            )
        except Exception as exc:
            logger.exception("Camera discovery scan failed")
            await self._finish(
                scan_id,
                "failed",
                CameraDiscoveryResult(errors=[
                    CameraDiscoveryError(
                        code="scan_failed",
                        message="Camera discovery scan failed.",
                        detail=str(exc),
                    )
                ]),
            )
        else:
            status: ScanStatus = "failed" if result.errors else "completed"
            logger.info(
                "Camera discovery scan %s finished with status=%s cameras=%d",
                scan_id,
                status,
                len(result.cameras),
            )
            await self._finish(scan_id, status, result)

    async def _update_running_results(
        self,
        scan_id: str,
        cameras: List[DiscoveredCamera],
    ) -> None:
        async with self._lock:
            if self._state.scan_id != scan_id or self._state.status != "running":
                return
            self._state.discovered_cameras = cameras

    async def _finish(
        self,
        scan_id: str,
        status: ScanStatus,
        result: CameraDiscoveryResult,
    ) -> None:
        async with self._lock:
            if self._state.scan_id != scan_id:
                return
            self._state.status = status
            self._state.discovered_cameras = result.cameras
            self._state.errors = result.errors
            self._state.finished_at = self._now()

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)
