from __future__ import annotations

import bisect
import math
import threading
from pathlib import Path

MAX_PAGES = 400

COVER = 0.85

PROBE_PAGES = 3

ZOOM = 2.0

LETTER = 0.30

STRETCH = (0.35, 1.6)

FIT = 0.3

ASCENT, DESCENT = 1.55, 0.5

_MEMO: dict[tuple, dict] = {}
_MEMO_MAX = 32

_LOCK = threading.Lock()

def _is_scan(page) -> bool:
    area = abs(page.rect) or 1.0
    try:
        infos = page.get_image_info()
    except Exception:
        return False
    for info in infos:
        box = info.get("bbox")
        if box is None:
            continue
        x0, y0, x1, y1 = box
        if (x1 - x0) * (y1 - y0) >= COVER * area:
            return True
    return False

def _ocr_lines(page) -> list[dict]:

    try:
        import pymupdf as fitz

        raw = page.get_text("words", flags=fitz.TEXTFLAGS_WORDS & ~fitz.TEXT_MEDIABOX_CLIP)
    except Exception:
        return []
    groups: dict[tuple, list] = {}
    for x0, y0, x1, y1, text, block, line, _ in raw:
        groups.setdefault((block, line), []).append((x0, y0, x1, y1, text))
    lines: list[dict] = []
    for words in groups.values():
        words.sort()
        row = {"x0": words[0][0], "x1": words[-1][2],
               "y0": min(w[1] for w in words), "y1": max(w[3] for w in words),
               "words": words, "text": " ".join(w[4] for w in words)}
        twin = next((r for r in lines if r["text"] == row["text"]
                     and abs(r["y1"] - row["y1"]) < 2 and abs(r["x0"] - row["x0"]) < 3),
                    None)
        if twin is None:
            lines.append(row)
        elif row["x1"] - row["x0"] < twin["x1"] - twin["x0"]:
            lines[lines.index(twin)] = row
    return lines

def _otsu(hist: list[int]) -> int:

    total = sum(hist)
    weighted = sum(i * n for i, n in enumerate(hist))
    below = below_sum = 0
    best, cut = -1.0, 128
    for level, n in enumerate(hist):
        below += n
        if not below:
            continue
        above = total - below
        if not above:
            break
        below_sum += level * n
        gap = below_sum / below - (weighted - below_sum) / above
        spread = below * above * gap * gap
        if spread > best:
            best, cut = spread, level
    return cut

def _ink(page):

    try:
        import pymupdf as fitz
        from PIL import Image
        pix = page.get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM),
                              colorspace=fitz.csGRAY, alpha=False)
        grey = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    except Exception:
        return None
    cut = min(max(_otsu(grey.histogram()), 60), 200)
    return grey.point(lambda v: 255 if v < cut else 0)

def _profile(ink, box, rows: bool) -> tuple[int, list[float]]:

    from PIL import Image
    x0, y0 = max(int(box[0] * ZOOM), 0), max(int(box[1] * ZOOM), 0)
    x1, y1 = min(int(box[2] * ZOOM), ink.width), min(int(box[3] * ZOOM), ink.height)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return 0, []
    crop = ink.crop((x0, y0, x1, y1))
    size = (1, y1 - y0) if rows else (x1 - x0, 1)
    return (y0 if rows else x0), [v / 255 for v in crop.resize(size, Image.BOX).tobytes()]

def _runs(flags: list[bool], bridge: int = 0) -> list[tuple[int, int]]:

    out: list[tuple[int, int]] = []
    start = end = None
    for i, on in enumerate(flags):
        if not on:
            continue
        if start is not None and i - end - 1 > bridge:
            out.append((start, end))
            start = None
        if start is None:
            start = i
        end = i
    if start is not None:
        out.append((start, end))
    return out

def _right_edge(lines: list[dict], i: int, width: float) -> float:

    me = lines[i]
    h = me["y1"] - me["y0"]
    edge = width
    for j, other in enumerate(lines):
        if j == i or other["x0"] <= me["x0"] + 3:
            continue
        shared = min(me["y1"], other["y1"]) - max(me["y0"], other["y0"])
        if shared >= 0.3 * min(h, other["y1"] - other["y0"]):
            edge = min(edge, other["x0"] - 0.5)
    return edge

