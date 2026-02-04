console.log("[Local Grammarly] loaded at", location.href || window.location.href);
let bootAttempts = 0;

let editor = null;
let overlay = null;
let timer = null;
let currentRequestId = 0;
let _lastErrors = [];
let inputListener = null;
let scrollListener = null;
let resizeObserver = null;
const ANALYZE_DELAY = 800;
// DEBUG: force content script to call backend directly (bypasses background)
const FORCE_DIRECT_FETCH = true;
let suggestionTooltip = null;

function hideSuggestionTooltip() {
  if (suggestionTooltip && suggestionTooltip.parentNode) {
    suggestionTooltip.parentNode.removeChild(suggestionTooltip);
    suggestionTooltip = null;
    document.removeEventListener("click", suggestionTooltipOutsideClick);
    document.removeEventListener("keydown", suggestionTooltipEsc);
  }
}

function suggestionTooltipOutsideClick(ev) {
  if (!suggestionTooltip) return;
  if (!suggestionTooltip.contains(ev.target)) {
    hideSuggestionTooltip();
  }
}

function suggestionTooltipEsc(ev) {
  if (ev.key === "Escape") hideSuggestionTooltip();
}

function showSuggestionTooltip(err, rect, targetEl) {
  hideSuggestionTooltip();
  suggestionTooltip = document.createElement("div");
  // use fixed positioning so tooltip is not affected by page transforms/offset parents
  suggestionTooltip.style.position = "fixed";
  // very high z-index to avoid being covered by site UI
  suggestionTooltip.style.zIndex = "2147483647";
  suggestionTooltip.style.pointerEvents = "auto";
  suggestionTooltip.style.background = "#fff";
  suggestionTooltip.style.border = "1px solid rgba(0,0,0,0.15)";
  suggestionTooltip.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
  suggestionTooltip.style.padding = "8px";
  suggestionTooltip.style.borderRadius = "6px";
  suggestionTooltip.style.font = "12px/1.2 " + (getComputedStyle(document.body).fontFamily || "sans-serif");
  suggestionTooltip.style.minWidth = "160px";
  suggestionTooltip.style.maxWidth = "320px";

  const title = document.createElement("div");
  title.style.marginBottom = "6px";
  title.style.color = "#111";
  title.textContent = err.message || "Suggestion";

  const suggestion = document.createElement("div");
  suggestion.style.marginBottom = "8px";
  suggestion.style.color = "#222";
  const repVal = (err.correct !== undefined ? err.correct : (err.replacement !== undefined ? err.replacement : (err.to !== undefined ? err.to : err.replacementText)));
  if (repVal === "") {
    suggestion.textContent = "(remove)";
  } else {
    suggestion.textContent = repVal || "(no suggestion)";
  }
  // replace suggestion display with an editable input so user can choose/modify replacement
  const input = document.createElement("input");
  input.type = "text";
  input.style.width = "100%";
  input.style.boxSizing = "border-box";
  input.style.marginBottom = "8px";
  input.value = repVal !== undefined && repVal !== null ? repVal : "";
  // alternatives list (if provided by backend)
  if (err.alternatives && Array.isArray(err.alternatives) && err.alternatives.length) {
    const altBox = document.createElement("div");
    altBox.style.display = "flex";
    altBox.style.flexWrap = "wrap";
    altBox.style.gap = "6px";
    altBox.style.marginBottom = "8px";
    for (const a of err.alternatives) {
      const chip = document.createElement("button");
      chip.textContent = a + "";
      chip.style.padding = "4px 8px";
      chip.style.border = "1px solid rgba(0,0,0,0.1)";
      chip.style.background = "#f6f8fb";
      chip.style.borderRadius = "4px";
      chip.style.cursor = "pointer";
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        input.value = a + "";
      });
      altBox.appendChild(chip);
    }
    suggestion.appendChild(altBox);
  }
  suggestion.appendChild(input);

  const btnRow = document.createElement("div");
  btnRow.style.display = "flex";
  btnRow.style.gap = "8px";

  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply";
  applyBtn.style.padding = "6px 8px";
  applyBtn.style.border = "none";
  applyBtn.style.background = "#0b63ff";
  applyBtn.style.color = "#fff";
  applyBtn.style.borderRadius = "4px";
  applyBtn.style.cursor = "pointer";
  applyBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    hideSuggestionTooltip();
    const val = input.value;
    applyCorrection(err, val);
    // re-run analysis after a small delay to allow DOM update
    setTimeout(() => analyze(), 150);
  });

  const ignoreBtn = document.createElement("button");
  ignoreBtn.textContent = "Ignore";
  ignoreBtn.style.padding = "6px 8px";
  ignoreBtn.style.border = "1px solid rgba(0,0,0,0.1)";
  ignoreBtn.style.background = "transparent";
  ignoreBtn.style.color = "#111";
  ignoreBtn.style.borderRadius = "4px";
  ignoreBtn.style.cursor = "pointer";
  ignoreBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    hideSuggestionTooltip();
  });

  btnRow.appendChild(applyBtn);
  // Apply all button
  const applyAllBtn = document.createElement("button");
  applyAllBtn.textContent = "Apply all";
  applyAllBtn.style.padding = "6px 8px";
  applyAllBtn.style.border = "none";
  applyAllBtn.style.background = "#0b63ff";
  applyAllBtn.style.color = "#fff";
  applyAllBtn.style.borderRadius = "4px";
  applyAllBtn.style.cursor = "pointer";
  applyAllBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    hideSuggestionTooltip();
    try {
      applyAllSuggestionsToEditor(editor, _lastErrors || []);
    } catch (e) {
      console.error("[Local Grammarly] applyAll failed:", e);
    }
  });
  btnRow.appendChild(applyAllBtn);
  btnRow.appendChild(ignoreBtn);

  suggestionTooltip.appendChild(title);
  suggestionTooltip.appendChild(suggestion);
  suggestionTooltip.appendChild(btnRow);

  document.body.appendChild(suggestionTooltip);

  // Ensure the target is visible (nearest). Use center behavior to make room for the tooltip.
  try {
    const targetRect = targetEl.getBoundingClientRect();
    const viewportTop = 0;
    const viewportBottom = window.innerHeight;
    if (targetRect.bottom > viewportBottom - 40 || targetRect.top < viewportTop + 40) {
      targetEl.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    }
  } catch (e) {}

  // Defer measurement/positioning to next frame so scroll/layout settle.
  requestAnimationFrame(() => {
    try {
      const r = targetEl.getBoundingClientRect();
      // measure tooltip now
      const tb = suggestionTooltip.getBoundingClientRect();
      const tw = tb.width || suggestionTooltip.offsetWidth;
      const th = tb.height || suggestionTooltip.offsetHeight;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;

      // prefer below the element (centered horizontally)
      let left = r.left + Math.max(0, (r.width - tw) / 2);
      // clamp horizontally to viewport
      left = Math.min(Math.max(left, 8), Math.max(8, viewportW - tw - 8));
      let top = r.bottom + 8; // below
      // if not enough space below, place above
      if (top + th > viewportH - 8) {
        top = r.top - th - 8;
      }
      // clamp vertically
      if (top < 8) top = 8;

      suggestionTooltip.style.left = left + "px";
      suggestionTooltip.style.top = top + "px";
    } catch (e) {
      console.error("[Local Grammarly] tooltip positioning failed:", e);
    }
  });

  // close on outside click or Esc
  setTimeout(() => {
    document.addEventListener("click", suggestionTooltipOutsideClick);
    document.addEventListener("keydown", suggestionTooltipEsc);
  }, 0);
}

