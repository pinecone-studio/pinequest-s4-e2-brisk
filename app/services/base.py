"""Shared service interfaces."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterable, TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.camera_discovery import CameraDiscoveryResult


class BaseCameraDiscoveryService(ABC):
    """Interface for camera discovery implementations."""

    @abstractmethod
    def discover(self, targets: str | Iterable[str]) -> "CameraDiscoveryResult":
        """Scan targets and return structured discovery results."""
