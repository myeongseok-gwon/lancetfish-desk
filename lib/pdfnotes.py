from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import re
import unicodedata
from pathlib import Path

import lancetfish as lf

SCHEMA_VERSION = 1

COLORS = ("yellow", "green", "pink")
DEFAULT_COLOR = "yellow"

SHAPES = ("box",)

WRITING_SIZES = (1.1, 1.6, 2.4)
DEFAULT_WRITING_SIZE = WRITING_SIZES[0]
DEFAULT_WRITING_COLOR = "pink"
MAX_WRITINGS = 5000
MAX_WRITING_CHARS = 4000

DRAWING_SIZES = (2.5, 4.5, 8.0)
DEFAULT_DRAWING_SIZE = DRAWING_SIZES[0]
MAX_DRAWINGS = 5000
MAX_POINTS_PER_STROKE = 4000

MAX_HIGHLIGHTS = 5000
MAX_RECTS_PER_HIGHLIGHT = 600
MAX_QUOTE_CHARS = 6000
MAX_NOTE_CHARS = 20000
MAX_PAGE = 20000
MAX_COMMENT_PAGES = 5000
MAX_TURNED_PAGES = 5000

MAX_CONTENTS = 500
MAX_CONTENTS_TITLE = 300
MAX_LEVEL = 4

ROTATIONS = (90, 180, 270)

def doc_id(name: str) -> str:

    stem = Path(str(name)).stem
    text = unicodedata.normalize("NFKC", stem).lower()
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE)
    slug = re.sub(r"[\s_]+", "-", text).strip("-")[:60].rstrip("-") or "document"
    return f"{slug}-{hashlib.sha256(str(name).encode()).hexdigest()[:8]}"

def _now() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")

def blank(ident: str = "", name: str = "", pages: int = 0) -> dict:
    return {"version": SCHEMA_VERSION, "id": str(ident), "name": str(name),
            "pages": int(pages or 0), "updated": None,
            "highlights": [], "comments": {}, "rotations": {}, "contents": [],
            "writings": [], "drawings": []}

def _text(value, limit: int) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")

    text = "".join(c for c in text if c == "\n" or c == "\t" or ord(c) >= 32)
    return text[:limit]

def _page(value) -> int | None:
    try:
        num = int(value)
    except (TypeError, ValueError):
        return None
    return num if 1 <= num <= MAX_PAGE else None

def _frac(value) -> float | None:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num):
        return None
    return round(min(max(num, 0.0), 1.0), 5)

def _rect(raw) -> dict | None:

    if not isinstance(raw, dict):
        return None
    x, y = _frac(raw.get("x")), _frac(raw.get("y"))
    w, h = _frac(raw.get("w")), _frac(raw.get("h"))
    if None in (x, y, w, h) or w <= 0.0005 or h <= 0.0005:
        return None
    return {"x": x, "y": y, "w": min(w, round(1.0 - x, 5)),
            "h": min(h, round(1.0 - y, 5))}

def _rotation(value) -> int | None:

    try:
        turn = int(value)
    except (TypeError, ValueError):
        return None
    turn %= 360
    return turn if turn in ROTATIONS else None

def _highlight(raw, seen: set[str]) -> dict | None:
    if not isinstance(raw, dict):
        return None
    page = _page(raw.get("page"))
    if page is None:
        return None
    rects = [r for r in (_rect(x) for x in (raw.get("rects") or [])) if r]
    if not rects:
        return None
    ident = _text(raw.get("id"), 64).strip() or ""
    if not ident or ident in seen:
        ident = f"h{hashlib.sha256(json.dumps([page, rects, len(seen)]).encode()).hexdigest()[:12]}"
    seen.add(ident)
    color = raw.get("color")
    shape = raw.get("shape") if raw.get("shape") in SHAPES else None
    if shape == "box":
        rects = rects[:1]
    out = {
        "id": ident,
        "page": page,
        "color": color if color in COLORS else DEFAULT_COLOR,
        "rects": rects[:MAX_RECTS_PER_HIGHLIGHT],
        "text": _text(raw.get("text"), MAX_QUOTE_CHARS),
        "note": _text(raw.get("note"), MAX_NOTE_CHARS),
        "created": _text(raw.get("created"), 40) or _now(),
    }
    if shape:
        out["shape"] = shape
    return out