/* ======================
   FIND EDITOR
====================== */
// Broad selector to detect editable regions
const EDITOR_SELECTOR = '[contenteditable], textarea, input[type="text"], [role="textbox"]';

function attachEditor(el) {
  if (!el) return;
  if (editor === el) return;
  // detach previous listeners
  try {
    if (inputListener && editor) editor.removeEventListener("input", inputListener);
    if (scrollListener && editor) editor.removeEventListener("scroll", scrollListener);
    if (resizeObserver && typeof resizeObserver.disconnect === "function") resizeObserver.disconnect();
  } catch (e) {}
  editor = el;
  console.log("[Local Grammarly] attached editor:", el.tagName, "classes=", el.className || "", "len=", (el.value || el.innerText || "").length);
  // create overlay for both contentEditable and inputs (mirror)
  initOverlay();
  try {
    hookInput();
  } catch (e) {
    console.error("[Local Grammarly] hookInput failed:", e);
  }
  // run one immediate analysis for debugging / initial state
  try {
    setTimeout(() => {
      console.log("[Local Grammarly] initial analyze trigger");
      analyze();
    }, 200);
  } catch (e) {}
  // sync overlay when editor scrolls (for textarea)
  scrollListener = () => {
    if (overlay && editor) {
      // mirror internal scroll
      overlay.scrollTop = editor.scrollTop || 0;
      overlay.scrollLeft = editor.scrollLeft || 0;
    }
  };
  editor.addEventListener("scroll", scrollListener, { passive: true });
  // observe size changes to reposition overlay
  try {
    resizeObserver = new ResizeObserver(syncPosition);
    resizeObserver.observe(editor);
  } catch (e) {}
}

