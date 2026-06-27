import asyncio
import unittest

from app.services.camera_discovery import (
    CameraDiscoveryError,
    CameraDiscoveryResult,
    DiscoveredCamera,
)
from app.services.camera_discovery_state import CameraDiscoveryScanManager


class FakeDiscoveryService:
    def __init__(self, result=None, delay=0):
        self.result = result or CameraDiscoveryResult()
        self.delay = delay
        self.calls = 0

    def discover(self, targets):
        self.calls += 1
        if self.delay:
            asyncio.run(asyncio.sleep(self.delay))
        return self.result


class CameraDiscoveryScanManagerTest(unittest.IsolatedAsyncioTestCase):
    async def test_scan_completes_with_discovered_cameras(self):
        service = FakeDiscoveryService(CameraDiscoveryResult(cameras=[
            DiscoveredCamera(host="192.168.1.10", port=554, rtsp_url="rtsp://192.168.1.10/live")
        ]))
        manager = CameraDiscoveryScanManager(discovery_service=service, timeout_seconds=1)

        started = await manager.start_scan(["192.168.1.0/24"])
        await asyncio.sleep(0.01)
        state = await manager.get_state()

        self.assertEqual(started.scan_id, state.scan_id)
        self.assertEqual(state.status, "completed")
        self.assertEqual(state.discovered_cameras[0].host, "192.168.1.10")
        self.assertEqual(service.calls, 1)

    async def test_running_scan_is_reused(self):
        service = FakeDiscoveryService(delay=0.05)
        manager = CameraDiscoveryScanManager(discovery_service=service, timeout_seconds=1)

        first = await manager.start_scan(["192.168.1.0/24"])
        second = await manager.start_scan(["192.168.1.0/24"])
        await asyncio.sleep(0.08)

        self.assertEqual(first.scan_id, second.scan_id)
        self.assertEqual(service.calls, 1)

    async def test_scan_timeout_sets_timeout_state(self):
        service = FakeDiscoveryService(delay=0.05)
        manager = CameraDiscoveryScanManager(discovery_service=service, timeout_seconds=0.001)

        await manager.start_scan(["192.168.1.0/24"])
        await asyncio.sleep(0.02)
        state = await manager.get_state()

        self.assertEqual(state.status, "timeout")
        self.assertEqual(state.errors[0].code, "scan_timeout")

    async def test_service_errors_mark_scan_failed(self):
        service = FakeDiscoveryService(CameraDiscoveryResult(errors=[
            CameraDiscoveryError(code="docker_execution_failed", message="Docker failed")
        ]))
        manager = CameraDiscoveryScanManager(discovery_service=service, timeout_seconds=1)

        await manager.start_scan(["192.168.1.0/24"])
        await asyncio.sleep(0.01)
        state = await manager.get_state()

        self.assertEqual(state.status, "failed")
        self.assertEqual(state.errors[0].code, "docker_execution_failed")


if __name__ == "__main__":
    unittest.main()
