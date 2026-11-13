(function (global) {
  "use strict";

  const COLORS = ["yellow", "green", "pink"];
  const DEFAULT_COLOR = "yellow";

  const WRITING_SIZES = [1.1, 1.6, 2.4];
  const WRITING_SIZE_NAMES = ["S", "M", "L"];

  const DRAWING_SIZES = [2.5, 4.5, 8];

  const INK_UNITS = 1000;

  const SWAPS = { "->": "→", "<-": "←", "←>": "↔", "-→": "→",
                  "<=": "≤", ">=": "≥", "!=": "≠", "~~": "≈", "+-": "±" };

  const BOX_GRAB = 6;

  function onBoxEdge(r, x, y, px, py) {
    const outer = x >= r.x - px && x <= r.x + r.w + px
      && y >= r.y - py && y <= r.y + r.h + py;
    const inner = x > r.x + px && x < r.x + r.w - px
      && y > r.y + py && y < r.y + r.h - py;
    return outer && !inner;
  }

  const ZOOMS = [0.4, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 6;

  const MAX_CANVAS_PX = 12e6;

  const AUTOSAVE_MS = 900;
  const RETRY_MS = 6000;

  const HISTORY_MAX = 60;
  const SETTLE_MS = 320;

  const QUIET_MS = 5000;

  const SAFE_URL = /^(https?:|mailto:)/i;

  const PEEK_W = 520;
  const PEEK_H = 320;
  const PEEK_LEAD = 26;

  const PEEK_PAGES = 4;

  const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
  const round5 = (n) => Math.round(n * 1e5) / 1e5;

  function toFraction(rect, box) {
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const x = clamp01((rect.left - box.left) / box.width);
    const y = clamp01((rect.top - box.top) / box.height);
    const w = clamp01((rect.right - box.left) / box.width) - x;
    const h = clamp01((rect.bottom - box.top) / box.height) - y;
    if (w <= 0.0005 || h <= 0.0005) return null;
    return { x: round5(x), y: round5(y), w: round5(w), h: round5(h) };
  }

  function unionRect(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return {
      x: round5(x), y: round5(y),
      w: round5(Math.max(a.x + a.w, b.x + b.w) - x),
      h: round5(Math.max(a.y + a.h, b.y + b.h) - y),
    };
  }

  function sameLine(a, b) {
    const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (overlap <= 0) return false;
    if (overlap < 0.55 * Math.min(a.h, b.h)) return false;
    const gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
    return gap <= 0.012;
  }

  function mergeRects(rects) {
    const rows = rects.filter(Boolean).slice()
      .sort((p, q) => (p.y - q.y) || (p.x - q.x));
    const out = [];
    for (const r of rows) {
      const hit = out.findIndex((o) => sameLine(o, r));
      if (hit < 0) out.push({ ...r });
      else out[hit] = unionRect(out[hit], r);
    }

    if (out.length && out.length < rows.length) {
      const again = mergeRects(out);
      if (again.length < out.length) return again;
    }
    return out.sort((p, q) => (p.y - q.y) || (p.x - q.x));
  }

  function rectsHit(rects, x, y, pad) {
    const p = pad || 0;
    return (rects || []).some((r) =>
      x >= r.x - p && x <= r.x + r.w + p && y >= r.y - p && y <= r.y + r.h + p);
  }

  function tidyQuote(text) {
    return String(text || "")
      .replace(/­/g, "")
      .replace(/([A-Za-z])-\n\s*([a-z])/g, "$1$2")
      .replace(/\s*\n\s*/g, " ")
      .replace(/[ \t ]+/g, " ")
      .trim();
  }

  function joinLines(pieces) {
    let out = "", line = null;
    for (const piece of pieces || []) {
      const text = piece && piece.text ? String(piece.text) : "";
      if (!text) continue;
      const top = Number(piece.top) || 0;
      if (line !== null && Math.abs(top - line) > 1
          && !/\s$/.test(out) && !/^\s/.test(text)) out += " ";
      out += text;
      line = top;
    }
    return out;
  }

  function hasNote(highlight) {
    return !!(highlight && String(highlight.note || "").trim());
  }

  function pickCurrent(entries) {
    let best = null;
    for (const e of entries) {
      if (!e.ratio) continue;
      if (!best || e.ratio > best.ratio + 0.02
          || (Math.abs(e.ratio - best.ratio) <= 0.02 && e.page < best.page)) {
        best = e;
      }
    }
    return best ? best.page : null;
  }

  function boxFraction(quad, width, height) {
    if (!quad || quad.length < 4) return null;
    if (!(width > 0) || !(height > 0)) return null;
    const x1 = Math.min(quad[0], quad[2]), x2 = Math.max(quad[0], quad[2]);
    const y1 = Math.min(quad[1], quad[3]), y2 = Math.max(quad[1], quad[3]);
    const x = clamp01(x1 / width), y = clamp01(y1 / height);
    const w = clamp01(x2 / width) - x, h = clamp01(y2 / height) - y;
    if (w <= 0.0005 || h <= 0.0005) return null;
    return { x: round5(x), y: round5(y), w: round5(w), h: round5(h) };
  }

  function linkQuads(rect, quadPoints) {
    const out = [];
    if (quadPoints && quadPoints.length >= 8) {
      for (let i = 0; i + 7 < quadPoints.length; i += 8) {
        const xs = [quadPoints[i], quadPoints[i + 2],
                    quadPoints[i + 4], quadPoints[i + 6]];
        const ys = [quadPoints[i + 1], quadPoints[i + 3],
                    quadPoints[i + 5], quadPoints[i + 7]];
        out.push([Math.min.apply(null, xs), Math.min.apply(null, ys),
                  Math.max.apply(null, xs), Math.max.apply(null, ys)]);
      }
      if (out.length) return out;
    }
    if (rect && rect.length >= 4) {
      out.push([rect[0], rect[1], rect[2], rect[3]]);
    }
    return out;
  }

  function destY(dest) {
    if (!Array.isArray(dest) || dest.length < 2) return null;
    const spec = dest[1];
    const name = typeof spec === "string" ? spec : (spec && spec.name);
    const at = (i) => {
      const v = dest[i];
      return typeof v === "number" && isFinite(v) ? v : null;
    };
    if (name === "XYZ") return at(3);
    if (name === "FitH" || name === "FitBH") return at(2);
    if (name === "FitR") return at(5);
    return null;
  }

  function bigJump(from, to, viewport) {
    return Math.abs(to - from) > Math.max((viewport || 0) * 1.5, 400);
  }

  function normalizeRotation(value) {
    const num = Math.round(Number(value));
    if (!isFinite(num)) return 0;
    const turn = ((num % 360) + 360) % 360;
    return turn % 90 === 0 ? turn : 0;
  }

  function rotateRect(r, rot) {
    if (!r) return null;
    const turn = normalizeRotation(rot);
    if (turn === 90) {
      return { x: round5(1 - (r.y + r.h)), y: r.x, w: r.h, h: r.w };
    }
    if (turn === 180) {
      return { x: round5(1 - (r.x + r.w)), y: round5(1 - (r.y + r.h)),
               w: r.w, h: r.h };
    }
    if (turn === 270) {
      return { x: r.y, y: round5(1 - (r.x + r.w)), w: r.h, h: r.w };
    }
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  function unrotateRect(r, rot) {
    return rotateRect(r, 360 - normalizeRotation(rot));
  }

  function rotateFrac(frac, rot) {
    const turn = normalizeRotation(rot);
    if (turn === 180) return round5(clamp01(1 - frac));
    if (turn) return 0;
    return frac;
  }

  function peekWindow(top, pageH, viewH, lead) {
    if (!(pageH > 0) || !(viewH > 0)) return { y: 0, h: 0 };
    const h = Math.min(viewH, pageH);
    let y = (isFinite(top) ? top : 0) - (lead || 0);
    if (y + h > pageH) y = pageH - h;
    if (!(y > 0)) y = 0;
    return { y: round5(y), h: round5(h) };
  }

  function placeFraction(pos, pages) {
    if (!pos || !(pages > 0)) return null;
    const page = Math.round(pos.page) || 0;
    if (page < 1) return null;
    return clamp01((page - 1 + clamp01(pos.frac || 0)) / pages);
  }

  function markFraction(mark, pages) {
    if (!mark || !(pages > 0)) return null;
    const page = Math.round(mark.page) || 0;
    if (page < 1) return null;
    const depth = mark.frac == null ? 1 : clamp01(mark.frac);
    return clamp01((page - 1 + depth) / pages);
  }

  function shelfFraction(lastMarked, pages) {
    const last = Math.round(lastMarked) || 0;
    if (!(pages > 0) || last < 1) return null;
    return clamp01(Math.min(last, pages) / pages);
  }

  function placeAt(fraction, pages) {
    if (!(pages > 0)) return null;
    const into = clamp01(fraction) * pages;
    const page = Math.min(Math.floor(into) + 1, pages);
    return { page: page, frac: round5(clamp01(into - (page - 1))) };
  }

  const SECTION_SLACK = 0.02;

  function sectionFromSelection(parts) {
    if (!Array.isArray(parts) || !parts.length) return null;
    const part = parts[0];
    const page = Math.round(Number(part && part.page)) || 0;
    const rect = part && part.rects && part.rects[0];
    if (page < 1 || !rect) return null;
    const title = tidyQuote(String(part.text || "")).replace(/\s+/g, " ").trim();
    if (!title) return null;

    return { title: title.slice(0, 300), page: page,
             frac: clamp01(rect.y), x: clamp01(rect.x) };
  }

  function sortSections(rows) {
    const depth = (r) => (r && r.frac == null ? 0 : clamp01(r.frac));
    const column = (r) => (r && r.x != null && clamp01(r.x) >= 0.5 ? 1 : 0);
    return (Array.isArray(rows) ? rows.slice() : [])
      .sort((a, b) => ((a.page || 0) - (b.page || 0))
        || (column(a) - column(b)) || (depth(a) - depth(b)));
  }

  function levelFromDrag(level, dx, step) {
    const width = step > 0 ? step : 22;
    const next = Math.round((Number(level) || 1) + dx / width);
    return Math.max(1, Math.min(next, 4));
  }

  function pickSection(entries, page, frac) {
    if (!Array.isArray(entries) || !(page >= 1)) return -1;
    const depth = frac == null ? 0 : clamp01(frac);
    let best = -1;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const at = Math.round(Number(entry && entry.page)) || 0;
      if (at < 1 || at > page) continue;

      if (at === page && entry.y != null
          && clamp01(entry.y) > depth + SECTION_SLACK) continue;
      best = i;
    }
    return best;
  }

  const FIND_QUOTES = { "‘": "'", "’": "'", "‚": "'", "‛": "'",
                        "′": "'", "“": '"', "”": '"', "„": '"',
                        "″": '"' };
  const FIND_HYPHEN = /[­‐‑‒–—−-]/;

  function foldChar(c) {
    if (FIND_QUOTES[c]) return FIND_QUOTES[c];
    if (FIND_HYPHEN.test(c)) return "";
    if (/\s/.test(c)) return " ";
    return c.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  }

  function findText(pieces) {
    let text = "";
    const pieceOf = [], offsetOf = [];
    let hyphenEnd = false;
    const put = (s, piece, offset) => {
      for (const ch of s) {
        if (ch === " " && (!text || text[text.length - 1] === " ")) continue;
        text += ch;
        pieceOf.push(piece);
        offsetOf.push(offset);
      }
    };
    (pieces || []).forEach((p, i) => {
      const str = (p && p.str) || "";
      let o = 0;
      for (const c of str) {
        const f = foldChar(c);
        if (f) put(f, i, o);
        if (/\S/.test(c)) hyphenEnd = FIND_HYPHEN.test(c);
        o += c.length;
      }
      if (p && p.eol && !hyphenEnd) put(" ", i, str.length);
    });
    return { text, pieceOf, offsetOf };
  }

  function findAll(text, needle) {
    const at = [];
    if (!needle) return at;
    let i = text.indexOf(needle);
    while (i >= 0) { at.push(i); i = text.indexOf(needle, i + needle.length); }
    return at;
  }

  function el(tag, cls, text, parent) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function button(cls, text, parent, title) {
    const b = el("button", cls, text, parent);
    b.type = "button";
    if (title) b.title = title;
    return b;
  }

  function newId() {
    return "h" + Date.now().toString(36)
      + Math.random().toString(36).slice(2, 8);
  }

  function clockLabel(date) {
    try {
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit",
                                           second: "2-digit" });
    } catch (_) { return date.toTimeString().slice(0, 8); }
  }

  function grow(area) {
    area.style.height = "auto";
    area.style.height = Math.min(area.scrollHeight + 2, 460) + "px";
  }

  let pdfjsPromise = null;
  function loadPdfjs(assets) {
    if (!pdfjsPromise) {
      pdfjsPromise = import(assets.lib).then((mod) => {
        mod.GlobalWorkerOptions.workerSrc = assets.worker;
        return mod;
      });
    }
    return pdfjsPromise;
  }

  function mount(host, opts) {
    const options = Object.assign({
      title: "", url: "", autosaveMs: AUTOSAVE_MS,
      load: async () => ({}), save: async (doc) => doc,
      onState: null,

      onActivity: null,

      lookup: null,

      study: null,

      showTitle: true,

      body: null,

      resume: true,

      startPage: 0,

      toc: null,

      draftToc: null,

      words: null,

      chat: null,

      heard: null,

      onPage: null,
    }, opts || {});
    const assets = Object.assign({
      lib: "/vendor/pdfjs/pdf.min.mjs",
      worker: "/vendor/pdfjs/pdf.worker.min.mjs",
      cmaps: "/vendor/pdfjs/cmaps/",
      fonts: "/vendor/pdfjs/standard_fonts/",
      wasm: "/vendor/pdfjs/wasm/",
      icc: "/vendor/pdfjs/iccs/",
    }, options.assets || {});

    let pdf = null;
    let sheets = [];

    let scale = 1;
    let fitMode = "width";
    let zoomRender = null;
    let refitFrame = null;
    let settleFits = [];
    let current = 1;
    let reading = { highlights: [], comments: {}, rotations: {}, contents: [],
                    writings: [], drawings: [] };
    let dirty = false, saving = false, savedAt = null, saveError = null;
    let readingLoaded = false;
    let saveTimer = null, statusTimer = null, saveFlight = null;
    let destroyed = false;
    let popupFor = null;
    let noteEditingId = null;
    let pendingSelection = null;
    const boxColor = "pink";
    const visible = new Map();

    const backStack = [];
    const fwdStack = [];
    let settled = null;
    let settleTimer = null;
    let ourScroll = false;
    let quietUntil = 0;
    let hotLink = null;
    let peekFor = null;
    let peekToken = 0;

    const peekPages = new Map();

    const reached = new Set();
    let railFrame = null;
    let railNoteTimer = null;
    let scrubbing = false;

    let tocEntries = [], tocRows = [], tocFetched = [];
    let tocSource = "none", tocWhy = "", tocAt = -2;

    let tocManual = false;
    let tocCarry = null;
    let tocDrafting = false;
    let tocDraftNote = "";

    let chatTab = "notes";
    let chatRows = [];
    let chatLoaded = false, chatBusy = false;
    let chatCarried = null;

    let heardTakes = null, heardBusy = false, heardError = "";

    const find = { needle: "", pages: [], indexed: 0, indexing: null,
                   hits: [], at: -1, ranges: new Map(), pending: null,
                   jumped: false };

    const root = el("div", "pr", null, host);
    root.tabIndex = -1;

    root.classList.add("pr-no-toc");

    const bar = el("div", "pr-bar", null, root);
    const barL = el("div", "pr-bar-l", null, bar);
    const titleEl = el("div", "pr-title", options.title || "", barL);
    titleEl.title = options.title || "";
    titleEl.hidden = !options.showTitle;

    const barC = el("div", "pr-bar-c", null, bar);

    const backBtn = button("pr-icon pr-nav", "←", barC, "Back (⌥←)");
    const fwdBtn = button("pr-icon pr-nav", "→", barC, "Forward (⌥→)");
    el("span", "pr-sep", null, barC);
    const prevBtn = button("pr-icon", "‹", barC, "Previous page");
    const pageBox = el("div", "pr-pagebox", null, barC);
    const pageInput = el("input", "pr-pageno", null, pageBox);
    pageInput.type = "text";
    pageInput.inputMode = "numeric";
    pageInput.setAttribute("aria-label", "Page");
    pageInput.value = "1";
    const pageCount = el("span", "pr-pagecount", "/ –", pageBox);
    const nextBtn = button("pr-icon", "›", barC, "Next page");
    el("span", "pr-sep", null, barC);
    const zoomOut = button("pr-icon", "−", barC, "Zoom out (⌘−)");
    const zoomLabel = button("pr-zoom", "100%", barC, "Back to 100 % (⌘0 fits)");
    const zoomIn = button("pr-icon", "+", barC, "Zoom in (⌘+)");
    const fitBtn = button("pr-chip", "Fit", barC,
                          "Fit the page to the width of the well (⌘0)");
    el("span", "pr-sep", null, barC);

    const rotBtn = button("pr-icon pr-rot", "⟳", barC, "");

    const boxBtn = button("pr-icon pr-box", "▭", barC,
                          "Draw a rectangle: drag over a figure or a table (r)");

    const writeBtn = button("pr-icon pr-write", "✎", barC,
                            "Write on the page: click where the words go (w)");
    const drawBtn = button("pr-icon pr-draw", "〰", barC,
                           "Draw freehand on the page (d) · ⌘Z takes back a stroke");

    const barR = el("div", "pr-bar-r", null, bar);
    const saveState = el("span", "pr-save", "", barR);

    const tocBtn = button("pr-chip", "Contents", barR,
                          "Show or hide the contents panel");
    tocBtn.hidden = true;
    const notesBtn = button("pr-chip pr-chip-on", "Notes", barR,
                            "Show or hide the notes panel");

    const askBtn = button("pr-chip", options.chat && options.chat.who !== "Ask"
                          ? "Ask " + (options.chat.who || "Marlin") : "Ask", barR,
                          "Ask about this paper (m)");
    askBtn.hidden = !options.chat;

    const rail = el("div", "pr-rail", null, root);
    rail.hidden = true;
    const railRead = el("span", "pr-rail-pct", "", rail);
    const railTrack = el("div", "pr-rail-track", null, rail);
    const railTail = el("i", "pr-rail-tail", null, railTrack);
    railTail.hidden = true;
    const railFill = el("i", "pr-rail-fill", null, railTrack);
    const railMark = el("i", "pr-rail-mark", null, railTrack);
    railMark.hidden = true;
    const railLeft = el("span", "pr-rail-pct pr-rail-left", "", rail);

    const railNote = el("span", "pr-rail-note", "", rail);
    railNote.hidden = true;

    const body = el("div", "pr-body", null, root);

    const tocEl = el("aside", "pr-toc", null, body);
    const tocHead = el("div", "pr-toc-head", null, tocEl);
    el("span", "pr-toc-title", "Contents", tocHead);
    const tocNote = el("span", "pr-toc-note", "", tocHead);
    const tocEdit = button("pr-toc-edit", "Mark sections", tocHead,
                           "Mark the sections yourself, when the paper will "
                           + "not give up its own");

    const tocAsk = button("pr-toc-ask", "Ask Marlin", tocHead,
                          "Marlin reads the pages and proposes the sections. "
                          + "Correct any of them and the outline becomes yours.");
    tocAsk.hidden = true;
    const tocList = el("div", "pr-toc-list", null, tocEl);

    const scroller = el("div", "pr-scroll", null, body);
    const pagesEl = el("div", "pr-pages", null, scroller);
    const loading = el("div", "pr-loading", "Opening…", pagesEl);

    const side = el("aside", "pr-side", null, body);
    const sideHead = el("div", "pr-side-head", null, side);
    const sideTitle = el("span", "pr-side-title", "Notes", sideHead);

    const sideTabs = el("div", "pr-side-tabs", null, sideHead);
    sideTabs.hidden = !(options.chat || options.heard);
    sideTitle.hidden = !(sideTabs.hidden);
    const notesTab = button("pr-side-tab pr-side-tab-on", "Notes", sideTabs,
                            "Your highlights and margin notes");
    const chatTabBtn = button("pr-side-tab",
                              options.chat ? (options.chat.who || "Marlin") : "Ask",
                              sideTabs, "Ask about this paper (m)");
    chatTabBtn.hidden = !options.chat;
    const heardTabBtn = button("pr-side-tab", "Heard", sideTabs,
                               "What was said while this page was open");
    heardTabBtn.hidden = !options.heard;
    const sideCount = el("span", "pr-side-count", "", sideHead);
    const sideList = el("div", "pr-side-list", null, side);

    const chatEl = el("div", "pr-chat", null, side);
    chatEl.hidden = true;
    const heardEl = el("div", "pr-heard", null, side);
    heardEl.hidden = true;
    const chatShortcuts = el("div", "pr-chat-shortcuts", null, chatEl);
    const configuredShortcuts = options.chat && Array.isArray(options.chat.shortcuts)
      ? options.chat.shortcuts.filter((item) => item && item.label && item.message)
      : [];
    chatShortcuts.hidden = !configuredShortcuts.length;
    const shortcutButtons = configuredShortcuts.map((item) =>
      button("pr-chat-shortcut", item.label, chatShortcuts, item.title || item.label));
    const chatLog = el("div", "pr-chat-log", null, chatEl);
    chatLog.setAttribute("role", "log");
    chatLog.setAttribute("aria-live", "polite");
    const chatFoot = el("form", "pr-chat-foot", null, chatEl);

    const chatCarry = el("div", "pr-chat-carry", null, chatFoot);
    chatCarry.hidden = true;
    const chatCarryText = el("span", "pr-chat-carry-text", "", chatCarry);
    const chatCarryDrop = button("pr-chat-carry-drop", "×", chatCarry,
                                 "Ask without this passage");
    const chatInput = el("textarea", "pr-chat-input", null, chatFoot);
    chatInput.rows = 3;
    chatInput.placeholder = "What was the task, and what did they find?";
    chatInput.setAttribute("aria-label", "Ask about this paper");
    const chatActions = el("div", "pr-chat-actions", null, chatFoot);
    const chatClear = button("pr-chat-clear", "Clear", chatActions,
                             "Forget this conversation. Your marks, the "
                             + "takeaway and the shelf are not touched.");
    chatClear.hidden = !(options.chat && options.chat.clear);
    const chatSend = button("pr-chat-send", "Ask", chatActions, "Send (Enter)");
    chatSend.type = "submit";

    const pop = el("div", "pr-pop", null, root);
    pop.hidden = true;

    const tip = el("div", "pr-linktip", null, root);
    tip.hidden = true;

    const peek = el("div", "pr-peek", null, root);
    peek.hidden = true;
    const peekHead = el("div", "pr-peek-head", "", peek);
    const peekView = el("div", "pr-peek-view", null, peek);
    const peekCanvas = el("canvas", "pr-peek-canvas", null, peekView);

    const findBar = el("form", "pr-find", null, root);
    findBar.hidden = true;
    findBar.setAttribute("role", "search");
    const findInput = el("input", "pr-find-input", null, findBar);
    findInput.type = "search";
    findInput.placeholder = "Find in paper";
    findInput.setAttribute("aria-label", "Find in paper");
    findInput.spellcheck = false;
    const findCount = el("span", "pr-find-count", "", findBar);
    findCount.setAttribute("aria-live", "polite");
    const findPrev = button("pr-icon pr-find-step", "↑", findBar, "Previous match (⇧↵, ⇧⌘G)");
    const findNext = button("pr-icon pr-find-step", "↓", findBar, "Next match (↵, ⌘G)");
    const findClose = button("pr-icon pr-find-step", "×", findBar, "Close (Esc)");

    function swatches(parent, active, onPick) {
      const wrap = el("div", "pr-swatches", null, parent);
      for (const color of COLORS) {
        const dot = button("pr-dot pr-dot-" + color, "", wrap,
                           color[0].toUpperCase() + color.slice(1));
        if (color === active) dot.classList.add("pr-dot-on");
        dot.addEventListener("mousedown", (ev) => ev.preventDefault());
        dot.addEventListener("click", () => onPick(color));
      }
      return wrap;
    }

    function activity(what) {
      if (options.onActivity) {
        try { options.onActivity(what); } catch (_) {}
      }
    }

    function markDirty() {
      if (!readingLoaded) return;
      dirty = true;
      paintSave();

      paintRail();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flush(), options.autosaveMs);
    }

    function flush(force) {
      if (!readingLoaded || destroyed || saving || (!dirty && !force)) return saveFlight || Promise.resolve();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      saving = true; dirty = false; saveError = null;
      paintSave();
      const snapshot = serialize();
      saveFlight = (async () => {
        try {
          const stored = await Promise.resolve().then(() => options.save(snapshot));
          savedAt = new Date();
          if (stored && stored.updated) savedAt = new Date(stored.updated);
        } catch (err) {
          saveError = err && err.message ? err.message : String(err);
          dirty = true;
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => flush(), RETRY_MS);
        } finally {
          saving = false;
          saveFlight = null;
          paintSave();
        }
      })();
      return saveFlight;
    }

    async function saveStable() {
      while (saving || dirty) {
        await (saveFlight || flush());
        if (saveError) throw new Error(saveError);
        if (destroyed) throw new Error("Reader closed before saving completed");
      }
    }

    function serialize() {
      return {
        ...reading,
        version: 1,
        pages: pdf ? pdf.numPages : 0,
        highlights: reading.highlights.map((h) => ({
          ...h,
          id: h.id, page: h.page, color: h.color, rects: h.rects,
          text: h.text, note: h.note, created: h.created,
          ...(h.shape ? { shape: h.shape } : {}),
        })),
        comments: reading.comments,
        rotations: reading.rotations,
        writings: reading.writings.filter((w) => w.text.trim()),
        drawings: reading.drawings,
        contents: reading.contents,
      };
    }

    function paintSave() {
      let text = "", title = "";
      if (saveError) {
        text = "⚠ save failed — retrying";
        title = saveError;
      } else if (saving) {
        text = "saving…";
      } else if (dirty) {
        text = "unsaved…";
      } else if (savedAt) {
        text = "saved · " + clockLabel(savedAt);
        title = savedAt.toString();
      } else {
        text = "no changes yet";
      }
      saveState.textContent = text;
      saveState.title = title;
      saveState.classList.toggle("pr-save-warn", !!saveError);
      if (options.onState) {
        options.onState({
          dirty, saving, savedAt, error: saveError,
          highlights: reading.highlights.length,
          comments: Object.keys(reading.comments).length,
          pages: new Set([...reading.highlights.map(h => h.page),
                          ...Object.keys(reading.comments).map(Number)]).size,
        });
      }
    }

    function rotOf(page) {
      return normalizeRotation(reading.rotations[String(page)]);
    }

    function viewRects(rects, rot) {
      if (!rot) return rects || [];
      return (rects || []).map((r) => rotateRect(r, rot));
    }

    function sheetSize(sheet) {
      const vp = sheet.base;
      return rotOf(sheet.num) % 180
        ? { width: vp.height, height: vp.width }
        : { width: vp.width, height: vp.height };
    }

    function layoutSheet(sheet) {
      const vp = sheetSize(sheet);
      const w = Math.floor(vp.width * scale);
      const h = Math.floor(vp.height * scale);
      sheet.page.style.width = w + "px";
      sheet.page.style.height = h + "px";
      sheet.page.style.setProperty("--total-scale-factor", String(scale));
      sheet.page.style.setProperty("--pw", w + "px");
    }

    function sheetDensity(sheet, want) {
      const dpr = Math.min(Math.max(global.devicePixelRatio || 1, 1), 4);
      const size = sheetSize(sheet);
      const px = size.width * want * dpr * size.height * want * dpr;
      if (!(px > MAX_CANVAS_PX)) return dpr;

      const fit = dpr * Math.sqrt(MAX_CANVAS_PX / px);
      return Math.max(1, Math.round(fit * 20) / 20);
    }

    async function renderSheet(sheet) {
      if (!pdf || sheet.rendering) return;

      ensureLinks(sheet);
      const want = scale;
      const turn = rotOf(sheet.num);
      const dpr = sheetDensity(sheet, want);
      if (sheet.renderedAt === want && sheet.renderedRot === turn
          && sheet.renderedDpr === dpr
          && sheet.canvas.width) return;
      sheet.rendering = true;

      let stale = false;
      try {
        const page = sheet.proxy || (sheet.proxy = await pdf.getPage(sheet.num));
        if (destroyed) return;

        const rotation = (page.rotate || 0) + turn;
        const vp = page.getViewport({ scale: want * dpr, rotation });
        const canvas = sheet.canvas;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);

        if (sheet.task) { try { sheet.task.cancel(); } catch (_) {} }
        sheet.task = page.render({ canvas, viewport: vp });
        await sheet.task.promise;
        sheet.task = null;
        if (destroyed) return;
        if (scale !== want || rotOf(sheet.num) !== turn
            || sheetDensity(sheet, want) !== dpr) {
          stale = true;
          return;
        }

        if (sheet.textRot !== turn || !sheet.text.firstChild) {
          sheet.text.replaceChildren();
          const content = await page.getTextContent({ includeMarkedContent: true });
          if (destroyed) return;
          const layer = new sheet.TextLayer({
            textContentSource: await wordByWord(oneCopyEach(content), sheet.num),
            container: sheet.text,
            viewport: page.getViewport({ scale: 1, rotation }),
          });
          await layer.render();
          if (destroyed) return;
          sheet.textRot = turn;
          paintFindPage(sheet);
        }
        sheet.renderedAt = want;
        sheet.renderedRot = turn;
        sheet.renderedDpr = dpr;
      } catch (err) {
        if (err && err.name === "RenderingCancelledException") { stale = true; return; }
        if (!destroyed) console.warn("page", sheet.num, err);
      } finally {
        sheet.rendering = false;
        if (stale && !destroyed && sheet.near) renderSheet(sheet);
      }
    }

    function oneCopyEach(content) {
      const items = (content && content.items) || [];
      const runs = new Map();
      let text = 0;
      items.forEach((it, i) => {
        if (typeof it.str !== "string" || !it.str.trim() || !it.transform) return;
        text += 1;
        const key = it.str + "\u0000" + Math.round(it.transform[5]);
        const copies = runs.get(key) || [];
        const twin = copies.find((c) => Math.abs(items[c.i].transform[4] - it.transform[4]) < 3);
        if (!twin) copies.push({ i });
        else if (it.width < items[twin.i].width) twin.i = i;
        runs.set(key, copies);
      });
      const keep = new Set();
      for (const copies of runs.values()) for (const c of copies) keep.add(c.i);
      if (keep.size === text) return content;
      return { ...content,
               items: items.filter((it, i) => typeof it.str !== "string"
                                      || !it.str.trim() || !it.transform || keep.has(i)) };
    }

    const wordsAsked = new Map();
    function scanWords(pageNum) {
      if (!options.words) return Promise.resolve(null);
      if (!wordsAsked.has(pageNum)) {
        wordsAsked.set(pageNum, Promise.resolve().then(() => options.words(pageNum))
          .catch(() => null));
      }
      return wordsAsked.get(pageNum);
    }

    const ascents = new Map();
    function ascentShare(family) {
      if (!ascents.has(family)) {
        let share = 0.8;
        try {
          const ctx = document.createElement("canvas").getContext("2d");
          ctx.font = "30px " + family;
          const m = ctx.measureText("");
          const up = m.fontBoundingBoxAscent;
          const down = Math.abs(m.fontBoundingBoxDescent);
          if (up) share = up / (up + down);
        } catch (_) {  }
        ascents.set(family, share);
      }
      return ascents.get(family);
    }

    function findRun(lines, t, said) {
      for (const line of lines) {
        if (t[5] < line.y0 - 1 || t[5] > line.y1 + 1) continue;
        const at = line.words.findIndex((w) => w[0] === said[0]
          && Math.abs((w.length > 3 ? w[3] : line.x0) - t[4]) < 4);
        if (at < 0 || at + said.length > line.words.length) continue;
        if (said.every((word, k) => line.words[at + k][0] === word)) return { line, at };
      }
      return null;
    }

    async function wordByWord(content, pageNum) {
      const data = await scanWords(pageNum);
      const lines = data && data.scan && data.pages && data.pages[String(pageNum)];
      if (!lines || !lines.length) return content;
      const items = [];
      let spaced = false;
      for (const it of content.items) {
        const t = it.transform;
        const text = typeof it.str === "string" ? it.str : "";
        if (spaced && t && text && !text.trim()) continue;
        spaced = false;
        const said = text.trim() ? text.trim().split(/\s+/) : [];
        const hit = said.length && t && t[1] === 0 && t[2] === 0 && t[3] > 0
          && findRun(lines, t, said);
        if (!hit) { items.push(it); continue; }
        const { line, at } = hit;
        let size = t[3];
        let base = t[5];
        if (line.ink) {
          const style = content.styles && content.styles[it.fontName];
          size = line.ink[1] - line.ink[0];
          base = line.ink[1] - ascentShare(style ? style.fontFamily : "sans-serif") * size;
        }
        const stretch = t[0] * size / t[3];
        const last = at + said.length - 1;
        for (let k = at; k <= last; k++) {
          const [word, x0, x1] = line.words[k];
          const more = k < line.words.length - 1;
          items.push({ ...it,
                       str: more ? word + " " : word,
                       transform: [stretch, 0, 0, size, x0, base],
                       width: (more ? line.words[k + 1][1] : x1) - x0,
                       height: size,
                       hasEOL: k === last ? it.hasEOL : false });
        }
        spaced = last < line.words.length - 1;
      }
      return { ...content, items };
    }

    function releaseSheet(sheet) {
      if (sheet.task) { try { sheet.task.cancel(); } catch (_) {} sheet.task = null; }
      sheet.canvas.width = sheet.canvas.height = 0;
      sheet.text.replaceChildren();
      if (find.ranges.delete(sheet.num)) paintFindMarks();
      sheet.textRot = null;
      sheet.renderedAt = null;
      sheet.renderedRot = null;
      sheet.renderedDpr = null;
    }

    function paintMarks(pageNum) {
      const sheet = sheets[pageNum - 1];
      if (!sheet) return;
      sheet.marks.replaceChildren();
      const turn = rotOf(pageNum);
      for (const h of reading.highlights) {
        if (h.page !== pageNum) continue;
        for (const r of viewRects(h.rects, turn)) {
          const box = el("div", "pr-mark pr-mark-" + h.color
                         + (h.shape === "box" ? " pr-mark-box" : "")
                         + (hasNote(h) ? " pr-mark-noted" : ""), null, sheet.marks);
          box.style.left = (r.x * 100) + "%";
          box.style.top = (r.y * 100) + "%";
          box.style.width = (r.w * 100) + "%";
          box.style.height = (r.h * 100) + "%";
          box.dataset.hl = h.id;
        }
      }
      paintInk(pageNum);
    }

    let writeMode = false;
    let writingColor = "pink";
    let editingId = null;
    let putDownAt = 0;

    function paintInk(pageNum) {
      const sheet = sheets[pageNum - 1];
      if (!sheet || !sheet.ink) return;

      const live = editingId && sheet.ink.querySelector(".pr-writing-editing");
      for (const node of [...sheet.ink.children]) if (node !== live) node.remove();
      const turn = rotOf(pageNum);
      const strokes = reading.drawings.filter((d) => d.page === pageNum);
      if (strokes.length) {
        const svg = inkSvg(sheet);
        sheet.ink.insertBefore(svg, sheet.ink.firstChild);
        for (const d of strokes) svg.appendChild(strokeNode(d, sheet, turn));
      }
      for (const w of reading.writings) {
        if (w.page !== pageNum || w.id === editingId) continue;
        sheet.ink.appendChild(writingNode(w, turn));
      }
    }

    function placeWriting(node, w, turn) {
      const at = rotateRect({ x: w.x, y: w.y, w: 0, h: 0 }, turn);
      node.style.left = (at.x * 100) + "%";
      node.style.top = (at.y * 100) + "%";
      node.style.setProperty("--fs", String(w.size));
      node.dataset.color = w.color;
    }

    function writingText(node, text) {
      if (!global.katex) { node.textContent = text; return; }
      const math = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<![\\$])\$([^$\n]+?)(?<!\\)\$(?!\$)/g;
      let at = 0;
      for (const match of text.matchAll(math)) {
        node.appendChild(document.createTextNode(text.slice(at, match.index)));
        const span = document.createElement("span");
        const display = match[1] != null || match[3] != null;
        try {
          global.katex.render(match[1] ?? match[2] ?? match[3] ?? match[4], span,
            { displayMode: display, throwOnError: false, output: "html", strict: "ignore" });
        } catch { span.textContent = match[0]; }
        node.appendChild(span);
        at = match.index + match[0].length;
      }
      node.appendChild(document.createTextNode(text.slice(at)));
    }

    function writingNode(w, turn) {
      const node = el("div", "pr-writing", null, null);
      writingText(node, w.text);
      node.dataset.w = w.id;
      placeWriting(node, w, turn);
      node.addEventListener("pointerdown", (ev) => grabWriting(ev, w, node));
      node.addEventListener("click", (ev) => ev.stopPropagation());
      node.addEventListener("dblclick", (ev) => {
        ev.stopPropagation(); editWriting(w);
      });
      return node;
    }

    function grabWriting(ev, w, node) {
      if (ev.button !== 0 || w.id === editingId) return;
      ev.stopPropagation();
      ev.preventDefault();
      const sheet = sheets[w.page - 1];
      const box = sheet.page.getBoundingClientRect();
      const turn = rotOf(w.page);
      const start = rotateRect({ x: w.x, y: w.y, w: 0, h: 0 }, turn);
      const x0 = ev.clientX, y0 = ev.clientY;
      let moved = false;
      const move = (e) => {
        const dx = e.clientX - x0, dy = e.clientY - y0;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        if (!moved) hidePopup();
        moved = true;
        const at = { x: clamp01(start.x + dx / box.width),
                     y: clamp01(start.y + dy / box.height), w: 0, h: 0 };
        node.style.left = (at.x * 100) + "%";
        node.style.top = (at.y * 100) + "%";
        node._at = at;
      };
      const up = () => {
        global.removeEventListener("pointermove", move);
        global.removeEventListener("pointerup", up);
        if (moved && node._at) {
          const back = unrotateRect(node._at, turn);
          w.x = back.x; w.y = back.y;
          markDirty();
          activity("note");
          return;
        }
        if (writeMode) { editWriting(w); return; }
        showWritingPopup(w, node.getBoundingClientRect());
      };
      global.addEventListener("pointermove", move);
      global.addEventListener("pointerup", up);
    }

    let drawMode = false;
    let stroke = null;
    const drawnNow = [];
    const SVG_NS = "http://www.w3.org/2000/svg";

    function inkSvg(sheet) {
      const size = sheetSize(sheet);
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "pr-drawing");
      svg.setAttribute("viewBox", "0 0 " + INK_UNITS + " "
                       + (INK_UNITS * size.height / size.width));
      svg.setAttribute("preserveAspectRatio", "none");
      return svg;
    }

    function strokePath(d, sheet, turn) {
      const ratio = INK_UNITS * sheetSize(sheet).height / sheetSize(sheet).width;
      return d.points.map((p, i) => {
        const at = rotateRect({ x: p[0], y: p[1], w: 0, h: 0 }, turn);
        return (i ? "L" : "M") + (at.x * INK_UNITS).toFixed(1) + " "
          + (at.y * ratio).toFixed(1);
      }).join("");
    }

    function strokeNode(d, sheet, turn) {
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "pr-stroke");
      g.dataset.color = d.color;
      g.dataset.d = d.id;
      const path = strokePath(d, sheet, turn);
      const line = document.createElementNS(SVG_NS, "path");
      line.setAttribute("d", path);
      line.setAttribute("stroke-width", String(d.size));
      line.setAttribute("class", "pr-stroke-line");
      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", path);
      hit.setAttribute("stroke-width", String(Math.max(d.size, 12)));
      hit.setAttribute("class", "pr-stroke-hit");
      g.append(line, hit);
      hit.addEventListener("pointerdown", (ev) => {
        if (drawMode) return;
        ev.stopPropagation();
      });
      hit.addEventListener("click", (ev) => {
        if (drawMode) return;
        ev.stopPropagation();
        showStrokePopup(d, { left: ev.clientX - 1, right: ev.clientX + 1,
                             top: ev.clientY - 6, bottom: ev.clientY + 6,
                             width: 2, height: 12 });
      });
      return g;
    }

    function setDrawMode(on) {
      drawMode = !!on;
      if (drawMode && boxMode) setBoxMode(false);
      if (drawMode && writeMode) setWriteMode(false);
      drawBtn.classList.toggle("pr-icon-on", drawMode);
      pagesEl.classList.toggle("pr-drawing-on", drawMode);
      if (drawMode) { document.getSelection().removeAllRanges(); hidePopup(); }
    }

    function startStroke(ev) {
      if (!drawMode || ev.button !== 0) return;
      const hit = sheetAtPoint(visibleBoxes(), ev.clientX, ev.clientY);
      if (!hit) return;
      ev.preventDefault();
      hidePopup();
      const d = { id: newId(), page: hit.sheet.num, points: [],
                  color: "pink", size: DRAWING_SIZES[0],
                  created: new Date().toISOString() };
      const svg = inkSvg(hit.sheet);
      svg.classList.add("pr-drawing-live");
      hit.sheet.ink.appendChild(svg);
      stroke = { d, sheet: hit.sheet, box: hit.box, svg, view: [],
                 last: null, id: ev.pointerId };
      try { pagesEl.setPointerCapture(ev.pointerId); } catch (_) {}
      extendStroke(ev);
    }

    function extendStroke(ev) {
      const st = stroke;
      if (!st || ev.pointerId !== st.id) return;

      const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
      for (const e of (events.length ? events : [ev])) {
        const x = e.clientX, y = e.clientY;
        if (st.last && Math.hypot(x - st.last[0], y - st.last[1]) < 1.5) continue;
        st.last = [x, y];
        st.view.push([clamp01((x - st.box.left) / st.box.width),
                      clamp01((y - st.box.top) / st.box.height)]);
      }
      const shown = { ...st.d, points: st.view };
      st.svg.replaceChildren(strokeNode(shown, st.sheet, 0));
    }

    function endStroke(ev) {
      const st = stroke;
      if (!st || ev.pointerId !== st.id) return;
      stroke = null;
      try { pagesEl.releasePointerCapture(ev.pointerId); } catch (_) {}
      st.svg.remove();
      if (ev.type === "pointercancel") return;

      if (st.view.length === 1) st.view.push([st.view[0][0] + 0.0005, st.view[0][1]]);
      if (st.view.length < 2) return;
      const turn = rotOf(st.d.page);
      st.d.points = st.view.map(([x, y]) => {
        const back = unrotateRect({ x, y, w: 0, h: 0 }, turn);
        return [Math.round(back.x * 1e5) / 1e5, Math.round(back.y * 1e5) / 1e5];
      });
      reading.drawings.push(st.d);
      drawnNow.push(st.d.id);
      paintInk(st.d.page);
      markDirty();
      activity("note");
    }

    function removeStroke(d) {
      const i = reading.drawings.indexOf(d);
      if (i < 0) return;
      reading.drawings.splice(i, 1);
      hidePopup();
      paintInk(d.page);
      markDirty();
      activity("erase");
    }

    function undoStroke() {
      while (drawnNow.length) {
        const id = drawnNow.pop();
        const d = reading.drawings.find((x) => x.id === id);
        if (d) { removeStroke(d); return true; }
      }
      return false;
    }

    function showStrokePopup(d, clientRect) {
      pendingSelection = null;
      popupFor = null;
      pop.replaceChildren();
      swatches(pop, d.color, (color) => {
        d.color = color; paintInk(d.page); markDirty();
        showStrokePopup(d, clientRect);
      });
      el("span", "pr-sep", null, pop);
      DRAWING_SIZES.forEach((size, i) => {
        const b = button("pr-pop-btn pr-size" + (d.size === size ? " pr-size-on" : ""),
                         WRITING_SIZE_NAMES[i], pop, ["Thin", "Medium", "Thick"][i]);
        b.addEventListener("mousedown", (ev) => ev.preventDefault());
        b.addEventListener("click", () => {
          d.size = size; paintInk(d.page); markDirty();
          showStrokePopup(d, clientRect);
        });
      });
      el("span", "pr-sep", null, pop);
      const del = button("pr-pop-btn pr-pop-danger", "Delete", pop);
      del.addEventListener("click", () => removeStroke(d));
      placePop(clientRect);
    }

    function swapSymbols(node) {
      for (let pass = 0; pass < 6; pass++) {
        const sel = document.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        const text = range.startContainer;
        if (text.nodeType !== 3 || !node.contains(text)) return;
        const at = range.startOffset;
        const swap = at >= 2 ? SWAPS[text.data.slice(at - 2, at)] : undefined;
        if (!swap) return;
        const pair = document.createRange();
        pair.setStart(text, at - 2);
        pair.setEnd(text, at);
        sel.removeAllRanges();
        sel.addRange(pair);

        if (!document.execCommand("insertText", false, swap)) {
          text.data = text.data.slice(0, at - 2) + swap + text.data.slice(at);
          const caret = document.createRange();
          caret.setStart(text, at - 2 + swap.length);
          caret.collapse(true);
          sel.removeAllRanges();
          sel.addRange(caret);
        }
      }
    }

    function setWriteMode(on) {
      writeMode = !!on;
      if (writeMode && boxMode) setBoxMode(false);
      if (writeMode && drawMode) setDrawMode(false);
      writeBtn.classList.toggle("pr-icon-on", writeMode);
      pagesEl.classList.toggle("pr-writing-on", writeMode);
      if (writeMode) { document.getSelection().removeAllRanges(); hidePopup(); }
    }

    function startWriting(ev) {
      const hit = sheetAtPoint(visibleBoxes(), ev.clientX, ev.clientY);
      if (!hit) return;
      const num = hit.sheet.num;
      const at = unrotateRect({ x: clamp01((ev.clientX - hit.box.left) / hit.box.width),
                                y: clamp01((ev.clientY - hit.box.top) / hit.box.height),
                                w: 0, h: 0 }, rotOf(num));
      const w = { id: newId(), page: num, x: at.x, y: at.y, text: "",
                  color: writingColor, size: WRITING_SIZES[0],
                  created: new Date().toISOString() };
      reading.writings.push(w);
      editWriting(w);
    }

    function editWriting(w) {
      if (editingId && editingId !== w.id) finishEditing();
      hidePopup();
      const sheet = sheets[w.page - 1];
      if (!sheet) return;
      editingId = w.id;
      paintInk(w.page);
      const node = el("div", "pr-writing pr-writing-editing", null, sheet.ink);
      placeWriting(node, w, rotOf(w.page));
      node.textContent = w.text;
      node.contentEditable = "plaintext-only";
      node.spellcheck = false;
      node.setAttribute("role", "textbox");
      node.setAttribute("aria-label", "Writing on page " + w.page);
      node.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      node.addEventListener("click", (ev) => ev.stopPropagation());
      node.addEventListener("input", (ev) => {
        if (!ev.isComposing) swapSymbols(node);
        w.text = node.innerText;
      });
      node.addEventListener("keydown", (ev) => {

        if (ev.key === "Escape" || (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey))) {
          ev.preventDefault(); ev.stopPropagation();
          finishEditing();
        }
      });
      node.addEventListener("blur", () => finishEditing());
      node.focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const sel = document.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    }

    function finishEditing() {
      const id = editingId;
      if (!id) return;
      editingId = null;
      putDownAt = Date.now();
      const w = reading.writings.find((x) => x.id === id);
      if (!w) return;
      w.text = w.text.replace(/\n+$/, "");
      if (!w.text.trim()) {

        reading.writings.splice(reading.writings.indexOf(w), 1);
      } else {
        activity("note");
      }
      paintInk(w.page);
      markDirty();
    }

    function removeWriting(w) {
      const i = reading.writings.indexOf(w);
      if (i < 0) return;
      reading.writings.splice(i, 1);
      hidePopup();
      paintInk(w.page);
      markDirty();
      activity("erase");
    }

    function showWritingPopup(w, clientRect) {
      pendingSelection = null;
      popupFor = null;
      pop.replaceChildren();
      swatches(pop, w.color, (color) => {
        w.color = color; paintInk(w.page); markDirty();
        showWritingPopup(w, clientRect);
      });
      el("span", "pr-sep", null, pop);
      WRITING_SIZES.forEach((size, i) => {
        const b = button("pr-pop-btn pr-size" + (w.size === size ? " pr-size-on" : ""),
                         WRITING_SIZE_NAMES[i], pop,
                         ["Small", "Medium", "Large"][i]);
        b.addEventListener("mousedown", (ev) => ev.preventDefault());
        b.addEventListener("click", () => {
          w.size = size; paintInk(w.page); markDirty();
          const node = sheets[w.page - 1].ink.querySelector('[data-w="' + w.id + '"]');
          showWritingPopup(w, node ? node.getBoundingClientRect() : clientRect);
        });
      });
      el("span", "pr-sep", null, pop);
      const edit = button("pr-pop-btn", "Edit", pop, "Change the words (double-click)");
      edit.addEventListener("click", () => editWriting(w));
      const del = button("pr-pop-btn pr-pop-danger", "Delete", pop);
      del.addEventListener("click", () => removeWriting(w));
      placePop(clientRect);
    }

    function paintAllMarks() {
      for (const sheet of sheets) paintMarks(sheet.num);
    }

    function flashHighlight(id) {
      for (const node of root.querySelectorAll('[data-hl="' + id + '"]')) {
        node.classList.remove("pr-mark-flash");
        void node.offsetWidth;
        node.classList.add("pr-mark-flash");
      }
    }

    function capturePosition(atY) {
      if (!sheets.length) return null;

      const nums = [];
      for (const [num, ratio] of visible) if (ratio > 0) nums.push(num);
      if (!nums.length) nums.push(current);
      const top = atY == null ? scroller.getBoundingClientRect().top : atY;
      let best = null, nearest = Infinity;
      for (const num of nums) {
        const sheet = sheets[num - 1];
        if (!sheet) continue;
        const rect = sheet.root.getBoundingClientRect();
        if (rect.height <= 0) continue;
        if (rect.top <= top && rect.bottom > top) { best = sheet; break; }
        const away = Math.abs(rect.top - top);
        if (away < nearest) { nearest = away; best = sheet; }
      }
      if (!best) return null;
      const rect = best.root.getBoundingClientRect();
      const frac = rect.height > 0 ? (top - rect.top) / rect.height : 0;
      return { page: best.num, frac: round5(Math.max(-1, Math.min(frac, 2))) };
    }

    function moveScroller(top, behavior) {
      const want = Math.max(top, 0);
      if (Math.abs(want - scroller.scrollTop) > 1) {
        ourScroll = true;
        quietUntil = Date.now() + QUIET_MS;
      }
      scroller.scrollTo({ top: want, behavior: behavior || "auto" });
    }

    function scrollToPosition(pos, behavior, atY) {
      if (!pos) return;
      const sheet = sheets[pos.page - 1];
      if (!sheet) return;
      const rect = sheet.root.getBoundingClientRect();
      const line = atY == null ? scroller.getBoundingClientRect().top : atY;
      const delta = rect.top - line + (pos.frac || 0) * rect.height;
      moveScroller(scroller.scrollTop + delta,
                   behavior === "smooth" ? "smooth" : "auto");
      setCurrent(pos.page);
    }

    function pushBack(pos) {
      if (!pos) return;
      const last = backStack[backStack.length - 1];

      if (last && last.page === pos.page && Math.abs(last.frac - pos.frac) < 0.03) {
        return;
      }
      backStack.push(pos);
      if (backStack.length > HISTORY_MAX) backStack.shift();
      fwdStack.length = 0;
      paintNav();
    }

    function goBack() {
      if (!backStack.length) return;
      const here = capturePosition();
      const pos = backStack.pop();
      if (here) {
        fwdStack.push(here);
        if (fwdStack.length > HISTORY_MAX) fwdStack.shift();
      }
      scrollToPosition(pos, "smooth");
      paintNav();
    }

    function goForward() {
      if (!fwdStack.length) return;
      const here = capturePosition();
      const pos = fwdStack.pop();
      if (here) {
        backStack.push(here);
        if (backStack.length > HISTORY_MAX) backStack.shift();
      }
      scrollToPosition(pos, "smooth");
      paintNav();
    }

    function paintNav() {
      backBtn.disabled = !backStack.length;
      fwdBtn.disabled = !fwdStack.length;
      const b = backStack[backStack.length - 1];
      const f = fwdStack[fwdStack.length - 1];
      backBtn.title = b ? "Back to page " + b.page + " (⌥←)" : "Back (⌥←)";
      fwdBtn.title = f ? "Forward to page " + f.page + " (⌥→)" : "Forward (⌥→)";
    }

    function railPages() {
      const total = pdf ? pdf.numPages : 0;
      const want = Math.round((options.body && options.body.pages) || 0);
      return want > 0 && want <= (total || want) ? want : total;
    }

    function lastMarkedPage() {
      let page = 0;
      for (const h of reading.highlights) if (h.page > page) page = h.page;
      for (const key of Object.keys(reading.comments)) {
        const n = Number(key);
        if (n > page) page = n;
      }
      return page;
    }

    function lastMarkPlace() {
      const page = lastMarkedPage();
      if (!(page >= 1)) return null;
      if (reading.comments[String(page)]) return { page: page, frac: 1 };
      const rot = rotOf(page);
      let foot = null;
      for (const h of reading.highlights) {
        if (h.page !== page) continue;
        for (const r of viewRects(h.rects, rot)) {
          const bottom = (r.y || 0) + (r.h || 0);
          if (foot == null || bottom > foot) foot = bottom;
        }
      }
      return { page: page, frac: foot == null ? 1 : foot };
    }

    function paintRail() {
      const total = pdf ? pdf.numPages : 0;
      if (!total) { rail.hidden = true; return; }
      rail.hidden = false;
      const pages = railPages();
      const counted = pages < total;

      railTail.hidden = !counted;
      if (counted) railTail.style.left = (pages / total) * 100 + "%";

      const here = capturePosition();
      const along = placeFraction(here, total);
      railFill.style.width = (along == null ? 0 : along * 100) + "%";

      const marked = lastMarkedPage();
      const notch = markFraction(lastMarkPlace(), total);
      railMark.hidden = notch == null;
      if (notch != null) railMark.style.left = notch * 100 + "%";

      const read = placeFraction(here, pages);
      const pct = read == null ? null : Math.round(read * 100);
      railRead.textContent = pct == null ? "" : pct + "% read";
      railLeft.textContent = pct == null ? "" : (100 - pct) + "% left";

      const shelf = shelfFraction(marked, pages);
      const says = [];
      if (here) says.push("You are on page " + here.page + " of " + total + ".");
      says.push(counted
        ? "The percentage is of the " + pages + " pages before the back matter, "
          + "not the " + total + " in the file."
        : "The percentage is of all " + total + " pages.");
      says.push(marked
        ? "The notch stands at your furthest mark, on page " + marked + ". The "
          + "shelf counts that page whole, which is "
          + Math.round(shelf * 100) + "% of the paper."
        : "Nothing is marked yet, so there is no progress notch.");
      says.push("Drag the rail to move through the paper.");
      railTrack.title = says.join(" ");
      railRead.title = railTrack.title;
      railLeft.title = railTrack.title;
    }

    function railTick() {
      if (railFrame) return;
      railFrame = global.requestAnimationFrame(() => {
        railFrame = null;
        if (!destroyed) paintRail();
      });
    }

    function sayResumed(page, linked) {
      railNote.textContent = (linked ? "Opened at the linked page, page "
        : "Opened at your last mark, page ") + page;
      railNote.hidden = false;
      if (railNoteTimer) clearTimeout(railNoteTimer);
      railNoteTimer = setTimeout(() => {
        railNoteTimer = null;
        railNote.hidden = true;
      }, 6000);
    }

    function resumePlace() {
      const page = lastMarkedPage();
      if (!(page >= 1) || page > sheets.length) return null;
      let top = null;
      const rot = rotOf(page);
      for (const h of reading.highlights) {
        if (h.page !== page) continue;
        for (const r of viewRects(h.rects, rot)) {
          if (top == null || r.y < top) top = r.y;
        }
      }

      return { page: page, frac: top == null ? 0 : Math.max(0, top - 0.06) };
    }

    function railScrub(ev) {
      if (!pdf) return;
      const box = railTrack.getBoundingClientRect();
      if (!(box.width > 0)) return;
      const pos = placeAt((ev.clientX - box.left) / box.width, pdf.numPages);
      if (pos) scrollToPosition(pos, "auto");
      paintRail();
    }

    railTrack.addEventListener("pointerdown", (ev) => {
      if (!pdf || ev.button) return;
      ev.preventDefault();
      scrubbing = true;
      pushBack(capturePosition());
      try { railTrack.setPointerCapture(ev.pointerId); } catch (_) {}
      railScrub(ev);
    });
    railTrack.addEventListener("pointermove", (ev) => {
      if (scrubbing) railScrub(ev);
    });

    function endScrub(ev) {
      if (!scrubbing) return;
      scrubbing = false;
      try { railTrack.releasePointerCapture(ev.pointerId); } catch (_) {}

      if (!reached.has(current)) { reached.add(current); activity("page"); }
    }
    railTrack.addEventListener("pointerup", endScrub);
    railTrack.addEventListener("pointercancel", endScrub);

    function onSettle() {
      settleTimer = null;
      const top = scroller.scrollTop;
      const ours = ourScroll && Date.now() < quietUntil;
      ourScroll = false;
      if (!ours && settled && bigJump(settled.top, top, scroller.clientHeight)) {
        pushBack(settled.pos);
      }
      settled = { top: top, pos: capturePosition() };
    }

    function applyScale(next, at) {
      const clamped = Math.min(Math.max(next, MIN_SCALE), MAX_SCALE);
      if (Math.abs(clamped - scale) < 0.0005) { paintZoom(); return; }
      const well = scroller.getBoundingClientRect();
      const ax = at ? at.x : well.left + well.width / 2;
      const ay = at ? at.y : well.top;
      const pos = capturePosition(ay);

      let hold = null;
      if (pos) {
        const r = sheets[pos.page - 1].page.getBoundingClientRect();
        if (r.width > 0) hold = { page: pos.page, fx: (ax - r.left) / r.width };
      }
      scale = clamped;
      for (const sheet of sheets) layoutSheet(sheet);
      paintZoom();
      if (pos) scrollToPosition(pos, "instant", ay);
      if (hold) {
        const r = sheets[hold.page - 1].page.getBoundingClientRect();
        if (r.width > 0) {
          scroller.scrollLeft += r.left + hold.fx * r.width - ax;
        }
      }

      if (zoomRender) clearTimeout(zoomRender);
      zoomRender = setTimeout(() => {
        zoomRender = null;
        if (!destroyed) renderVisible();
      }, 110);
    }

    function fitScale(mode) {
      if (!sheets.length || scroller.clientWidth < 160) return scale;
      const base = sheetSize(sheets[Math.max(current - 1, 0)]);
      if (!(base.width > 0)) return scale;
      const style = global.getComputedStyle(pagesEl);
      const sideways = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);

      const w = (scroller.clientWidth - sideways - 2) / base.width;
      if (mode === "page") {
        const tall = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        return Math.min(w, (scroller.clientHeight - tall - 2) / base.height);
      }
      return w;
    }

    function setFit(mode) {
      fitMode = mode || null;
      if (fitMode) applyScale(fitScale(fitMode));
      paintZoom();
    }

    function refit() {
      if (!fitMode || refitFrame) return;
      refitFrame = global.requestAnimationFrame(() => {
        refitFrame = null;
        if (!destroyed && fitMode) applyScale(fitScale(fitMode));
      });
    }

    function paintZoom() {
      zoomLabel.textContent = Math.round(scale * 100) + "%";
      fitBtn.classList.toggle("pr-chip-on", !!fitMode);
      zoomOut.disabled = scale <= MIN_SCALE + 0.0005;
      zoomIn.disabled = scale >= MAX_SCALE - 0.0005;
    }

    function zoomBy(dir, at) {
      setFit(null);
      const step = dir > 0
        ? (ZOOMS.find((z) => z > scale + 0.001) || scale * 1.2)
        : (ZOOMS.filter((z) => z < scale - 0.001).pop() || scale / 1.2);
      applyScale(step, at);
    }

    function rotatePage(num, delta) {
      const n = Math.min(Math.max(Math.round(num) || 1, 1), sheets.length || 1);
      const sheet = sheets[n - 1];
      if (!sheet) return;
      const turn = normalizeRotation(rotOf(n) + delta);
      if (turn) reading.rotations[String(n)] = turn;
      else delete reading.rotations[String(n)];
      layoutSheet(sheet);
      releaseSheet(sheet);
      paintMarks(n);
      paintLinks(sheet);

      sortHighlights();
      renderSide();

      refit();
      goToPage(n, "instant");
      renderVisible();
      paintRotate();
      markDirty();

      activity("rotate");
    }

    function paintRotate() {
      const turn = rotOf(current);
      rotBtn.classList.toggle("pr-icon-on", !!turn);
      rotBtn.title = turn
        ? "Page " + current + " is turned " + turn + "° — click to keep "
          + "turning, ⇧-click to turn it back (t / ⇧T)"
        : "Turn this page (t) — ⇧-click for the other way";
    }

    function goToPage(num, behavior) {
      const n = Math.min(Math.max(Math.round(num) || 1, 1), sheets.length || 1);
      const sheet = sheets[n - 1];
      if (!sheet) return;

      const delta = sheet.root.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top;
      moveScroller(scroller.scrollTop + delta - 14,
                   behavior === "instant" ? "auto" : "smooth");
      setCurrent(n);
    }

    function jumpToPage(num, behavior) {
      const n = Math.min(Math.max(Math.round(num) || 1, 1), sheets.length || 1);
      if (n !== current) pushBack(capturePosition());
      goToPage(n, behavior);
    }

    function setCurrent(n) {
      if (n === current) return;
      current = n;
      pageInput.value = String(n);
      if (options.onPage) { try { options.onPage(n); } catch (_) {  } }
      if (chatTab === "heard") paintHeard();
      paintRotate();
      renderSide();
      paintRail();
      paintToc();

      if (!scrubbing && !reached.has(n)) { reached.add(n); activity("page"); }
    }

    function recomputeCurrent() {
      const entries = [];
      for (const [page, ratio] of visible) entries.push({ page, ratio });
      const pick = pickCurrent(entries);
      if (pick) setCurrent(pick);
    }

    function renderVisible() {
      for (const sheet of sheets) {
        if (sheet.near) renderSheet(sheet);
      }
    }

    function indexPages() {
      if (find.indexing || !pdf) return;
      find.indexing = (async () => {
        for (const sheet of sheets) {
          if (destroyed) return;
          let built = { text: "", pieceOf: [], ys: [] };
          try {
            const page = sheet.proxy || (sheet.proxy = await pdf.getPage(sheet.num));
            const items = oneCopyEach(await page.getTextContent()).items
              .filter((it) => typeof it.str === "string");
            built = findText(items.map((it) => ({ str: it.str, eol: it.hasEOL })));

            const vp = page.getViewport({ scale: 1 });
            built.ys = items.map((it) => (it.transform
              ? clamp01(vp.convertToViewportPoint(it.transform[4], it.transform[5])[1]
                        / vp.height)
              : 0));
          } catch (_) {  }
          if (destroyed) return;
          find.pages[sheet.num - 1] = built;
          find.indexed = sheet.num;
          if (find.needle) runFind(false);
          else paintFindCount();
        }
      })();
    }

    function hitPlace(hit) {
      return { page: hit.page, frac: rotateFrac(hit.y, rotOf(hit.page)) };
    }

    function runFind(fresh) {
      const was = find.hits[find.at];
      find.hits = [];
      find.pages.forEach((p, i) => {
        if (!p || !find.needle) return;
        findAll(p.text, find.needle).forEach((pos, k) => {
          find.hits.push({ page: i + 1, k, y: p.ys[p.pieceOf[pos]] || 0 });
        });
      });
      let at = -1;
      if (!fresh && was) {
        at = find.hits.findIndex((h) => h.page === was.page && h.k === was.k);
      }
      if (at < 0 && find.hits.length) {
        const here = capturePosition() || { page: current, frac: 0 };
        at = find.hits.findIndex((h) => {
          const pos = hitPlace(h);
          return pos.page > here.page || (pos.page === here.page && pos.frac >= here.frac);
        });

        if (at < 0 && find.indexed >= sheets.length) at = 0;
      }
      const moved = at !== find.at || fresh;
      find.at = at;
      if (fresh) for (const sheet of sheets) if (sheet.text.firstChild) paintFindPage(sheet);
      paintFindMarks();
      paintFindCount();
      if (moved && at >= 0) revealHit(find.hits[at]);
    }

    function paintFindPage(sheet) {
      find.ranges.delete(sheet.num);
      if (find.needle && sheet.text.firstChild) {
        const pieces = [], nodes = [];
        const walk = document.createTreeWalker(sheet.text,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.nodeType === Node.TEXT_NODE) { pieces.push({ str: n.data }); nodes.push(n); }
          else if (n.tagName === "BR" && pieces.length) pieces[pieces.length - 1].eol = true;
        }
        const built = findText(pieces);
        const ranges = findAll(built.text, find.needle).map((pos) => {
          const end = pos + find.needle.length - 1;
          const startNode = nodes[built.pieceOf[pos]];
          const endNode = nodes[built.pieceOf[end]];
          const endAt = built.offsetOf[end];
          const range = document.createRange();
          range.setStart(startNode, Math.min(built.offsetOf[pos], startNode.length));
          range.setEnd(endNode, Math.min(
            endAt + (endNode.data.codePointAt(endAt) > 0xffff ? 2 : 1), endNode.length));
          return range;
        });
        if (ranges.length) find.ranges.set(sheet.num, ranges);
      }
      paintFindMarks();
      const hit = find.pending;
      if (hit && hit.page === sheet.num) revealHit(hit);
    }

    function paintFindMarks() {
      if (!global.CSS || !CSS.highlights || typeof Highlight === "undefined") return;
      const all = new Highlight(), now = new Highlight();
      const hit = find.hits[find.at];
      for (const [num, ranges] of find.ranges) {
        ranges.forEach((r, k) => (hit && hit.page === num && hit.k === k ? now : all).add(r));
      }
      CSS.highlights.set("pr-find", all);
      CSS.highlights.set("pr-find-now", now);
    }

    function paintFindCount() {
      const busy = find.indexed < sheets.length;
      findBar.classList.toggle("pr-find-none",
        !!find.needle && !find.hits.length && !busy);
      if (!find.needle) {
        findCount.textContent = busy ? "reading…" : "";
      } else if (!find.hits.length) {
        findCount.textContent = busy ? "reading…" : "No matches";
      } else if (find.at < 0) {
        findCount.textContent = find.hits.length + " so far";
      } else {
        findCount.textContent = (find.at + 1) + " of " + find.hits.length
          + (busy ? "+" : "") + " · p. " + find.hits[find.at].page;
      }
      findCount.title = busy
        ? "Read " + find.indexed + " of " + sheets.length + " pages so far" : "";
      findPrev.disabled = findNext.disabled = !find.hits.length;
    }

    function revealHit(hit) {
      if (!hit) return;
      if (!find.jumped) { pushBack(capturePosition()); find.jumped = true; }
      const range = (find.ranges.get(hit.page) || [])[hit.k];
      const box = scroller.getBoundingClientRect();
      if (range && range.startContainer.isConnected) {
        find.pending = null;
        const r = range.getBoundingClientRect();
        if (r.top < box.top + 24 || r.bottom > box.bottom - 24) {
          moveScroller(scroller.scrollTop + r.top - box.top - box.height / 3);
        }
        if (r.left < box.left + 12 || r.right > box.right - 12) {
          scroller.scrollLeft += r.left - box.left - box.width / 3;
        }
        return;
      }
      find.pending = hit;
      scrollToPosition(hitPlace(hit), "auto", box.top + box.height / 3);
    }

    function stepFind(dir) {
      if (!find.hits.length) return;
      const n = find.hits.length;
      find.at = find.at < 0 ? (dir > 0 ? 0 : n - 1) : (find.at + dir + n) % n;
      paintFindMarks();
      paintFindCount();
      revealHit(find.hits[find.at]);
    }

    function placeFind() {
      const well = scroller.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      findBar.style.top = (well.top - box.top + 10) + "px";
      findBar.style.right = (box.right - well.right + 18) + "px";
    }

    function openFind() {

      const sel = document.getSelection();
      const picked = sel && !sel.isCollapsed && pagesEl.contains(sel.anchorNode)
        ? sel.toString().replace(/\s+/g, " ").trim() : "";
      if (picked && picked.length <= 80) findInput.value = picked;
      findBar.hidden = false;
      placeFind();
      find.jumped = false;
      findInput.focus();
      findInput.select();
      indexPages();
      setNeedle();
    }

    function closeFind() {
      findBar.hidden = true;
      find.needle = "";
      find.hits = [];
      find.at = -1;
      find.pending = null;
      find.ranges.clear();
      paintFindMarks();
      if (root.isConnected) root.focus({ preventScroll: true });
    }

    function setNeedle() {
      const needle = findText([{ str: findInput.value }]).text.trim();
      if (needle === find.needle) { paintFindCount(); return; }
      find.needle = needle;
      runFind(true);
    }

    findInput.addEventListener("input", setNeedle);
    findInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeFind(); }
    });
    findBar.addEventListener("submit", (ev) => ev.preventDefault());
    findPrev.addEventListener("click", () => stepFind(-1));
    findNext.addEventListener("click", () => stepFind(1));
    findClose.addEventListener("click", closeFind);

    async function loadToc() {
      if (!options.toc) return;
      let data = null;
      try { data = await options.toc(); } catch (_) { data = null; }
      if (destroyed || !data) return;
      tocSource = String(data.source || "none");
      tocWhy = String(data.why || "");
      tocFetched = (Array.isArray(data.entries) ? data.entries : [])
        .filter((e) => e && Math.round(Number(e.page)) >= 1)
        .map((e) => ({ level: Math.max(1, Math.round(Number(e.level)) || 1),
                       title: String(e.title || "").slice(0, 300),
                       page: Math.round(Number(e.page)),
                       y: e.y == null ? null : Number(e.y),
                       x: e.x == null ? null : Number(e.x) }));
      buildToc();
    }

    function tocDisplay() {
      const mine = reading.contents || [];
      if (!mine.length) return tocFetched;
      return sortSections(mine).map((s) => ({
        id: s.id,
        level: Math.max(1, Math.min(Number(s.level) || 1, 4)),
        title: s.title,
        page: Math.round(Number(s.page)) || 1,
        y: s.frac == null ? null : Number(s.frac),
        x: s.x == null ? null : Number(s.x),
        mine: true,
      }));
    }

    function sectionById(id) {
      return (reading.contents || []).find((s) => s.id === id) || null;
    }

    async function askMarlin() {
      if (!options.draftToc || tocDrafting) return;
      tocDrafting = true;
      tocDraftNote = "";
      buildToc();
      let outcome = null;
      try {
        outcome = await options.draftToc();
      } catch (err) {
        if (destroyed) return;
        tocDrafting = false;
        tocDraftNote = "Marlin could not read this paper: "
          + ((err && err.message) ? err.message : String(err));
        buildToc();
        return;
      }
      if (destroyed) return;
      tocDrafting = false;
      if (Array.isArray(outcome && outcome.sections)) {
        reading.contents = sortSections(outcome.sections);
      }
      const lost = (outcome && outcome.dropped) || [];
      const said = [];
      if (outcome && outcome.note) said.push(String(outcome.note));
      if (lost.length) {
        said.push(`${lost.length} heading${lost.length === 1 ? " was" : "s were"} `
                  + "not printed where Marlin placed them and were left out.");
      }
      tocDraftNote = said.join(" ");
      tocManual = true;
      buildToc();
      activity("contents");
    }

    function addSection(capture) {
      const made = sectionFromSelection(capture && capture.parts);
      if (!made) return;
      if (!Array.isArray(reading.contents)) reading.contents = [];
      reading.contents.push({ id: newId(), title: made.title, level: 1,
                              page: made.page, frac: made.frac, x: made.x,
                              created: new Date().toISOString() });
      reading.contents = sortSections(reading.contents);
      const sel = document.getSelection();
      if (sel) sel.removeAllRanges();
      pendingSelection = null;
      hidePopup();
      tocManual = true;
      buildToc();
      markDirty();
      activity("contents");
    }

    function adoptFetched(without) {
      const now = new Date().toISOString();
      reading.contents = sortSections(tocFetched
        .filter((e) => e !== without)
        .map((e) => ({ id: newId(), title: e.title, level: e.level,
                       page: e.page, frac: e.y, x: e.x,
                       by: "reader", created: now })));
      buildToc();
      markDirty();
      activity("contents");
    }

    function removeSection(id) {
      const rows = reading.contents || [];
      const at = rows.findIndex((s) => s.id === id);
      if (at < 0) return;
      rows.splice(at, 1);
      buildToc();
      markDirty();
    }

    function startNest(ev, row, entry) {
      if (ev.button !== 0) return;
      const tag = ev.target && ev.target.tagName;
      if (tag === "INPUT" || tag === "BUTTON") return;
      const rec = sectionById(entry.id);
      if (!rec) return;
      const startX = ev.clientX, startLevel = rec.level || 1;
      const base = Math.min(...tocEntries.map((e) => e.level));
      let moved = false;
      try { row.setPointerCapture(ev.pointerId); } catch (_) {}
      row.onpointermove = (move) => {
        const dx = move.clientX - startX;
        if (!moved && Math.abs(dx) < 6) return;
        moved = true;
        const next = levelFromDrag(startLevel, dx, 22);
        if (next === rec.level) return;
        rec.level = next;
        rec.by = "reader";

        row.style.paddingLeft = (8 + Math.min(next - base, 4) * 12) + "px";
      };
      const end = () => {
        row.onpointermove = null; row.onpointerup = null;
        row.onpointercancel = null;
        try { row.releasePointerCapture(ev.pointerId); } catch (_) {}
        if (moved) { buildToc(); markDirty(); }
      };
      row.onpointerup = end;
      row.onpointercancel = end;
    }

    function jumpToSection(entry) {
      const n = Math.min(Math.max(Math.round(Number(entry.page)) || 1, 1),
                         sheets.length || 1);
      const sheet = sheets[n - 1];
      if (!sheet) return;

      if (n !== current) pushBack(capturePosition());
      const rect = sheet.root.getBoundingClientRect();
      const into = entry.y == null ? 0 : clamp01(entry.y) * rect.height;
      const delta = rect.top - scroller.getBoundingClientRect().top + into;
      moveScroller(scroller.scrollTop + delta - 14, "smooth");
      setCurrent(n);
    }

    function buildToc() {
      tocEntries = tocDisplay();
      const mine = !!(reading.contents && reading.contents.length);
      tocList.replaceChildren();
      tocRows = [];
      tocAt = -2;
      tocBtn.hidden = false;
      tocEdit.hidden = false;
      tocEdit.textContent = tocManual ? "Done" : "Mark sections";
      tocEdit.classList.toggle("pr-toc-edit-on", tocManual);
      root.classList.toggle("pr-toc-editing", tocManual);
      if (tocManual) { root.classList.remove("pr-no-toc"); tocBtn.classList.add("pr-chip-on"); }

      tocAsk.hidden = !options.draftToc || (tocSource === "file" && !tocManual);
      tocAsk.disabled = tocDrafting;
      tocAsk.textContent = tocDrafting ? "Reading…" : "Ask Marlin";

      if (tocManual) {
        el("div", "pr-toc-hint",
           "Select a heading in the paper and drag it in here, or press "
           + "＋ Contents. Drag a line sideways to nest it.", tocList);
      }
      if (tocDraftNote) el("div", "pr-toc-hint", tocDraftNote, tocList);

      if (!tocEntries.length) {

        const nothing = tocWhy || "This file carries no contents Lancetfish can read.";
        el("div", "pr-toc-empty",
           tocManual
             ? "Nothing marked yet. The first heading you drag in starts the contents."
             : (tocDrafting ? "Marlin is reading the pages."
                : options.draftToc
                  ? nothing + " Ask Marlin to read them off the pages, or mark them yourself."
                  : nothing),
           tocList);
        tocNote.textContent = "";
        return;
      }

      const base = Math.min(...tocEntries.map((e) => e.level));
      const indent = (entry) =>
        (8 + Math.min(entry.level - base, 4) * 12) + "px";

      for (const entry of tocEntries) {
        if (tocManual && entry.mine) {
          const row = el("div", "pr-toc-row pr-toc-mine", null, tocList);
          row.style.paddingLeft = indent(entry);
          const title = el("input", "pr-toc-title", null, row);
          title.value = entry.title;
          title.setAttribute("aria-label", "Section title");
          title.addEventListener("input", () => {
            const rec = sectionById(entry.id);
            if (!rec) return;
            rec.title = title.value;

            rec.by = "reader";
            markDirty();
          });
          const go = button("pr-toc-go", String(entry.page), row,
                            "Go to this section");
          go.addEventListener("click", () => jumpToSection(entry));
          const drop = button("pr-toc-x", "×", row, "Remove this section");
          drop.addEventListener("click", () => removeSection(entry.id));
          row.addEventListener("pointerdown", (ev) => startNest(ev, row, entry));
          tocRows.push(row);
          continue;
        }
        if (tocManual) {

          const row = el("div", "pr-toc-row pr-toc-file", null, tocList);
          row.style.paddingLeft = indent(entry);
          el("span", "pr-toc-title", entry.title, row);
          const go = button("pr-toc-go", String(entry.page), row,
                            "Go to this section");
          go.addEventListener("click", () => jumpToSection(entry));
          const drop = button("pr-toc-x", "×", row, "Remove this section");
          drop.addEventListener("click", () => adoptFetched(entry));
          tocRows.push(row);
          continue;
        }
        const row = button("pr-toc-row", entry.title, tocList,
                           `Go to page ${entry.page}`);
        row.style.paddingLeft = indent(entry);
        el("span", null, String(entry.page), row);
        row.addEventListener("click", () => jumpToSection(entry));
        tocRows.push(row);
      }

      tocNote.textContent = mine ? "yours"
        : (tocSource === "detected" ? "read by Lancetfish" : "");
      tocNote.title = mine ? "The sections you marked yourself" : tocWhy;
      root.classList.remove("pr-no-toc");
      tocBtn.classList.add("pr-chip-on");
      paintToc();
      requestAnimationFrame(refit);
    }

    function paintToc() {
      if (!tocRows.length) return;
      const here = capturePosition() || { page: current, frac: 0 };
      const at = pickSection(tocEntries, here.page, here.frac);
      if (at === tocAt) return;
      tocAt = at;
      for (let i = 0; i < tocRows.length; i++) {
        tocRows[i].classList.toggle("pr-toc-now", i === at);
      }
      const row = tocRows[at];
      if (!row || root.classList.contains("pr-no-toc")) return;
      const box = tocList.getBoundingClientRect();
      const mark = row.getBoundingClientRect();
      if (mark.top < box.top || mark.bottom > box.bottom) {
        row.scrollIntoView({ block: "nearest" });
      }
    }

    function pageBoxes() {
      return sheets.map((s) => ({ sheet: s, box: s.page.getBoundingClientRect() }));
    }

    function visibleBoxes() {
      const nums = [];
      for (const [num, ratio] of visible) if (ratio > 0) nums.push(num);
      if (!nums.length) nums.push(current);
      const out = [];
      for (const num of nums) {
        const sheet = sheets[num - 1];
        if (sheet) out.push({ sheet, box: sheet.page.getBoundingClientRect() });
      }
      return out;
    }

    function sheetAtPoint(boxes, x, y) {
      for (const b of boxes) {
        if (x >= b.box.left && x <= b.box.right
            && y >= b.box.top && y <= b.box.bottom) return b;
      }
      return null;
    }

    function rangeTextInPage(range, sheet) {
      const bounds = document.createRange();
      bounds.selectNodeContents(sheet.text);
      const clipped = range.cloneRange();
      try {
        if (clipped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
          clipped.setStart(bounds.startContainer, bounds.startOffset);
        }
        if (clipped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
          clipped.setEnd(bounds.endContainer, bounds.endOffset);
        }
      } catch (_) { return ""; }
      if (clipped.collapsed) return "";

      const pieces = [];
      for (const span of sheet.text.querySelectorAll("span")) {
        if (span.children.length) continue;
        if (!clipped.intersectsNode(span)) continue;
        const part = document.createRange();
        part.selectNodeContents(span);
        try {
          if (part.compareBoundaryPoints(Range.START_TO_START, clipped) < 0) {
            part.setStart(clipped.startContainer, clipped.startOffset);
          }
          if (part.compareBoundaryPoints(Range.END_TO_END, clipped) > 0) {
            part.setEnd(clipped.endContainer, clipped.endOffset);
          }
        } catch (_) { continue; }
        if (part.collapsed) continue;
        pieces.push({ text: part.toString(),
                      top: span.getBoundingClientRect().top });
      }
      return pieces.length ? joinLines(pieces) : clipped.toString();
    }

    const CONTEXT_SPAN = 220;

    function sheetFor(page) {
      return sheets.find((s) => s.num === page) || null;
    }

    function contextAround(sheet, needle) {
      if (!sheet || !sheet.text) return "";
      const whole = sheet.text.textContent.replace(/\s+/g, " ").trim();
      if (!whole) return "";
      const want = String(needle || "").replace(/\s+/g, " ").trim();
      const at = want ? whole.indexOf(want) : -1;
      if (at < 0) return whole.slice(0, CONTEXT_SPAN * 2);
      return whole.slice(Math.max(0, at - CONTEXT_SPAN),
                        at + want.length + CONTEXT_SPAN);
    }

    function askLookup(term, sheet, clientRect) {
      if (!options.lookup) return;
      const text = String(term || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      hidePopup();
      try {
        options.lookup(text, contextAround(sheet, text), clientRect || null);
      } catch (_) {}
      activity("lookup");
    }

    function askStudy(term, sheet, clientRect) {
      if (!options.study) return;
      const text = String(term || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      hidePopup();
      try {
        options.study(text, contextAround(sheet, text), clientRect || null);
      } catch (_) {}
      activity("lookup");
    }

    function captureSelection() {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      if (!sel.toString().trim()) return null;
      const boxes = pageBoxes();
      const byPage = new Map();
      let last = null;
      for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        if (!pagesEl.contains(range.commonAncestorContainer)) continue;
        for (const rect of range.getClientRects()) {
          if (rect.width < 0.5 || rect.height < 0.5) continue;
          const hit = sheetAtPoint(boxes, rect.left + rect.width / 2,
                                   rect.top + rect.height / 2);
          if (!hit) continue;
          const frac = toFraction(rect, hit.box);
          if (!frac) continue;
          if (!byPage.has(hit.sheet.num)) {
            byPage.set(hit.sheet.num, { sheet: hit.sheet, rects: [], text: [] });
          }
          byPage.get(hit.sheet.num).rects.push(frac);
          last = rect;
        }
        for (const entry of byPage.values()) {
          const text = rangeTextInPage(range, entry.sheet);
          if (text) entry.text.push(text);
        }
      }
      if (!byPage.size) return null;
      const parts = [...byPage.entries()]
        .sort((a, b) => a[0] - b[0])

        .map(([num, entry]) => ({
          page: num,
          rects: mergeRects(entry.rects)
            .map((r) => unrotateRect(r, rotOf(num))),
          text: tidyQuote(entry.text.join(" ")),
        }))
        .filter((p) => p.rects.length);
      return parts.length ? { parts, anchor: last } : null;
    }

    function addHighlight(color) {
      const capture = pendingSelection;
      if (!capture) return;
      const created = new Date().toISOString();
      let first = null;
      for (const part of capture.parts) {
        const h = { id: newId(), page: part.page, color: color,
                    rects: part.rects, text: part.text, note: "",
                    created: created };
        reading.highlights.push(h);
        paintMarks(part.page);
        if (!first) first = h;
      }
      sortHighlights();
      document.getSelection().removeAllRanges();
      pendingSelection = null;
      hidePopup();
      renderSide();
      markDirty();
      activity("highlight");
      if (first) flashHighlight(first.id);
    }

    function sortHighlights() {
      const seen = new Map();
      const where = (h) => {
        let r = seen.get(h);
        if (!r) { r = rotateRect(h.rects[0], rotOf(h.page)); seen.set(h, r); }
        return r;
      };
      reading.highlights.sort((a, b) => (a.page - b.page)
        || (where(a).y - where(b).y) || (where(a).x - where(b).x));
    }

    function removeHighlight(h) {
      const i = reading.highlights.indexOf(h);
      if (i < 0) return;
      reading.highlights.splice(i, 1);
      paintMarks(h.page);
      hidePopup();
      renderSide();
      markDirty();
      activity("erase");
    }

    function recolor(h, color) {
      if (h.color === color) return;
      h.color = color;
      paintMarks(h.page);
      renderSide();
      markDirty();
    }

    function highlightAtPoint(x, y) {
      const hit = sheetAtPoint(visibleBoxes(), x, y);
      if (!hit) return null;
      const nx = (x - hit.box.left) / hit.box.width;
      const ny = (y - hit.box.top) / hit.box.height;
      const turn = rotOf(hit.sheet.num);
      const onPage = reading.highlights.filter((h) => h.page === hit.sheet.num);

      const px = BOX_GRAB / hit.box.width, py = BOX_GRAB / hit.box.height;
      for (let i = onPage.length - 1; i >= 0; i--) {
        const rects = viewRects(onPage[i].rects, turn);
        if (onPage[i].shape === "box") {
          const r = rects[0];
          if (r && onBoxEdge(r, nx, ny, px, py)) return onPage[i];
        } else if (rectsHit(rects, nx, ny, 0.002)) {
          return onPage[i];
        }
      }
      return null;
    }

    let boxMode = false;
    let boxDrag = null;
    let boxJustDrawn = false;

    function setBoxMode(on) {
      boxMode = !!on;
      if (boxMode && writeMode) setWriteMode(false);
      if (boxMode && drawMode) setDrawMode(false);
      boxBtn.classList.toggle("pr-icon-on", boxMode);
      pagesEl.classList.toggle("pr-boxing", boxMode);
      if (boxMode) { document.getSelection().removeAllRanges(); hidePopup(); }
    }

    function textInBox(sheet, clientRect) {
      const words = [];
      for (const span of sheet.text.querySelectorAll("span")) {
        if (span.children.length) continue;
        const r = span.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx >= clientRect.left && cx <= clientRect.right
            && cy >= clientRect.top && cy <= clientRect.bottom) {
          words.push(span.textContent);
        }
      }
      return tidyQuote(words.join(" "));
    }

    function boxClientRect(d, x, y) {
      const left = Math.max(d.box.left, Math.min(d.x0, x));
      const right = Math.min(d.box.right, Math.max(d.x0, x));
      const top = Math.max(d.box.top, Math.min(d.y0, y));
      const bottom = Math.min(d.box.bottom, Math.max(d.y0, y));
      return { left, right, top, bottom,
               width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    }

    function startBox(ev) {
      if (!boxMode || ev.button !== 0) return;
      const hit = sheetAtPoint(visibleBoxes(), ev.clientX, ev.clientY);
      if (!hit) return;
      ev.preventDefault();
      hidePopup();
      const ghost = el("div", "pr-mark pr-mark-box pr-mark-" + boxColor
                       + " pr-mark-ghost", null, hit.sheet.marks);
      boxDrag = { sheet: hit.sheet, box: hit.box, x0: ev.clientX, y0: ev.clientY,
                  ghost, id: ev.pointerId };
      try { pagesEl.setPointerCapture(ev.pointerId); } catch (_) {}
      moveBox(ev);
    }

    function moveBox(ev) {
      const d = boxDrag;
      if (!d || ev.pointerId !== d.id) return;
      const r = boxClientRect(d, ev.clientX, ev.clientY);
      d.ghost.style.left = ((r.left - d.box.left) / d.box.width * 100) + "%";
      d.ghost.style.top = ((r.top - d.box.top) / d.box.height * 100) + "%";
      d.ghost.style.width = (r.width / d.box.width * 100) + "%";
      d.ghost.style.height = (r.height / d.box.height * 100) + "%";
    }

    function endBox(ev) {
      const d = boxDrag;
      if (!d || ev.pointerId !== d.id) return;
      boxDrag = null;
      d.ghost.remove();
      try { pagesEl.releasePointerCapture(ev.pointerId); } catch (_) {}
      if (ev.type === "pointercancel") return;
      const r = boxClientRect(d, ev.clientX, ev.clientY);

      if (r.width < 6 || r.height < 6) return;
      const frac = toFraction(r, d.box);
      if (!frac) return;
      const num = d.sheet.num;
      const h = { id: newId(), page: num, color: boxColor, shape: "box",
                  rects: [unrotateRect(frac, rotOf(num))],
                  text: textInBox(d.sheet, r), note: "",
                  created: new Date().toISOString() };
      reading.highlights.push(h);
      sortHighlights();
      paintMarks(num);
      renderSide();
      markDirty();
      activity("highlight");
      boxJustDrawn = true;
      setTimeout(() => { boxJustDrawn = false; }, 0);
      showHighlightPopup(h, { left: r.right - 1, right: r.right + 1,
                              top: r.top, bottom: r.top + 12, width: 2, height: 12 });
    }

    function toViewportBox(vp, quad) {
      const a = vp.convertToViewportPoint(quad[0], quad[1]);
      const b = vp.convertToViewportPoint(quad[2], quad[3]);
      return [a[0], a[1], b[0], b[1]];
    }

    async function ensureLinks(sheet) {
      if (sheet.links || sheet.linksLoading || !pdf) return;
      sheet.linksLoading = true;
      try {
        const page = sheet.proxy || (sheet.proxy = await pdf.getPage(sheet.num));
        const annots = await page.getAnnotations({ intent: "display" });
        if (destroyed) return;
        const vp = page.getViewport({ scale: 1 });
        const found = [];
        for (const a of annots || []) {
          if (!a || a.subtype !== "Link" || a.hidden) continue;
          const url = typeof a.url === "string" && SAFE_URL.test(a.url)
            ? a.url : null;
          const dest = url ? null : (a.dest || null);
          if (!url && !dest) continue;
          const rects = [];
          for (const quad of linkQuads(a.rect, a.quadPoints)) {
            const box = boxFraction(toViewportBox(vp, quad), vp.width, vp.height);
            if (box) rects.push(box);
          }
          if (!rects.length) continue;
          found.push({ id: "l" + sheet.num + "-" + found.length,
                       rects, url, dest, target: null });
        }
        sheet.links = found;
        paintLinks(sheet);

        for (const link of found) {
          if (destroyed) return;
          await resolveDest(link);
        }
      } catch (_) {
        sheet.links = sheet.links || [];
      } finally {
        sheet.linksLoading = false;
      }
    }

    async function resolveDest(link) {
      if (link.target) return link.target;
      if (!link.dest || !pdf) return null;
      try {
        let dest = link.dest;
        if (typeof dest === "string") dest = await pdf.getDestination(dest);
        if (!Array.isArray(dest) || !dest.length) return null;
        const ref = dest[0];
        let index = null;
        if (typeof ref === "number") index = ref;
        else if (ref && typeof ref === "object") index = await pdf.getPageIndex(ref);
        if (index == null || index < 0 || index >= sheets.length) return null;
        let frac = 0;
        const y = destY(dest);
        if (y != null) {
          const sheet = sheets[index];
          const page = sheet.proxy || (sheet.proxy = await pdf.getPage(index + 1));
          const vp = page.getViewport({ scale: 1 });

          const point = vp.convertToViewportPoint(0, y);
          frac = clamp01(point[1] / vp.height);
        }

        link.target = { page: index + 1, frac: round5(Math.max(0, frac - 0.012)),
                        whole: y == null };
        return link.target;
      } catch (_) { return null; }
    }

    function paintLinks(sheet) {
      if (!sheet.linkLayer) return;
      sheet.linkLayer.replaceChildren();
      const turn = rotOf(sheet.num);
      for (const link of sheet.links || []) {
        for (const r of viewRects(link.rects, turn)) {
          const box = el("div", "pr-link" + (link.url ? " pr-link-out" : ""),
                         null, sheet.linkLayer);
          box.style.left = (r.x * 100) + "%";
          box.style.top = (r.y * 100) + "%";
          box.style.width = (r.w * 100) + "%";
          box.style.height = (r.h * 100) + "%";
          box.dataset.link = link.id;
        }
      }
    }

    function linkAtPoint(x, y) {
      const hit = sheetAtPoint(visibleBoxes(), x, y);
      if (!hit || !hit.sheet.links || !hit.sheet.links.length) return null;
      const nx = (x - hit.box.left) / hit.box.width;
      const ny = (y - hit.box.top) / hit.box.height;
      const turn = rotOf(hit.sheet.num);
      for (const link of hit.sheet.links) {
        if (rectsHit(viewRects(link.rects, turn), nx, ny, 0)) return link;
      }
      return null;
    }

    function linkLabel(link) {
      if (link.url) {
        const url = link.url.replace(/^mailto:/i, "");
        return url.length > 68 ? url.slice(0, 66) + "…" : url;
      }
      return link.target ? "→ page " + link.target.page : "→ …";
    }

    function placeFloat(node, x, y) {
      const box = root.getBoundingClientRect();
      node.hidden = false;
      const w = node.offsetWidth, h = node.offsetHeight;
      let left = x - box.left + 14;
      let top = y - box.top + 18;
      if (left + w > box.width - 8) left = x - box.left - w - 10;
      if (top + h > box.height - 8) top = y - box.top - h - 10;
      node.style.left = pin(left, w, box.width) + "px";
      node.style.top = pin(top, h, box.height) + "px";
    }

    function pin(want, size, room) {
      return Math.max(8, Math.min(want, room - size - 8));
    }

    function setHotLink(link, x, y) {
      const id = link ? link.id : null;
      if (id !== (hotLink && hotLink.id)) {
        for (const node of root.querySelectorAll(".pr-link-hot")) {
          node.classList.remove("pr-link-hot");
        }
        hotLink = link;
        if (id) {
          for (const node of root.querySelectorAll('[data-link="' + id + '"]')) {
            node.classList.add("pr-link-hot");
          }
        }
      }
      if (!link) { hideHint(); return; }

      if (link.url || !link.dest) { showTip(link, x, y); return; }
      if (link.target) { showPeek(link, x, y); return; }

      showTip(link, x, y);
      resolveDest(link).then(() => {
        if (destroyed || hotLink !== link) return;
        const at = hoverAt || { x: x, y: y };
        setHotLink(link, at.x, at.y);
      });
    }

    function showTip(link, x, y) {
      hidePeek();
      tip.textContent = linkLabel(link);
      placeFloat(tip, x, y);
    }

    function hideHint() {
      tip.hidden = true;
      tip.textContent = "";
      hidePeek();
    }

    function hidePeek() {
      peekFor = null;
      peekToken++;
      peek.hidden = true;
    }

    function peekPage(num, width) {
      const turn = rotOf(num);
      const hit = peekPages.get(num);
      if (hit && hit.width === width && hit.rot === turn) {
        peekPages.delete(num);
        peekPages.set(num, hit);
        return hit.job;
      }
      if (hit) dropPeekPage(num);

      const dpr = Math.min(Math.max(global.devicePixelRatio || 1, 1), 2);
      const job = (async () => {
        const sheet = sheets[num - 1];
        if (!pdf || !sheet) throw new Error("no page " + num);
        const page = sheet.proxy || (sheet.proxy = await pdf.getPage(num));

        const rotation = (page.rotate || 0) + turn;
        const at1 = page.getViewport({ scale: 1, rotation });
        const vp = page.getViewport({ scale: (width / at1.width) * dpr, rotation });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvas, viewport: vp }).promise;
        return { canvas, dpr, width: vp.width / dpr, height: vp.height / dpr };
      })();
      peekPages.set(num, { job, width: width, rot: turn });
      job.catch(() => {
        const entry = peekPages.get(num);
        if (entry && entry.job === job) peekPages.delete(num);
      });
      while (peekPages.size > PEEK_PAGES) {
        dropPeekPage(peekPages.keys().next().value);
      }
      return job;
    }

    function dropPeekPage(num) {
      const entry = peekPages.get(num);
      if (!entry) return;
      peekPages.delete(num);
      entry.job.then((shot) => { shot.canvas.width = shot.canvas.height = 0; },
                     () => {});
    }

    function showPeek(link, x, y) {
      const target = link.target;
      const sheet = target && sheets[target.page - 1];
      if (!sheet) { showTip(link, x, y); return; }
      tip.hidden = true;

      if (peekFor === link) { placeFloat(peek, x, y); return; }
      peekFor = link;
      const token = ++peekToken;

      const size = sheetSize(sheet);
      const room = root.getBoundingClientRect();
      let width = Math.min(PEEK_W, Math.max(200, room.width - 32));

      if (target.whole && size.width > 0 && size.height > 0) {
        width = Math.min(width, PEEK_H * (size.width / size.height));
      }
      const tall = size.width > 0
        ? Math.min(PEEK_H, size.height * (width / size.width)) : PEEK_H;

      peekHead.textContent = linkLabel(link);
      peekView.style.width = Math.round(width) + "px";
      peekView.style.height = Math.round(tall) + "px";
      peekCanvas.style.height = Math.round(tall) + "px";
      placeFloat(peek, x, y);

      peekPage(target.page, width).then((shot) => {
        if (destroyed || token !== peekToken) return;
        const frac = rotateFrac(target.frac, rotOf(target.page));
        const win = peekWindow(frac * shot.height, shot.height,
                               Math.min(PEEK_H, shot.height), PEEK_LEAD);
        if (!(win.h > 0)) return;

        const sy = Math.round(win.y * shot.dpr);
        const sh = Math.round(win.h * shot.dpr);
        peekCanvas.width = shot.canvas.width;
        peekCanvas.height = sh;
        peekCanvas.style.width = shot.width + "px";
        peekCanvas.style.height = win.h + "px";
        peekCanvas.getContext("2d")
          .drawImage(shot.canvas, 0, sy, shot.canvas.width, sh,
                     0, 0, shot.canvas.width, sh);
        peekView.style.width = Math.round(shot.width) + "px";
        peekView.style.height = Math.round(win.h) + "px";
        const at = hoverAt || { x: x, y: y };
        placeFloat(peek, at.x, at.y);
      }).catch(() => {
        if (destroyed || token !== peekToken) return;

        showTip(link, x, y);
      });
    }

    function flashPlace(pos) {
      const sheet = sheets[pos.page - 1];
      if (!sheet || !sheet.linkLayer) return;
      const band = el("div", "pr-landing", null, sheet.linkLayer);
      band.style.top = (pos.frac * 100) + "%";
      setTimeout(() => band.remove(), 1600);
    }

    async function followLink(link) {
      hidePopup();
      setHotLink(null);
      if (link.url) {

        try { global.open(link.url, "_blank", "noopener,noreferrer"); }
        catch (_) {}
        return;
      }
      const from = capturePosition();
      const found = await resolveDest(link);
      if (!found || destroyed) return;

      const pos = { page: found.page,
                    frac: rotateFrac(found.frac, rotOf(found.page)) };
      pushBack(from);
      scrollToPosition(pos, "smooth");
      flashPlace(pos);
    }

    function placePop(clientRect) {
      const box = root.getBoundingClientRect();
      pop.hidden = false;
      const w = pop.offsetWidth, h = pop.offsetHeight;
      let left = clientRect.left + clientRect.width / 2 - box.left - w / 2;
      let top = clientRect.top - box.top - h - 10;
      if (top < 8) top = clientRect.bottom - box.top + 10;
      pop.style.left = pin(left, w, box.width) + "px";
      pop.style.top = pin(top, h, box.height) + "px";
    }

    function hidePopup() {
      pop.hidden = true;
      pop.replaceChildren();
      popupFor = null;
    }

    function showSelectionPopup(capture) {
      pendingSelection = capture;
      popupFor = null;
      pop.replaceChildren();
      swatches(pop, null, (color) => addHighlight(color));
      const n = capture.parts.reduce((sum, p) => sum + p.rects.length, 0);
      el("span", "pr-pop-hint", n ? "highlight" : "", pop);
      if (options.toc) {
        el("span", "pr-sep", null, pop);
        const add = button("pr-pop-btn", "＋ Contents", pop,
                           "Add this heading to the contents");
        add.addEventListener("mousedown", (evt) => evt.preventDefault());
        add.addEventListener("click", () => addSection(capture));
      }
      if (options.lookup) {
        el("span", "pr-sep", null, pop);
        const term = capture.parts.map((part) => part.text).join(" ");
        const ask = button("pr-pop-btn", "Translate", pop,
                           "A definition for the sense used here");
        ask.addEventListener("mousedown", (ev) => ev.preventDefault());
        ask.addEventListener("click", () =>
          askLookup(term, sheetFor(capture.parts[0].page), capture.anchor));
      }
      if (options.study) {
        const term = capture.parts.map((part) => part.text).join(" ");
        const learn = button("pr-pop-btn", "Study", pop,
                             "Learn this concept in your Obsidian vault");
        learn.addEventListener("mousedown", (ev) => ev.preventDefault());
        learn.addEventListener("click", () =>
          askStudy(term, sheetFor(capture.parts[0].page), capture.anchor));
      }
      placePop(capture.anchor);
    }

    function showHighlightPopup(h, clientRect) {
      pendingSelection = null;
      popupFor = h;
      pop.replaceChildren();
      swatches(pop, h.color, (color) => { recolor(h, color); showHighlightPopup(h, clientRect); });
      el("span", "pr-sep", null, pop);
      const noteBtn = button("pr-pop-btn", h.note ? "Edit note" : "Note", pop,
                             "Write a remark on this highlight");
      noteBtn.addEventListener("click", () => {
        hidePopup();
        focusHighlightNote(h);
      });
      if (options.lookup && h.text) {
        const ask = button("pr-pop-btn", "Translate", pop,
                           "A definition for the sense used here");
        ask.addEventListener("click", () =>
          askLookup(h.text, sheetFor(h.page), clientRect));
      }
      if (options.study && h.text) {
        const learn = button("pr-pop-btn", "Study", pop,
                             "Learn this concept in your Obsidian vault");
        learn.addEventListener("click", () =>
          askStudy(h.text, sheetFor(h.page), clientRect));
      }
      const del = button("pr-pop-btn pr-pop-danger", "Delete", pop);
      del.addEventListener("click", () => removeHighlight(h));
      placePop(clientRect);
    }

    const groups = new Map();

    function commentFor(page) {
      return (reading.comments[String(page)] || {}).text || "";
    }

    function setComment(page, text) {
      const key = String(page);
      const body = text.trim();
      if (!body) delete reading.comments[key];
      else {
        reading.comments[key] = { text: text,
                                  updated: new Date().toISOString() };
      }
      markDirty();
      activity("note");
      paintSideCount();
    }

    function paintSideCount() {
      const marks = reading.highlights.length;
      const notes = Object.keys(reading.comments).length;
      const bits = [];
      if (marks) bits.push(marks + (marks === 1 ? " highlight" : " highlights"));
      if (notes) bits.push(notes + (notes === 1 ? " note" : " notes"));
      sideCount.textContent = bits.join(" · ");
    }

    function makeGroup(page) {
      const g = { cards: new Map() };
      g.root = el("section", "pr-group", null, null);
      const head = el("header", "pr-group-head", null, g.root);
      const label = button("pr-group-page", "Page " + page, head,
                           "Jump to page " + page);
      label.addEventListener("click", () => jumpToPage(page));
      g.count = el("span", "pr-group-count", "", head);
      g.comment = el("textarea", "pr-comment", null, g.root);
      g.comment.rows = 1;
      g.comment.placeholder = "What did this page tell you?";
      g.comment.addEventListener("input", () => {
        grow(g.comment);
        setComment(page, g.comment.value);
      });
      g.comment.addEventListener("focus", () => {
        if (current !== page) jumpToPage(page);
      });
      g.cardsEl = el("div", "pr-cards", null, g.root);
      return g;
    }

    function makeCard(h) {
      const card = { };
      card.root = el("article", "pr-card", null, null);
      card.bar = el("div", "pr-card-bar", null, card.root);
      card.swatches = swatches(card.bar, h.color, (color) => recolor(h, color));
      const del = button("pr-card-x", "✕", card.bar, "Delete this highlight");
      del.addEventListener("click", () => removeHighlight(h));
      card.quote = button("pr-quote", "", card.root, "Show it on the page");
      card.quote.addEventListener("click", () => {
        jumpToPage(h.page);
        setTimeout(() => flashHighlight(h.id), 260);
      });
      card.note = el("textarea", "pr-note", null, card.root);
      card.note.rows = 1;
      card.note.placeholder = "Add a remark…";
      card.note.addEventListener("input", () => {
        grow(card.note);
        h.note = card.note.value;

        paintMarks(h.page);
        markDirty();
        activity("note");
        paintSideCount();
      });
      card.note.addEventListener("blur", () => {
        if (!hasNote(h) && noteEditingId === h.id) {
          noteEditingId = null;
          renderSide();
        }
      });
      return card;
    }

    function focusHighlightNote(h) {
      noteEditingId = h.id;
      renderSide();
      const g = groups.get(h.page);
      const card = g && g.cards.get(h.id);
      if (!card) return;
      card.root.scrollIntoView({ block: "nearest", behavior: "smooth" });
      card.note.focus();
    }

    function renderSide() {
      const wanted = new Set([current]);
      for (const h of reading.highlights) {
        if (hasNote(h) || h.id === noteEditingId) wanted.add(h.page);
      }
      for (const key of Object.keys(reading.comments)) wanted.add(Number(key));
      const order = [...wanted].filter((n) => n >= 1).sort((a, b) => a - b);

      for (const [page, g] of groups) {
        if (!wanted.has(page)) { g.root.remove(); groups.delete(page); }
      }
      for (const page of order) {
        let g = groups.get(page);
        if (!g) { g = makeGroup(page); groups.set(page, g); }
        sideList.appendChild(g.root);
        g.root.classList.toggle("pr-group-now", page === current);

        const text = commentFor(page);
        if (document.activeElement !== g.comment && g.comment.value !== text) {
          g.comment.value = text;
        }
        grow(g.comment);

        const notes = reading.highlights.filter((h) => h.page === page
          && (hasNote(h) || h.id === noteEditingId));
        g.count.textContent = notes.length ? String(notes.length) : "";
        const alive = new Set(notes.map((h) => h.id));
        for (const [id, card] of g.cards) {
          if (!alive.has(id)) { card.root.remove(); g.cards.delete(id); }
        }
        for (const h of notes) {
          let card = g.cards.get(h.id);
          if (!card) { card = makeCard(h); g.cards.set(h.id, card); }
          g.cardsEl.appendChild(card.root);
          card.root.dataset.color = h.color;
          card.quote.textContent = (h.shape === "box" ? "▭ " : "")
            + (h.text || (h.shape === "box" ? "a box with no words in it"
                                             : "(no text — a marked area)"));
          for (const dot of card.swatches.children) {
            dot.classList.toggle("pr-dot-on",
                                 dot.classList.contains("pr-dot-" + h.color));
          }
          if (document.activeElement !== card.note && card.note.value !== (h.note || "")) {
            card.note.value = h.note || "";
          }
          grow(card.note);
        }
      }
      if (!order.length) {
        el("p", "pr-side-empty",
           "Select a sentence to highlight it. Notes you write here are saved "
           + "with the page they belong to.", sideList);
      } else {
        const stray = sideList.querySelector(".pr-side-empty");
        if (stray) stray.remove();
      }
      paintSideCount();
    }

    function showSide(which) {
      chatTab = options.chat && which === "chat" ? "chat"
        : options.heard && which === "heard" ? "heard" : "notes";
      const asking = chatTab === "chat";
      const hearing = chatTab === "heard";
      notesTab.classList.toggle("pr-side-tab-on", chatTab === "notes");
      chatTabBtn.classList.toggle("pr-side-tab-on", asking);
      heardTabBtn.classList.toggle("pr-side-tab-on", hearing);
      notesTab.setAttribute("aria-pressed", chatTab === "notes" ? "true" : "false");
      chatTabBtn.setAttribute("aria-pressed", asking ? "true" : "false");
      heardTabBtn.setAttribute("aria-pressed", hearing ? "true" : "false");
      sideList.hidden = chatTab !== "notes";
      chatEl.hidden = !asking;
      heardEl.hidden = !hearing;
      sideCount.hidden = chatTab !== "notes";
      if (hearing) { if (heardTakes === null) loadHeard(); else paintHeard(); }
      askBtn.classList.toggle("pr-chip-on", asking && !root.classList.contains("pr-no-side"));
      if (asking && !chatLoaded) loadChat();
    }

    async function loadHeard() {
      if (!options.heard || heardBusy) return;
      heardBusy = true; heardError = "";
      paintHeard();
      try {
        const data = await options.heard.load();
        heardTakes = (data && data.takes) || [];
      } catch (err) {
        heardError = (err && err.message) || String(err);
        heardTakes = heardTakes || [];
      }
      heardBusy = false;
      if (!destroyed) paintHeard();
    }

    function heardClock(seconds) {
      const v = Math.max(0, Math.round(Number(seconds) || 0));
      const h = Math.floor(v / 3600), m = Math.floor(v / 60) % 60, sec = v % 60;
      return (h ? h + ":" + String(m).padStart(2, "0") : String(m))
        + ":" + String(sec).padStart(2, "0");
    }

    function paintHeard() {
      heardEl.replaceChildren();
      const head = el("div", "pr-heard-head", null, heardEl);
      el("span", "pr-heard-page", "Page " + current, head);
      const again = button("pr-heard-reload", "↻", head, "Read the takes again");
      again.addEventListener("click", () => loadHeard());
      const list = el("div", "pr-heard-list", null, heardEl);
      if (heardBusy && heardTakes === null) {
        el("p", "pr-side-empty", "Reading the takes…", list); return;
      }
      if (heardError) el("p", "pr-heard-error", heardError, list);
      const takes = heardTakes || [];
      if (!takes.length) {
        el("p", "pr-side-empty", (options.heard && options.heard.hint)
           || "Nothing recorded over this paper yet.", list);
        return;
      }
      let any = false;
      for (const take of takes) {
        const stretches = (take.pages || {})[String(current)] || [];
        if (!stretches.length) continue;
        any = true;
        const box = el("div", "pr-heard-take", null, list);
        el("div", "pr-heard-label", take.label || take.take, box);
        for (const stretch of stretches) {
          const at = button("pr-heard-span",
            heardClock(stretch.start) + (stretch.end != null
              ? " – " + heardClock(stretch.end) : " –"), box,
            "Play from here");
          at.addEventListener("click", () =>
            options.heard.play && options.heard.play(take.take, stretch.start));
          if (!stretch.segments.length) {
            el("p", "pr-heard-none", !take.transcribed
               ? (take.pending ? "Transcribing…"
                  : "No timed transcript for this take yet.")
               : "Nothing was said while this page was up.", box);
          }
          for (const seg of stretch.segments) {
            const line = button("pr-heard-line", "", box, "Play this");
            if (seg.speaker) el("strong", null, seg.speaker + " ", line);
            el("span", null, seg.text, line);
            line.addEventListener("click", () =>
              options.heard.play && options.heard.play(take.take, seg.start));
          }
        }
      }
      if (!any) {
        el("p", "pr-side-empty", "This page was not open during any take. "
           + "Pages it was: " + takes.map((t) => Object.keys(t.pages || {})
             .map(Number).sort((a, b) => a - b).join(", ")).filter(Boolean)
             .join(" · ") + ".", list);
      }
    }

    function openChat() {
      if (!options.chat) return;
      if (root.classList.contains("pr-no-side")) {
        root.classList.remove("pr-no-side");
        notesBtn.classList.add("pr-chip-on");
        requestAnimationFrame(refit);
      }
      showSide("chat");
      chatInput.focus();
    }

    function chatLine(parent, cls, text) {
      const row = el("p", cls, text, parent);
      return row;
    }

    function paintChat() {
      chatLog.replaceChildren();
      if (!chatRows.length) {
        el("p", "pr-chat-empty",
           (options.chat && options.chat.hint)
           || "Ask what the task was, what they were asking, what they found. "
              + "Select a passage first and it rides along with the question.",
           chatLog);
      }
      for (const row of chatRows) {
        const mine = row.role === "reader";
        const turn = el("div", "pr-chat-turn" + (mine ? " pr-chat-mine" : ""),
                        null, chatLog);
        const who = el("span", "pr-chat-who", mine ? "You"
                       : (options.chat && options.chat.who) || "Marlin", turn);
        const providerLabel = !mine && row.provider && options.chat
          && options.chat.providers && options.chat.providers[row.provider];
        if (providerLabel) {
          el("span", "pr-chat-provider", "· " + providerLabel, who);
        }

        if (mine && row.via) el("span", "pr-chat-via", "· " + row.via, who);
        if (mine && row.selection) {
          el("p", "pr-chat-quoted",
             "“" + row.selection + "”"
             + (row.page ? "  (p. " + row.page + ")" : ""), turn);
        }
        const answer = chatLine(turn, "pr-chat-text", row.text || "");

        if (!mine && row.text_ko) {
          const langs = el("span", "pr-chat-langs", null, who);
          langs.setAttribute("role", "group");
          langs.setAttribute("aria-label", "Brief language");
          const en = button("pr-chat-lang pr-chat-lang-on", "EN", langs,
                            "Show the English brief");
          const ko = button("pr-chat-lang", "Translation", langs,
                            "Show the translated summary");
          const show = (language) => {
            answer.textContent = language === "ko" ? row.text_ko : (row.text || "");
            answer.lang = language === "ko" ? "ko" : "en";
            en.classList.toggle("pr-chat-lang-on", language === "en");
            ko.classList.toggle("pr-chat-lang-on", language === "ko");
            en.setAttribute("aria-pressed", language === "en" ? "true" : "false");
            ko.setAttribute("aria-pressed", language === "ko" ? "true" : "false");
          };
          en.addEventListener("click", () => show("en"));
          ko.addEventListener("click", () => show("ko"));
          show("en");
        }
        for (const line of row.done || []) {
          chatLine(turn, "pr-chat-did", "✓ " + line);
        }
        for (const line of row.refused || []) {
          chatLine(turn, "pr-chat-refused", "○ " + line);
        }
      }
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    function paintCarry() {
      chatCarry.hidden = !chatCarried;
      if (chatCarried) {
        const text = chatCarried.text;
        chatCarryText.textContent = "“"
          + (text.length > 140 ? text.slice(0, 140) + "…" : text)
          + "”  p. " + chatCarried.page;
        chatCarryText.title = text;
      }
    }

    function carrySelection(capture) {
      if (!options.chat || !capture) return;
      const part = capture.parts.find((p) => (p.text || "").trim());
      if (!part) return;
      chatCarried = { text: part.text.trim(), page: part.page };
      paintCarry();
    }

    async function loadChat() {
      if (!options.chat || !options.chat.load) return;
      chatLoaded = true;
      try {
        const data = await options.chat.load();
        chatRows = (data && data.messages) || [];
      } catch (err) {
        chatRows = [];
        chatLoaded = false;
        paintChat();
        el("p", "pr-chat-refused",
           "The conversation could not be read: " + (err.message || err), chatLog);
        return;
      }
      paintChat();
    }

    function chatWaiting(on) {
      chatBusy = on;
      chatSend.disabled = on;
      for (const control of shortcutButtons) control.disabled = on;
      chatSend.textContent = on ? "Reading…" : "Ask";
      chatEl.classList.toggle("pr-chat-busy", on);
    }

    async function sendChatTurn(turn, restore) {
      if (!options.chat || !options.chat.send || chatBusy) return;

      chatRows = chatRows.concat([{ role: "reader", text: turn.message,
                                    intent: turn.intent || "",
                                    selection: turn.selection || "",
                                    page: turn.page || current }]);
      paintChat();
      chatWaiting(true);
      const pending = el("p", "pr-chat-waiting",
                         ((options.chat.who || "Marlin"))
                         + " is reading the paper…", chatLog);
      chatLog.scrollTop = chatLog.scrollHeight;
      try {
        const data = await options.chat.send(turn);
        chatRows = (data && data.messages) || chatRows;
        paintChat();
      } catch (err) {
        pending.remove();
        chatLine(chatLog, "pr-chat-refused",
                 "No answer: " + (err.message || err)
                 + (restore ? " Your question is still in the box."
                            : " Press the shortcut to try again."));
        if (restore) restore();
      } finally {
        chatWaiting(false);
        chatLog.scrollTop = chatLog.scrollHeight;
      }
    }

    async function sendChat() {
      if (!options.chat || !options.chat.send || chatBusy) return;
      const text = chatInput.value.trim();
      if (!text) return;
      const carried = chatCarried;
      chatInput.value = "";
      grow(chatInput);
      chatCarried = null;
      paintCarry();
      await sendChatTurn({
        message: text, page: carried ? carried.page : current,
        selection: carried ? carried.text : "",
      }, () => {
        chatInput.value = text;
        chatCarried = carried;
        paintCarry();
        grow(chatInput);
      });
    }

    async function sendShortcut(shortcut) {
      if (!shortcut || chatBusy) return;
      await sendChatTurn({ message: shortcut.message, intent: shortcut.intent || "",
                           provider: shortcut.provider || "claude",
                           page: current, selection: "" });
    }

    notesTab.addEventListener("click", () => showSide("notes"));
    chatTabBtn.addEventListener("click", () => openChat());
    heardTabBtn.addEventListener("click", () => showSide("heard"));
    askBtn.addEventListener("click", () => {

      if (chatTab === "chat" && !root.classList.contains("pr-no-side")) {
        root.classList.add("pr-no-side");
        notesBtn.classList.remove("pr-chip-on");
        askBtn.classList.remove("pr-chip-on");
        requestAnimationFrame(refit);
        return;
      }
      openChat();
    });
    chatCarryDrop.addEventListener("click", () => {
      chatCarried = null;
      paintCarry();
      chatInput.focus();
    });
    chatFoot.addEventListener("submit", (ev) => { ev.preventDefault(); sendChat(); });
    shortcutButtons.forEach((control, index) => {
      control.addEventListener("click", () => sendShortcut(configuredShortcuts[index]));
    });
    chatInput.addEventListener("input", () => grow(chatInput));
    chatInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); sendChat(); }
    });
    chatClear.addEventListener("click", async () => {
      if (!options.chat || !options.chat.clear) return;
      if (!global.confirm("Forget this conversation? Your marks, the takeaway "
                          + "and the paper's shelf state are not touched.")) return;
      try {
        const data = await options.chat.clear();
        chatRows = (data && data.messages) || [];
        paintChat();
      } catch (err) {
        chatLine(chatLog, "pr-chat-refused",
                 "It could not be cleared: " + (err.message || err));
      }
    });

    backBtn.addEventListener("click", () => goBack());
    fwdBtn.addEventListener("click", () => goForward());
    paintNav();

    prevBtn.addEventListener("click", () => goToPage(current - 1));
    nextBtn.addEventListener("click", () => goToPage(current + 1));
    pageInput.addEventListener("change", () => {
      jumpToPage(parseInt(pageInput.value, 10));
      pageInput.value = String(current);
    });
    pageInput.addEventListener("focus", () => pageInput.select());

    zoomIn.addEventListener("click", () => zoomBy(1));
    zoomOut.addEventListener("click", () => zoomBy(-1));
    zoomLabel.addEventListener("click", () => { setFit(null); applyScale(1); });
    fitBtn.addEventListener("click", () => setFit(fitMode ? null : "width"));

    scroller.addEventListener("wheel", (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      setFit(null);
      const d = Math.max(-24, Math.min(24, ev.deltaY));
      applyScale(scale * Math.exp(-d * 0.012), { x: ev.clientX, y: ev.clientY });
    }, { passive: false });

    rotBtn.addEventListener("click",
                            (ev) => rotatePage(current, ev.shiftKey ? -90 : 90));
    paintRotate();

    tocBtn.addEventListener("click", () => {
      const off = root.classList.toggle("pr-no-toc");
      tocBtn.classList.toggle("pr-chip-on", !off);
      requestAnimationFrame(refit);
    });

    tocEdit.addEventListener("click", () => {
      tocManual = !tocManual;
      buildToc();
      requestAnimationFrame(refit);
    });

    tocAsk.addEventListener("click", () => { askMarlin(); });

    pagesEl.addEventListener("dragstart", () => { tocCarry = captureSelection(); });
    tocEl.addEventListener("dragover", (ev) => {
      if (!tocCarry) return;
      ev.preventDefault();
      tocEl.classList.add("pr-toc-drop");
    });
    tocEl.addEventListener("dragleave", () => tocEl.classList.remove("pr-toc-drop"));
    tocEl.addEventListener("drop", (ev) => {
      ev.preventDefault();
      tocEl.classList.remove("pr-toc-drop");
      const carried = tocCarry;
      tocCarry = null;
      if (carried) addSection(carried);
    });

    notesBtn.addEventListener("click", () => {
      const on = root.classList.toggle("pr-no-side");
      notesBtn.classList.toggle("pr-chip-on", !on);

      if (!on) showSide("notes");
      askBtn.classList.toggle("pr-chip-on", !on && chatTab === "chat");

      requestAnimationFrame(refit);
    });

    scroller.addEventListener("scroll", () => {

      hideHint();

      railTick();

      paintToc();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(onSettle, SETTLE_MS);
    }, { passive: true });

    pagesEl.addEventListener("mouseup", () => {
      if (boxMode || writeMode || drawMode || editingId) return;
      setTimeout(() => {
        const capture = captureSelection();
        if (capture) {
          showSelectionPopup(capture);

          if (chatTab === "chat") carrySelection(capture);
        } else if (pendingSelection) hidePopup();
      }, 0);
    });

    pagesEl.addEventListener("pointerdown", startBox);
    pagesEl.addEventListener("pointermove", moveBox);
    pagesEl.addEventListener("pointerup", endBox);
    pagesEl.addEventListener("pointercancel", endBox);
    boxBtn.addEventListener("click", () => setBoxMode(!boxMode));
    writeBtn.addEventListener("click", () => setWriteMode(!writeMode));
    drawBtn.addEventListener("click", () => setDrawMode(!drawMode));
    pagesEl.addEventListener("pointerdown", startStroke);
    pagesEl.addEventListener("pointermove", extendStroke);
    pagesEl.addEventListener("pointerup", endStroke);
    pagesEl.addEventListener("pointercancel", endStroke);

    pagesEl.addEventListener("click", (ev) => {
      if (boxJustDrawn) return;
      if (drawMode) return;
      if (writeMode) {

        if (editingId || Date.now() - putDownAt < 500) return;
        if (!pop.hidden) { hidePopup(); return; }
        startWriting(ev);
        return;
      }
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;

      const link = linkAtPoint(ev.clientX, ev.clientY);
      if (link) { ev.preventDefault(); followLink(link); return; }
      const h = highlightAtPoint(ev.clientX, ev.clientY);
      if (h) {
        const rect = { left: ev.clientX - 1, right: ev.clientX + 1,
                       top: ev.clientY - 6, bottom: ev.clientY + 6,
                       width: 2, height: 12 };
        showHighlightPopup(h, rect);
      } else if (!pop.hidden) hidePopup();
    });

    let hoverAt = null, hoverQueued = false;
    pagesEl.addEventListener("mousemove", (ev) => {
      hoverAt = { x: ev.clientX, y: ev.clientY };
      if (hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(() => {
        hoverQueued = false;
        if (destroyed || !hoverAt) return;
        const sel = document.getSelection();
        const selecting = sel && !sel.isCollapsed;
        const link = selecting ? null : linkAtPoint(hoverAt.x, hoverAt.y);
        const mark = (selecting || link) ? null
          : highlightAtPoint(hoverAt.x, hoverAt.y);
        pagesEl.classList.toggle("pr-over-link", !!link);
        pagesEl.classList.toggle("pr-over-mark", !!mark);
        setHotLink(link, hoverAt.x, hoverAt.y);
      });
    });

    pagesEl.addEventListener("mouseleave", () => {
      hoverAt = null;
      pagesEl.classList.remove("pr-over-link", "pr-over-mark");
      setHotLink(null);
    });

    function onAux(ev) {
      if (ev.button !== 3 && ev.button !== 4) return;
      ev.preventDefault();
      if (ev.type !== "mousedown") return;
      if (ev.button === 3) goBack(); else goForward();
    }
    root.addEventListener("mousedown", onAux);
    root.addEventListener("auxclick", onAux);

    function onDocDown(ev) {
      if (pop.hidden || pop.contains(ev.target)) return;
      if (pagesEl.contains(ev.target)) return;
      hidePopup();
    }
    document.addEventListener("mousedown", onDocDown, true);

    function onKey(ev) {
      if (destroyed || !root.isConnected) return;

      const modals = document.querySelectorAll("dialog:modal");
      if (modals.length && root.closest("dialog") !== modals[modals.length - 1]) return;
      const key = ev.key;

      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (key === "f" || key === "F")) {
        ev.preventDefault();
        openFind();
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (key === "g" || key === "G")
          && !findBar.hidden) {
        ev.preventDefault();
        stepFind(ev.shiftKey ? -1 : 1);
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && (key === "s" || key === "S")) {
        ev.preventDefault();
        flush(true);
        return;
      }

      if (drawMode && (ev.metaKey || ev.ctrlKey) && !ev.shiftKey
          && (key === "z" || key === "Z") && !(ev.target && ev.target.isContentEditable)) {
        if (undoStroke()) ev.preventDefault();
        return;
      }

      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey) {
        if (key === "+" || key === "=") { ev.preventDefault(); zoomBy(1); return; }
        if (key === "-" || key === "_") { ev.preventDefault(); zoomBy(-1); return; }
        if (key === "0") { ev.preventDefault(); setFit("width"); return; }
      }
      const inField = ev.target && (ev.target.tagName === "INPUT"
        || ev.target.tagName === "TEXTAREA" || ev.target.isContentEditable);
      if (key === "Escape") {

        hideHint();
        if (!pop.hidden) { ev.preventDefault(); ev.stopPropagation(); hidePopup(); }
        else if (boxMode) { ev.preventDefault(); ev.stopPropagation(); setBoxMode(false); }
        else if (writeMode) { ev.preventDefault(); ev.stopPropagation(); setWriteMode(false); }
        else if (drawMode) { ev.preventDefault(); ev.stopPropagation(); setDrawMode(false); }
        else if (!findBar.hidden) { ev.preventDefault(); ev.stopPropagation(); closeFind(); }
        return;
      }
      if (inField) return;

      if (ev.altKey && !ev.metaKey && !ev.ctrlKey
          && (key === "ArrowLeft" || key === "ArrowRight")) {
        ev.preventDefault();
        if (key === "ArrowLeft") goBack(); else goForward();
        return;
      }

      if (ev.altKey && !ev.metaKey && !ev.ctrlKey && /^Digit[1-3]$/.test(ev.code || "")) {
        const color = COLORS[Number(ev.code.slice(5)) - 1];
        if (pendingSelection) { ev.preventDefault(); addHighlight(color); }
        else if (popupFor) { ev.preventDefault(); recolor(popupFor, color); hidePopup(); }
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (key === "ArrowRight" || key === "PageDown" || key === "j") {
        ev.preventDefault(); goToPage(current + 1);
      } else if (key === "ArrowLeft" || key === "PageUp" || key === "k") {
        ev.preventDefault(); goToPage(current - 1);
      } else if (key === "+" || key === "=") {
        ev.preventDefault(); zoomBy(1);
      } else if (key === "-") {
        ev.preventDefault(); zoomBy(-1);
      } else if (key === "0") {
        ev.preventDefault(); setFit("width");
      } else if (key === "t" || key === "T") {

        ev.preventDefault(); rotatePage(current, ev.shiftKey ? -90 : 90);
      } else if (key === "r" || key === "R") {
        ev.preventDefault(); setBoxMode(!boxMode);
      } else if (key === "w" || key === "W") {
        ev.preventDefault(); setWriteMode(!writeMode);
      } else if (key === "d" || key === "D") {
        ev.preventDefault(); setDrawMode(!drawMode);
      } else if ((key === "m" || key === "M") && options.chat) {

        ev.preventDefault();
        const capture = captureSelection();
        openChat();
        if (capture) carrySelection(capture);
      }
    }
    document.addEventListener("keydown", onKey);

    function onBeforeUnload(ev) {
      if (!dirty && !saving) return;
      ev.preventDefault();
      ev.returnValue = "";
    }
    global.addEventListener("beforeunload", onBeforeUnload);

    function onHide() { if (document.visibilityState === "hidden") flush(); }
    document.addEventListener("visibilitychange", onHide);

    function refreshResolution() {
      for (const sheet of sheets) if (sheet.near) renderSheet(sheet);
    }
    global.addEventListener("resize", refreshResolution, { passive: true });

    const resizeObs = new ResizeObserver(() => {
      refit();
      if (!findBar.hidden) placeFind();
    });
    resizeObs.observe(scroller);

    const visObs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const num = Number(entry.target.dataset.page);
        visible.set(num, entry.intersectionRatio);
      }
      recomputeCurrent();
    }, { root: scroller, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });

    const nearObs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const sheet = sheets[Number(entry.target.dataset.page) - 1];
        if (!sheet) continue;
        sheet.near = entry.isIntersecting;
        if (sheet.near) renderSheet(sheet);
        else if (sheet.renderedAt != null) releaseSheet(sheet);
      }
    }, { root: scroller, rootMargin: "200% 0px" });

    function storedRotations(raw) {
      const out = {};
      if (!raw || typeof raw !== "object") return out;
      for (const [key, value] of Object.entries(raw)) {
        const page = Math.round(Number(key));
        const turn = normalizeRotation(value);
        if (turn && page >= 1) out[String(page)] = turn;
      }
      return out;
    }

    async function open() {
      const pdfjs = await loadPdfjs(assets);
      const [documentResult, readingResult] = await Promise.allSettled([
        pdfjs.getDocument({
          url: options.url,
          cMapUrl: assets.cmaps, cMapPacked: true,
          standardFontDataUrl: assets.fonts,
          wasmUrl: assets.wasm, iccUrl: assets.icc,
        }).promise,
        Promise.resolve().then(() => options.load()),
      ]);
      if (readingResult.status === "rejected" || documentResult.status === "rejected") {
        if (documentResult.status === "fulfilled") {
          try { await documentResult.value.destroy?.(); } catch (_) {  }
        }
        const error = readingResult.status === "rejected" ? readingResult.reason : documentResult.reason;
        throw new Error(`Could not load this document and its annotations: ${error && error.message ? error.message : String(error)}`);
      }
      const doc = documentResult.value, stored = readingResult.value;
      if (destroyed) { try { await doc.destroy?.(); } catch (_) {} return; }
      pdf = doc;
      reading = {
        ...(stored || {}),
        highlights: Array.isArray(stored && stored.highlights)
          ? stored.highlights.map((h) => ({
              ...h,
              id: h.id || newId(), page: h.page, color: h.color || DEFAULT_COLOR,
              rects: h.rects || [], text: h.text || "", note: h.note || "",
              created: h.created || "",
              ...(h.shape === "box" ? { shape: "box" } : {}),
            })).filter((h) => h.page >= 1 && h.rects.length)
          : [],
        writings: Array.isArray(stored && stored.writings)
          ? stored.writings.map((w) => ({
              ...w,
              id: w.id || newId(), page: w.page, x: w.x, y: w.y,
              text: w.text || "", color: COLORS.includes(w.color) ? w.color : "pink",
              size: WRITING_SIZES.includes(w.size) ? w.size : WRITING_SIZES[0],
              created: w.created || "",
            })).filter((w) => w.page >= 1 && w.text.trim())
          : [],
        drawings: Array.isArray(stored && stored.drawings)
          ? stored.drawings.map((d) => ({
              ...d,
              id: d.id || newId(), page: d.page, points: d.points || [],
              color: COLORS.includes(d.color) ? d.color : "pink",
              size: DRAWING_SIZES.includes(d.size) ? d.size : DRAWING_SIZES[0],
              created: d.created || "",
            })).filter((d) => d.page >= 1 && d.points.length >= 2)
          : [],
        comments: (stored && stored.comments) || {},

        rotations: storedRotations(stored && stored.rotations),

        contents: sortSections(Array.isArray(stored && stored.contents)
          ? stored.contents : []),
      };
      readingLoaded = true;
      sortHighlights();
      paintRotate();
      if (stored && stored.updated) savedAt = new Date(stored.updated);

      loading.remove();
      pageCount.textContent = "/ " + pdf.numPages;
      if (!options.title) {
        titleEl.textContent = (pdf.title || "").trim() || "Untitled";
      }

      for (let n = 1; n <= pdf.numPages; n++) {
        const sheet = { num: n, TextLayer: pdfjs.TextLayer, near: false,
                        textRot: null,
                        renderedAt: null, renderedRot: null, renderedDpr: null };
        sheet.root = el("div", "pr-sheet", null, pagesEl);
        sheet.root.dataset.page = String(n);
        sheet.page = el("div", "pr-page", null, sheet.root);
        sheet.page.style.setProperty("--scale-round-x", "1px");
        sheet.page.style.setProperty("--scale-round-y", "1px");
        sheet.canvas = el("canvas", "pr-canvas", null, sheet.page);
        sheet.marks = el("div", "pr-marks", null, sheet.page);
        sheet.text = el("div", "textLayer", null, sheet.page);
        sheet.links = null;
        sheet.linkLayer = el("div", "pr-links", null, sheet.page);
        sheet.ink = el("div", "pr-ink", null, sheet.page);
        el("div", "pr-label", String(n), sheet.root);
        sheets.push(sheet);
      }

      const first = await pdf.getPage(1);
      const baseline = first.getViewport({ scale: 1 });
      for (const sheet of sheets) sheet.base = baseline;
      sheets[0].proxy = first;
      for (const sheet of sheets) { layoutSheet(sheet); }

      setFit("width");
      settleFits = [80, 320].map((ms) => setTimeout(() => {
        if (!destroyed && fitMode) applyScale(fitScale(fitMode));
      }, ms));

      (async () => {
        for (const sheet of sheets) {
          if (destroyed) return;
          try {
            const page = sheet.proxy || (sheet.proxy = await pdf.getPage(sheet.num));
            const vp = page.getViewport({ scale: 1 });
            if (Math.abs(vp.width - sheet.base.width) > 0.5
                || Math.abs(vp.height - sheet.base.height) > 0.5) {
              sheet.base = vp;
              layoutSheet(sheet);
            }
          } catch (_) {  }
        }
      })();

      paintAllMarks();
      for (const sheet of sheets) { visObs.observe(sheet.root); nearObs.observe(sheet.root); }

      loadToc();

      const asked = Math.min(Math.round(options.startPage) || 0, sheets.length);
      const resumeAt = asked > 1 ? { page: asked, frac: 0 }
        : options.resume ? resumePlace() : null;
      if (resumeAt && resumeAt.page > 1) {

        reached.add(resumeAt.page);
        backStack.push({ page: 1, frac: 0 });
        paintNav();
        scrollToPosition(resumeAt, "auto");
        sayResumed(resumeAt.page, asked > 1);
      }

      renderSide();
      paintSave();
      paintRail();
      if (options.onPage) { try { options.onPage(current); } catch (_) {  } }
      statusTimer = setInterval(paintSave, 30000);
    }

    const ready = open().catch((err) => {
      loading.textContent = "Could not open this PDF — " + (err.message || err);
      loading.classList.add("pr-error");
      console.error(err);
      throw err;
    });

    function destroy() {
      destroyed = true;
      if (saveTimer) clearTimeout(saveTimer);
      if (statusTimer) clearInterval(statusTimer);
      if (settleTimer) clearTimeout(settleTimer);
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onHide);
      global.removeEventListener("beforeunload", onBeforeUnload);
      global.removeEventListener("resize", refreshResolution);
      if (zoomRender) clearTimeout(zoomRender);
      if (refitFrame) global.cancelAnimationFrame(refitFrame);
      if (railFrame) global.cancelAnimationFrame(railFrame);
      if (railNoteTimer) clearTimeout(railNoteTimer);
      for (const t of settleFits) clearTimeout(t);
      visObs.disconnect(); nearObs.disconnect(); resizeObs.disconnect();
      for (const sheet of sheets) releaseSheet(sheet);
      if (global.CSS && CSS.highlights) {
        CSS.highlights.delete("pr-find");
        CSS.highlights.delete("pr-find-now");
      }
      for (const num of [...peekPages.keys()]) dropPeekPage(num);
      if (pdf) { try { pdf.destroy(); } catch (_) {} }
      root.remove();
    }

    return {
      ready,
      destroy,
      save: () => flush(true),
      saveStable,
      isDirty: () => dirty || saving,
      goToPage,
      get page() { return current; },

      reloadHeard: () => { heardTakes = null; if (chatTab === "heard") loadHeard(); },
      showHeard: () => {
        if (!options.heard) return;
        if (root.classList.contains("pr-no-side")) {
          root.classList.remove("pr-no-side");
          notesBtn.classList.add("pr-chip-on");
          requestAnimationFrame(refit);
        }
        showSide("heard");
      },

      setBody: (next) => { options.body = next || null; paintRail(); },
      get reading() { return serialize(); },
    };
  }

  global.PdfReader = { mount, COLORS,
                       _internals: { toFraction, mergeRects, rectsHit, onBoxEdge,
                                     tidyQuote, hasNote, pickCurrent, unionRect,
                                     boxFraction, linkQuads, destY,
                                     bigJump, normalizeRotation, rotateRect,
                                     unrotateRect, rotateFrac, peekWindow,
                                     placeFraction, markFraction, shelfFraction,
                                     placeAt, pickSection, sectionFromSelection,
                                     sortSections, levelFromDrag,
                                     foldChar, findText, findAll } };
})(window);

