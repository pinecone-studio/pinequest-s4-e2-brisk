"""
Test WebSocket listener — connects to the live violations feed and prints every event.

Usage (in a separate terminal while run.py --source 0 --serve is running):
    python3 scripts/ws_listener.py

Each littering alert broadcast by push_violation will appear here as a JSON line.
"""

import json
import sys

try:
    import websocket  # pip install websocket-client
except ImportError:
    sys.exit("Install websocket-client first:  pip install websocket-client")

URL = "ws://localhost:8080/ws"


def on_message(ws, message):
    try:
        data = json.loads(message)
        print(f"[BROADCAST] type={data.get('type')}  id={data.get('id')}  "
              f"camera={data.get('camera_id')}  obj={data.get('object_id')}")
    except Exception:
        print(f"[BROADCAST] raw: {message}")


def on_error(ws, error):
    print(f"[WS ERROR] {error}")


def on_close(ws, code, msg):
    print(f"[WS CLOSED] code={code}")


def on_open(ws):
    print(f"[WS] connected to {URL} — waiting for violations …")


if __name__ == "__main__":
    ws = websocket.WebSocketApp(
        URL,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    ws.run_forever()
