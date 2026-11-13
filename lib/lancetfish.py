from __future__ import annotations

import os
import uuid
from pathlib import Path

def _resolve_root() -> Path:

    value = os.environ.get("LANCETFISH_ROOT", "")
    if value and Path(value).expanduser().is_dir():
        return Path(value).expanduser().resolve()
    return Path(__file__).resolve().parents[1]

ROOT = _resolve_root()
CONFIG_PATH = ROOT / "config" / "lancetfish.toml"
LEDGER_PATH = ROOT / "data" / "ledger.jsonl"

def load_config() -> dict:

    return {}

def workflow_settings(job: str, cfg: dict | None = None, **_: object) -> dict:
    return {}

def prompt_template(value: str) -> str:
    raise FileNotFoundError(f"No prompt named {value} in this install")

def write_atomic(path: str | Path, text: str, *, encoding: str = "utf-8") -> Path:

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with open(temp, "w", encoding=encoding) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, target)
    finally:
        if temp.exists():
            temp.unlink()
    return target
