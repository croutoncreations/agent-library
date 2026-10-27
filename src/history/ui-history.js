  // ---------- version history (docs/version-history.md) ----------
  // One timeline of content versions and details (title/folder/tags) versions, newest first. Bursts of your own
  // browser autosaves collapse into one expandable row; versions by apps and agents are always shown singly.
  var VH = (function () {
    var root = h("div", { class: "vh" }), msg = h("p", { class: "msg", role: "status" }), list = h("ul", { class: "list vh-list", "aria-busy": "true" });
    var more = h("button", { type: "button", class: "secondary", hidden: true }, "Show older versions");
    var detail = h("div", { class: "vh-detail" });
    root.append(msg, list, h("div", { class: "row vh-more" }, more), detail);
    var moreMeta = h("button", { type: "button", class: "secondary", hidden: true }, "Show older details");
    var revs = [], metas = [], cursor = null, metaCursor = null, loading = false, openRev = null, burstSeq = 0;
    var BURST_MS = 10 * 60 * 1000;
    function ago(s) {
      var t = Date.parse(s); if (isNaN(t)) return "";
      var d = (Date.now() - t) / 1000;
      if (d < 60) return "just now";
      if (d < 3600) return Math.round(d / 60) + " min ago";
      if (d < 86400) return Math.round(d / 3600) + " h ago";
      return fmtDate(s);
    }
    function delta(v, prev) {
      if (!prev || v.size == null || prev.size == null) return "";
      var d = v.size - prev.size; if (!d) return "";
      return (d > 0 ? "+" : "−") + fmtBytes(Math.abs(d));
    }
    var reported = function () { return h("span", { class: "vh-reported", text: "reported" }); };
    function whoLine(v, extra) {
      var parts = [h("strong", { class: "vh-who", text: v.who || "Unknown" })];
      if (v.via && v.via.kind === "oauth") parts.push(h("span", { class: "badge", text: "connected app" }));
      else if (v.via && v.via.kind === "api_key") parts.push(h("span", { class: "badge", text: "API key" }));
      else if (v.via && v.via.kind === "publisher") parts.push(h("span", { class: "badge", text: "publishing app" }));
      else if (v.via && v.via.kind === "grant") parts.push(h("span", { class: "badge", text: "agent token" }));
      if (v.client_info) parts.push(h("span", { class: "muted small" }, "via " + v.client_info + " ", reported()));
      if (extra) parts.push(h("span", { class: "muted small", text: extra }));
      return h("span", { class: "vh-wholine" }, parts);
    }
    function isAgent(v) { return !!(v.via && v.via.kind !== "browser"); }
    // The automatic "Restored version N" note repeats what the row already says; show only notes someone wrote.
    function noteText(v) {
      if (!v.change_note) return null;
      if (v.restored_from && (v.change_note === "Restored version " + v.restored_from || v.change_note === "Restored details from version " + v.restored_from)) return null;
      return v.change_note;
    }
    function note(v) {
      var t = noteText(v); if (!t) return null;
      return h("span", { class: "vh-note" + (isAgent(v) ? " agent" : "") }, "“" + t + "”", isAgent(v) ? [" ", reported()] : null);
    }
    function isMine(v) { return (!v.via || v.via.kind === "browser") && v.who === "You"; }
    // Group consecutive autosaves of yours (no note, not a restore) within BURST_MS of each other.
    function groups() {
      var out = [], g = null;
      for (var i = 0; i < revs.length; i++) {
        var v = revs[i], burst = isMine(v) && !v.change_note && !v.restored_from;
        if (burst && g && g.burst && Date.parse(g.items[g.items.length - 1].created_at) - Date.parse(v.created_at) <= BURST_MS) g.items.push(v);
        else { g = { burst: burst, items: [v] }; out.push(g); }
      }
      return out;
    }
    function revRow(v, i) {
      var prev = revs[i + 1];
      var current = v.rev === A.rev, isOpen = openRev === v.rev;
      return h("li", { class: "vh-row" + (isOpen ? " open" : ""), "aria-current": isOpen ? "true" : null, dataset: { rev: String(v.rev) } },
        h("span", { class: "vh-n", text: "v" + v.rev }),
        h("span", { class: "grow" },
          whoLine(v),
          h("span", { class: "meta" }, ago(v.created_at) + (delta(v, prev) ? " · " + delta(v, prev) : "") + (v.restored_from ? " · restored from v" + v.restored_from : "")),
          note(v)),
        current ? h("span", { class: "badge accent", text: "current" }) : null,
        h("button", { type: "button", class: "secondary vh-open", onclick: function () { open(v.rev); } }, current ? "View" : "Compare", h("span", { class: "sr", text: " version " + v.rev })));
    }
    function draw() {
      list.replaceChildren(); list.removeAttribute("aria-busy");
      if (!revs.length) { list.append(h("li", { class: "empty", text: "No versions yet." })); return; }
      groups().forEach(function (g) {
        if (!g.burst || g.items.length < 3) { g.items.forEach(function (v) { list.append(revRow(v, revs.indexOf(v))); }); return; }
        var first = g.items[0], last = g.items[g.items.length - 1];
        var hasOpen = g.items.some(function (v) { return v.rev === openRev; });
        var innerId = "vh-burst-" + (++burstSeq);
        var inner = h("ul", { class: "list vh-inner", id: innerId, hidden: !hasOpen });
        g.items.forEach(function (v) { inner.append(revRow(v, revs.indexOf(v))); });
        var label = function (o) { return o ? "Hide " + g.items.length + " edits" : "Show " + g.items.length + " edits"; };
        var toggle = h("button", { type: "button", class: "secondary vh-toggle", "aria-expanded": String(hasOpen), "aria-controls": innerId }, icon("chevron"), h("span", { text: label(hasOpen) }));
        toggle.onclick = function () { var o = inner.hidden; inner.hidden = !o; toggle.setAttribute("aria-expanded", String(o)); toggle.lastChild.textContent = label(o); };
        var span = ago(last.created_at) === ago(first.created_at) ? ago(first.created_at) : ago(last.created_at) + " – " + ago(first.created_at);
        list.append(h("li", { class: "vh-burst" },
          h("span", { class: "vh-n", text: "v" + last.rev + "–" + first.rev }),
          h("span", { class: "grow" }, h("span", { class: "vh-wholine" }, h("strong", { class: "vh-who", text: "You" })),
            h("span", { class: "meta", text: "autosaved while editing · " + span })),
          first.rev === A.rev ? h("span", { class: "badge accent", text: "current" }) : null,
          toggle, inner));
      });
      if (metas.length > 1) {
        list.append(h("li", { class: "group", text: "Title, folder and tags" }));
        metas.forEach(function (m) {
          var cur = m.version === A.meta.meta_version;
          list.append(h("li", { class: "vh-row", dataset: { meta: String(m.version) } },
            h("span", { class: "vh-n", text: "#" + m.version }),
            h("span", { class: "grow" }, whoLine(m),
              h("span", { class: "meta", text: "“" + m.title + "”" + (m.folder ? " · " + m.folder : "") + (m.tags.length ? " · " + m.tags.join(", ") : "") + (m.trashed ? " · in trash" : "") + " · " + ago(m.created_at) }),
              note(m)),
            cur ? h("span", { class: "badge accent", text: "current" }) : h("button", { type: "button", class: "secondary", onclick: function (e) { restoreMeta(m, e.currentTarget); } }, "Restore", h("span", { class: "sr", text: " title and tags from details version " + m.version }))));
        });
        // Details history pages separately from content versions (its own cursor).
        if (metaCursor) list.append(h("li", { class: "vh-more-meta" }, moreMeta));
      }
      moreMeta.hidden = !metaCursor;
    }
    async function fetchPage(again) {
      var r = await api("GET", base + "/history" + (again && cursor ? "?cursor=" + enc(cursor) : ""));
      if (again) revs = revs.concat(r.revisions); else { revs = r.revisions; metas = r.meta_versions || []; metaCursor = r.meta_next_cursor || null; }
      cursor = r.next_cursor; more.hidden = !cursor;
    }
    moreMeta.onclick = async function () {
      if (!metaCursor || loading) return;
      loading = true; moreMeta.disabled = true;
      try {
        var r = await api("GET", base + "/meta-history?cursor=" + enc(metaCursor));
        metas = metas.concat(r.meta_versions || []); metaCursor = r.next_cursor || null;
        draw();
        if (!metaCursor) { var g = list.querySelector('[data-meta="' + metas[metas.length - 1].version + '"]'); if (g) { g.setAttribute("tabindex", "-1"); g.focus(); } }
        else moreMeta.focus();
      } catch (err) { showErr(msg, err); }
      finally { loading = false; moreMeta.disabled = false; }
    };
    async function load(again) {
      if (loading) return; loading = true; more.disabled = true;
      try {
        await fetchPage(again);
        // A requested version older than the loaded pages: keep paging until it is loaded (or the history ends).
        while (!again && openRev && cursor && !revs.some(function (x) { return x.rev === openRev; }) && openRev < revs[revs.length - 1].rev) await fetchPage(true);
        draw();
        if (openRev && !again) await open(openRev, true);
      } catch (err) { list.removeAttribute("aria-busy"); showErr(msg, err); }
      finally { loading = false; more.disabled = false; }
    }
    more.onclick = function () { load(true); };
    function link(n) { return docUrl(pid, aid) + "?v=" + n; }
    function busy(btn, on) { if (btn) btn.disabled = on; }
    async function open(n, quiet) {
      var v = revs.filter(function (x) { return x.rev === n; })[0];
      if (!v) {
        // load() pages back to any existing version first, so a miss here means it never existed.
        openRev = null; draw();
        detail.replaceChildren(h("p", { class: "msg error", role: "alert", text: "Version " + n + " doesn't exist for this document." }));
        return;
      }
      openRev = n;
      draw(); // marks the open row (and expands its burst)
      var title = h("h2", { tabindex: "-1", text: "Version " + n + (n === A.rev ? " (current)" : "") });
      var head = h("div", { class: "vh-head" }, title,
        h("span", { class: "icons" }, copyIcon("link", "Copy link to this version", function () { return link(n); })));
      var body = h("div", { class: "vh-body" });
      var actions = h("div", { class: "row" });
      if (n !== A.rev) actions.append(h("button", { type: "button", onclick: function (e) { restoreRev(n, e.currentTarget); } }, "Restore this version"));
      if (n > 1) actions.append(h("button", { type: "button", class: "secondary", onclick: function () { showDiff(n - 1, n, body); } }, "What changed in v" + n));
      if (n !== A.rev) actions.append(h("button", { type: "button", class: "secondary", onclick: function () { showDiff(n, A.rev, body); } }, "Compare with current"));
      if (isDataKind(A.meta.kind)) actions.append(h("button", { type: "button", class: "ghost", onclick: function () { body.replaceChildren(mediaFor(v.mime, base + "/content?rev=" + n, A.meta.title, "v" + n)); } }, "Preview v" + n));
      if (isTextDoc(A.meta.kind) || isDataKind(A.meta.kind)) actions.append(h("button", { type: "button", class: "ghost", onclick: function () { showSource(n, body); } }, "Show full text"));
      // replaceChildren() would print a null argument as the text "null"; pass only real nodes.
      var parts = [head, h("p", { class: "muted small" }, whoLine(v, fmtDate(v.created_at)))];
      if (note(v)) parts.push(h("p", null, note(v)));
      parts.push(actions, body);
      detail.replaceChildren.apply(detail, parts);
      // Default view: what this version changed (matches its note); "Compare with current" is one tap away.
      if (isTextDoc(A.meta.kind) || isDataKind(A.meta.kind)) await showDiff(Math.max(1, n - 1), n, body);
      else body.append(mediaFor(v.mime, base + "/content?rev=" + n, A.meta.title));
      if (!quiet || VH.focusOnOpen) { title.focus({ preventScroll: true }); title.scrollIntoView({ block: "start", behavior: "smooth" }); VH.focusOnOpen = false; }
    }
    async function showDiff(from, to, into) {
      if (from === to) { into.replaceChildren(h("p", { class: "muted", text: "This is the first version." })); return; }
      into.replaceChildren(h("p", { class: "muted", text: "Comparing…" }));
      if (A.meta.kind === "json") return showJsonDiff(from, to, into);
      return showLineDiff(from, to, into);
    }
    // note: optional text put before the caption (e.g. why a JSON comparison fell back to lines).
    async function showLineDiff(from, to, into, note) {
      try {
        var d = await api("GET", base + "/diff?from=" + from + "&to=" + to);
        var what = to === A.rev && from !== to - 1 ? "Current (v" + to + ") compared with v" + from : "Changes from v" + from + " to v" + to;
        var cap = h("p", { class: "muted small", text: (note ? note + " " : "") + what + (d.identical ? " · identical" : d.binary ? " · file changed (" + fmtBytes(d.from.size) + " → " + fmtBytes(d.to.size) + ")" : d.too_many_lines ? " · too many lines to compare here (" + fmtBytes(d.from.size) + " → " + fmtBytes(d.to.size) + "); use Show full text" : " · " + d.added + " added, " + d.removed + " removed" + (d.truncated ? " (large change: partly shown)" : "")) });
        if (d.binary || d.identical || d.too_many_lines) { into.replaceChildren(cap); return; }
        var pre = h("div", { class: "vh-diff", role: "group", tabindex: "0", "aria-label": what });
        d.hunks.forEach(function (hk, i) {
          if (i) pre.append(h("div", { class: "vh-gap", "aria-hidden": "true", text: "⋯" }));
          var a = hk.a_start, b = hk.b_start;
          hk.lines.forEach(function (l) {
            var op = l[0], t = l.slice(1), cls = op === "+" ? "add" : op === "-" ? "del" : "ctx";
            pre.append(h("div", { class: "vh-line " + cls },
              h("span", { class: "vh-ln", "aria-hidden": "true", text: op === "+" ? "" : String(a) }),
              h("span", { class: "vh-ln", "aria-hidden": "true", text: op === "-" ? "" : String(b) }),
              h("span", { class: "vh-mark", "aria-hidden": "true", text: op === "+" ? "+" : op === "-" ? "−" : "" }),
              h("span", { class: "sr", text: op === "+" ? "added: " : op === "-" ? "removed: " : "" }),
              h("span", { class: "vh-t", text: t || " " })));
            if (op !== "+") a++; if (op !== "-") b++;
          });
        });
        into.replaceChildren(cap, pre);
      } catch (err) { into.replaceChildren(h("p", { class: "msg error", role: "alert", text: "Couldn't compare: " + err.message })); }
    }
    // JSON: compare values by path (minified JSON is often one line, so a line diff would only say "everything").
    // Built with text nodes only; bounded by jsonChanges' cap. Falls back to the line diff when a side isn't valid
    // JSON or the documents are too large to compare value by value (never reports "no changes" for an unfinished walk).
    async function showJsonDiff(from, to, into) {
      // Without exact number parsing a changed big number can round to the same value and vanish from a value
      // diff (even when other values changed), so such browsers always get the line diff.
      if (!JSON_EXACT_NUMBERS) return showLineDiff(from, to, into, "This browser rounds numbers, so this compares lines.");
      try {
        var ra = await api("GET", base + "?rev=" + from), rb = await api("GET", base + "?rev=" + to);
        var A1, B1;
        try { A1 = jsonParse(ra.content); B1 = jsonParse(rb.content); } catch (e) { return showLineDiff(from, to, into, "One of these versions isn't valid JSON, so this compares lines."); }
        var what = to === A.rev && from !== to - 1 ? "Current (v" + to + ") compared with v" + from : "Changes from v" + from + " to v" + to;
        var identical = ra.revision.sha256 === rb.revision.sha256;
        var c = identical ? { list: [], total: 0, incomplete: false } : jsonChanges(A1, B1, 300);
        if (c.incomplete) return showLineDiff(from, to, into, "Too large to compare value by value, so this compares lines.");
        var counts = { changed: 0, added: 0, removed: 0 }; c.list.forEach(function (x) { counts[x.op]++; });
        var parts = ["changed", "added", "removed"].filter(function (k) { return counts[k]; }).map(function (k) { return counts[k] + " " + k; });
        var cap = h("p", { class: "muted small", text: what + (identical ? " · identical" : !c.total ? " · same values (formatting only)" :
          " · " + (c.total > c.list.length ? plural(c.total, "value") + " changed (first " + fmtCount(c.list.length) + " shown: " + parts.join(", ") + ")" : parts.join(", "))) });
        if (!c.total) { into.replaceChildren(cap); return; }
        var box = h("div", { class: "vh-diff vh-json", role: "list", tabindex: "0", "aria-label": what });
        c.list.forEach(function (x) {
          var row = h("div", { class: "vh-jrow " + x.op, role: "listitem" },
            h("span", { class: "vh-mark", "aria-hidden": "true", text: x.op === "added" ? "+" : x.op === "removed" ? "−" : "~" }),
            h("span", { class: "sr", text: x.op + ": " }),
            h("code", { class: "vh-jpath", text: x.path }));
          if (x.op === "changed") row.append(h("span", { class: "sr", text: " was " }));
          if (x.op !== "added") row.append(h("span", { class: "vh-jold", text: jsonBrief(x.from) }));
          if (x.op === "changed") row.append(h("span", { class: "vh-jarrow", "aria-hidden": "true", text: "→" }), h("span", { class: "sr", text: ", now " }));
          if (x.op !== "removed") row.append(h("span", { class: "vh-jnew", text: jsonBrief(x.to) }));
          box.append(row);
        });
        into.replaceChildren(cap, box);
      } catch (err) { into.replaceChildren(h("p", { class: "msg error", role: "alert", text: "Couldn't compare: " + err.message })); }
    }
    async function showSource(n, into) {
      try { var r = await api("GET", base + "?rev=" + n); into.replaceChildren(h("pre", { class: "raw", tabindex: "0", text: typeof r.body === "string" ? r.body : r.content })); }
      catch (err) { into.replaceChildren(h("p", { class: "msg error", role: "alert", text: "Couldn't load the text: " + err.message })); }
    }
    function conflictRev(err) { return ((err.data || {}).error || {}).current_revision || "?"; }
    async function restoreRev(n, btn) {
      if (A.isBusy && A.isBusy()) { showMsg(msg, "Save or discard your local edits before restoring an older version."); return; }
      if (!confirm("Restore version " + n + "? This adds a new version with its content. Nothing is deleted.")) return;
      busy(btn, true);
      try {
        var r = await api("POST", base + "/restore", { expected_revision: A.rev, from_revision: n }, { key: uuid() });
        if (A.reload) await A.reload();
        openRev = r.revision; VH.focusOnOpen = true; await load();
        toast("Restored version " + n + " as version " + r.revision);
        showMsg(msg, "Restored version " + n + " as version " + r.revision + ".", true);
      } catch (err) {
        busy(btn, false);
        if (err.status === 409) { showMsg(msg, "The document changed (now version " + conflictRev(err) + "). The list is refreshed; try again."); if (A.reload) await A.reload(); load(); }
        else showErr(msg, err);
        msg.scrollIntoView({ block: "nearest" });
      }
    }
    async function restoreMeta(m, btn) {
      // Say plainly when the restore also moves the document into or out of the trash.
      var trashNote = m.trashed && !A.meta.trashed ? " This also moves the document to the trash." : !m.trashed && A.meta.trashed ? " This also takes the document out of the trash." : "";
      if (!confirm("Restore the title “" + m.title + "”" + (m.folder ? ", folder and tags" : " and tags") + " from details version " + m.version + "?" + trashNote + " Nothing is deleted.")) return;
      busy(btn, true);
      try {
        var r = await api("POST", base + "/meta-restore", { expected_meta_version: A.meta.meta_version, from_version: m.version }, { key: uuid() });
        A.meta.meta_version = r.meta_version; A.meta.title = r.title; A.meta.folder = r.folder; A.meta.tags = r.tags; A.meta.trashed = r.trashed;
        if (fillMeta) fillMeta();
        await load();
        toast("Restored details from version " + m.version);
        var row = list.querySelector('[data-meta="' + r.meta_version + '"]');
        if (row) { row.setAttribute("tabindex", "-1"); row.focus({ preventScroll: false }); }
      } catch (err) {
        busy(btn, false);
        if (err.status === 409) { showMsg(msg, "Details were changed elsewhere. The list is refreshed; try again."); await reloadMeta(); load(); }
        else showErr(msg, err);
        msg.scrollIntoView({ block: "nearest" });
      }
    }
    function requestedVersion() {
      var q = /[?&]v=([0-9]{1,9})(?:&|$)/.exec(location.search) || /[?&]v=([0-9]{1,9})(?:&|$)/.exec(location.hash);
      return q ? Number(q[1]) : null;
    }
    return { root: root, load: function () { return load(false); }, open: function (n) { openRev = n; VH.focusOnOpen = true; }, requestedVersion: requestedVersion, focusOnOpen: false };
  })();
