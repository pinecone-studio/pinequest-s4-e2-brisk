import tempfile
import unittest
from pathlib import Path

from app.services.camera_discovery import CameraDiscoveryConfig, CameraDiscoveryService


class FakeContainers:
    def __init__(self):
        self.last_run = None

    def run(self, image, **kwargs):
        self.last_run = {"image": image, **kwargs}
        return FakeContainer(kwargs["volumes"])


class FakeContainer:
    def __init__(self, volumes):
        self.volumes = volumes
        self.removed = False

    def wait(self, timeout):
        self.timeout = timeout
        output_dir = next(iter(self.volumes.keys()))
        Path(output_dir, "cameradar-results.m3u").write_text(
            "#EXTM3U\n"
            "rtsp://admin:secret@192.168.1.10:554/live.sdp\n"
            "rtsp://192.168.1.11/stream1\n"
        )
        return {"StatusCode": 0}

    def logs(self, stdout=True, stderr=True):
        return b"scan completed"

    def remove(self, force=True):
        self.removed = True


class FakeDockerClient:
    def __init__(self):
        self.containers = FakeContainers()


class CameraDiscoveryServiceTest(unittest.TestCase):
    def test_discover_runs_cameradar_with_docker_sdk_and_parses_results(self):
        docker_client = FakeDockerClient()
        service = CameraDiscoveryService(CameraDiscoveryConfig(docker_client=docker_client))

        result = service.discover("192.168.1.0/24")

        self.assertTrue(result.ok)
        self.assertEqual(len(result.cameras), 2)
        self.assertEqual(result.cameras[0].host, "192.168.1.10")
        self.assertEqual(result.cameras[0].username, "admin")
        self.assertEqual(result.cameras[0].password, "secret")
        self.assertEqual(result.cameras[1].port, 554)
        self.assertEqual(
            docker_client.containers.last_run["command"],
            [
                "--targets",
                "/tmp/cameradar-output/cameradar-targets.txt",
                "--output",
                "/tmp/cameradar-output/cameradar-results.m3u",
            ],
        )
        self.assertTrue(docker_client.containers.last_run["detach"])
        self.assertEqual(docker_client.containers.last_run["network_mode"], "host")

    def test_discover_returns_structured_error_for_docker_failure(self):
        class FailingService(CameraDiscoveryService):
            def _run_cameradar(self, output_dir):
                raise RuntimeError("docker daemon unavailable")

        result = FailingService().discover("192.168.1.0/24")

        self.assertFalse(result.ok)
        self.assertEqual(result.errors[0].code, "docker_execution_failed")
        self.assertEqual(result.errors[0].detail, "docker daemon unavailable")

    def test_discover_returns_structured_error_for_invalid_targets(self):
        result = CameraDiscoveryService().discover("")

        self.assertFalse(result.ok)
        self.assertEqual(result.errors[0].code, "invalid_targets")

    def test_parse_output_fails_cleanly_for_malformed_rtsp_entries(self):
        service = CameraDiscoveryService()
        with tempfile.TemporaryDirectory() as output_dir:
            output_path = Path(output_dir) / "result.m3u"
            output_path.write_text("rtsp://camera.local:not-a-port/live\n")

            with self.assertRaises(ValueError):
                service._parse_output(output_path, "")


if __name__ == "__main__":
    unittest.main()