def _band(ink, line: dict, right: float) -> tuple[float, float] | None:

    h = line["y1"] - line["y0"]
    probe = min(line["x0"] + 0.6 * (line["x1"] - line["x0"]), right)
    if h <= 0 or probe - line["x0"] < 2:
        return None
    first, shares = _profile(ink, (line["x0"], line["y0"] - 0.6 * h,
                                   probe, line["y1"] + 0.6 * h), rows=True)
    peak = max((v for i, v in enumerate(shares)
                if line["y0"] <= (first + i + 0.5) / ZOOM <= line["y1"]), default=0.0)
    if peak < 0.02:
        return None
    best = key = None
    for a, b in _runs([v >= 0.4 * peak for v in shares], bridge=1):
        top, base = (first + a) / ZOOM, (first + b + 1) / ZOOM
        shared = min(base, line["y1"]) - max(top, line["y0"])
        rank = (shared, -abs(top + base - line["y0"] - line["y1"]))
        if key is None or rank > key:
            best, key = (top, base), rank
    if best is None or key[0] <= 0 or not 0.15 * h <= best[1] - best[0] <= 0.8 * h:
        return None
    return best

def _fit(ink, line: dict, band: tuple[float, float], right: float,
         cut_off: bool) -> list[tuple[float, float]] | None:

    top, base = band
    xh = base - top
    words = line["words"]
    x0, width = line["x0"], line["x1"] - line["x0"]
    if width <= 0:
        return None
    first, shares = _profile(ink, (x0 - 2.5 * xh - 1, top - 0.5 * xh,
                                   right, base + 0.25 * xh), rows=False)
    bridge = max(1, round(LETTER * xh * ZOOM)) - 1
    blobs = [((first + a) / ZOOM, (first + b + 1) / ZOOM)
             for a, b in _runs([v > 0 for v in shares], bridge)]

    blobs = [b for b in blobs if b[1] > x0 - 2.5 * xh]
    must = next((k for k, b in enumerate(blobs) if b[1] > x0 + 0.5), None)
    n, m = len(words), len(blobs)
    if must is None or m - must < n or blobs[must][0] > x0 + max(4.0, xh):
        return None
    left = blobs[must][0]
    starts = [b[0] for b in blobs]
    stops = [b[1] for b in blobs]
    marks = [w[0] - x0 for w in words[1:]]

    def miss(points: list[float], x: float) -> float:
        i = bisect.bisect_left(points, x)
        return min([abs(points[j] - x) for j in (i - 1, i) if 0 <= j < len(points)]
                   + [xh])

    def cost(s: float) -> float:
        c = sum(miss(starts, left + s * d) ** 2 for d in marks)
        c += miss(stops, left + s * width) ** 2

        return c + 0.01 * (xh * (s - 1)) ** 2

    lo, hi = STRETCH
    s = min((lo + i * 0.02 for i in range(round((hi - lo) / 0.02) + 1)), key=cost)
    s = min((s + i * 0.002 for i in range(-10, 11)), key=cost)

    inf = float("inf")
    best = [[inf] * m for _ in range(n)]
    back = [[0] * m for _ in range(n)]
    for i, w in enumerate(words):
        want = s * max(w[2] - w[0], 0.5)
        at = left + s * (w[0] - x0)
        for b in range(i, m - (n - 1 - i)):
            for a in (range(min(b, must), -1, -1) if i == 0 else range(b, i - 1, -1)):
                span = stops[b] - starts[a]
                if span > 2.5 * want + 2 * xh:
                    break
                before = best[i - 1][a - 1] if i else 0.0
                c = before + math.log(span / want) ** 2 + ((starts[a] - at) / (6 * xh)) ** 2
                if c < best[i][b]:
                    best[i][b], back[i][b] = c, a

    def tail(b: int) -> float:

        if b == m - 1 or cut_off or starts[b + 1] - stops[b] >= 1.5 * xh:
            return 0.0
        return inf

    end = min(range(n - 1, m), key=lambda b: best[n - 1][b] + tail(b))
    if best[n - 1][end] + tail(end) == inf:
        return None
    spans: list[tuple[float, float]] = []
    b = end
    for i in range(n - 1, -1, -1):
        a = back[i][b]
        spans.append((starts[a], stops[b]))
        b = a - 1
    spans.reverse()
    off = [abs(math.log((r - q) / (s * max(w[2] - w[0], 0.5))))
           for (q, r), w in zip(spans, words)]
    if sum(off) / n > FIT:
        return None
    return spans