// initial scan + MutationObserver to catch later-added editors
function startEditorObserver() {
  // initial find
  const first = document.querySelector(EDITOR_SELECTOR);
  if (first) {
    attachEditor(first);
  }
  const mo = new MutationObserver(() => {
    if (editor) return; // already attached
    const el = document.querySelector(EDITOR_SELECTOR);
    if (el) attachEditor(el);
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  // also watch focus changes to switch active editor
  window.addEventListener("focusin", (ev) => {
    const t = ev.target;
    if (t && t.matches && t.matches(EDITOR_SELECTOR)) {
      attachEditor(t);
    }
  });
}

startEditorObserver();

/* ======================
   OVERLAY
====================== */
function initOverlay() {
  const rect = editor.getBoundingClientRect();

  overlay = document.createElement("div");
  overlay.style.position = "absolute";
  overlay.style.left = rect.left + "px";
  overlay.style.top = rect.top + "px";
  overlay.style.width = rect.width + "px";
  overlay.style.height = rect.height + "px";
  // Don't block typing — only suggestion spans will receive pointer events
  overlay.style.pointerEvents = "none";
  overlay.style.whiteSpace = editor.tagName === "INPUT" ? "nowrap" : "pre-wrap";
  overlay.style.font = getComputedStyle(editor).font;
  overlay.style.color = "transparent";
  overlay.style.boxSizing = "border-box";
  overlay.style.padding = getComputedStyle(editor).padding;
  overlay.style.lineHeight = getComputedStyle(editor).lineHeight;
  overlay.style.overflow = "hidden";
  overlay.style.zIndex = "9999";

  document.body.appendChild(overlay);
  // allow clicking suggestion spans
  // Clicks should reach suggestion spans (they have pointer-events:auto).
  overlay.addEventListener("click", (ev) => {
    const target = ev.target;
    console.log("[Local Grammarly] overlay click target:", target, "dataset:", target && target.dataset);
    const id = target && target.dataset && target.dataset.suggestionId;
    console.log("[Local Grammarly] clicked suggestionId:", id, "known errors count:", (_lastErrors||[]).length);
    if (id) {
      const err = _lastErrors && _lastErrors.find(x => x._id === id);
      console.log("[Local Grammarly] matched error:", err);
      if (err) {
        // show tooltip with suggested replacement before applying
        showSuggestionTooltip(err, target.getBoundingClientRect(), target);
      }
    }
  });
}

/* ======================
   INPUT HANDLER
====================== */
function hookInput() {
  // remove previous listener
  if (inputListener && editor) {
    try { editor.removeEventListener("input", inputListener); } catch (e) {}
  }
  inputListener = () => {
    const preview = editor.isContentEditable ? editor.innerText : editor.value || editor.textContent || "";
    console.log("[Local Grammarly] input:", preview.slice(0, 200));
    clearTimeout(timer);
    timer = setTimeout(analyze, ANALYZE_DELAY);
  };
  editor.addEventListener("input", inputListener);
  console.log("[Local Grammarly] input listener attached");
}

/* ======================
   ANALYZE
====================== */
async function analyze() {
  if (!editor) return;
  const text = editor.isContentEditable ? editor.innerText : (editor.value || editor.textContent || "");
  if (!text.trim()) {
    if (overlay) overlay.innerHTML = "";
    return;
  }

  try {
    // skip non-English text
    if (!isProbablyEnglish(text)) {
      if (overlay) overlay.innerHTML = "";
      console.log("[Local Grammarly] analyze skipped (not English)");
      return;
    }
    // use background to call API (avoids CORS / hides keys). background may
    // return { errors: [...] } or { suggestions: [...] }.
    const reqId = ++currentRequestId;
    console.log("[Local Grammarly] analyze -> requestId=", reqId, "text:", text.slice(0, 300));
    if (FORCE_DIRECT_FETCH) {
      console.log("[Local Grammarly] forcing direct fetch to backend");
      try {
        const url = "http://localhost:8080/analyze";
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        })
          .then(r => {
            console.log("[Local Grammarly] direct fetch status:", r.status);
            return r.json();
          })
          .then(data => {
            console.log("[Local Grammarly] direct fetch result:", data);
            const errors = data.errors || [];
            render(text, errors);
          })
          .catch(e => console.error("[Local Grammarly] direct fetch error", e));
      } catch (e) {
        console.error("[Local Grammarly] direct fetch thrown", e);
      }
      return;
    }

    chrome.runtime.sendMessage({ type: "ANALYZE", text, requestId: reqId }, (response) => {
      // detect runtime errors (e.g., no background listener)
      if (chrome.runtime && chrome.runtime.lastError) {
        console.warn("[Local Grammarly] sendMessage error:", chrome.runtime.lastError.message);
        return;
      }

      console.log("[Local Grammarly] analyze response:", response);
      if (!response) {
        console.warn("[Local Grammarly] analyze: no response from background");
        return;
      }
      // discard stale responses
      if (response.requestId && response.requestId !== currentRequestId) return;
      let errors = response.errors || [];
      if ((!errors || errors.length === 0) && response.suggestions) {
        errors = mapSuggestionsToErrors(text, response.suggestions);
      }
      errors = normalizeErrorOffsets(errors || [], text);
      render(text, errors || []);
    });
  } catch (e) {
    console.error("[Grammar Error]", e);
  }
}

