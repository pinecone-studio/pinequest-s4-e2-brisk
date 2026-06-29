import os
import unittest
from unittest.mock import patch

from app.camera_discovery_api import _resolve_targets, _targets_from_camera_config


class CameraDiscoveryApiTest(unittest.TestCase):
    def test_resolve_targets_prefers_request_body(self):
        with patch("app.camera_discovery_api._detect_local_subnet") as detect_local_subnet:
            self.assertEqual(_resolve_targets(["10.0.0.0/24"]), ["10.0.0.0/24"])

        detect_local_subnet.assert_not_called()

    def test_resolve_targets_reads_environment(self):
        with patch.dict(os.environ, {"CAMERA_DISCOVERY_TARGETS": "10.0.0.0/24, 10.0.1.0/24"}), \
                patch("app.camera_discovery_api._detect_local_subnet") as detect_local_subnet:
            self.assertEqual(_resolve_targets(None), ["10.0.0.0/24", "10.0.1.0/24"])

        detect_local_subnet.assert_not_called()

    def test_resolve_targets_uses_camera_config_before_local_subnet(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch("app.camera_discovery_api._targets_from_camera_config", return_value=["192.168.1.0/24"]), \
                patch("app.camera_discovery_api._detect_local_subnet") as detect_local_subnet:
            self.assertEqual(_resolve_targets(None), ["192.168.1.0/24"])

        detect_local_subnet.assert_not_called()

    def test_resolve_targets_falls_back_to_local_subnet(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch("app.camera_discovery_api._targets_from_camera_config", return_value=[]), \
                patch("app.camera_discovery_api._detect_local_subnet", return_value="192.168.50.0/24"):
            self.assertEqual(_resolve_targets(None), ["192.168.50.0/24"])

    def test_resolve_targets_returns_empty_list_when_local_subnet_detection_fails(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch("app.camera_discovery_api._targets_from_camera_config", return_value=[]), \
                patch("app.camera_discovery_api._detect_local_subnet", side_effect=RuntimeError("no subnet")):
            self.assertEqual(_resolve_targets(None), [])

    def test_targets_from_missing_config_returns_empty_list(self):
        self.assertEqual(_targets_from_camera_config("missing-cameras.json"), [])


if __name__ == "__main__":
    unittest.main()