def _page_lines(page) -> list[dict]:

    inv = ~page.transformation_matrix
    lines = _ocr_lines(page)
    ink = _ink(page) if lines else None
    width = page.rect.width
    placed: list[tuple[list | None, tuple | None]] = []
    for i, line in enumerate(lines):
        band = fitted = None
        if ink is not None:
            right = _right_edge(lines, i, width)
            band = _band(ink, line, right)
            if band is not None:
                fitted = _fit(ink, line, band, right, line["x1"] > width - 1)
        placed.append((fitted, band))

    seen = [((band[1] - line["y1"]) / h, (band[1] - band[0]) / h)
            for line, (_, band) in zip(lines, placed)
            if band and (h := line["y1"] - line["y0"]) > 0]

    def median(xs: list[float]) -> float:
        xs = sorted(xs)
        return xs[len(xs) // 2]

    usual = (median([s[0] for s in seen]), median([s[1] for s in seen])) if len(seen) >= 3 else None

    out: list[dict] = []
    dx = inv.e

    def up(y: float) -> float:

        return y * inv.d + inv.f

    for line, (fitted, band) in zip(lines, placed):
        h = line["y1"] - line["y0"]
        if band is None and usual is not None and h > 0:
            base = line["y1"] + usual[0] * h
            band = (base - usual[1] * h, base)
        spans = fitted or [(w[0], w[2]) for w in line["words"]]
        lo, hi = sorted((up(line["y1"]), up(line["y0"])))
        row = {"y0": round(lo, 2), "y1": round(hi, 2),
               "x0": round(line["x0"] + dx, 2), "x1": round(line["x1"] + dx, 2),
               "words": [[w[4], round(a + dx, 2), round(b + dx, 2), round(w[0] + dx, 2)]
                         for w, (a, b) in zip(line["words"], spans)]}
        if band is not None:
            xh = band[1] - band[0]
            ink_lo, ink_hi = sorted((up(band[1] + DESCENT * xh), up(band[1] - ASCENT * xh)))
            row["ink"] = [round(ink_lo, 2), round(ink_hi, 2)]
        out.append(row)
    return out

def read(path, page: int | None = None) -> dict:

    path = Path(path)
    try:
        stat = path.stat()
    except OSError:
        return {"scan": False, "pages": {}}
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    with _LOCK:
        memo = _MEMO.get(key)
        if memo is None:
            if len(_MEMO) >= _MEMO_MAX:
                _MEMO.clear()
            memo = _MEMO[key] = {"scan": None, "pages": {}, "all": False}
        return _answer(path, memo, page)

def _answer(path: Path, memo: dict, page: int | None) -> dict:
    nothing = {"scan": False, "pages": {}}
    if memo["scan"] is False:
        return nothing
    wanted = None if page is None else str(int(page))
    if memo["all"] or (wanted is not None and wanted in memo["pages"]):
        return _reply(memo, wanted)
    try:
        import pymupdf as fitz
        doc = fitz.open(path)
    except Exception:
        memo["scan"] = False
        return nothing
    with doc:
        if memo["scan"] is None:
            if doc.needs_pass or len(doc) > MAX_PAGES:
                memo["scan"] = False
            else:
                probe = [doc[i] for i in range(min(len(doc), PROBE_PAGES))]
                memo["scan"] = any(_is_scan(p) and p.get_text("text").strip()
                                   for p in probe)
            if not memo["scan"]:
                return nothing
        numbers = (range(len(doc)) if wanted is None
                   else [int(wanted) - 1] if 1 <= int(wanted) <= len(doc) else [])
        for number in numbers:
            if str(number + 1) in memo["pages"]:
                continue
            sheet = doc[number]
            lines = _page_lines(sheet) if _is_scan(sheet) and sheet.rotation == 0 else []
            memo["pages"][str(number + 1)] = lines
        if wanted is None:
            memo["all"] = True
    return _reply(memo, wanted)

def _reply(memo: dict, wanted: str | None) -> dict:
    pages = {n: lines for n, lines in memo["pages"].items()
             if lines and (wanted is None or n == wanted)}
    if wanted is None:
        return {"scan": bool(pages), "pages": pages}
    return {"scan": True, "pages": pages}