/* ======================
   RENDER UNDERLINE
====================== */
function render(text, errors) {
  console.log("[Local Grammarly] render called, errors:", errors);
  // keep a copy of last errors with ids so we can accept them later
  _lastErrors = (errors || []).map((e, i) => Object.assign({}, e, { _id: String(Date.now()) + "-" + i }));
  let html = "";
  let idx = 0;

  for (const e of _lastErrors) {
    html += escape(text.slice(idx, e.start));
    const id = e._id || "";
    // insertion (start==end) -> show the suggested replacement visibly in the overlay
    if (typeof e.start === "number" && typeof e.end === "number" && e.start === e.end) {
      // Minimal inline marker for insertions (small clickable pill). Tooltip shows the replacement.
      const rep = (e.correct !== undefined ? e.correct : (e.replacement !== undefined ? e.replacement : (e.to !== undefined ? e.to : e.replacementText))) || "";
      const repEsc = escape(String(rep));
      html += `<span data-suggestion-id="${id}" data-rep="${repEsc}" title="${repEsc}" style="
        display:inline-block;
        width:8px;height:8px;
        margin-left:6px;margin-right:4px;
        border-radius:50%;
        background:#ff5e5e;
        vertical-align:middle;
        pointer-events: auto;
        cursor: pointer;
      "></span>`;
      idx = e.end;
    } else {
      html += `<span data-suggestion-id="${id}" style="
        text-decoration: underline;
        text-decoration-color: red;
        text-decoration-thickness: 2px;
        pointer-events: auto;
        cursor: pointer;
        color: inherit;
      ">${escape(text.slice(e.start, e.end))}</span>`;
      idx = e.end;
    }
  }

  html += escape(text.slice(idx));
  if (overlay) {
    overlay.innerHTML = html;
    syncPosition();
  } else {
    // Plain inputs/textareas: can't overlay. Log suggestions and attach data for debugging.
    console.log("[Local Grammarly] suggestions for input (count=" + _lastErrors.length + "):", _lastErrors);
  }
}

