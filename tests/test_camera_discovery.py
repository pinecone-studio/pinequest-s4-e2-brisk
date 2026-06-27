import unittest
from unittest.mock import patch

from app.services.camera_discovery import CameraDiscoveryConfig, CameraDiscoveryService


class FakeHost:
    def __init__(self, tcp):
        self._tcp = tcp

    def has_tcp(self, port):
        return port in self._tcp

    def __getitem__(self, key):
        if key == "tcp":
            return self._tcp
        raise KeyError(key)


class FakePortScanner:
    def __init__(self):
        self.scans = []
        self.hosts = {
            "192.168.1.10": FakeHost({
                554: {"state": "open", "product": "Hikvision"},
                80: {"state": "closed", "product": "HTTP"},
            }),
            "192.168.1.11": FakeHost({
                8554: {"state": "open"},
            }),
        }

    def scan(self, hosts, arguments):
        self.scans.append({"hosts": hosts, "arguments": arguments})
        return {"scan": "completed"}

    def all_hosts(self):
        return list(self.hosts)

    def __getitem__(self, host):
        return self.hosts[host]


class FailingPortScanner:
    def scan(self, hosts, arguments):
        raise RuntimeError("nmap unavailable")


class CameraDiscoveryServiceTest(unittest.TestCase):
    @patch("app.services.camera_discovery.nmap.PortScanner")
    def test_discover_runs_nmap_and_returns_discovered_cameras(self, port_scanner):
        scanner = FakePortScanner()
        port_scanner.return_value = scanner
        service = CameraDiscoveryService(CameraDiscoveryConfig(probe_rtsp=True))
        service._probe_rtsp = lambda host, port: ("/live.sdp", "admin", "admin")

        result = service.discover("192.168.1.0/24")

        self.assertTrue(result.ok)
        self.assertEqual(len(result.cameras), 2)
        self.assertEqual(result.cameras[0].host, "192.168.1.10")
        self.assertEqual(result.cameras[0].username, "admin")
        self.assertEqual(result.cameras[0].password, "admin")
        self.assertEqual(result.cameras[0].path, "/live.sdp")
        self.assertTrue(result.cameras[0].is_accessible)
        self.assertEqual(result.cameras[1].port, 8554)
        self.assertEqual(scanner.scans[0]["hosts"], "192.168.1.0/24")
        self.assertEqual(scanner.scans[0]["arguments"], "-sn -n -T5")
        self.assertEqual(scanner.scans[1]["hosts"], "192.168.1.10 192.168.1.11")
        self.assertEqual(scanner.scans[1]["arguments"], "-p 554,8554,80,8080 --open -n -sT")

    @patch("app.services.camera_discovery.nmap.PortScanner")
    def test_discover_returns_structured_error_for_nmap_failure(self, port_scanner):
        port_scanner.return_value = FailingPortScanner()
        result = CameraDiscoveryService().discover("192.168.1.0/24")

        self.assertFalse(result.ok)
        self.assertEqual(result.errors[0].code, "nmap_scan_failed")
        self.assertEqual(result.errors[0].detail, "nmap unavailable")

    def test_discover_returns_structured_error_for_invalid_targets(self):
        result = CameraDiscoveryService().discover("")

        self.assertFalse(result.ok)
        self.assertEqual(result.errors[0].code, "invalid_targets")

    def test_probe_rtsp_returns_route_and_credentials_for_successful_describe(self):
        class FakeSocket:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return None

            def sendall(self, data):
                self.request = data

            def recv(self, size):
                return b"RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n"

        service = CameraDiscoveryService(CameraDiscoveryConfig(
            rtsp_routes=["/live"],
            credentials=[("admin", "admin")],
        ))

        with patch("app.services.camera_discovery.socket.create_connection", return_value=FakeSocket()):
            route, username, password = service._probe_rtsp("192.168.1.10", 554)

        self.assertEqual(route, "/live")
        self.assertEqual(username, "admin")
        self.assertEqual(password, "admin")


if __name__ == "__main__":
    unittest.main()