def _section(raw, seen: set[str]) -> dict | None:

    if not isinstance(raw, dict):
        return None
    page = _page(raw.get("page"))
    if page is None:
        return None
    title = " ".join(_text(raw.get("title"), MAX_CONTENTS_TITLE).split()).strip()
    if not title:
        return None
    ident = _text(raw.get("id"), 64).strip()
    if not ident or ident in seen:
        ident = "s" + hashlib.sha256(
            json.dumps([page, title, len(seen)]).encode()).hexdigest()[:12]
    seen.add(ident)
    try:
        level = int(raw.get("level", 1))
    except (TypeError, ValueError):
        level = 1

    by = _text(raw.get("by"), 24).strip().lower()
    return {"id": ident, "title": title,
            "level": min(max(level, 1), MAX_LEVEL),
            "by": by if by in ("reader", "marlin") else "reader",
            "page": page, "frac": _frac(raw.get("frac")),

            "x": _frac(raw.get("x")),
            "created": _text(raw.get("created"), 40) or _now()}

def _writing(raw, seen: set[str]) -> dict | None:

    if not isinstance(raw, dict):
        return None
    page = _page(raw.get("page"))
    x, y = _frac(raw.get("x")), _frac(raw.get("y"))
    text = _text(raw.get("text"), MAX_WRITING_CHARS).strip("\n")
    if page is None or x is None or y is None or not text.strip():
        return None
    ident = _text(raw.get("id"), 64).strip()
    if not ident or ident in seen:
        ident = "w" + hashlib.sha256(
            json.dumps([page, x, y, text, len(seen)]).encode()).hexdigest()[:12]
    seen.add(ident)
    try:
        size = float(raw.get("size"))
    except (TypeError, ValueError):
        size = DEFAULT_WRITING_SIZE
    if size not in WRITING_SIZES:
        size = DEFAULT_WRITING_SIZE
    color = raw.get("color")
    return {"id": ident, "page": page, "x": x, "y": y, "text": text,
            "color": color if color in COLORS else DEFAULT_WRITING_COLOR,
            "size": size,
            "created": _text(raw.get("created"), 40) or _now()}

def _drawing(raw, seen: set[str]) -> dict | None:

    if not isinstance(raw, dict):
        return None
    page = _page(raw.get("page"))
    if page is None or not isinstance(raw.get("points"), list):
        return None
    points = []
    for pt in raw["points"][:MAX_POINTS_PER_STROKE]:
        if not isinstance(pt, (list, tuple)) or len(pt) != 2:
            continue
        x, y = _frac(pt[0]), _frac(pt[1])
        if x is not None and y is not None:
            points.append([x, y])
    if len(points) < 2:
        return None
    ident = _text(raw.get("id"), 64).strip()
    if not ident or ident in seen:
        ident = "d" + hashlib.sha256(
            json.dumps([page, points[:4], len(seen)]).encode()).hexdigest()[:12]
    seen.add(ident)
    try:
        size = float(raw.get("size"))
    except (TypeError, ValueError):
        size = DEFAULT_DRAWING_SIZE
    color = raw.get("color")
    return {"id": ident, "page": page, "points": points,
            "color": color if color in COLORS else DEFAULT_WRITING_COLOR,
            "size": size if size in DRAWING_SIZES else DEFAULT_DRAWING_SIZE,
            "created": _text(raw.get("created"), 40) or _now()}

def section_order(row: dict) -> tuple:

    frac = row.get("frac")
    x = row.get("x")
    return (row.get("page", 0), 1 if (x is not None and x >= 0.5) else 0,
            frac if frac is not None else 0)