if (document.getElementById('readerHost')) {
  const { topbar, toast, CLIENT } = await import('/ui/common.js');
  const can = CLIENT.features || {};
  if (can.translate === false) document.getElementById('readerSyncAnki').hidden = true;
  document.getElementById('top').innerHTML = topbar('library');
  const params = new URLSearchParams(location.search);
  const paperId = location.pathname === '/reader/material' ? '' : decodeURIComponent(location.pathname.split('/').pop());
  const scope = paperId ? new URLSearchParams({ paperId }) : new URLSearchParams({ path: params.get('path') || '' });
  const endpoint = (name, extra = {}) => `/api/reader/${name}?${new URLSearchParams({ ...Object.fromEntries(scope), ...extra })}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  async function request(url, method = 'GET', value) {
    const response = await fetch(url, { method, ...(value === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  const helper = document.getElementById('readerHelper');
  const helperBody = document.getElementById('helperBody');
  let helperToken = 0;
  function element(tag, text, parent = helperBody, cls = '') {
    const item = document.createElement(tag); item.textContent = text;
    if (cls) item.className = cls;
    parent.append(item); return item;
  }
  function openHelper(title) {
    helperToken += 1;
    document.getElementById('helperTitle').textContent = title;
    helperBody.replaceChildren();
    if (!helper.open) helper.showModal();
    return helperToken;
  }
  helper.addEventListener('close', () => { helperToken += 1; });
  helper.addEventListener('click', (event) => { if (event.target === helper) helper.close(); });
  function action(label, fn, parent = helperBody, primary = false) {
    const button = element('button', label, parent, `btn${primary ? ' primary' : ''}`);
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await fn(button); }
      catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    });
    return button;
  }
  function line(label, text) {
    if (!text) return;
    const row = element('div', '', helperBody, 'reader-helper-line');
    element('small', label, row); element('p', text, row);
  }
  function download(value, name) {
    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  let reader, metadata, revision, observed;
  async function lookup(term, context) {
    const token = openHelper('Translate & vocabulary');
    element('h2', term);
    const status = element('p', 'Looking up the dictionary and reading this passage with your Claude Code subscription…', helperBody, 'muted');
    try {
      const row = await request(endpoint('lookup'), 'POST', { term, context, provider: 'claude' });
      if (token !== helperToken) return;
      helperBody.replaceChildren();
      element('h2', row.headword || row.term || term);
      if (row.ipa) element('p', row.ipa, helperBody, 'muted');
      line('Dictionary', row.entry_definition);
      line('In this passage', row.in_context || row.definition);
      line('Example', row.example);
      if (row.dictionary?.url && /^https?:\/\//.test(row.dictionary.url)) {
        const link = element('a', 'Dictionary source', helperBody, 'reader-helper-source');
        link.href = row.dictionary.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      }
      const states = { added: 'Added to Anki', duplicate: 'Already in Anki', queued: 'Queued locally. Open Anki, then press Sync queued vocabulary cards in Export.', failed: 'Anki could not save this card.' };
      const card = element('p', states[row.card?.state] || 'A passage is kept as a lookup. You can add its headword to Anki.', helperBody, 'muted');
      if (!['added', 'duplicate', 'queued'].includes(row.card?.state)) action('Add headword to Anki', async () => {
        const result = await request(endpoint('lookup-card'), 'POST', { id: row.id });
        card.textContent = states[result.card?.state] || 'Anki did not add this card.';
      });
      if (row.cached) element('small', 'Saved lookup · dictionary and model sources are identified above.', helperBody, 'muted');
    } catch (error) { if (token === helperToken) { status.textContent = error.message; action('Try again', () => lookup(term, context)); } }
  }
  function study(term, context) {
    const token = openHelper('Study a concept');
    const form = element('form', '', helperBody, 'reader-study-form');
    const label = element('label', 'Concept', form);
    const name = document.createElement('input'); name.value = String(term).slice(0, 200); name.required = true; name.maxLength = 200; label.append(name);
    const questionLabel = element('label', 'What would you like to understand?', form);
    const question = document.createElement('textarea'); question.rows = 3; question.placeholder = 'Optional question or direction for the write-up'; questionLabel.append(question);
    const providerLabel = element('label', 'Write with', form);
    const provider = document.createElement('select');
    for (const [value, title] of [['claude', 'Claude Code'], ['codex', 'Codex']]) { const option = document.createElement('option'); option.value = value; option.textContent = title; provider.append(option); }
    providerLabel.append(provider);
    element('p', 'Study notes and write-ups open in your connected Obsidian vault, linked to this paper.', form, 'muted');
    const status = element('p', '', form, 'reader-helper-status');
    const submit = element('button', 'Study in my vault', form, 'btn primary'); submit.type = 'submit';
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); submit.disabled = true;
      status.textContent = 'Connecting this concept and paper in your vault…';
      try {
        let row = await request('/api/knowledge/study', 'POST', { paperId: metadata.paperId, term: name.value.trim(), question: question.value.trim(),
          context, page: reader.page, provider: provider.value, sourcePath: metadata.materialPath || '' });
        while (['queued', 'running'].includes(row.status) && token === helperToken) {
          status.textContent = 'Writing your study note. You can close this panel and continue reading.';
          await new Promise((resolve) => setTimeout(resolve, 2500));
          if (token !== helperToken) return;
          row = await request(`/api/knowledge/study?id=${encodeURIComponent(row.id)}`);
        }
        if (token !== helperToken) return;
        if (['failed', 'error', 'interrupted'].includes(row.status)) throw new Error(row.error || 'The study note could not be prepared.');
        status.textContent = 'Your linked study note is ready in Obsidian.';
        const note = row.notePath || row.main;
        if (note) action('Open study note', () => request('/api/knowledge/open', 'POST', { path: note }), helperBody, true);
        for (const entry of row.path || []) if (entry.rel && entry.rel !== note) action(entry.title || entry.rel, () => request('/api/knowledge/open', 'POST', { path: entry.rel }));
      } catch (error) { if (token === helperToken) status.textContent = error.message; }
      finally { if (token === helperToken) submit.disabled = false; }
    });
    question.focus();
  }
  try {
    metadata = await request(endpoint('document'));
    document.title = `${metadata.title} · Lancetfish`;
    document.getElementById('readerTitle').textContent = metadata.title;
    document.getElementById('readerBack').href = metadata.back;
    document.getElementById('readerBack').textContent = metadata.materialPath ? '← Schedule' : '← Library';
    if (metadata.detail) { const details = document.getElementById('readerDetails'); details.href = metadata.detail; details.hidden = false; }
    document.getElementById('readerPdf').href = endpoint('file', { download: '1' });
    document.getElementById('readerMarkdown').href = endpoint('reading.md');
    const envelope = await request(endpoint('reading'));
    revision = envelope.revision;
    reader = window.PdfReader.mount(document.getElementById('readerHost'), {
      url: endpoint('file'), title: metadata.title, showTitle: false, autosaveMs: 250,
      startPage: Number(params.get('page')) || 0,
      assets: { lib: '/vendor/pdfjs/pdf.min.mjs', worker: '/vendor/pdfjs/pdf.worker.min.mjs', cmaps: '/vendor/pdfjs/cmaps/', fonts: '/vendor/pdfjs/standard_fonts/', wasm: '/vendor/pdfjs/wasm/', icc: '/vendor/pdfjs/iccs/' },
      load: async () => envelope.reading,
      save: async (reading) => {
        const sent = clone(reading);
        const saved = await request(endpoint('reading'), 'PUT', { reading: sent, revision, observed: observed || clone(envelope.reading) });
        revision = saved.revision; observed = sent;
        return saved.reading;
      },
      toc: () => request(endpoint('toc')),
      words: (page) => request(endpoint('words', { page })),
      lookup: can.translate === false ? null : lookup, study: can.study === false ? null : study,
      chat: can.readerChat === false ? null : { who: 'Ask', hint: 'Ask about the question, method, findings or a selected passage. Replies cite PDF pages and use your subscription CLI.',
        shortcuts: [{ label: 'Claude brief', message: 'Give me the research question, method and data, main findings and limitations, with PDF page references.', provider: 'claude' },
          { label: 'Codex brief', message: 'Give me the research question, method and data, main findings and limitations, with PDF page references.', provider: 'codex' }],
        providers: { claude: 'Claude Code', codex: 'Codex' },
        load: () => request(endpoint('chat')),
        send: (turn) => request(endpoint('chat'), 'POST', turn),
        clear: () => request(endpoint('chat'), 'DELETE', {}),
      },
      onPage: (page) => {
        const address = new URL(location.href);
        if (page > 1) address.searchParams.set('page', page); else address.searchParams.delete('page');
        history.replaceState(null, '', address);
      },
    });
    window.v2Reader = reader;
    await reader.ready;
    observed = clone(reader.reading);
    document.getElementById('readerRecovery').addEventListener('click', () => download({ paperId: metadata.paperId, key: metadata.key, revision, reading: reader.reading }, `${metadata.key}-annotations.json`));
    document.getElementById('readerSyncAnki').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try { const out = await request(endpoint('anki-sync'), 'POST', {}); toast(`Anki: ${out.synced.added} added, ${out.synced.duplicates} already present.`); }
      catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    });

    document.addEventListener('click', async (event) => {
      const link = event.target.closest('a[href]');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === '_blank' || link.download) return;
      const address = new URL(link.href, location.href);
      if (address.origin !== location.origin || !reader.isDirty()) return;
      event.preventDefault();
      try { await reader.saveStable(); location.assign(address.href); }
      catch (error) { toast(`${error.message} Export JSON to keep a recovery copy.`); }
    });
  } catch (error) {
    document.getElementById('readerTitle').textContent = 'This document could not open';
    document.getElementById('readerSubtitle').textContent = error.message;
    if (!reader) document.getElementById('readerHost').textContent = error.message;
  }
}
