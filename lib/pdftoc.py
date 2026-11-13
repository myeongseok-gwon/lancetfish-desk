from __future__ import annotations

import re
from pathlib import Path

MAX_PAGES = 400
MAX_ENTRIES = 400
MAX_TITLE = 160
MAX_WORDS = 14

RUNNING_HEAD_PAGES = 3

NUMBERED = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,3})[.)]?(?:\s+|$)")

ROMAN = re.compile(r"^((?:IX|IV|V?I{1,3}|VI{1,3}|X)(?:\.[A-Z])?)[.)]?(?:\s+|$)")

YEAR = re.compile(r"^(?:19|20)\d{2}\b")

HAS_WORD = re.compile(r"[A-Z]{2,}")

EQUATION = re.compile(r"\(\s*\d{1,3}\s*\)\s*$")

JUNK = re.compile(
    r"^\s*(?:received|revised|accepted|published|copyright|correspondence"
    r"|contact|keywords?|key words|jel|doi|issn|isbn|https?:|www\.|©|funding"
    r"|conflicts? of interest|author contributions|data availability"
    r"|editor|subject classifications?|area of review|history)\b[:.]?",
    re.IGNORECASE)

NOT_WORDS = re.compile(r"^[\W\d_]+$")

_MEMO: dict[tuple, dict] = {}
_MEMO_MAX = 32

def empty(why: str = "") -> dict:
    return {"source": "none", "entries": [], "pages": 0, "why": why}