def normalize(payload: dict, *, ident: str = "", name: str = "",
              pages: int = 0) -> dict:

    payload = payload if isinstance(payload, dict) else {}
    out = blank(ident or _text(payload.get("id"), 128),
                name or _text(payload.get("name"), 256),
                pages or _page(payload.get("pages")) or 0)

    seen: set[str] = set()
    raw_highlights = payload.get("highlights")
    if isinstance(raw_highlights, list):
        for raw in raw_highlights[:MAX_HIGHLIGHTS]:
            row = _highlight(raw, seen)
            if row:
                out["highlights"].append(row)
    out["highlights"].sort(key=lambda h: (h["page"], h["rects"][0]["y"],
                                          h["rects"][0]["x"]))

    raw_comments = payload.get("comments")
    if isinstance(raw_comments, dict):
        for key, value in list(raw_comments.items())[:MAX_COMMENT_PAGES]:
            page = _page(key)
            if page is None:
                continue
            if isinstance(value, dict):
                text, updated = value.get("text"), value.get("updated")
            else:
                text, updated = value, None
            body = _text(text, MAX_NOTE_CHARS).strip()
            if not body:
                continue
            out["comments"][str(page)] = {
                "text": body,
                "updated": _text(updated, 40) or _now(),
            }

    raw_rotations = payload.get("rotations")
    if isinstance(raw_rotations, dict):
        for key, value in list(raw_rotations.items())[:MAX_TURNED_PAGES]:
            page, turn = _page(key), _rotation(value)
            if page is None or turn is None:
                continue
            out["rotations"][str(page)] = turn

    raw_contents = payload.get("contents")
    if isinstance(raw_contents, list):
        marked: set[str] = set()
        for raw in raw_contents[:MAX_CONTENTS]:
            row = _section(raw, marked)
            if row:
                out["contents"].append(row)

    out["contents"].sort(key=section_order)

    raw_writings = payload.get("writings")
    if isinstance(raw_writings, list):
        written: set[str] = set()
        for raw in raw_writings[:MAX_WRITINGS]:
            row = _writing(raw, written)
            if row:
                out["writings"].append(row)
    out["writings"].sort(key=lambda w: (w["page"], w["y"], w["x"]))

    raw_drawings = payload.get("drawings")
    if isinstance(raw_drawings, list):
        drawn: set[str] = set()
        for raw in raw_drawings[:MAX_DRAWINGS]:
            row = _drawing(raw, drawn)
            if row:
                out["drawings"].append(row)

    out["updated"] = _text(payload.get("updated"), 40) or _now()
    return out

def load(path: Path, *, ident: str = "", name: str = "") -> dict:

    path = Path(path)
    if not path.is_file():
        return blank(ident, name)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        try:
            path.replace(path.with_suffix(path.suffix + ".corrupt"))
        except OSError:
            pass
        return blank(ident, name)
    return normalize(payload, ident=ident, name=name)

def save(path: Path, payload: dict, *, ident: str = "", name: str = "",
         pages: int = 0) -> dict:

    doc = normalize(payload, ident=ident, name=name, pages=pages)
    doc["updated"] = _now()
    lf.write_atomic(path, json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    return doc

def summary(doc: dict) -> dict:

    highlights = doc.get("highlights") or []
    comments = doc.get("comments") or {}
    pages = {h["page"] for h in highlights if isinstance(h, dict) and "page" in h}
    pages |= {int(k) for k in comments if str(k).isdigit()}
    return {"highlights": len(highlights), "comments": len(comments),
            "pages_touched": len(pages),
            "notes": sum(1 for h in highlights
                         if (h.get("note") or "").strip()),
            "last_page": max(pages) if pages else 0,
            "updated": doc.get("updated")}

def as_markdown(doc: dict, title: str = "") -> str:

    highlights = sorted((doc.get("highlights") or []),
                        key=lambda h: (h.get("page", 0),))
    comments = doc.get("comments") or {}
    pages = sorted({h.get("page", 0) for h in highlights}
                   | {int(k) for k in comments if str(k).isdigit()})
    lines = [f"# {title or doc.get('name') or doc.get('id') or 'Reading'}", ""]
    if not pages:
        lines.append("*Nothing marked yet.*")
        return "\n".join(lines) + "\n"
    for page in pages:
        lines.append(f"## Page {page}")
        lines.append("")
        note = (comments.get(str(page)) or {}).get("text", "").strip()
        if note:
            lines += [note, ""]
        for h in [x for x in highlights if x.get("page") == page]:
            quote = " ".join((h.get("text") or "").split())
            if quote:
                lines.append(f"> {quote}  ")
                lines.append(f"> — {h.get('color', DEFAULT_COLOR)}")
                lines.append("")
            remark = (h.get("note") or "").strip()
            if remark:
                lines += [remark, ""]
    return "\n".join(lines).rstrip() + "\n"
