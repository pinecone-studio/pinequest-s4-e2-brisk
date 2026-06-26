"""
Standalone dashboard server — no live cameras required.
Usage: python3 serve.py [--port PORT]
Opens the Aegis web dashboard at http://localhost:8080
"""
import argparse
import sys
import logging
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)

Path("logs").mkdir(exist_ok=True)
Path("evidence").mkdir(exist_ok=True)

from app.database import init_db
from app import cameras as cameras_mod

init_db()
cameras_mod.load_config("cameras.json")  # load config but don't start RTSP streams

import uvicorn
from app.api import app as fastapi_app

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8080, help="Port to listen on (default: 8080)")
args = parser.parse_args()

print(f"\nAegis Dashboard")
print(f"  URL: http://localhost:{args.port}\n")
uvicorn.run(fastapi_app, host="0.0.0.0", port=args.port, log_level="warning")