/* ======================
   SYNC POSITION
====================== */
function syncPosition() {
  const r = editor.getBoundingClientRect();
  overlay.style.left = r.left + "px";
  overlay.style.top = r.top + "px";
  overlay.style.width = r.width + "px";
  overlay.style.height = r.height + "px";
}

/* ======================
   UTILS
====================== */
function escape(str) {
  return str.replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])
  );
}

/* ======================
   LANGUAGE DETECTION (lightweight)
   Heuristic: enough Latin letters and few non-Latin scripts.
====================== */
function isProbablyEnglish(text) {
  if (!text || typeof text !== "string") return false;
  // remove punctuation and digits
  const letters = text.replace(/[\d\p{P}\p{S}\s]+/gu, "");
  if (letters.length === 0) return false;
  // count ASCII letters vs other letters
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const ch of letters) {
    if (/[A-Za-z]/.test(ch)) asciiCount++;
    else nonAsciiCount++;
  }
  const ratio = asciiCount / (asciiCount + nonAsciiCount);
  // require at least 40% ascii letters and at least one English word of length>=2
  const hasEnglishWord = /\b[a-zA-Z]{2,}\b/.test(text);
  return ratio >= 0.4 && hasEnglishWord;
}

/* ======================
  HELPERS: map suggestions -> errors
 ====================== */
function mapSuggestionsToErrors(text, suggestions) {
  const out = [];
  let cursor = 0;
  for (const s of suggestions) {
    const original = s.original || s.match || s.from || "";
    const replacement = s.replacement || s.correct || s.to || s.replacementText || "";
    if (!original) continue;
    const idx = text.indexOf(original, cursor);
    if (idx === -1) {
      // try global search from start
      const idx2 = text.indexOf(original);
      if (idx2 === -1) continue;
      out.push({ type: s.type || "grammar", original, correct: replacement, start: idx2, end: idx2 + original.length });
      cursor = idx2 + original.length;
    } else {
      out.push({ type: s.type || "grammar", original, correct: replacement, start: idx, end: idx + original.length });
      cursor = idx + original.length;
    }
  }
  return out;
}

// Normalize offsets if backend uses 1-based indexing or otherwise mismatched indices.
function normalizeErrorOffsets(errors, text) {
  if (!errors || !errors.length) return errors;
  const maxStart = Math.max(...errors.map(e => (typeof e.start === "number" ? e.start : -Infinity)));
  const minStart = Math.min(...errors.map(e => (typeof e.start === "number" ? e.start : Infinity)));
  // Heuristic: only adjust if indices are outside valid 0-based range.
  // If any start is greater than text.length, assume 1-based indexing and subtract 1.
  if (maxStart > text.length) {
    return errors.map(e => {
      const copy = Object.assign({}, e);
      if (typeof copy.start === "number") copy.start = Math.max(0, copy.start - 1);
      if (typeof copy.end === "number") copy.end = Math.max(0, copy.end - 1);
      return copy;
    });
  }
  return errors;
}

/* ======================
  HELPERS: find text node by char index and apply replacement
 ====================== */
function findNodeForIndex(root, index) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  let node;
  let cum = 0;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (cum + len >= index) {
      return { node, offset: index - cum };
    }
    cum += len;
  }
  return null;
}

/* ======================
  HELPERS: batch apply edits
 ====================== */
