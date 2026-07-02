"""Minimal client to test the running CCTV violation-gate server.

Usage:
    python test_client.py path/to/frame.jpg
    python test_client.py path/to/frame.jpg https://<lightning-url>/predict
"""

import base64
import sys

import requests


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python test_client.py <image.jpg> [url]")
        sys.exit(1)

    image_path = sys.argv[1]
    url = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8000/predict"

    with open(image_path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode("ascii")

    # Server expects JSON {"image": "<base64-jpeg>"}.
    response = requests.post(url, json={"image": b64}, timeout=60)
    response.raise_for_status()
    print(response.json())


if __name__ == "__main__":
    main()
