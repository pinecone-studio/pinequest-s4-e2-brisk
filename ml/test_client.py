"""Minimal client to test the running CCTV analytics server.

Usage:
    python test_client.py path/to/frame.jpg
    python test_client.py path/to/frame.jpg http://localhost:8000/predict
"""

import sys

import requests

def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python test_client.py <image.jpg> [url]")
        sys.exit(1)

    image_path = sys.argv[1]
    url = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8000/predict"

    with open(image_path, "rb") as fh:
        jpeg_bytes = fh.read()

    # Send raw JPEG bytes as the request body.
    response = requests.post(
        url,
        data=jpeg_bytes,
        headers={"Content-Type": "application/octet-stream"},
        timeout=30,
    )
    response.raise_for_status()
    print(response.json())


if __name__ == "__main__":
    main()