function applyEditsToPlainText(text, edits) {
  // Reconstruct new string from original text and edits using original indices.
  // Sort edits by start ascending and walk the original text.
  const list = (edits || []).slice().sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const e of list) {
    const start = e.start || 0;
    const end = e.end || start;
    if (start > pos) {
      out += text.slice(pos, start);
    }
    let rep = (e.correct !== undefined ? e.correct : (e.replacement !== undefined ? e.replacement : (e.to !== undefined ? e.to : e.replacementText))) || "";
    // insert a space if previous output ends with a word char and replacement starts with a word char
    const prevChar = out.slice(-1);
    const firstRepChar = rep.charAt(0);
    if (prevChar && firstRepChar && /\w/.test(prevChar) && /\w/.test(firstRepChar)) {
      rep = " " + rep;
    }
    out += rep;
    pos = end;
  }
  // append remaining
  if (pos < text.length) out += text.slice(pos);
  return out;
}

function applyEditsToContentEditable(root, edits) {
  // Simpler reliable approach: reconstruct entire text to avoid offset shifting complexities.
  const orig = root.innerText || "";
  const newText = applyEditsToPlainText(orig, edits);
  root.innerText = newText;
  root.normalize && root.normalize();
}

function applyAllSuggestionsToEditor(ed, edits) {
  if (!edits || !edits.length) return;
  if (ed.isContentEditable) {
    applyEditsToContentEditable(ed, edits);
  } else {
    const val = ed.value !== undefined ? ed.value : (ed.textContent || "");
    const newVal = applyEditsToPlainText(val, edits);
    if ("value" in ed) {
      ed.value = newVal;
      try { ed.setSelectionRange(newVal.length, newVal.length); ed.focus(); } catch (e) {}
    } else {
      ed.textContent = newVal;
    }
  }
  setTimeout(() => analyze(), 150);
}

async function applyCorrection(err, overrideReplacement) {
  console.log("[Local Grammarly] applyCorrection:", err, "override:", overrideReplacement);
  const text = editor && editor.isContentEditable ? editor.innerText : (editor && (editor.value || editor.textContent) || "");
  const start = err.start;
  const end = err.end;
  const correct = (overrideReplacement !== undefined ? overrideReplacement : (err.correct || err.replacement || err.to || err.replacementText || ""));
  if (start == null || end == null) return;
  try {
    // If start/end are missing, try to locate by original text
    let s = start;
    let e = end;
    if (s == null || e == null) {
      const orig = err.original || err.match || "";
      if (orig) {
        const idx = (editor.isContentEditable ? editor.innerText : (editor.value || editor.textContent || "")).indexOf(orig);
        if (idx !== -1) {
          s = idx;
          e = idx + orig.length;
          console.log("[Local Grammarly] fallback located original at", s, e);
        } else {
          console.warn("[Local Grammarly] could not locate original text to apply correction", orig);
          return;
        }
      } else {
        console.warn("[Local Grammarly] no start/end and no original to search for");
        return;
      }
    }

    if (editor.isContentEditable) {
      const startPos = findNodeForIndex(editor, s);
      const endPos = findNodeForIndex(editor, e);
      if (startPos && endPos) {
        const range = document.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        range.deleteContents();
        const textNode = document.createTextNode(correct);
        range.insertNode(textNode);
        editor.normalize();
        return;
      }
      // fallback: replace whole text (best-effort)
      const cur = editor.innerText;
      const newText = cur.slice(0, s) + correct + cur.slice(e);
      editor.innerText = newText;
      editor.normalize && editor.normalize();
      return;
    } else {
      // plain input/textarea
      const val = editor.value || editor.textContent || "";
      const newVal = val.slice(0, s) + correct + val.slice(e);
      const caretPos = s + correct.length;
      if ("value" in editor) {
        editor.value = newVal;
        try {
          editor.setSelectionRange(caretPos, caretPos);
          editor.focus();
        } catch (e) {}
      } else {
        editor.textContent = newVal;
      }
      return;
    }
  } catch (ex) {
    console.error("[Local Grammarly] applyCorrection failed:", ex);
  }
}
