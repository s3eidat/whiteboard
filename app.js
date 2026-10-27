/* Whiteboard — a vector model (strokes, shapes, text) drawn on a canvas; exports PNG and SVG; boards autosave locally. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$, h = S3.h;
  var KEY = "wb.v1";
  var COLORS = ["ink", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];
  var TEXT_SIZE = { 2: 18, 4: 26, 8: 38, 16: 56 };
  var BG = { dark: "#15181c", light: "#ffffff" };

  // ---------- model helpers (tested) ----------
  function ink(c, bg) { return c === "ink" ? (bg === "light" ? "#111827" : "#eceef2") : c; }
  function num(v, lo, hi) { return typeof v === "number" && isFinite(v) && v >= lo && v <= hi; }
  var LIM = 1e6;
  function cleanShape(s) {
    if (!s || typeof s !== "object") return null;
    var c = s.c === "ink" || (typeof s.c === "string" && /^#[0-9a-f]{6}$/i.test(s.c)) ? s.c : "ink";
    var w = num(s.w, 0.5, 80) ? s.w : 4;
    if (s.t === "pen") {
      if (!Array.isArray(s.pts)) return null;
      var pts = s.pts.slice(0, 20000).filter(function (p) { return Array.isArray(p) && num(p[0], -LIM, LIM) && num(p[1], -LIM, LIM) && (p.length < 3 || num(p[2], 0, 1)); })
        .map(function (p) { return p.length > 2 ? [p[0], p[1], p[2]] : [p[0], p[1]]; });
      return pts.length ? { t: "pen", pts: pts, c: c, w: w, hl: s.hl === true, pr: s.pr === true } : null;
    }
    if (["line", "arrow", "rect", "ellipse"].indexOf(s.t) >= 0) {
      if (![s.x1, s.y1, s.x2, s.y2].every(function (v) { return num(v, -LIM, LIM); })) return null;
      return { t: s.t, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, c: c, w: w };
    }
    if (s.t === "text") {
      if (!num(s.x, -LIM, LIM) || !num(s.y, -LIM, LIM) || typeof s.s !== "string" || !s.s.trim()) return null;
      return { t: "text", x: s.x, y: s.y, s: s.s.slice(0, 2000), c: c, size: num(s.size, 8, 200) ? s.size : 26 };
    }
    return null;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function cleanBoard(b, i) {
    b = b && typeof b === "object" ? b : {};
    var v = b.view && typeof b.view === "object" ? b.view : {};
    return {
      id: typeof b.id === "string" && /^[a-z0-9]{1,24}$/i.test(b.id) ? b.id : uid() + i,
      name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 40) : "Board " + (i + 1),
      bg: b.bg === "light" ? "light" : "dark", grid: b.grid === true,
      view: { x: num(v.x, -LIM, LIM) ? v.x : 0, y: num(v.y, -LIM, LIM) ? v.y : 0, k: num(v.k, 0.1, 8) ? v.k : 1 },
      shapes: (Array.isArray(b.shapes) ? b.shapes : []).slice(0, 20000).map(cleanShape).filter(Boolean)
    };
  }
  // Segment widths for a pressure stroke, grouped into runs of equal (quantized) width.
  function runs(s) {
    if (!s.pr || s.hl || s.pts.length < 2) return [{ w: s.w, pts: s.pts }];
    var out = [], cur = null;
    for (var i = 1; i < s.pts.length; i++) {
      var p = ((s.pts[i - 1][2] == null ? .5 : s.pts[i - 1][2]) + (s.pts[i][2] == null ? .5 : s.pts[i][2])) / 2;
      var w = Math.max(0.5, Math.round(s.w * (0.25 + 1.5 * p) * 2) / 2);
      if (!cur || cur.w !== w) { cur = { w: w, pts: [s.pts[i - 1]] }; out.push(cur); }
      cur.pts.push(s.pts[i]);
    }
    return out;
  }
  var mctx = document.createElement("canvas").getContext("2d");
  function font(size) { return "500 " + size + "px Inter, system-ui, sans-serif"; }
  function textLines(s) { return s.s.split("\n"); }
  function bbox(s) {
    if (s.t === "pen") {
      var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      s.pts.forEach(function (p) { x1 = Math.min(x1, p[0]); y1 = Math.min(y1, p[1]); x2 = Math.max(x2, p[0]); y2 = Math.max(y2, p[1]); });
      var pad = (s.hl ? s.w * 3 : s.w * 1.2) / 2;
      return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
    }
    if (s.t === "text") {
      mctx.font = font(s.size);
      var w = Math.max.apply(null, textLines(s).map(function (l) { return mctx.measureText(l).width; }));
      return { x1: s.x, y1: s.y, x2: s.x + w, y2: s.y + textLines(s).length * s.size * 1.25 };
    }
    var p2 = s.w / 2 + (s.t === "arrow" ? s.w * 3 + 8 : 0);
    return { x1: Math.min(s.x1, s.x2) - p2, y1: Math.min(s.y1, s.y2) - p2, x2: Math.max(s.x1, s.x2) + p2, y2: Math.max(s.y1, s.y2) + p2 };
  }
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }
  function hit(s, x, y, tol) {
    var b = bbox(s);
    if (x < b.x1 - tol || x > b.x2 + tol || y < b.y1 - tol || y > b.y2 + tol) return false;
    if (s.t === "text") return true;
    if (s.t === "pen") {
      var r = (s.hl ? s.w * 1.5 : s.w) / 2 + tol;
      if (s.pts.length === 1) return Math.hypot(x - s.pts[0][0], y - s.pts[0][1]) <= r;
      for (var i = 1; i < s.pts.length; i++) if (segDist(x, y, s.pts[i - 1][0], s.pts[i - 1][1], s.pts[i][0], s.pts[i][1]) <= r) return true;
      return false;
    }
    if (s.t === "line" || s.t === "arrow") return segDist(x, y, s.x1, s.y1, s.x2, s.y2) <= s.w / 2 + tol;
    var lx = Math.min(s.x1, s.x2), rx = Math.max(s.x1, s.x2), ty = Math.min(s.y1, s.y2), by = Math.max(s.y1, s.y2);
    if (s.t === "rect") return x >= lx - tol && x <= rx + tol && y >= ty - tol && y <= by + tol;
    var cx = (lx + rx) / 2, cy = (ty + by) / 2, ex = (rx - lx) / 2 + tol, ey = (by - ty) / 2 + tol;
    return ex > 0 && ey > 0 && ((x - cx) * (x - cx)) / (ex * ex) + ((y - cy) * (y - cy)) / (ey * ey) <= 1;
  }
  function moved(s, dx, dy) {
    var o = JSON.parse(JSON.stringify(s));
    if (o.t === "pen") o.pts = o.pts.map(function (p) { var q = [p[0] + dx, p[1] + dy]; if (p.length > 2) q.push(p[2]); return q; });
    else if (o.t === "text") { o.x += dx; o.y += dy; }
    else { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
    return o;
  }
  function arrowHead(s) {
    var a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), L = Math.max(12, s.w * 4), sp = 0.45;
    return [[s.x2 - L * Math.cos(a - sp), s.y2 - L * Math.sin(a - sp)], [s.x2 - L * Math.cos(a + sp), s.y2 - L * Math.sin(a + sp)]];
  }
  function allBox(shapes) {
    if (!shapes.length) return null;
    var b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    shapes.forEach(function (s) { var q = bbox(s); b.x1 = Math.min(b.x1, q.x1); b.y1 = Math.min(b.y1, q.y1); b.x2 = Math.max(b.x2, q.x2); b.y2 = Math.max(b.y2, q.y2); });
    return b;
  }

  // ---------- drawing ----------
  function trace(ctx, pts) {
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) { ctx.lineTo(pts[0][0] + 0.01, pts[0][1]); return; }
    for (var i = 1; i < pts.length - 1; i++) { var mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  }
  function drawShape(ctx, s, bg) {
    var col = ink(s.c, bg);
    ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (s.t === "pen") {
      if (s.hl) { ctx.globalAlpha = .35; ctx.lineWidth = s.w * 3; ctx.lineCap = "butt"; ctx.beginPath(); trace(ctx, s.pts); ctx.stroke(); }
      else runs(s).forEach(function (r) { ctx.lineWidth = r.w; ctx.beginPath(); trace(ctx, r.pts); ctx.stroke(); });
    } else if (s.t === "line" || s.t === "arrow") {
      ctx.lineWidth = s.w; ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
      if (s.t === "arrow") { var hd = arrowHead(s); ctx.moveTo(hd[0][0], hd[0][1]); ctx.lineTo(s.x2, s.y2); ctx.lineTo(hd[1][0], hd[1][1]); }
      ctx.stroke();
    } else if (s.t === "rect") {
      ctx.lineWidth = s.w; ctx.beginPath(); ctx.rect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1)); ctx.stroke();
    } else if (s.t === "ellipse") {
      ctx.lineWidth = s.w; ctx.beginPath();
      ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (s.t === "text") {
      ctx.font = font(s.size); ctx.textBaseline = "top";
      textLines(s).forEach(function (l, i) { ctx.fillText(l, s.x, s.y + i * s.size * 1.25 + s.size * 0.08); });
    }
    ctx.restore();
  }

  // ---------- SVG export (tested: text is escaped) ----------
  function r1(n) { return Math.round(n * 10) / 10; }
  function svgPath(pts) {
    var d = "M" + r1(pts[0][0]) + " " + r1(pts[0][1]);
    if (pts.length === 1) return d + "l0.01 0";
    for (var i = 1; i < pts.length - 1; i++) d += "Q" + r1(pts[i][0]) + " " + r1(pts[i][1]) + " " + r1((pts[i][0] + pts[i + 1][0]) / 2) + " " + r1((pts[i][1] + pts[i + 1][1]) / 2);
    return d + "L" + r1(pts[pts.length - 1][0]) + " " + r1(pts[pts.length - 1][1]);
  }
  function toSVG(board) {
    var b = allBox(board.shapes) || { x1: 0, y1: 0, x2: 400, y2: 300 }, pad = 24;
    var x = Math.floor(b.x1 - pad), y = Math.floor(b.y1 - pad), w = Math.ceil(b.x2 - b.x1 + 2 * pad), hh = Math.ceil(b.y2 - b.y1 + 2 * pad);
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + hh + '" viewBox="' + x + " " + y + " " + w + " " + hh + '">',
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + hh + '" fill="' + BG[board.bg] + '"/>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round">'];
    board.shapes.forEach(function (s) {
      var col = S3.esc(ink(s.c, board.bg));
      if (s.t === "pen") {
        if (s.hl) out.push('<path d="' + svgPath(s.pts) + '" stroke="' + col + '" stroke-width="' + s.w * 3 + '" stroke-opacity="0.35" stroke-linecap="butt"/>');
        else runs(s).forEach(function (r) { out.push('<path d="' + svgPath(r.pts) + '" stroke="' + col + '" stroke-width="' + r.w + '"/>'); });
      } else if (s.t === "line") out.push('<line x1="' + r1(s.x1) + '" y1="' + r1(s.y1) + '" x2="' + r1(s.x2) + '" y2="' + r1(s.y2) + '" stroke="' + col + '" stroke-width="' + s.w + '"/>');
      else if (s.t === "arrow") {
        var hd = arrowHead(s);
        out.push('<path d="M' + r1(s.x1) + " " + r1(s.y1) + "L" + r1(s.x2) + " " + r1(s.y2) + "M" + r1(hd[0][0]) + " " + r1(hd[0][1]) + "L" + r1(s.x2) + " " + r1(s.y2) + "L" + r1(hd[1][0]) + " " + r1(hd[1][1]) + '" stroke="' + col + '" stroke-width="' + s.w + '"/>');
      } else if (s.t === "rect") out.push('<rect x="' + r1(Math.min(s.x1, s.x2)) + '" y="' + r1(Math.min(s.y1, s.y2)) + '" width="' + r1(Math.abs(s.x2 - s.x1)) + '" height="' + r1(Math.abs(s.y2 - s.y1)) + '" stroke="' + col + '" stroke-width="' + s.w + '"/>');
      else if (s.t === "ellipse") out.push('<ellipse cx="' + r1((s.x1 + s.x2) / 2) + '" cy="' + r1((s.y1 + s.y2) / 2) + '" rx="' + r1(Math.abs(s.x2 - s.x1) / 2) + '" ry="' + r1(Math.abs(s.y2 - s.y1) / 2) + '" stroke="' + col + '" stroke-width="' + s.w + '"/>');
      else if (s.t === "text") {
        out.push('<text x="' + r1(s.x) + '" y="' + r1(s.y) + '" fill="' + col + '" stroke="none" font-family="Inter, system-ui, sans-serif" font-weight="500" font-size="' + s.size + '" dominant-baseline="text-before-edge" xml:space="preserve">' +
          textLines(s).map(function (l, i) { return '<tspan x="' + r1(s.x) + '" dy="' + (i ? s.size * 1.25 : s.size * 0.08) + '">' + S3.esc(l) + "</tspan>"; }).join("") + "</text>");
      }
    });
    out.push("</g></svg>");
    return out.join("\n");
  }

  // ---------- state ----------
  var stored = S3.store(KEY), data = { boards: [] };
  if (stored && Array.isArray(stored.boards)) data.boards = stored.boards.slice(0, 30).map(cleanBoard);
  if (!data.boards.length) data.boards.push(cleanBoard({ name: "My board" }, 0));
  var board = data.boards.filter(function (b) { return stored && b.id === stored.current; })[0] || data.boards[0];
  var tool = "pen", color = "ink", width = 4, sel = -1, undoStack = [], redoStack = [];
  var cv = $("#cv"), ctx = cv.getContext("2d"), stage = $("#stage"), dpr = 1, W = 0, H = 0;
  var draft = null;  // shape being drawn

  var persist = S3.debounce(function () {
    data.current = board.id;
    var ok = S3.store(KEY, data) !== undefined;
    $("#saved").textContent = ok ? "Saved in this browser · " + board.shapes.length + " item" + (board.shapes.length === 1 ? "" : "s") : "Couldn't save: browser storage is full. Export a PNG or SVG to keep your work.";
    $("#saved").classList.toggle("bad", !ok);
  }, 400);
  function commit() { persist(); render(); }
  function snap() { undoStack.push(board.shapes.slice()); if (undoStack.length > 200) undoStack.shift(); redoStack = []; }
  function undo() { if (!undoStack.length) return; redoStack.push(board.shapes.slice()); board.shapes = undoStack.pop(); sel = -1; commit(); }
  function redo() { if (!redoStack.length) return; undoStack.push(board.shapes.slice()); board.shapes = redoStack.pop(); sel = -1; commit(); }

  // ---------- render ----------
  function resize() {
    var r = stage.getBoundingClientRect(); dpr = Math.min(3, window.devicePixelRatio || 1); W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + "px"; cv.style.height = H + "px"; render();
  }
  function render() {
    var v = board.view, dark = board.bg === "dark";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG[board.bg]; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
    if (board.grid) {
      var step = 24, x0 = Math.floor(-v.x / v.k / step) * step, y0 = Math.floor(-v.y / v.k / step) * step, x1 = x0 + W / v.k + step, y1 = y0 + H / v.k + step;
      if (v.k * step >= 6) {
        ctx.fillStyle = dark ? "rgba(255,255,255,.13)" : "rgba(15,23,32,.16)";
        var rr = 1.1 / v.k;
        for (var gx = x0; gx < x1; gx += step) for (var gy = y0; gy < y1; gy += step) ctx.fillRect(gx - rr, gy - rr, rr * 2, rr * 2);
      }
    }
    board.shapes.forEach(function (s) { drawShape(ctx, s, board.bg); });
    if (draft) drawShape(ctx, draft, board.bg);
    if (sel >= 0 && board.shapes[sel]) {
      var b = bbox(board.shapes[sel]);
      ctx.save(); ctx.setLineDash([6 / v.k, 4 / v.k]); ctx.strokeStyle = "#3dd6d0"; ctx.lineWidth = 1.5 / v.k;
      ctx.strokeRect(b.x1 - 4 / v.k, b.y1 - 4 / v.k, b.x2 - b.x1 + 8 / v.k, b.y2 - b.y1 + 8 / v.k); ctx.restore();
    }
    $("#zoomReset").textContent = Math.round(v.k * 100) + "%";
    $("#undo").disabled = !undoStack.length; $("#redo").disabled = !redoStack.length; $("#del").disabled = sel < 0;
    $("#empty").hidden = board.shapes.length > 0 || !!draft;
    stage.classList.toggle("light", board.bg === "light");
    stage.dataset.tool = tool;
  }

  // ---------- pointer input ----------
  var pointers = {}, gesture = null, action = null, spaceDown = false;
  function world(e) { var r = cv.getBoundingClientRect(), v = board.view; return { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k }; }
  function zoomAt(sx, sy, k) {
    var v = board.view; k = Math.max(0.1, Math.min(8, k));
    v.x = sx - (sx - v.x) * (k / v.k); v.y = sy - (sy - v.y) * (k / v.k); v.k = k; persist(); render();
  }
  cv.addEventListener("pointerdown", function (e) {
    if (!$("#textIn").hidden) commitText();
    cv.setPointerCapture(e.pointerId);
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);
    if (ids.length === 2) {   // second finger: switch to pinch/pan, abandon any stroke
      draft = null; action = null;
      var a = pointers[ids[0]], b = pointers[ids[1]], v = board.view;
      gesture = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, k: v.k, vx: v.x, vy: v.y };
      render(); return;
    }
    if (ids.length > 2) return;
    var p = world(e);
    if (tool === "hand" || spaceDown || e.button === 1) { action = { type: "pan", sx: e.clientX, sy: e.clientY, vx: board.view.x, vy: board.view.y }; return; }
    if (e.button > 0) return;
    if (tool === "select") {
      sel = -1;
      for (var i = board.shapes.length - 1; i >= 0; i--) if (hit(board.shapes[i], p.x, p.y, 6 / board.view.k)) { sel = i; break; }
      if (sel >= 0) action = { type: "move", sx: p.x, sy: p.y, orig: board.shapes[sel], moved: false };
      render(); return;
    }
    if (tool === "eraser") { snap(); action = { type: "erase", n: 0 }; eraseAt(p); return; }
    if (tool === "text") { e.preventDefault(); openText(p, e); return; }
    sel = -1;
    var pressure = e.pointerType === "pen";
    if (tool === "pen" || tool === "marker") draft = { t: "pen", pts: [pressure ? [p.x, p.y, e.pressure || .5] : [p.x, p.y]], c: color, w: width, hl: tool === "marker", pr: pressure && tool === "pen" };
    else draft = { t: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, c: color, w: width };
    action = { type: "draw" }; render();
  });
  cv.addEventListener("pointermove", function (e) {
    if (pointers[e.pointerId]) pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (gesture) {
      var ids = Object.keys(pointers); if (ids.length < 2) return;
      var a = pointers[ids[0]], b = pointers[ids[1]], r = cv.getBoundingClientRect(), v = board.view;
      var k = Math.max(0.1, Math.min(8, gesture.k * Math.hypot(a.x - b.x, a.y - b.y) / (gesture.d || 1)));
      var cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top, ox = gesture.cx - r.left, oy = gesture.cy - r.top;
      v.k = k; v.x = cx - (ox - gesture.vx) * (k / gesture.k); v.y = cy - (oy - gesture.vy) * (k / gesture.k); render(); return;
    }
    if (!action) return;
    var p = world(e);
    if (action.type === "pan") { board.view.x = action.vx + e.clientX - action.sx; board.view.y = action.vy + e.clientY - action.sy; render(); return; }
    if (action.type === "move") {
      if (!action.moved) { snap(); action.moved = true; }
      board.shapes[sel] = moved(action.orig, p.x - action.sx, p.y - action.sy); render(); return;
    }
    if (action.type === "erase") { eraseAt(p); return; }
    if (action.type === "draw" && draft) {
      if (draft.t === "pen") {
        var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        evs.forEach(function (ce) {
          var q = world(ce), last = draft.pts[draft.pts.length - 1];
          if (Math.hypot(q.x - last[0], q.y - last[1]) * board.view.k < 1.5) return;
          var pt = [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]; if (draft.pr) pt.push(Math.round((ce.pressure || .5) * 100) / 100);
          draft.pts.push(pt);
        });
      } else {
        var x2 = p.x, y2 = p.y;
        if (e.shiftKey) {   // Shift: straight lines snap to 45°, boxes and ellipses become squares and circles
          var dx = x2 - draft.x1, dy = y2 - draft.y1;
          if (draft.t === "line" || draft.t === "arrow") { var ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(dx, dy); x2 = draft.x1 + len * Math.cos(ang); y2 = draft.y1 + len * Math.sin(ang); }
          else { var m = Math.max(Math.abs(dx), Math.abs(dy)); x2 = draft.x1 + Math.sign(dx || 1) * m; y2 = draft.y1 + Math.sign(dy || 1) * m; }
        }
        draft.x2 = x2; draft.y2 = y2;
      }
      render();
    }
  });
  function endPointer(e) {
    delete pointers[e.pointerId];
    if (gesture) { if (Object.keys(pointers).length < 2) { gesture = null; persist(); } return; }
    if (!action) return;
    if (action.type === "draw" && draft) {
      var keep = draft.t === "pen" || Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 2;
      if (keep) { snap(); board.shapes.push(cleanShape(draft) || draft); S3.done(); }
      draft = null;
    } else if (action.type === "erase" && !action.n) undoStack.pop();
    else if (action.type === "pan") persist();
    action = null; commit();
  }
  cv.addEventListener("pointerup", endPointer);
  cv.addEventListener("pointercancel", function (e) { draft = null; action = null; endPointer(e); });
  function eraseAt(p) {
    var tol = 8 / board.view.k, before = board.shapes.length;
    board.shapes = board.shapes.filter(function (s) { return !hit(s, p.x, p.y, tol); });
    if (board.shapes.length !== before) { action.n += before - board.shapes.length; render(); }
  }
  cv.addEventListener("wheel", function (e) {
    e.preventDefault();
    var r = cv.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, board.view.k * Math.exp(-e.deltaY * 0.0025));
    else { board.view.x -= e.deltaX; board.view.y -= e.deltaY; persist(); render(); }
  }, { passive: false });

  // ---------- text ----------
  var textAt = null, textIn = $("#textIn");
  function openText(p, e, existing) {
    var r = stage.getBoundingClientRect(), v = board.view, size = existing ? existing.size : TEXT_SIZE[width] || 26;
    textAt = { x: p.x, y: p.y, size: size, c: existing ? existing.c : color, editing: existing ? board.shapes.indexOf(existing) : -1 };
    textIn.hidden = false; textIn.value = existing ? existing.s : "";
    textIn.style.left = (p.x * v.k + v.x) + "px"; textIn.style.top = (p.y * v.k + v.y) + "px";
    textIn.style.fontSize = size * v.k + "px"; textIn.style.color = ink(textAt.c, board.bg);
    textIn.style.width = Math.max(120, r.width - (p.x * v.k + v.x) - 16) + "px";
    setTimeout(function () { textIn.focus(); }, 0);
  }
  function commitText() {
    if (!textAt) return;
    var t = textIn.value.replace(/\s+$/, ""), at = textAt; textAt = null; textIn.hidden = true;
    var s = cleanShape({ t: "text", x: at.x, y: at.y, s: t, c: at.c, size: at.size });
    if (at.editing >= 0) { snap(); if (s) board.shapes[at.editing] = s; else board.shapes.splice(at.editing, 1); }
    else if (s) { snap(); board.shapes.push(s); S3.done(); }
    commit();
  }
  textIn.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { textAt = null; textIn.hidden = true; render(); }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
  });
  textIn.addEventListener("blur", function () { setTimeout(commitText, 0); });
  cv.addEventListener("dblclick", function (e) {
    var p = world(e);
    for (var i = board.shapes.length - 1; i >= 0; i--) if (board.shapes[i].t === "text" && hit(board.shapes[i], p.x, p.y, 4)) { var s = board.shapes[i]; sel = -1; openText({ x: s.x, y: s.y }, e, s); return; }
  });

  // ---------- toolbar ----------
  var TOOLS = [
    ["select", "Select and move (V)", "v", '<path d="M5 3l14 8-6 2-3 6z"/>'],
    ["hand", "Pan (H)", "h", '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.3 15a1.5 1.5 0 0 1 2.5-1.7L8 16"/>'],
    ["pen", "Pen (P)", "p", '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'],
    ["marker", "Highlighter (M)", "m", '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'],
    ["eraser", "Eraser: removes whole strokes (E)", "e", '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21z"/><path d="M22 21H7M5 11l9 9"/>'],
    ["line", "Line (L)", "l", '<path d="M5 19 19 5"/>'],
    ["arrow", "Arrow (A)", "a", '<path d="M5 19 19 5M10 5h9v9"/>'],
    ["rect", "Rectangle (R)", "r", '<rect x="4" y="6" width="16" height="12" rx="1"/>'],
    ["ellipse", "Ellipse (O)", "o", '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>'],
    ["text", "Text (T)", "t", '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>']
  ];
  TOOLS.forEach(function (t) {
    $("#tools").appendChild(h("button", { type: "button", "class": "btn icon small wb-tool", "data-tool": t[0], title: t[1], "aria-label": t[1], "aria-pressed": String(t[0] === tool),
      html: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + t[3] + "</svg>" }));
  });
  function setTool(t) {
    if (!$("#textIn").hidden) commitText();
    tool = t; if (t !== "select") sel = -1;
    $$(".wb-tool").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.tool === t)); }); render();
  }
  $("#tools").addEventListener("click", function (e) { var b = e.target.closest("[data-tool]"); if (b) setTool(b.dataset.tool); });
  COLORS.forEach(function (c) {
    var b = h("button", { type: "button", "class": "wb-color" + (c === "ink" ? " ink" : ""), "data-c": c, "aria-label": c === "ink" ? "Ink (black or white)" : c, title: c === "ink" ? "Ink" : c, "aria-pressed": String(c === color) });
    if (c !== "ink") b.style.setProperty("--c", c);
    $("#colors").appendChild(b);
  });
  $("#colors").addEventListener("click", function (e) {
    var b = e.target.closest("[data-c]"); if (!b) return;
    color = b.dataset.c; $$(".wb-color").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
    if (sel >= 0 && board.shapes[sel]) { snap(); var s = JSON.parse(JSON.stringify(board.shapes[sel])); s.c = color; board.shapes[sel] = s; commit(); }
    if (tool === "eraser" || tool === "select" || tool === "hand") { if (sel < 0) setTool("pen"); }
  });
  function seg(el, value, onPick) {
    $$("button", el).forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.v === String(value)));
      b.addEventListener("click", function () { $$("button", el).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); onPick(b.dataset.v); });
    });
  }
  seg($("#widths"), width, function (v) {
    width = +v;
    if (sel >= 0 && board.shapes[sel]) { snap(); var s = JSON.parse(JSON.stringify(board.shapes[sel])); if (s.t === "text") s.size = TEXT_SIZE[width]; else s.w = width; board.shapes[sel] = s; commit(); }
  });
  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);
  function delSel() { if (sel < 0) return; snap(); board.shapes.splice(sel, 1); sel = -1; commit(); }
  $("#del").addEventListener("click", delSel);
  $("#zoomIn").addEventListener("click", function () { zoomAt(W / 2, H / 2, board.view.k * 1.25); });
  $("#zoomOut").addEventListener("click", function () { zoomAt(W / 2, H / 2, board.view.k / 1.25); });
  $("#zoomReset").addEventListener("click", function () { board.view = { x: 0, y: 0, k: 1 }; persist(); render(); });
  function fit() {
    var b = allBox(board.shapes); if (!b) { board.view = { x: 0, y: 0, k: 1 }; render(); return; }
    var k = Math.max(0.1, Math.min(2, Math.min((W - 60) / (b.x2 - b.x1 || 1), (H - 60) / (b.y2 - b.y1 || 1))));
    board.view = { k: k, x: W / 2 - (b.x1 + b.x2) / 2 * k, y: H / 2 - (b.y1 + b.y2) / 2 * k }; persist(); render();
  }
  $("#fit").addEventListener("click", fit);
  document.addEventListener("keydown", function (e) {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    var k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " ") { if (!spaceDown) { spaceDown = true; stage.classList.add("panning"); } e.preventDefault(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && sel >= 0) { e.preventDefault(); delSel(); return; }
    if (e.key === "Escape") { sel = -1; render(); return; }
    var t = TOOLS.filter(function (x) { return x[2] === k; })[0]; if (t) setTool(t[0]);
  });
  document.addEventListener("keyup", function (e) { if (e.key === " ") { spaceDown = false; stage.classList.remove("panning"); } });

  // ---------- boards, background, export ----------
  function fillPick() {
    var p = $("#boardPick"); p.textContent = "";
    data.boards.forEach(function (b) { p.appendChild(h("option", { value: b.id, text: b.name })); });
    p.value = board.id;
    $("#grid").checked = board.grid;
    $$("#bg button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === board.bg)); });
  }
  function switchTo(b) { if (!$("#textIn").hidden) commitText(); board = b; sel = -1; undoStack = []; redoStack = []; fillPick(); persist(); render(); }
  $("#boardPick").addEventListener("change", function (e) { var b = data.boards.filter(function (x) { return x.id === e.target.value; })[0]; if (b) switchTo(b); });
  $("#boardNew").addEventListener("click", function () {
    if (data.boards.length >= 30) return S3.toast("30 boards is the limit; delete one first", "error");
    var b = cleanBoard({ name: "Board " + (data.boards.length + 1), bg: board.bg, grid: board.grid }, data.boards.length);
    data.boards.push(b); switchTo(b);
  });
  $("#boardRename").addEventListener("click", function () { var n = window.prompt("Board name", board.name); if (n && n.trim()) { board.name = n.trim().slice(0, 40); fillPick(); persist(); } });
  $("#boardDel").addEventListener("click", function () {
    if (!window.confirm("Delete the board “" + board.name + "”? This can't be undone.")) return;
    data.boards.splice(data.boards.indexOf(board), 1);
    if (!data.boards.length) data.boards.push(cleanBoard({ name: "My board" }, 0));
    switchTo(data.boards[0]);
  });
  $("#grid").addEventListener("change", function (e) { board.grid = e.target.checked; commit(); });
  seg($("#bg"), board.bg, function (v) { board.bg = v; commit(); });
  $("#clear").addEventListener("click", function () {
    if (!board.shapes.length) return;
    if (!window.confirm("Clear everything on “" + board.name + "”? You can still undo it right after.")) return;
    snap(); board.shapes = []; sel = -1; commit();
  });
  function fileBase() { return (board.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "whiteboard").toLowerCase(); }
  $("#svg").addEventListener("click", function () {
    if (!board.shapes.length) return S3.toast("The board is empty", "error");
    S3.download(toSVG(board), fileBase() + ".svg", "image/svg+xml"); S3.done();
  });
  $("#png").addEventListener("click", function () {
    var b = allBox(board.shapes); if (!b) return S3.toast("The board is empty", "error");
    var pad = 24, sc = 2, w = b.x2 - b.x1 + pad * 2, hh = b.y2 - b.y1 + pad * 2;
    sc = Math.min(sc, 8000 / w, 8000 / hh);
    var c = document.createElement("canvas"); c.width = Math.ceil(w * sc); c.height = Math.ceil(hh * sc);
    var x = c.getContext("2d"); x.fillStyle = BG[board.bg]; x.fillRect(0, 0, c.width, c.height);
    x.setTransform(sc, 0, 0, sc, (pad - b.x1) * sc, (pad - b.y1) * sc);
    board.shapes.forEach(function (s) { drawShape(x, s, board.bg); });
    c.toBlob(function (blob) { if (blob) { S3.download(blob, fileBase() + ".png", "image/png"); S3.done(); } }, "image/png");
  });

  window.addEventListener("resize", S3.debounce(resize, 100));
  if (window.ResizeObserver) new ResizeObserver(S3.debounce(resize, 50)).observe(stage);
  fillPick(); resize(); persist();
  if (document.fonts) document.fonts.ready.then(render);

  window.S3_DEMO = function () {
    var squiggle = [], i;
    for (i = 0; i <= 60; i++) squiggle.push([620 + i * 4.2, 300 + Math.sin(i / 5) * 16 - i * 0.4, Math.round((0.3 + 0.6 * Math.sin(i / 60 * Math.PI)) * 100) / 100]);
    var b = cleanBoard({ name: "Launch plan", bg: "dark", grid: true, view: { x: 0, y: 0, k: 1 }, shapes: [
      { t: "text", x: 70, y: 40, s: "Launch plan ✏️", c: "ink", size: 38 },
      { t: "rect", x1: 70, y1: 120, x2: 290, y2: 220, c: "#3b82f6", w: 4 },
      { t: "text", x: 98, y: 152, s: "Idea", c: "ink", size: 26 },
      { t: "arrow", x1: 300, y1: 170, x2: 420, y2: 170, c: "ink", w: 4 },
      { t: "ellipse", x1: 430, y1: 110, x2: 640, y2: 230, c: "#22c55e", w: 4 },
      { t: "text", x: 476, y: 152, s: "Build it", c: "ink", size: 26 },
      { t: "arrow", x1: 650, y1: 170, x2: 760, y2: 170, c: "ink", w: 4 },
      { t: "rect", x1: 770, y1: 120, x2: 990, y2: 220, c: "#f97316", w: 4 },
      { t: "text", x: 806, y: 152, s: "Ship it 🚀", c: "ink", size: 26 },
      { t: "pen", pts: [[90, 330], [180, 322], [270, 334], [360, 326], [450, 330]], c: "#eab308", w: 4, hl: true },
      { t: "text", x: 92, y: 316, s: "Talk to 10 customers first", c: "ink", size: 22 },
      { t: "pen", pts: squiggle, c: "#ec4899", w: 4, pr: true },
      { t: "line", x1: 620, y1: 360, x2: 880, y2: 360, c: "#a855f7", w: 2 },
      { t: "text", x: 660, y: 372, s: "target: Dec 1", c: "#a855f7", size: 18 }
    ] }, 0);
    data.boards = [b]; switchTo(b); setTool("pen");
  };

  window.S3_SELFTEST = function () {
    var evil = '<script>alert("x")</script> & co\'s';
    var bd = cleanBoard({ bg: "light", shapes: [{ t: "text", x: 10, y: 10, s: evil, c: "#ff0000", size: 20 }, { t: "rect", x1: 0, y1: 0, x2: 50, y2: 40, c: "red\" onload=\"x", w: 3 },
      { t: "pen", pts: [[0, 0, .2], [10, 0, .9], [20, 5, .9]], c: "ink", w: 4, pr: true }, { t: "line", x1: NaN, y1: 0, x2: 1, y2: 1 }, { t: "evil" }, "x"] }, 0);
    var svg = toSVG(bd), doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    var parsedOk = !doc.querySelector("parsererror") && doc.querySelectorAll("script").length === 0 && doc.querySelector("tspan").textContent === evil;
    var escOk = svg.indexOf("<script") < 0 && svg.indexOf("&lt;script&gt;") >= 0 && svg.indexOf("&amp; co&#39;s") >= 0 && svg.indexOf("onload") < 0;
    var shapesOk = bd.shapes.length === 3 && bd.shapes[1].c === "ink" && bd.bg === "light";
    var line = { t: "line", x1: 0, y1: 0, x2: 100, y2: 0, c: "ink", w: 4 };
    var hitOk = hit(line, 50, 3, 2) && !hit(line, 50, 20, 2) && hit({ t: "ellipse", x1: 0, y1: 0, x2: 100, y2: 50, c: "ink", w: 2 }, 50, 25, 2) &&
      !hit({ t: "ellipse", x1: 0, y1: 0, x2: 100, y2: 50, c: "ink", w: 2 }, 2, 2, 1);
    var bb = bbox({ t: "rect", x1: 10, y1: 20, x2: -10, y2: 60, c: "ink", w: 4 });
    var rs = runs(bd.shapes[2]), mv = moved(line, 5, 7);
    return parsedOk && escOk && shapesOk && hitOk && bb.x1 === -12 && bb.y2 === 62 && rs.length === 2 && rs[0].w < rs[1].w &&
      mv.x1 === 5 && mv.y2 === 7 && line.x1 === 0 && ink("ink", "light") === "#111827" && ink("#123456", "dark") === "#123456" &&
      cleanBoard({ view: { k: 99 } }, 0).view.k === 1;
  };
})();
