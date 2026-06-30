import json
import unittest
from unittest.mock import patch
from urllib import error

from app.services.camera_discovery import CameraDiscoveryService
from app.services.unifi_protect import UniFiProtectService


class FakeHeaders:
    def __init__(self, values=None):
        self.values = values or {}

    def get(self, key):
        return self.values.get(key)


class FakeResponse:
    def __init__(self, payload=None, headers=None):
        self.payload = payload
        self.headers = FakeHeaders(headers)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return None

    def read(self):
        if self.payload is None:
            return b""
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


class UniFiProtectServiceTest(unittest.TestCase):
    def test_enable_rtsp_logs_in_fetches_cameras_and_patches_each_camera(self):
        responses = [
            FakeResponse(headers={"Set-Cookie": "TOKEN=session-token; Path=/; Secure"}),
            FakeResponse(payload=[
                {"id": "camera-1"},
                {"_id": "camera-2"},
                {"name": "missing id"},
            ]),
            FakeResponse(),
            FakeResponse(),
        ]

        with patch("app.services.unifi_protect.request.urlopen", side_effect=responses) as urlopen:
            enabled_count = UniFiProtectService(
                host="protect.local",
                username="admin",
                password="secret",
            ).enable_rtsp_on_cameras()

        self.assertEqual(enabled_count, 2)
        login_request = urlopen.call_args_list[0].args[0]
        cameras_request = urlopen.call_args_list[1].args[0]
        first_patch_request = urlopen.call_args_list[2].args[0]
        second_patch_request = urlopen.call_args_list[3].args[0]

        self.assertEqual(login_request.full_url, "https://protect.local/api/auth/login")
        self.assertEqual(login_request.get_method(), "POST")
        self.assertEqual(json.loads(login_request.data.decode("utf-8")), {
            "username": "admin",
            "password": "secret",
        })
        self.assertEqual(
            cameras_request.full_url,
            "https://protect.local/proxy/protect/api/cameras",
        )
        self.assertEqual(cameras_request.get_header("Cookie"), "TOKEN=session-token")
        self.assertEqual(
            first_patch_request.full_url,
            "https://protect.local/proxy/protect/api/cameras/camera-1",
        )
        self.assertEqual(first_patch_request.get_method(), "PATCH")
        self.assertEqual(json.loads(first_patch_request.data.decode("utf-8")), {
            "rtspAlias": "enabled",
        })
        self.assertEqual(
            second_patch_request.full_url,
            "https://protect.local/proxy/protect/api/cameras/camera-2",
        )

    def test_enable_rtsp_returns_zero_for_api_errors(self):
        with patch(
            "app.services.unifi_protect.request.urlopen",
            side_effect=error.URLError("unavailable"),
        ):
            enabled_count = UniFiProtectService(
                host="protect.local",
                username="admin",
                password="secret",
            ).enable_rtsp_on_cameras()

        self.assertEqual(enabled_count, 0)

    @patch("app.services.camera_discovery.nmap.PortScanner")
    @patch("app.services.unifi_protect.UniFiProtectService.enable_rtsp_on_cameras")
    def test_camera_discovery_enables_unifi_protect_rtsp_when_credentials_are_set(
        self,
        enable_rtsp_on_cameras,
        port_scanner,
    ):
        port_scanner.return_value = EmptyPortScanner()
        enable_rtsp_on_cameras.return_value = 2

        with patch.dict("os.environ", {
            "UNIFI_PROTECT_HOST": "protect.local",
            "UNIFI_PROTECT_USERNAME": "admin",
            "UNIFI_PROTECT_PASSWORD": "secret",
        }, clear=True):
            result = CameraDiscoveryService().discover("192.168.1.0/24")

        self.assertTrue(result.ok)
        enable_rtsp_on_cameras.assert_called_once()

    @patch("app.services.camera_discovery.nmap.PortScanner")
    @patch("app.services.unifi_protect.UniFiProtectService.enable_rtsp_on_cameras")
    def test_camera_discovery_skips_unifi_protect_without_credentials(
        self,
        enable_rtsp_on_cameras,
        port_scanner,
    ):
        port_scanner.return_value = EmptyPortScanner()

        with patch.dict("os.environ", {}, clear=True):
            result = CameraDiscoveryService().discover("192.168.1.0/24")

        self.assertTrue(result.ok)
        enable_rtsp_on_cameras.assert_not_called()


if __name__ == "__main__":
    unittest.main()
