import sqlite3
import logging
from datetime import date
from pathlib import Path
from typing import Dict, List

DB_PATH = Path("data/guardai.db")
logger = logging.getLogger(__name__)


def init_db():
    DB_PATH.parent.mkdir(exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS violations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                camera_id TEXT NOT NULL,
                floor INTEGER NOT NULL,
                zone TEXT NOT NULL,
                type TEXT NOT NULL,
                confidence REAL NOT NULL,
                image_path TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            )
        """)
        conn.commit()
    logger.info("Database initialised at %s", DB_PATH)


def insert_violation(camera_id: str, floor: int, zone: str,
                     vtype: str, confidence: float, image_path: str) -> int:
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute(
            """INSERT INTO violations (camera_id, floor, zone, type, confidence, image_path)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (camera_id, floor, zone, vtype, confidence, image_path),
        )
        conn.commit()
        return cur.lastrowid


def get_violations(limit: int = 50) -> List[Dict]:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM violations ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_stats_today() -> Dict:
    today = date.today().isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM violations WHERE created_at >= ?", (today,)
        ).fetchone()[0]
        smoking = conn.execute(
            "SELECT COUNT(*) FROM violations WHERE type='smoking' AND created_at >= ?",
            (today,),
        ).fetchone()[0]
        garbage = conn.execute(
            "SELECT COUNT(*) FROM violations WHERE type='garbage' AND created_at >= ?",
            (today,),
        ).fetchone()[0]
    return {"total": total, "smoking": smoking, "garbage": garbage}
