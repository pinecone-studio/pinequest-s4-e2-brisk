import json
import unittest
from unittest.mock import patch
from urllib import error

from app.services.camera_discovery import CameraDiscoveryService, DiscoveredCamera
from app.services.unifi_api import UniFiApiService


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return None

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class EmptyPortScanner:
    def __init__(self):
        self.hosts = {"192.168.1.10": EmptyHost()}

    def scan(self, hosts, arguments):
        return {"scan": "completed"}

    def all_hosts(self):
        return list(self.hosts)

    def __getitem__(self, host):
        return self.hosts[host]


class EmptyHost:
    def has_tcp(self, port):
        return False

    def __getitem__(self, key):
        if key == "tcp":
            return {}
        raise KeyError(key)


class UniFiApiServiceTest(unittest.TestCase):
    def test_fetch_cameras_uses_api_key_and_parses_cameras(self):
        payload = {
            "data": [
                {
                    "ip": "10.0.0.1",
                    "devices": [
                        {
                            "type": "camera",
                            "ip": "10.0.0.20",
                            "model": "UVC-G5-Bullet",
                        },
                        {
                            "type": "switch",
                            "ip": "10.0.0.30",
                            "model": "USW-Pro",
                        },
                    ],
                }
            ]
        }

        with patch(
            "app.services.unifi_api.request.urlopen",
            return_value=FakeResponse(payload),
        ) as urlopen:
            cameras = UniFiApiService(api_key="test-key").fetch_cameras()

        api_request = urlopen.call_args.args[0]
        self.assertEqual(api_request.full_url, "https://api.ui.com/v1/hosts")
        self.assertEqual(api_request.get_header("X-api-key"), "test-key")
        self.assertEqual(len(cameras), 1)
        self.assertEqual(cameras[0].host, "10.0.0.20")
        self.assertEqual(cameras[0].port, 7447)
        self.assertEqual(cameras[0].rtsp_url, "rtsp://10.0.0.20:7447")
        self.assertEqual(cameras[0].model, "UVC-G5-Bullet")

    def test_parse_cameras_uses_rtsp_url_port_and_path_when_available(self):
        service = UniFiApiService(api_key="test-key")
        cameras = service._parse_cameras({
            "hosts": [
                {
                    "address": "10.0.0.1",
                    "devices": [
                        {
                            "deviceType": "camera",
                            "rtspUrl": "rtsp://10.0.0.21:8554/live.sdp?profile=high",
                            "productName": "UniFi Camera",
                        }
                    ],
                }
            ]
        })

        self.assertEqual(len(cameras), 1)
        self.assertEqual(cameras[0].host, "10.0.0.21")
        self.assertEqual(cameras[0].port, 8554)
        self.assertEqual(cameras[0].path, "/live.sdp?profile=high")
        self.assertEqual(cameras[0].rtsp_route, "/live.sdp?profile=high")

    def test_fetch_cameras_returns_empty_list_for_api_errors(self):
        with patch(
            "app.services.unifi_api.request.urlopen",
            side_effect=error.URLError("unavailable"),
        ):
            cameras = UniFiApiService(api_key="test-key").fetch_cameras()

        self.assertEqual(cameras, [])

    @patch("app.services.camera_discovery.nmap.PortScanner")
    @patch("app.services.unifi_api.UniFiApiService.fetch_cameras")
    def test_camera_discovery_merges_unifi_cameras_when_api_key_is_set(
        self,
        fetch_cameras,
        port_scanner,
    ):
        port_scanner.return_value = EmptyPortScanner()
        fetch_cameras.return_value = [
            DiscoveredCamera(
                host="10.0.0.20",
                port=7447,
                rtsp_url="rtsp://10.0.0.20:7447",
            )
        ]

        with patch.dict("os.environ", {"UNIFI_API_KEY": "test-key"}):
            result = CameraDiscoveryService().discover("192.168.1.0/24")

        self.assertTrue(result.ok)
        self.assertEqual(len(result.cameras), 1)
        self.assertEqual(result.cameras[0].port, 7447)

    @patch("app.services.camera_discovery.nmap.PortScanner")
    @patch("app.services.unifi_api.UniFiApiService.fetch_cameras")
    def test_camera_discovery_skips_unifi_cameras_without_api_key(
        self,
        fetch_cameras,
        port_scanner,
    ):
        port_scanner.return_value = EmptyPortScanner()

        with patch.dict("os.environ", {}, clear=True):
            result = CameraDiscoveryService().discover("192.168.1.0/24")

        self.assertTrue(result.ok)
        self.assertEqual(result.cameras, [])
        fetch_cameras.assert_not_called()


if __name__ == "__main__":
    unittest.main()
