import asyncio
import logging
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import app.cameras as cameras_mod
from app.camera_discovery_api import router as camera_discovery_router
from app.database import get_violations, get_stats_today

logger = logging.getLogger(__name__)

app = FastAPI(title="Aegis")
app.include_router(camera_discovery_router)
app.mount("/static", StaticFiles(directory="app/static"), name="static")
Path("evidence").mkdir(exist_ok=True)
app.mount("/evidence", StaticFiles(directory="evidence"), name="evidence")

_ws_clients: List[WebSocket] = []
_violation_queue: Optional[asyncio.Queue] = None

DASHBOARD = Path("app/templates/dashboard.html")


@app.get("/", response_class=HTMLResponse)
async def index():
    return DASHBOARD.read_text()


@app.get("/api/violations")
async def api_violations():
    return JSONResponse(get_violations(50))


@app.get("/api/stats")
async def api_stats():
    stats = get_stats_today()
    online = sum(1 for c in cameras_mod.get_camera_statuses() if c["online"])
    stats["cameras_online"] = online
    return JSONResponse(stats)


@app.get("/api/cameras")
async def api_cameras():
    return JSONResponse(cameras_mod.get_camera_statuses())


@app.get("/api/snapshot/{camera_id}")
async def api_snapshot(camera_id: str):
    jpeg = cameras_mod.get_frame(camera_id)
    if jpeg is None:
        return Response(status_code=503)
    return Response(content=jpeg, media_type="image/jpeg")


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    _ws_clients.append(ws)
    logger.info("WebSocket client connected (%d total)", len(_ws_clients))
    try:
        while True:
            await ws.receive_text()  # keep alive
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.remove(ws)
        logger.info("WebSocket client disconnected")


async def broadcast_violation(violation: Dict):
    import json
    dead = []
    for ws in _ws_clients:
        try:
            await ws.send_text(json.dumps(violation))
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in _ws_clients:
            _ws_clients.remove(ws)


async def violation_broadcaster():
    while True:
        violation = await _violation_queue.get()
        await broadcast_violation(violation)


def push_violation(violation: Dict):
    if _violation_queue is None:
        return
    try:
        _violation_queue.put_nowait(violation)
    except asyncio.QueueFull:
        logger.warning("Violation queue full — dropping event")


@app.on_event("startup")
async def startup():
    global _violation_queue
    _violation_queue = asyncio.Queue()
    asyncio.create_task(violation_broadcaster())
