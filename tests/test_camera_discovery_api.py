import os
import unittest
from unittest.mock import patch

from app.camera_discovery_api import _resolve_targets, _targets_from_camera_config


class CameraDiscoveryApiTest(unittest.TestCase):
    def test_resolve_targets_prefers_request_body(self):
        self.assertEqual(_resolve_targets(["10.0.0.0/24"]), ["10.0.0.0/24"])

    def test_resolve_targets_reads_environment(self):
        with patch.dict(os.environ, {"CAMERA_DISCOVERY_TARGETS": "10.0.0.0/24, 10.0.1.0/24"}):
            self.assertEqual(_resolve_targets(None), ["10.0.0.0/24", "10.0.1.0/24"])

    def test_targets_from_missing_config_returns_empty_list(self):
        self.assertEqual(_targets_from_camera_config("missing-cameras.json"), [])


if __name__ == "__main__":
    unittest.main()
