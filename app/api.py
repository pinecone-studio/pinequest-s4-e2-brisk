import asyncio
import json
import logging
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
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

UPLOAD_DIR = Path("input/uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
ANALYZE_PAGE = Path("app/templates/analyze.html")

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


@app.get("/analyze", response_class=HTMLResponse)
async def analyze_page():
    return ANALYZE_PAGE.read_text()


def _evidence_url(path: Optional[str]) -> Optional[str]:
    """Map an 'evidence/...jpg' path to its served URL, only for real images."""
    if not path or not path.lower().endswith((".jpg", ".jpeg", ".png")):
        return None
    return "/" + path.lstrip("/")


def _clean_audio_label(label: Optional[str]) -> Optional[str]:
    """YAMNet class-map rows look like '19,/m/0463cq4,"Crying, sobbing"'.
    Return just the human-readable display name."""
    if not label:
        return label
    parts = label.split(",", 2)
    name = parts[2] if len(parts) == 3 else label
    return name.strip().strip('"')


def _ffmpeg_bin() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


MAX_URL_CLIP_SECONDS = 120


MAX_URL_CLIP_BYTES = 500 * 1024 * 1024  # 500 MB safety cap


def _http_download(url: str, dest: Path) -> str:
    """Download an http(s) resource to `dest`, returning its Content-Type."""
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        ctype = resp.headers.get("Content-Type", "")
        written = 0
        with open(dest, "wb") as fh:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_URL_CLIP_BYTES:
                    raise RuntimeError("Remote file exceeds size limit")
                fh.write(chunk)
    return ctype


def _ffmpeg_grab(url: str, dest: Path, is_stream: bool) -> None:
    """Grab a clip from a stream/playlist via ffmpeg (audio preserved)."""
    ffmpeg = _ffmpeg_bin()
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if is_stream:
        cmd += ["-rtsp_transport", "tcp"]
    else:
        cmd += ["-user_agent", "Mozilla/5.0"]
    cmd += ["-i", url, "-t", str(MAX_URL_CLIP_SECONDS),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-movflags", "+faststart", str(dest)]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=360)
    if res.returncode != 0:
        raise RuntimeError(res.stderr[-400:] or "ffmpeg failed")


def _download_url_to_clip(url: str, dest: Path) -> None:
    """Fetch a video link into `dest`.

    - http(s) direct media  -> plain download (exact file, audio preserved)
    - http(s) page link      -> yt-dlp if available, else direct download
    - rtsp/rtmp stream       -> ffmpeg grabs a capped clip
    """
    scheme = (urlparse(url).scheme or "").lower()
    if scheme not in ("http", "https", "rtsp", "rtmp", "rtmps"):
        raise ValueError(f"Unsupported URL scheme: {scheme or 'none'}")

    if scheme in ("rtsp", "rtmp", "rtmps"):
        _ffmpeg_grab(url, dest, is_stream=True)
    else:
        base = url.split("?", 1)[0].lower()
        media_exts = (".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".ts")
        is_direct_media = base.endswith(media_exts)

        if not is_direct_media and shutil.which("yt-dlp"):
            subprocess.run(
                ["yt-dlp", "-f", "mp4/best", "--no-playlist", "-o", str(dest), url],
                check=True, capture_output=True, text=True, timeout=300,
            )
        else:
            try:
                _http_download(url, dest)
            except Exception:
                # Could be HLS/DASH or a redirecting page — let ffmpeg try.
                _ffmpeg_grab(url, dest, is_stream=False)

    if not dest.exists() or dest.stat().st_size < 2048:
        raise RuntimeError("Could not retrieve a valid video from the link")


@app.post("/api/analyze")
async def api_analyze(
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
):
    """
    Accept an uploaded video OR a video link (url), run the full security
    pipeline (YOLO video + YAMNet audio + fusion) and stream progress/detections
    back as NDJSON so the client can render the briefing in real time.
    """
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    url = (url or "").strip() or None

    file_bytes: Optional[bytes] = None
    if file is not None and file.filename:
        safe_name = Path(file.filename).name
        dest = UPLOAD_DIR / f"{ts}_{safe_name}"
        file_bytes = await file.read()
        dest.write_bytes(file_bytes)
        source = {"kind": "file", "name": safe_name}
    elif url:
        dest = UPLOAD_DIR / f"{ts}_link.mp4"
        source = {"kind": "url", "url": url}
    else:
        return JSONResponse({"error": "Provide a file or a url"}, status_code=400)

    async def stream():
        def line(obj: Dict) -> str:
            return json.dumps(obj) + "\n"

        try:
            if source["kind"] == "url":
                yield line({"stage": "fetching_url", "url": source["url"]})
                await asyncio.to_thread(_download_url_to_clip, source["url"], dest)
                yield line({
                    "stage": "received",
                    "filename": source["url"],
                    "size": dest.stat().st_size,
                })
            else:
                yield line({
                    "stage": "received",
                    "filename": source["name"],
                    "size": len(file_bytes or b""),
                })

            with open("cameras.json") as f:
                config = json.load(f)
            sample_rate = config.get("sample_rate", 15)
            video_threshold = config.get("confidence_threshold", 0.5)
            audio_threshold = config.get("audio_threshold", 0.35)
            audio_enabled = config.get("audio_enabled", True)
            fusion_mode = config.get("fusion_mode", "any")

            from app.security_detector import detect_video_clip, load_model
            from app.audio_detector import analyze_clip
            from app.fusion import fuse
            from app.clip_processor import _save_evidence_frame

            yield line({"stage": "loading_models", "fusion_mode": fusion_mode})
            await asyncio.to_thread(load_model, config)

            yield line({"stage": "video_analyzing"})
            frame_results = await asyncio.to_thread(
                detect_video_clip, dest, sample_rate, video_threshold, config
            )
            video_best: Dict[str, float] = {}
            for fr in frame_results:
                for det in fr.get("detections", []):
                    t = det["type"]
                    c = float(det["confidence"])
                    if t not in video_best or c > video_best[t]:
                        video_best[t] = round(c, 4)
            yield line({
                "stage": "video_done",
                "frames_flagged": len(frame_results),
                "best": video_best,
            })

            audio_events = []
            if audio_enabled:
                yield line({"stage": "audio_analyzing"})
                try:
                    audio_events = await asyncio.to_thread(
                        analyze_clip, dest, audio_threshold
                    )
                    yield line({
                        "stage": "audio_done",
                        "events": [
                            {
                                "label": _clean_audio_label(e.label),
                                "type": e.vtype,
                                "confidence": round(e.confidence, 4),
                                "start": e.start_sec,
                                "end": e.end_sec,
                            }
                            for e in audio_events
                        ],
                    })
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Audio analysis skipped: %s", exc)
                    yield line({"stage": "audio_skipped", "reason": str(exc)})

            yield line({"stage": "fusing"})
            alerts = fuse(frame_results, audio_events, config)

            for alert in alerts:
                frame_num = alert.frame_number or 1
                img_path = await asyncio.to_thread(
                    _save_evidence_frame, dest, frame_num, "upload", alert.vtype
                )
                yield line({
                    "type": "detection",
                    "vtype": alert.vtype,
                    "confidence": round(alert.confidence, 4),
                    "source": alert.source,
                    "video_conf": alert.video_conf,
                    "audio_conf": alert.audio_conf,
                    "audio_label": _clean_audio_label(alert.audio_label),
                    "frame_number": alert.frame_number,
                    "evidence_url": _evidence_url(img_path),
                })

            yield line({"stage": "complete", "count": len(alerts)})
        except Exception as exc:  # noqa: BLE001
            logger.exception("Analyze failed")
            yield line({"stage": "error", "message": str(exc)})

    return StreamingResponse(stream(), media_type="application/x-ndjson")


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
        logger.info("Violation enqueued for broadcast: type=%s id=%s", violation.get("type"), violation.get("id"))
    except asyncio.QueueFull:
        logger.warning("Violation queue full — dropping event")


@app.on_event("startup")
async def startup():
    global _violation_queue
    _violation_queue = asyncio.Queue()
    asyncio.create_task(violation_broadcaster())
