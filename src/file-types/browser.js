// ---------- file types: specific labels, Home type filter and list thumbnails (src/file-types) ----------
// Labels come from the head revision's stored MIME type. Thumbnails are made from the revision-pinned content itself, only
// for the image and video types the server serves inline (never SVG, HTML or PDF). Each one is a single request, made only
// while its row is on screen, a few at a time and within a per-minute budget well under the owner's read limit; a 429
// pauses the queue for the server's Retry-After. The bytes are decoded in the browser and kept only as a 96px image for the
// session (content responses are no-store); everything is dropped when the signed-in identity changes. Any failure keeps
// the type icon.
var FILE_TYPE_FILTERS = [["all", "All types"], ["doc", "Docs"], ["page", "Pages"], ["image", "Images"], ["video", "Videos"], ["pdf", "PDFs"], ["csv", "CSV files"], ["json", "JSON files"], ["file", "Other files"]];
var FILE_TYPE_NOUNS = { doc: "docs", page: "pages", image: "images", video: "videos", pdf: "PDFs", csv: "CSV files", json: "JSON files", file: "other files" };
var FILE_MIME_LABELS = { "image/png": "PNG image", "image/jpeg": "JPEG image", "image/webp": "WebP image", "image/gif": "GIF image", "video/mp4": "MP4 video", "video/webm": "WebM video", "application/pdf": "PDF" };
var THUMB_MIME = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/;
function fileTypeName(t) { return FILE_TYPE_NOUNS[t] || "items"; }
function typeFilterSelect(value) {
  return h("select", { "aria-label": "Filter by type" }, FILE_TYPE_FILTERS.map(function (x) { return h("option", { value: x[0], selected: value === x[0], text: x[1] }); }));
}
var THUMBS = { gen: 0, active: 0, queue: [], starts: [], timer: 0, pausedUntil: 0, io: null, watched: new Set(), made: new Map(), failed: new Set(), tries: new Map(), waiting: new Map() };
var THUMB_MAX_ACTIVE = 3, THUMB_PER_MIN = 30, THUMB_TIMEOUT = 20000, THUMB_KEEP = 300, THUMB_PX = 96, THUMB_TRIES = 2;
// Only one frame is needed: larger files keep the type icon instead of being downloaded whole.
var THUMB_MAX_BYTES = { image: 5 * 1048576, video: 2 * 1048576 };
// Sign-out or a different principal: forget every thumbnail and stop pending work. In-flight work from before is discarded.
function thumbClear() {
  THUMBS.gen++; THUMBS.queue = []; THUMBS.waiting = new Map(); THUMBS.failed = new Set(); THUMBS.tries = new Map(); THUMBS.pausedUntil = 0;
  THUMBS.made.forEach(function (u) { URL.revokeObjectURL(u); }); THUMBS.made = new Map();
  if (THUMBS.io) { THUMBS.io.disconnect(); THUMBS.io = null; }
  THUMBS.watched = new Set();
}
function thumbShow(box, u) {
  var img = h("img", { class: "thumb", src: u, alt: "", decoding: "async" });
  img.addEventListener("load", function () { box.classList.add("has-thumb"); });
  img.addEventListener("error", function () { img.remove(); });
  box.append(img);
}
function thumbForget(box) { if (THUMBS.io) THUMBS.io.unobserve(box); THUMBS.watched.delete(box); box._thumbJob = null; }
// Decodes an image or video Blob and draws a centred, cropped 96px square. cb(objectURL or null); never throws.
function thumbFromBlob(blob, video, cb) {
  var src = URL.createObjectURL(blob), media, called = false;
  function finish(u) { if (called) { if (u) URL.revokeObjectURL(u); return; } called = true; URL.revokeObjectURL(src); if (media) media.removeAttribute("src"); cb(u); }
  function draw(w, hgt) {
    try {
      if (!w || !hgt) return finish(null);
      var c = document.createElement("canvas"), s = Math.max(THUMB_PX / w, THUMB_PX / hgt);
      c.width = THUMB_PX; c.height = THUMB_PX;
      c.getContext("2d").drawImage(media, (THUMB_PX - w * s) / 2, (THUMB_PX - hgt * s) / 2, w * s, hgt * s);
      c.toBlob(function (b) { finish(b ? URL.createObjectURL(b) : null); }, "image/webp", 0.85);
    } catch (e) { finish(null); }
  }
  if (video) {
    media = document.createElement("video");
    media.muted = true; media.playsInline = true; media.preload = "auto";
    media.addEventListener("loadedmetadata", function () {
      var d = isFinite(media.duration) ? media.duration : 0;
      try { media.currentTime = d > 0.2 ? Math.min(0.5, d / 2) : 0.01; } catch (e) { finish(null); }
    });
    media.addEventListener("seeked", function () { draw(media.videoWidth, media.videoHeight); });
  } else {
    media = new Image();
    media.addEventListener("load", function () { draw(media.naturalWidth, media.naturalHeight); });
  }
  media.addEventListener("error", function () { finish(null); });
  media.src = src;
  return function () { finish(null); };
}
function thumbPump() {
  var now = Date.now();
  if (THUMBS.pausedUntil > now) return thumbLater(THUMBS.pausedUntil - now);
  THUMBS.starts = THUMBS.starts.filter(function (t) { return now - t < 60000; });
  while (THUMBS.active < THUMB_MAX_ACTIVE && THUMBS.queue.length) {
    var job = THUMBS.queue[0];
    // Only rows still on the page and on screen; rows scrolled away re-queue when they come back into view.
    var boxes = (THUMBS.waiting.get(job.url) || []).filter(function (b) { return b.isConnected && b._inView !== false; });
    if (!boxes.length) { THUMBS.queue.shift(); THUMBS.waiting.delete(job.url); continue; }
    THUMBS.waiting.set(job.url, boxes);
    if (THUMBS.starts.length >= THUMB_PER_MIN) return thumbLater(60050 - (now - THUMBS.starts[0]));
    THUMBS.queue.shift(); THUMBS.starts.push(now); THUMBS.active++;
    thumbFetch(job);
  }
}
function thumbLater(ms) { if (!THUMBS.timer) THUMBS.timer = setTimeout(function () { THUMBS.timer = 0; thumbPump(); }, Math.max(250, ms)); }
function thumbFetch(job) {
  var gen = THUMBS.gen, finished = false, cancel = null, ctl = "AbortController" in window ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); if (cancel) cancel(); end(null, "retry"); }, THUMB_TIMEOUT);
  // outcome: "ok", "requeue" (429: back of the pause), "retry" (timeout, network, 5xx: tried again when next on screen,
  // up to THUMB_TRIES times) or "fail" (this revision can't be previewed, including a decode that never finishes).
  function end(u, outcome) {
    if (finished) { if (u) URL.revokeObjectURL(u); return; }
    finished = true; clearTimeout(timer); THUMBS.active--;
    if (gen !== THUMBS.gen) { if (u) URL.revokeObjectURL(u); thumbPump(); return; }
    var boxes = THUMBS.waiting.get(job.url) || [];
    if (outcome === "requeue") { THUMBS.queue.unshift(job); thumbPump(); return; }
    THUMBS.waiting.delete(job.url);
    if (u) {
      THUMBS.made.set(job.url, u);
      if (THUMBS.made.size > THUMB_KEEP) { var old = THUMBS.made.keys().next().value; URL.revokeObjectURL(THUMBS.made.get(old)); THUMBS.made.delete(old); }
      boxes.forEach(function (b) { thumbForget(b); thumbShow(b, u); });
    } else {
      var n = (THUMBS.tries.get(job.url) || 0) + 1; THUMBS.tries.set(job.url, n);
      if (outcome === "fail" || n >= THUMB_TRIES) { THUMBS.failed.add(job.url); boxes.forEach(thumbForget); }
    }
    thumbPump();
  }
  fetch(job.url, { credentials: "same-origin", cache: "no-store", signal: ctl ? ctl.signal : undefined }).then(function (r) {
    if (finished) return;
    if (gen !== THUMBS.gen) return end(null, "retry");
    if (r.status === 429) {
      var wait = Number(r.headers.get("retry-after"));
      THUMBS.pausedUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 120) * 1000 : 30000);
      return end(null, "requeue");
    }
    if (!r.ok) return end(null, r.status >= 500 || r.status === 401 ? "retry" : "fail");
    var type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!THUMB_MIME.test(type)) return end(null, "fail");
    var size = Number(r.headers.get("content-length"));
    if (Number.isFinite(size) && size > THUMB_MAX_BYTES[job.video ? "video" : "image"]) { if (ctl) ctl.abort(); return end(null, "fail"); }
    return r.blob().then(function (b) {
      if (finished) return;
      cancel = thumbFromBlob(b, job.video, function (u) { end(u, u ? "ok" : "fail"); });
    });
  }).catch(function () { end(null, "retry"); });
}
function thumbWant(box, job) {
  var have = THUMBS.made.get(job.url);
  if (have) { thumbForget(box); return thumbShow(box, have); }
  if (THUMBS.failed.has(job.url)) return thumbForget(box);
  var boxes = THUMBS.waiting.get(job.url);
  if (boxes) { if (boxes.indexOf(box) < 0) boxes.push(box); thumbPump(); return; }
  THUMBS.waiting.set(job.url, [box]); THUMBS.queue.push(job); thumbPump();
}
function thumbObserve(box, job) {
  if (THUMBS.made.has(job.url)) return thumbShow(box, THUMBS.made.get(job.url));
  if (THUMBS.failed.has(job.url)) return;
  if (!("IntersectionObserver" in window)) return thumbWant(box, job);
  if (!THUMBS.io) THUMBS.io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      e.target._inView = e.isIntersecting;
      if (e.isIntersecting && e.target._thumbJob) thumbWant(e.target, e.target._thumbJob);
    });
    thumbPump();
  }, { rootMargin: "200px 0px" });
  // Rows replaced by a redraw or navigation are never seen again: stop observing them.
  if (THUMBS.watched.size >= 200) THUMBS.watched.forEach(function (b) { if (!b.isConnected) thumbForget(b); });
  box._thumbJob = job; box._inView = false; THUMBS.io.observe(box); THUMBS.watched.add(box);
}
// a: { id, kind, mime, revision }. noPreview: icon only (trash: trashed content isn't served).
function fileThumb(a, pid, noPreview) {
  var t = HOME.typeOf(a), box = h("span", { class: "ficon-sm", "aria-hidden": "true", dataset: { type: t } }, icon(kindIcon(a)));
  if (noPreview || !a.id || !(a.revision > 0) || !THUMB_MIME.test(a.mime || "")) return box;
  thumbObserve(box, { video: t === "video", url: "/api/projects/" + enc(pid) + "/artifacts/" + enc(a.id) + "/content?rev=" + enc(String(a.revision)) });
  return box;
}
// Offline: a saved image copy is already on this device; draw a small thumbnail from it, one at a time so a long list
// never decodes many full-size images at once. Pending work stops and thumbnails are revoked on navigation.
var OFFLINE_THUMBS = Promise.resolve();
function offlineThumb(it) {
  var box = h("span", { class: "ficon-sm", "aria-hidden": "true", dataset: { type: HOME.typeOf(it) } }, icon(kindIcon(it)));
  if (it.blob && /^image\/(png|jpeg|webp|gif)$/.test(it.mime || "")) {
    var alive = true;
    S.cleanups.push(function () { alive = false; });
    OFFLINE_THUMBS = OFFLINE_THUMBS.then(function () {
      if (!alive) return;
      return new Promise(function (done) {
        thumbFromBlob(it.blob, false, function (u) {
          done();
          if (!u) return;
          if (!alive) return URL.revokeObjectURL(u);
          S.cleanups.push(function () { URL.revokeObjectURL(u); });
          thumbShow(box, u);
        });
      });
    });
  }
  return box;
}