def _title(text: str) -> str:

    text = re.sub(r"[  -​  ﻿]", " ", str(text or ""))
    text = re.sub(r"\s*\|\s*", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = text.strip("·•*†‡,;")
    return text[:MAX_TITLE].strip()

def _entry(level: int, title: str, page: int, y=None, x=None) -> dict | None:
    title = _title(title)
    if not title or page < 1:
        return None
    row = {"level": max(1, min(int(level), 6)), "title": title, "page": int(page)}
    row["y"] = None if y is None else round(max(0.0, min(float(y), 1.0)), 4)

    row["x"] = None if x is None else round(max(0.0, min(float(x), 1.0)), 4)
    return row

def reading_order(row: dict) -> tuple:

    y = row.get("y")
    x = row.get("x")
    return (row.get("page", 0), 1 if (x is not None and x >= 0.5) else 0,
            y if y is not None else 0)

def _dest_y(dest, height: float):

    if not height or height <= 0:
        return None
    point = dest.get("to") if isinstance(dest, dict) else None
    top = None
    if point is not None:
        top = getattr(point, "y", None)
        if top is None and isinstance(point, (tuple, list)) and len(point) > 1:
            top = point[1]
    if top is None and isinstance(dest, dict):

        numbers = re.findall(r"-?\d+(?:\.\d+)?", str(dest.get("dest") or ""))
        if len(numbers) >= 2:
            top = float(numbers[1]) if len(numbers) == 2 else float(numbers[-1])
    if top is None:
        return None
    try:
        top = float(top)
    except (TypeError, ValueError):
        return None

    if top <= 0 or top >= height - 1:
        return None
    return max(0.0, min(1.0 - (top / height), 1.0))

def _from_outline(doc) -> list[dict]:
    try:
        rows = doc.get_toc(simple=False)
    except Exception:
        return []
    out = []
    for row in rows[:MAX_ENTRIES]:
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            continue
        level, title, page = row[0], row[1], row[2]
        dest = row[3] if len(row) > 3 and isinstance(row[3], dict) else {}
        try:
            page = int(page)
        except (TypeError, ValueError):
            continue
        if page < 1 or page > len(doc):
            continue
        height = 0.0
        try:
            height = doc[page - 1].rect.height
        except Exception:
            height = 0.0
        entry = _entry(level, title, page, _dest_y(dest, height))
        if entry:
            out.append(entry)
    return out

PLACEHOLDER = re.compile(
    r"^\s*(?:image|img|page|pg|p\.?|slide|scan|sheet|bookmark|untitled|figure)?"
    r"[\s_#-]*\d{0,4}\s*$", re.IGNORECASE)

def _placeholder_outline(entries: list[dict]) -> bool:

    if not entries:
        return False
    blank = sum(1 for e in entries if PLACEHOLDER.match(str(e.get("title") or "")))
    return blank * 2 >= len(entries)

def _rows(page) -> list[dict]:

    out = []
    try:
        blocks = page.get_text("dict", sort=True)["blocks"]
    except Exception:
        return out
    for block in blocks:
        for line in block.get("lines", []):
            spans = [s for s in line.get("spans", []) if s.get("text", "").strip()]
            if not spans:
                continue
            text = "".join(s["text"] for s in spans).strip()
            if not text:
                continue
            first = spans[0]
            font = str(first.get("font", ""))
            out.append({
                "text": text,
                "x0": line["bbox"][0], "x1": line["bbox"][2],
                "y0": line["bbox"][1], "y1": line["bbox"][3],
                "size": round(float(first.get("size", 0)), 1),
                "bold": bool(int(first.get("flags", 0)) & 16)
                        or "bold" in font.lower() or "black" in font.lower(),
                "font": font,
            })
    return out

def _band(row: dict, mid: float) -> int:

    if row["x0"] < mid < row["x1"]:
        return 0
    return 1 if row["x1"] <= mid else 2

def _join_across(rows: list[dict]) -> list[dict]:

    out: list[dict] = []
    for row in sorted(rows, key=lambda r: (r["y0"], r["x0"])):
        prev = out[-1] if out else None
        if (prev and prev["size"] == row["size"] and prev["bold"] == row["bold"]
                and row["x0"] >= prev["x1"] - 1
                and min(prev["y1"], row["y1"]) - max(prev["y0"], row["y0"])
                    > 0.5 * min(prev["y1"] - prev["y0"], row["y1"] - row["y0"])):
            prev["text"] = f"{prev['text']} {row['text']}".strip()
            prev["x1"] = max(prev["x1"], row["x1"])
            prev["y1"] = max(prev["y1"], row["y1"])
            continue
        out.append(dict(row))
    return out

def _repeated(pages: list[list[dict]]) -> set[str]:

    seen: dict[str, set[int]] = {}
    for number, rows in enumerate(pages, 1):
        for row in rows:
            key = re.sub(r"\d+", "#", row["text"].casefold()).strip()
            if key:
                seen.setdefault(key, set()).add(number)
    return {key for key, hits in seen.items() if len(hits) >= RUNNING_HEAD_PAGES}

def _body_size(pages: list[list[dict]]) -> float:

    weight: dict[float, int] = {}
    for rows in pages:
        for row in rows:
            weight[row["size"]] = weight.get(row["size"], 0) + len(row["text"])
    if not weight:
        return 10.0
    return max(weight.items(), key=lambda kv: kv[1])[0]

def _numbering(text: str) -> tuple[str, int] | None:

    if YEAR.match(text):
        return None
    match = NUMBERED.match(text)
    if match:
        return match.group(1), match.group(1).count(".") + 1
    match = ROMAN.match(text)
    if match:
        return match.group(1), match.group(1).count(".") + 1
    return None

def _symbol_heavy(text: str) -> bool:

    solid = [ch for ch in text if not ch.isspace()]
    if not solid:
        return True
    letters = sum(1 for ch in solid if ch.isalpha())
    return letters / len(solid) < 0.6

def _titled(text: str) -> str:

    number = _numbering(text)
    if not number:
        return text.strip()
    return text[len(number[0]):].strip(" .)-:–—")

def _is_heading(row: dict, body: float, repeats: set[str]) -> bool:

    text = row["text"]
    if not (2 <= len(text) <= MAX_TITLE) or len(text.split()) > MAX_WORDS:
        return False
    if NOT_WORDS.match(text) or JUNK.match(text):
        return False
    if re.sub(r"\d+", "#", text.casefold()).strip() in repeats:
        return False

    if (text.endswith((".", ",", ";")) and not _numbering(text)
            and not text.isupper()):
        return False
    if EQUATION.search(text) or _symbol_heavy(text):
        return False

    if not (row["bold"] or row["size"] >= body + 0.5):
        return False
    rest = _titled(text)
    numbered = _numbering(text) is not None and bool(HAS_WORD.search(rest.upper()))
    caps = (text.isupper() and 1 <= len(text.split()) <= 8
            and bool(HAS_WORD.search(text)) and not YEAR.match(text))
    return bool(numbered or caps)

def _join_down(rows: list[dict]) -> list[dict]:

    out: list[dict] = []
    for row in rows:
        prev = out[-1] if out else None
        gap = row["y0"] - prev["y1"] if prev else 0
        line_h = max(prev["y1"] - prev["y0"], 1) if prev else 1
        if (prev and prev["page"] == row["page"]
                and prev.get("band") == row.get("band")
                and prev["size"] == row["size"] and prev["bold"] == row["bold"]
                and prev["font"] == row["font"]
                and -0.2 * line_h <= gap <= 0.9 * line_h
                and not prev["text"].endswith((".", "?"))
                and _numbering(row["text"]) is None):
            prev["text"] = f"{prev['text']} {row['text']}".strip()
            prev["y1"] = max(prev["y1"], row["y1"])
            continue
        out.append(dict(row))
    return out

def _levels(rows: list[dict]) -> list[dict]:

    sizes = sorted({row["size"] for row in rows}, reverse=True)
    rank = {size: index + 1 for index, size in enumerate(sizes[:4])}
    out, seen = [], set()
    for row in rows:
        if not _titled(row["text"]):
            continue
        number = _numbering(row["text"])
        level = number[1] if number else rank.get(row["size"], 2)
        entry = _entry(level, row["text"], row["page"], row["y"], row.get("x"))
        if not entry:
            continue

        key = (entry["page"], round(entry["y"] or 0, 3), entry["title"].casefold())
        if key in seen:
            continue
        seen.add(key)
        out.append(entry)
    return out

def _detect(doc) -> list[dict]:

    count = min(len(doc), MAX_PAGES)
    pages, heights = [], []
    for number in range(count):
        try:
            page = doc[number]
        except Exception:
            pages.append([])
            heights.append(792.0)
            continue
        pages.append(_rows(page))
        heights.append(page.rect.height or 792.0)
    if not any(pages):
        return []

    repeats = _repeated(pages)
    body = _body_size(pages)

    found: list[dict] = []
    for number, rows in enumerate(pages, 1):
        if not rows:
            continue
        mid = max((row["x1"] for row in rows), default=612.0) / 2
        page_height = heights[number - 1] or 792.0
        for row in _join_across(rows):
            if not _is_heading(row, body, repeats):
                continue
            row = dict(row)
            row["page"] = number
            row["band"] = _band(row, mid)
            row["y"] = max(0.0, min(row["y0"] / page_height, 1.0))
            row["x"] = max(0.0, min(row["x0"] / (mid * 2 or 612.0), 1.0))
            found.append(row)
        if len(found) > MAX_ENTRIES:
            break

    found.sort(key=lambda r: (r["page"], r["band"], r["y0"]))
    return _levels(_join_down(found))[:MAX_ENTRIES]

def read(path) -> dict:

    path = Path(path)
    try:
        stat = path.stat()
    except OSError:
        return empty("the file is not where the record says it is")
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    if key in _MEMO:
        return _MEMO[key]

    result = _read_uncached(path)
    if len(_MEMO) >= _MEMO_MAX:
        _MEMO.clear()
    _MEMO[key] = result
    return result

def _read_uncached(path: Path) -> dict:
    try:
        import pymupdf as fitz
    except ImportError:
        return empty("no PDF reader on this Mac")
    try:
        document = fitz.open(path)
    except Exception as exc:
        return empty(f"this file does not open as a PDF ({type(exc).__name__})")
    with document as doc:
        if doc.needs_pass:
            return empty("this PDF is locked")
        pages = len(doc)
        if pages > MAX_PAGES:
            return empty(f"longer than the {MAX_PAGES} pages read for contents")
        entries = _from_outline(doc)
        if entries and _placeholder_outline(entries):

            return {"source": "none", "entries": [], "pages": pages,
                    "why": "this is a scan: its only outline names the scanned "
                           "pages (\u201cimage 1\u201d, \u201cimage 2\u201d), not the "
                           "paper\u2019s sections"}
        if entries:
            return {"source": "file", "entries": entries, "pages": pages,
                    "why": "the outline the publisher wrote into the file"}
        entries = _detect(doc)

        if len(entries) >= 2:
            return {"source": "detected", "entries": entries, "pages": pages,
                    "why": "headings recognised by size, weight and numbering; "
                           "this is Lancetfish’s reading, not the file's own"}
        return {"source": "none", "entries": [], "pages": pages,
                "why": "this file carries no outline, and no headings stood out "
                       "from its text"}

ADMIN = re.compile(
    r"^\s*(?:\d{1,2}(?:\.\d{1,2})*[.)]?\s*)?"
    r"(?:abstract|keywords?|key words|references?|bibliography|works cited"
    r"|literature cited|acknowledge?ments?|funding|financial support"
    r"|credit author(?:ship)? contribution statement|credit author statement"
    r"|author contributions?|declarations? of(?: competing)? interests?"
    r"|competing interests?|conflicts? of interest|data availability"
    r"|code availability|supplementary (?:materials?|information)"
    r"|supplemental materials?|appendix(?:es)?|appendices|online appendix"
    r"|endnotes?|notes|about the authors?|biograph(?:y|ies)|orcid"
    r"|ethics (?:approval|statement)|informed consent)\b",
    re.IGNORECASE)

MAX_DIVIDERS = 12

def divider_sections(toc: dict, limit: int = MAX_DIVIDERS) -> list[dict]:

    entries = [row for row in (toc or {}).get("entries") or []
               if not ADMIN.match(row.get("title", ""))]
    rows = agenda({**(toc or {}), "entries": entries})
    return rows[:max(0, int(limit))]

def with_manual(extracted: dict, manual) -> dict:

    rows = []
    for row in (manual or []):
        if not isinstance(row, dict):
            continue
        entry = _entry(row.get("level", 1), row.get("title", ""),
                       row.get("page", 0), row.get("frac"), row.get("x"))
        if entry:
            rows.append(entry)
    if not rows:
        return extracted if isinstance(extracted, dict) else empty()
    rows.sort(key=reading_order)

    hand = any(str(row.get("by") or "reader") == "reader" for row in (manual or [])
               if isinstance(row, dict))
    return {"source": "reader" if hand else "marlin",
            "entries": rows[:MAX_ENTRIES],
            "pages": (extracted or {}).get("pages") or 0,
            "why": ("the sections you marked yourself" if hand else
                    "sections Marlin read off the pages; correct any of them "
                    "and the outline becomes yours")}

def agenda(toc: dict) -> list[dict]:

    entries = (toc or {}).get("entries") or []
    for level in (1, 2, 3):
        rows = [row for row in entries if row.get("level") == level]
        if len(rows) >= 2:
            return rows
    return []
