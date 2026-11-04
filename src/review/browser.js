// ---------- review gating (docs/review-gating.md; src/review) ----------
// Home shows "Needs review" only when something waits for review (nothing otherwise). The review screen shows who proposed
// what and why, the diff against the version it started from (and the current one when the document moved on), details
// changes and file previews, with Approve / Edit and approve / Reject. Everything is built from text nodes.
var RV_MODES_UI = ["off", "advisory", "required"];
var RV_MODE_LABELS = { off: "Off", advisory: "Optional (mark versions reviewed)", required: "Required (agent edits wait for approval)" };
var RV_SHORT = { off: "Off", advisory: "Optional", required: "Required" };
function rvViaBadge(via) {
  var t = via && { oauth: "connected app", api_key: "API key", grant: "agent token" }[via.kind];
  return t ? h("span", { class: "badge", text: t }) : null;
}
// Off / Optional / Required as radios with what each means (document Details and the project default share it).
function rvModeRadios(name, cur, onChange) {
  return RV_MODES_UI.map(function (m) {
    var r = h("input", { type: "radio", name: name, value: m, checked: cur === m });
    if (onChange) r.addEventListener("change", onChange);
    return h("label", { class: "rv-radio" }, r, h("span", null, h("strong", { text: RV_SHORT[m] }), h("span", { class: "muted small", text: RV_DESC[m] })));
  });
}
function rvPicked(radios, fallback) { var c = radios.map(function (l) { return l.firstChild; }).filter(function (x) { return x.checked; })[0]; return c ? c.value : fallback; }
function rvChanges(p) {
  var parts = [];
  if (p.is_new) parts.push("new " + (p.kind === "binary" ? "file" : "document"));
  else {
    if (p.changes.indexOf("content") >= 0) parts.push(p.kind === "binary" ? "new file version" : p.proposed && p.proposed.restored_from ? "restore of v" + p.proposed.restored_from : "edit");
    if (p.changes.indexOf("details") >= 0) parts.push("title, folder or tags");
  }
  return parts.join(" + ");
}
function rvAgo(s) {
  var t = Date.parse(s); if (isNaN(t)) return "";
  var d = (Date.now() - t) / 1000;
  return d < 60 ? "just now" : d < 3600 ? Math.round(d / 60) + " min ago" : d < 86400 ? Math.round(d / 3600) + " h ago" : fmtDate(s);
}
function rvCap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function rvTitle(p) { return p.document_title || (p.proposed && p.proposed.title) || "Untitled"; }
function rvRow(p, showProject) {
  var href = "#/p/" + enc(p.project_id) + "/review/" + enc(p.proposal_id);
  return h("li", { class: "link rv-row", dataset: { proposal: p.proposal_id } },
    h("span", { class: "ficon-sm", "aria-hidden": "true" }, icon(p.kind === "binary" ? "file" : "doc")),
    h("div", { class: "grow" }, rowLink(href, rvTitle(p)),
      h("span", { class: "meta" }, p.stale ? h("span", { class: "rv-stale", text: "Outdated: document changed · " }) : null,
        [rvCap(rvChanges(p)) + " by " + p.who, showProject ? p.project_title : null, rvAgo(p.created_at)].filter(Boolean).join(" · ")),
      p.change_note ? h("span", { class: "rv-note" }, "“" + p.change_note + "”") : null),
    h("span", { class: "chev", "aria-hidden": "true" }, icon("chevron")));
}
// Home: one compact section, rendered only when the queue is not empty.
// box.refresh() reloads it (Home's Refresh and returning to the tab).
function rvHomeSection() {
  var box = h("section", { class: "rv-home", hidden: true, "aria-labelledby": "rv-home-h" }), all = false, last = null;
  function draw() {
    var r = last;
    if (!r || !r.proposals.length) { box.hidden = true; box.replaceChildren(); return; }
    var shown = all ? r.proposals : r.proposals.slice(0, 5), n = r.proposals.length + (r.more ? "+" : "");
    box.replaceChildren(
      h("div", { class: "rv-home-head" }, h("h2", { id: "rv-home-h" }, "Needs review ", h("span", { class: "badge accent", text: String(n) })),
        r.proposals.length > shown.length ? h("button", { type: "button", class: "ghost small", onclick: function () { all = true; draw(); } }, r.more ? "Show newest " + r.proposals.length : "Show all " + n) : null),
      h("ul", { class: "list", "aria-label": "Edits waiting for review" }, shown.map(function (p) { return rvRow(p, true); })));
    box.hidden = false;
  }
  // Best effort: an extra section never takes over the page (a failure, even an ended session, just leaves it as is).
  box.refresh = function () {
    return api("GET", "/api/review-queue", undefined, { noAuthRedirect: true }).then(function (r) { if (box.isConnected || !last) { last = r; draw(); } }).catch(function () {});
  };
  box.refresh();
  return box;
}
// Project → Review tab: pending proposals, then the project's default for new documents.
async function viewProjectReview(pid) {
  var base = "/api/projects/" + enc(pid);
  var msg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
  var list = h("ul", { class: "list", "aria-label": "Edits waiting for review" }), empty = h("div", { hidden: true });
  var settings = h("div", { class: "card rv-settings" });
  shell(projCrumbs(pid, [{ t: "Review" }]), pageHead(projectTitles[pid] || pid, { sub: "Edits by apps and agents that wait for your approval before anyone else sees them." }), projectTabs(pid, "review"), msg, list, empty, settings);
  ensureProjectTitle(pid);
  skeletonRows(list, 2);
  try {
    var r = await api("GET", base + "/proposals");
    doneLoading(list); list.replaceChildren(); r.proposals.forEach(function (p) { list.append(rvRow(p, false)); });
    list.hidden = !r.proposals.length; empty.hidden = !!r.proposals.length;
    if (!r.proposals.length) empty.replaceChildren(stateBox("", "check", "Nothing to review", "When a document requires review, edits by apps and agents wait here until you approve them."));
    var cursor = r.next_cursor;
    if (cursor) {
      var more = h("button", { type: "button", class: "secondary", onclick: async function () {
        more.disabled = true;
        try { var n = await api("GET", base + "/proposals?cursor=" + enc(cursor)); n.proposals.forEach(function (p) { list.append(rvRow(p, false)); }); cursor = n.next_cursor; more.hidden = !cursor; }
        catch (err) { showErr(msg, err); } finally { more.disabled = false; }
      } }, "Load more");
      list.after(more);
    }
  } catch (err) { doneLoading(list); list.hidden = true; showErr(msg, err); }
  drawSettings();
  async function drawSettings(refocus) {
    var s;
    try { s = await api("GET", base + "/review-settings"); }
    catch (err) {
      settings.replaceChildren(h("h2", { text: "Review for new documents" }), h("p", { class: "msg error", text: "Review settings couldn't load: " + err.message }),
        h("div", { class: "row" }, h("button", { type: "button", class: "secondary", onclick: function (e) { e.currentTarget.disabled = true; drawSettings(true); } }, icon("refresh"), "Try again")));
      return;
    }
    var radios = rvModeRadios("rv-default-" + pid, s.default, function () { kindBox.hidden = picked() === "off"; });
    var picked = function () { return rvPicked(radios, s.default); };
    var kinds = [["markdown", "Docs"], ["html", "Pages"], ["json", "JSON"], ["csv", "CSV"], ["binary", "Files (images, PDFs, other uploads)"]].map(function (k) {
      return h("label", { class: "rv-kind" }, h("input", { type: "checkbox", value: k[0], checked: !s.kinds || s.kinds.indexOf(k[0]) >= 0 }), k[1]);
    });
    var kindBox = h("fieldset", { class: "rv-kinds", hidden: s.default === "off" }, h("legend", { class: "rv-legend", text: "Applies to" }), kinds);
    var smsg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
    function chosen() { var ks = kinds.map(function (l) { return l.firstChild; }).filter(function (c) { return c.checked; }).map(function (c) { return c.value; }); return ks.length === kinds.length ? null : ks; }
    async function persist() {
      var ks = chosen(); if (ks && !ks.length) { showMsg(smsg, "Pick at least one type, or turn review off."); return false; }
      s = await api("PUT", base + "/review-settings", { default: picked(), kinds: ks });
      return true;
    }
    var save = h("button", { type: "button", onclick: async function () {
      save.disabled = true;
      try { if (await persist()) showMsg(smsg, "Saved. New documents use this setting; existing ones keep theirs.", true); }
      catch (err) { showErr(smsg, err); } finally { save.disabled = false; }
    } }, "Save");
    // Applies exactly what the page shows (saving it first), and says what it will change before it does.
    var applyBtn = h("button", { type: "button", class: "secondary", onclick: async function () {
      var target = picked(), docs = s.documents || {}, others = RV_MODES_UI.filter(function (m) { return m !== target; })
        .map(function (m) { return docs[m] ? (chosen() ? "documents" : plural(docs[m], "document")) + " currently " + (m === "off" ? "without review" : m === "required" ? "requiring review" : "with optional review") : null; }).filter(Boolean);
      if (!others.length) { showMsg(smsg, "Every document already uses this setting.", true); return; }
      var what = target === "off" ? "Turn review off for " : "Set review to " + RV_MODE_LABELS[target].split(" (")[0].toLowerCase() + " for ";
      if (!confirm(what + others.join(" and ") + " (" + kindNames() + ")?" + (target === "required" ? " Their current versions count as reviewed." : "") + (target === "off" && docs.required ? " Agent edits will go live without approval." : "") + " Edits already waiting stay pending.")) return;
      applyBtn.disabled = true;
      try {
        if (!await persist()) return;
        var a = await api("POST", base + "/review-settings/apply", { expected_default: target, expected_kinds: s.kinds });
        showMsg(smsg, "Updated " + plural(a.updated.length, "document") + (a.skipped_changed.length ? "; " + plural(a.skipped_changed.length, "document") + " changed while applying and kept their setting" : "") + ".", true);
        s = await api("GET", base + "/review-settings");
      } catch (err) { showErr(smsg, err); } finally { applyBtn.disabled = false; }
    } }, "Save and apply to existing documents");
    function kindNames() { var ks = chosen(); return ks ? kinds.filter(function (l) { return l.firstChild.checked; }).map(function (l) { return l.textContent; }).join(", ") : "all types"; }
    settings.replaceChildren(h("h2", { text: "Review for new documents", tabindex: "-1" }),
      h("p", { class: "muted small rv-help", text: "Your own edits never wait for review. Files from publishing apps are never gated. Change one document from its Details." }),
      h("fieldset", { class: "rv-modes" }, h("legend", { class: "rv-legend", text: "New documents" }), radios), kindBox, h("div", { class: "row rv-actions" }, save, applyBtn), smsg);
    if (refocus) settings.querySelector("h2").focus();
  }
}
// One proposal: what changed and why, then the decision.
async function viewProposal(pid, prp) {
  var base = "/api/projects/" + enc(pid), path = base + "/proposals/" + enc(prp);
  shell(projCrumbs(pid, [{ t: "Review", href: "#/p/" + enc(pid) + "/review" }, { t: "Loading…" }]), h("div", { class: "doc-loading", "aria-busy": "true" }, h("span", { class: "skel-line wide" }), h("div", { class: "skel-block" })));
  ensureProjectTitle(pid);
  var d;
  try { d = await api("GET", path); }
  catch (err) {
    shell(projCrumbs(pid, [{ t: "Review", href: "#/p/" + enc(pid) + "/review" }, { t: "Not available" }]), stateBox("error", "alert", err.status === 404 ? "This proposal isn't available" : "Couldn't load this proposal", err.message, h("a", { class: "btn secondary", href: "#/p/" + enc(pid) + "/review" }, "Back to Review")));
    return;
  }
  var p = d.proposal, docHref = "#/p/" + enc(pid) + "/a/" + enc(p.artifact_id);
  var msg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
  var head = pageHead(rvTitle(p), { eyebrow: p.is_new ? "New " + (p.kind === "binary" ? "file" : "document") + " · waiting for review" : "Proposed " + rvChanges(p),
    actions: p.is_new ? null : h("a", { class: "btn secondary", href: docHref }, "Open document") });
  var who = h("p", { class: "rv-who" }, h("strong", { text: p.who }), rvViaBadge(p.via),
    h("span", { class: "muted small", text: [p.client_info ? "via " + p.client_info : null, rvAgo(p.created_at), p.is_new ? null : "based on v" + p.base_revision].filter(Boolean).join(" · ") }));
  var why = p.change_note ? h("blockquote", { class: "rv-why" }, p.change_note) : h("p", { class: "muted small", text: "No note given." });
  var status = p.status !== "pending" ? h("div", { class: "callout " + (p.status === "approved" ? "info" : "warn") }, icon(p.status === "approved" ? "check" : "alert"),
    h("span", null, h("strong", { text: { approved: "Approved", rejected: "Rejected", superseded: "Replaced by a newer proposal", withdrawn: "Withdrawn by its author" }[p.status] || p.status }),
      d.review ? " by " + d.review.who + (d.review.note ? ": “" + d.review.note + "”" : "") : "",
      p.status === "approved" && p.result_revision ? h("span", null, " · ", h("a", { href: docHref + "?v=" + p.result_revision, text: "version " + p.result_revision })) : null)) : null;
  var stale = p.status === "pending" && p.stale ? h("div", { class: "callout warn", id: "rv-stale" }, icon("alert"), h("span", null, h("strong", { text: "The document changed since this was proposed" }),
    p.kind === "binary" && p.changes.indexOf("content") >= 0
      ? " (now v" + p.current_revision + "). A file can't be merged: reject it and ask " + p.who + " to upload again, or upload the file yourself."
      : " (now v" + p.current_revision + "). It can't be approved as is: use Edit and approve to bring its changes into the current version, or reject it.")) : null;
  var sections = [];
  // Content: text diff, or file preview.
  var bodyText = typeof d.body === "string" ? d.body : null;
  if (p.changes.indexOf("content") >= 0) {
    if (p.kind === "binary") {
      var url = path + "/content";
      var prev = p.proposed && /^image\//.test(p.proposed.mime || "") && !p.is_new ? h("figure", null, h("img", { src: base + "/artifacts/" + enc(p.artifact_id) + "/content?rev=" + p.current_revision, alt: "Current version", loading: "lazy" }), h("figcaption", { text: "Current (v" + p.current_revision + ")" })) : null;
      var next = p.proposed && /^image\//.test(p.proposed.mime || "") ? h("figure", null, h("img", { src: url, alt: "Proposed file", loading: "lazy" }), h("figcaption", { text: "Proposed" })) : null;
      sections.push(h("section", { class: "rv-sec" }, h("h2", { text: "File" }),
        prev || next ? h("div", { class: "rv-files" }, prev, next) : null,
        h("p", { class: "muted small", text: (p.proposed.mime || "file") + " · " + fmtBytes(p.proposed.size) + " · SHA-256 " + String(p.proposed.sha256).slice(0, 16) + "…" +
          (d.diff_from_current && d.diff_from_current.identical || !d.diff_from_current && d.diff_from_base && d.diff_from_base.identical ? " · identical to the current version" : "") }),
        h("a", { class: "btn secondary", href: downloadUrl(url) }, icon("download"), "Download proposed file")));
    } else {
      var diffBox = h("div");
      var tabs = h("div", { class: "tabs", role: "group", "aria-label": "Compare with" });
      function tabBtn(label, diff, sel) { var b = h("button", { type: "button", "aria-pressed": String(!!sel), onclick: function () { tabs.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); rvDrawDiff(diffBox, diff, bodyText); } }, label); return b; }
      // Short labels (they fit a phone side by side); the caption above the diff names the version compared with.
      if (d.diff_from_current) tabs.append(tabBtn("Vs current", d.diff_from_current, true));
      if (d.diff_from_base) tabs.append(tabBtn("Proposed changes", d.diff_from_base, !d.diff_from_current));
      tabs.append(tabBtn("Full text", null, !d.diff_from_base && !d.diff_from_current));
      sections.push(h("section", { class: "rv-sec" }, h("h2", { text: p.is_new ? "Content" : "Changes" }), tabs.children.length > 1 ? tabs : null, diffBox));
      rvDrawDiff(diffBox, d.diff_from_current || d.diff_from_base, bodyText);
    }
  }
  if (d.details) {
    var c = d.details.current, n = d.details.proposed;
    var rows = [["Title", c.title, n.title], ["Folder", c.folder || "—", n.folder || "—"], ["Tags", (c.tags || []).join(", ") || "—", (n.tags || []).join(", ") || "—"]].filter(function (r) { return p.is_new || r[1] !== r[2]; });
    sections.push(h("section", { class: "rv-sec" }, h("h2", { text: "Title, folder and tags" }),
      h("table", { class: "rv-meta" }, h("thead", null, h("tr", null, h("th", { scope: "col" }, h("span", { class: "sr", text: "Field" })), p.is_new ? null : h("th", { scope: "col", text: "Now" }), h("th", { scope: "col", text: "Proposed" }))),
        h("tbody", null, rows.map(function (r) { return h("tr", null, h("th", { scope: "row", text: r[0] }), p.is_new ? null : h("td", { text: r[1] || "—" }), h("td", { text: r[2] || "—" })); })))));
  }
  // Decision.
  var decide = null;
  if (p.status === "pending" && d.can_review) {
    var note = h("input", { type: "text", maxLength: 280, placeholder: "Optional, up to 280 characters", "aria-label": "Review note", class: "full-w" });
    var dmsg = h("p", { class: "msg", id: "rv-dmsg", role: "status", "aria-live": "polite" });
    var staleNow = !!p.stale;
    var attempt = null, busy = false;
    var editor = null, fTitle = null, fFolder = null, fTags = null;
    var approve = h("button", { type: "button", onclick: function () { send("approve", false); } }, icon("check"), "Approve");
    function markStale() { approve.disabled = staleNow; if (staleNow) approve.setAttribute("aria-describedby", document.getElementById("rv-stale") ? "rv-stale" : "rv-dmsg"); }
    markStale();
    var canEdit = p.kind !== "binary" || d.details;
    var editBtn = canEdit ? h("button", { type: "button", class: "secondary", onclick: openEditor }, "Edit and approve…") : null;
    var reject = h("button", { type: "button", class: "danger", onclick: function () { send("reject", false); } }, "Reject");
    var editArea = h("div", { class: "rv-edit", hidden: true });
    function openEditor() {
      editArea.hidden = false; editBtn.hidden = true; approve.hidden = true;
      var parts = [h("p", { class: "muted small", text: "Your version is published instead of the proposed one; you'll be shown as its author, with " + p.who + " credited." })];
      if (p.kind !== "binary" && bodyText !== null) {
        editor = h("textarea", { class: "full-w rv-text", rows: 14, "aria-label": "Text to publish", spellcheck: "true" });
        editor.value = bodyText;
        if (staleNow && !p.is_new) {
          // Stale: start from the current version (nothing newer is lost) and bring the proposal's changes in by hand,
          // with its changes shown right here; or start from the proposed text.
          var fromCur = h("button", { type: "button", "aria-pressed": "true" }, "Current version (v" + p.current_revision + ")");
          var fromProp = h("button", { type: "button", "aria-pressed": "false" }, "Proposed text");
          var pick = async function (cur) {
            var set = function () { fromCur.setAttribute("aria-pressed", String(cur)); fromProp.setAttribute("aria-pressed", String(!cur)); };
            if (!cur) { editor.value = bodyText; set(); return; }
            editor.readOnly = true;
            try { var r = await api("GET", base + "/artifacts/" + enc(p.artifact_id) + "?rev=" + p.current_revision); editor.value = r.body; set(); }
            catch (err) { showErr(dmsg, err); fromCur.setAttribute("aria-pressed", "false"); fromProp.setAttribute("aria-pressed", "true"); }
            finally { editor.readOnly = false; }
          };
          fromProp.setAttribute("aria-pressed", "true"); fromCur.setAttribute("aria-pressed", "false");
          fromCur.addEventListener("click", function () { pick(true); }); fromProp.addEventListener("click", function () { pick(false); });
          var ref = h("div", { class: "rv-ref" });
          rvDrawDiff(ref, d.diff_from_base, bodyText);
          parts.push(h("div", { class: "row small" }, h("span", { class: "muted", text: "Start from" }), h("div", { class: "tabs", role: "group", "aria-label": "Start from" }, fromCur, fromProp)),
            h("details", { open: true }, h("summary", { text: "The proposal's changes" }), ref));
          pick(true);
        }
        parts.push(h("label", { class: "rv-field" }, "Text to publish", editor));
      }
      if (d.details) {
        fTitle = h("input", { type: "text", maxLength: 200, value: d.details.proposed.title || "" });
        fFolder = h("input", { type: "text", maxLength: 200, value: d.details.proposed.folder || "" });
        fTags = h("input", { type: "text", value: (d.details.proposed.tags || []).join(", ") });
        parts.push(h("div", { class: "grid2" }, h("label", { class: "rv-field" }, "Title", fTitle), h("label", { class: "rv-field" }, "Folder", fFolder), h("label", { class: "rv-field" }, "Tags (comma separated)", fTags)));
      }
      parts.push(h("div", { class: "row" }, h("button", { type: "button", onclick: function () { send("approve", true); } }, icon("check"), "Publish my version"),
        h("button", { type: "button", class: "secondary", onclick: closeEditor }, "Cancel")));
      editArea.replaceChildren.apply(editArea, parts);
      decideCard.classList.add("editing"); reject.hidden = true;
      editArea.onkeydown = function (e) {
        if (e.key === "Escape") { e.preventDefault(); closeEditor(); }
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send("approve", true); }
      };
      (editor || fTitle).focus();
    }
    function closeEditor() { editArea.hidden = true; editBtn.hidden = false; approve.hidden = false; reject.hidden = false; decideCard.classList.remove("editing"); editBtn.focus(); }
    async function send(decision, edited) {
      if (busy) return;
      if (decision === "reject" && !confirm("Reject this proposal?" + (note.value.trim() ? " " + p.who + " will see your note." : " You can add a note for " + p.who + " first."))) return;
      var req = { decision: decision, note: note.value.trim() || undefined };
      if (edited) {
        if (editor) { req.body = editor.value; req.expected_revision = p.is_new ? 0 : p.current_revision; }
        if (fTitle) { req.title = fTitle.value.trim(); req.folder = fFolder.value.trim(); req.tags = fTags.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean); if (!p.is_new) req.expected_meta_version = p.current_meta_version; }
      }
      var sig = JSON.stringify(req);
      if (!attempt || attempt.sig !== sig) attempt = { sig: sig, key: uuid() };
      busy = true; [approve, reject, editBtn].forEach(function (b) { if (b) b.disabled = true; });
      try {
        var r = await api("POST", path + "/review", req, { key: attempt.key });
        toast(r.status === "approved" ? "Approved · now version " + r.revision : "Rejected");
        location.hash = await rvNextHash(pid, p.proposal_id, r.status === "approved" ? docHref : "#/p/" + enc(pid) + "/review");
      } catch (err) {
        busy = false; [reject, editBtn].forEach(function (b) { if (b) b.disabled = false; });
        var code = ((err.data || {}).error || {}).code, reload = h("button", { type: "button", class: "secondary", onclick: function () { route(); } }, "Reload");
        if (code === "proposal_stale") { staleNow = true; showMsg(dmsg, "The document changed while you were reviewing (now v" + ((err.data.error || {}).current_revision || "?") + "). Reload to see it, then use Edit and approve."); dmsg.append(" ", reload); }
        else if (code === "proposal_closed") { staleNow = true; showMsg(dmsg, "This proposal was already " + ((err.data.error || {}).proposal_status || "closed") + "."); dmsg.append(" ", reload); }
        else showErr(dmsg, err);
        markStale();
      }
    }
    var decideCard = decide = h("section", { class: "card rv-decide", "aria-label": "Decision" }, h("label", { class: "rv-field" }, "Note for " + p.who, note), editArea,
      h("div", { class: "row" }, approve, editBtn, h("span", { class: "spacer" }), reject), dmsg);
  } else if (p.status === "pending" && p.mine) {
    decide = h("div", { class: "row" }, h("button", { type: "button", class: "secondary", onclick: async function (e) {
      e.target.disabled = true;
      try { await api("POST", path + "/withdraw", {}, { key: uuid() }); toast("Withdrawn"); location.hash = "#/p/" + enc(pid) + "/review"; }
      catch (err) { showErr(msg, err); e.target.disabled = false; }
    } }, "Withdraw"));
  }
  shell(projCrumbs(pid, [{ t: "Review", href: "#/p/" + enc(pid) + "/review" }, { t: rvTitle(p) }]), head, who, why, status, stale, msg, sections, decide);
}
// After a decision: the next waiting edit (in this project), else where it makes sense to land.
async function rvNextHash(pid, done, fallback) {
  try {
    var r = await api("GET", "/api/projects/" + enc(pid) + "/proposals");
    var next = r.proposals.filter(function (x) { return x.proposal_id !== done; })[0];
    if (next) return "#/p/" + enc(pid) + "/review/" + enc(next.proposal_id);
  } catch (e) {}
  return fallback;
}
function rvDrawDiff(into, d, full) {
  if (!d) { into.replaceChildren(h("pre", { class: "raw", tabindex: "0", text: full || "" })); return; }
  if (d.identical) { into.replaceChildren(h("p", { class: "muted", text: "No text changes." })); return; }
  if (d.too_many_lines) { into.replaceChildren(h("p", { class: "muted small", text: "Too many lines to compare here." }), h("pre", { class: "raw", tabindex: "0", text: full || "" })); return; }
  var cap = h("p", { class: "muted small", text: (d.from_revision ? "Compared with v" + d.from_revision + ": " : "") + d.added + " added, " + d.removed + " removed" + (d.truncated ? " (large change: partly shown)" : "") });
  var pre = h("div", { class: "vh-diff", role: "group", tabindex: "0", "aria-label": "Proposed changes" });
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
}
// Document page: banner when edits wait (linked straight to the edit when there is one), a status chip by the title,
// and the review setting in Details (owner): chosen, explained, then saved explicitly.
function rvDocumentUi(A, pid, aid, details, reload) {
  var rv = A.meta.review || null, out = { banner: null, chip: null };
  if (rv && rv.pending_proposals) {
    // Several: this document's History lists exactly its waiting edits (the project queue would mix in others).
    // If History couldn't load the list (A.rvPendingFailed), it goes to the project's Review queue instead.
    var link = h("a", { class: "btn secondary", href: "#/p/" + enc(pid) + "/review", onclick: function (e) {
      if (link.dataset.direct || A.rvPendingFailed) return;
      var t = [].filter.call(document.querySelectorAll('[role="tab"]'), function (x) { return x.textContent === "History"; })[0];
      if (t) { e.preventDefault(); t.click(); t.focus(); }
    } }, rv.pending_proposals === 1 ? "Review edit" : "Review edits");
    out.banner = h("div", { class: "callout info rv-banner" }, icon("doc"),
      h("span", null, h("strong", { text: plural(rv.pending_proposals, "edit") + " waiting for review." }), " Readers keep seeing the approved version."), link);
    if (rv.pending_proposals === 1) api("GET", "/api/projects/" + enc(pid) + "/proposals?artifact_id=" + enc(aid)).then(function (r) {
      if (r.proposals.length === 1) { link.href = "#/p/" + enc(pid) + "/review/" + enc(r.proposals[0].proposal_id); link.dataset.direct = "1"; }
    }).catch(function () {});
  }
  // Status chip: one container, redrawn from A.meta.review and A.rev after any change (mode save, mark, reload, autosave).
  out.chip = h("div", { class: "rv-chip-row", "aria-live": "polite" });
  out.redraw = function () {
    var r = A.meta.review;
    if (!r || r.mode === "off") { out.chip.replaceChildren(); out.chip.hidden = true; return; }
    var rr = r.reviewed_revision, behind = r.mode === "advisory" && rr !== A.rev, rev = A.rev;
    var parts = [h("span", { class: "rv-chip" + (behind ? " warn" : "") }, icon(behind ? "alert" : "check"),
      r.mode === "required" ? "Review required" : !behind ? "Reviewed (v" + rr + ")" : rr ? "Reviewed: v" + rr + " · current v" + rev + " not reviewed" : "Not reviewed yet")];
    if (behind && !A.meta.publisher) {
      var mk = h("button", { type: "button", class: "ghost small", onclick: async function () {
        mk.disabled = true;
        try {
          var x = await api("POST", A.base + "/revisions/" + rev + "/review", { decision: "approved" }, { key: uuid() });
          A.meta.review.reviewed_revision = x.reviewed_revision != null ? x.reviewed_revision : rev;
          toast("Version " + rev + " marked as reviewed"); out.redraw();
        } catch (err) { mk.disabled = false; toast("Couldn't mark it reviewed: " + err.message); }
      } }, "Mark v" + rev + " as reviewed");
      parts.push(mk);
    }
    out.chip.replaceChildren.apply(out.chip, parts); out.chip.hidden = false;
  };
  out.redraw();
  A.rvRedraw = out.redraw;
  if (A.meta.publisher) return out;
  var cur = rv ? rv.mode : "off";
  var radios = rvModeRadios("rv-mode-" + aid, cur, function () { sync(); });
  var rmsg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
  var save = h("button", { type: "button", hidden: true, onclick: async function () {
    var want = picked();
    if (want === "required" && !confirm("Require review? Version " + A.rev + " counts as reviewed; later edits by apps and agents wait for your approval.")) return;
    if (cur === "required" && want !== "required" && !confirm("Stop requiring review? Edits by apps and agents will go live without approval; edits already waiting stay pending.")) return;
    save.disabled = true;
    try {
      var r = await api("PUT", A.base + "/review-mode", { mode: want, expected_revision: A.rev });
      A.meta.review = r.review_mode === "off" && !(rv && rv.pending_proposals) ? undefined : { mode: r.review_mode, reviewed_revision: r.reviewed_revision, pending_proposals: rv ? rv.pending_proposals : 0 };
      rv = A.meta.review || null; cur = r.review_mode; sync(); out.redraw();
      showMsg(rmsg, "Review is now " + RV_MODE_LABELS[r.review_mode].split(" (")[0].toLowerCase() + "." + (r.review_mode === "off" && rv && rv.pending_proposals ? " Edits already waiting stay pending until you review them." : ""), true);
      if (reload) reload();
    } catch (err) {
      if (err.status === 409) { showMsg(rmsg, "The document changed (now v" + (((err.data || {}).error || {}).current_revision || "?") + "). Reloaded; check it and try again."); if (reload) reload(); }
      else showErr(rmsg, err);
    } finally { save.disabled = false; }
  } }, "Save review setting");
  function picked() { return rvPicked(radios, cur); }
  function sync() { save.hidden = picked() === cur; }
  // Details order: fields → Save details → its message ("Details saved.") → Review → ID line. The base UI puts the ID
  // line before the message, so the ID line moves below the Review section.
  var box = h("fieldset", { class: "rv-docmode" }, h("legend", { class: "rv-legend", text: "Review" }), radios, h("div", { class: "row" }, save), rmsg);
  var metaMsg = details.querySelector(":scope > p.msg"), idLine = details.querySelector(":scope > p.muted.small");
  if (metaMsg) metaMsg.after(box); else details.append(box);
  if (idLine) box.after(idLine);
  return out;
}
// History: edits waiting for review, listed above the versions with a direct Review link (the owner sees them all).
async function rvLoadPending(A, pid, aid) {
  A.rvPending = []; A.rvPendingFailed = null;
  if (!A.meta.review) return; // review off and nothing pending
  // Every page: "Review edits" sends the owner here for all of this document's waiting edits (bounded: 20 pages).
  var all = [], cursor = null, n = 0;
  try {
    do {
      var r = await api("GET", "/api/projects/" + enc(pid) + "/proposals?artifact_id=" + enc(aid) + (cursor ? "&cursor=" + enc(cursor) : ""));
      all = all.concat(r.proposals); cursor = r.next_cursor;
    } while (cursor && ++n < 20);
  } catch (e) { A.rvPendingFailed = e; }
  A.rvPending = all;
}
function rvPendingRows(A, pid, retry) {
  var ps = A.rvPending || [];
  if (A.rvPendingFailed) {
    var again = h("button", { type: "button", class: "secondary", onclick: function () { again.disabled = true; retry(); } }, icon("refresh"), "Try again");
    return [h("li", { class: "group", text: "Waiting for review" }),
      h("li", { class: "rv-load-err", role: "alert" }, h("span", { class: "grow", text: "Couldn't load the edits waiting for review: " + (A.rvPendingFailed.message || "error") + "." }), again,
        h("a", { class: "btn secondary", href: "#/p/" + enc(pid) + "/review" }, "Open project Review"))];
  }
  if (!ps.length) return [];
  return [h("li", { class: "group", text: "Waiting for review" })].concat(ps.map(function (p) {
    return h("li", { class: "vh-row rv-pending", dataset: { proposal: p.proposal_id } },
      h("span", { class: "vh-n", "aria-hidden": "true" }),
      h("span", { class: "grow" },
        h("span", { class: "vh-wholine" }, h("strong", { class: "vh-who", text: p.who }), rvViaBadge(p.via), p.client_info ? h("span", { class: "muted small", text: "via " + p.client_info }) : null),
        h("span", { class: "meta" }, p.stale ? h("span", { class: "rv-stale", text: "Outdated: document changed · " }) : null,
          [rvCap(rvChanges(p)), "proposed " + rvAgo(p.created_at), p.is_new ? null : "based on v" + p.base_revision].filter(Boolean).join(" · ")),
        p.change_note ? h("span", { class: "vh-note agent" }, "“" + p.change_note + "”") : null),
      h("span", { class: "vh-side" }, h("span", { class: "badge warnb", text: "Pending" }),
        h("a", { class: "btn secondary vh-open", href: "#/p/" + enc(pid) + "/review/" + enc(p.proposal_id) }, "Review", h("span", { class: "sr", text: " edit by " + p.who }))));
  }));
}
// New document form: review for this document, starting at the project's default for its type. Applied right after
// creating (owner only; the owner's first version is never gated).
function rvNewDocReview(pid, kindOf) {
  var sel = h("select", null, RV_MODES_UI.map(function (m) { return h("option", { value: m, text: RV_SHORT[m] }); }));
  // Not reserved while loading: most projects default to Off (no line), so only an Optional/Required default adds one.
  var help = h("p", { class: "muted small rv-newdoc-help", hidden: true });
  var s = null, touched = false;
  function def() { var k = kindOf(); return s && s.default !== "off" && (!s.kinds || s.kinds.indexOf(k) >= 0) ? s.default : "off"; }
  function sync() {
    var d = def();
    [].forEach.call(sel.options, function (o) { o.textContent = RV_SHORT[o.value] + (s && o.value === d ? " (project default)" : ""); });
    if (!touched) sel.value = d;
    explain();
  }
  // Off needs no explanation; Optional and Required say what they mean here too.
  function explain() { help.textContent = RV_DESC[sel.value]; help.hidden = sel.value === "off"; }
  sel.addEventListener("change", function () { touched = true; explain(); });
  // Its space is kept while the project default loads (no jump); the choice is offered only once the default is known.
  var label = h("label", { class: "rv-newdoc rv-wait" }, "Review", sel);
  api("GET", "/api/projects/" + enc(pid) + "/review-settings", undefined, { noAuthRedirect: true })
    .then(function (r) { s = r; sync(); label.classList.remove("rv-wait"); })
    .catch(function () { label.replaceChildren("Review", h("span", { class: "muted small", text: "Couldn't load review options. The project default will apply; you can change it in Details." })); label.classList.remove("rv-wait"); });
  return { label: label, help: help, sync: sync,
    // Sets the chosen mode if creation (project default at that moment, which may have changed since the form loaded) didn't.
    // Pinned to the revision this form created: turning on Required vouches for it, so an agent version saved in
    // between must never be vouched for unseen (the server answers 409 and the owner sets it from Details).
    apply: async function (aid, rev) {
      if (!s) return;
      var want = sel.value, a = "/api/projects/" + enc(pid) + "/artifacts/" + enc(aid);
      try {
        var cur = ((await api("GET", a)).artifact.review || {}).mode || "off";
        if (cur !== want) await api("PUT", a + "/review-mode", { mode: want, expected_revision: rev || 1 });
      } catch (err) { toast(err.status === 409 ? "Created. The document changed right away, so review wasn't set: set it from Details." : "Created. Review couldn't be set: " + err.message); }
    } };
}
var RV_DESC = {
  off: "Edits go live as usual.",
  advisory: "Edits go live as usual. Mark versions reviewed; agents can ask for the reviewed version.",
  required: "Edits by apps and agents wait for your approval; everyone else keeps reading the approved version."
};
// History: review marks on versions, and "Mark as reviewed" for advisory documents.
function rvHistoryBits(A, v, onDone) {
  var parts = [];
  if (v.review) parts.push(h("span", { class: "badge active rv-badge", title: "Reviewed by " + v.review.who + (v.review.note ? ": " + v.review.note : "") }, icon("check"), "Reviewed"));
  return parts;
}
function rvHistoryWho(v) {
  if (!v.review) return null;
  return h("span", { class: "meta rv-hist" }, (v.review.proposed_by ? "Edited from " + v.review.proposed_by + "'s proposal · " : "") + "approved by " + (v.review.who === "You" ? "you" : v.review.who) + (v.review.note ? " · “" + v.review.note + "”" : ""));
}
function rvMarkButton(A, v, done) {
  var rv = A.meta.review;
  // Only versions newer than the reviewed one: agents read the newest reviewed version, so marking an older one changes nothing.
  if (!rv || rv.mode !== "advisory" || (v.review && v.review.decision !== "rejected") || rv.reviewed_revision && v.rev <= rv.reviewed_revision) return null;
  return h("button", { type: "button", class: "secondary", onclick: async function (e) {
    e.target.disabled = true;
    try { var r = await api("POST", A.base + "/revisions/" + v.rev + "/review", { decision: "approved" }, { key: uuid() }); A.meta.review.reviewed_revision = r.reviewed_revision; toast("Version " + v.rev + " marked as reviewed"); done(); }
    catch (err) { e.target.disabled = false; toast("Couldn't mark it reviewed: " + err.message); }
  } }, icon("check"), "Mark as reviewed");
}
// Connections: "Can review" per project on apps, API keys and agent tokens (owner-granted, separate from edit).
// One request per Connections page, shared by its cards (not reused across pages: grants may have changed since).
var rvGrantCache = null, rvGrantAt = 0;
async function rvGrants(force) {
  if (Date.now() - rvGrantAt > 3000) force = true;
  if (!rvGrantCache || force) rvGrantAt = Date.now(), rvGrantCache = api("GET", "/api/review-grants", undefined, { noAuthRedirect: true }).then(function (r) { return r.review_grants; }).catch(function () { rvGrantCache = null; return null; });
  return rvGrantCache;
}
function rvReviewToggles(kind, id, projects, active) {
  var box = h("div", { class: "rv-grants" });
  if (!active || !projects.length) return box;
  rvGrants().then(function (gs) {
    if (!gs) { box.replaceChildren(h("p", { class: "muted small", text: "Couldn't load review permission. Reload to try again." })); return; }
    var rows = projects.map(function (p) {
      var on = gs.some(function (g) { return g.path_kind === kind && g.path_id === id && g.project_id === p.id; });
      var cb = h("input", { type: "checkbox", checked: on });
      cb.addEventListener("change", async function () {
        cb.disabled = true;
        try { await api("PUT", "/api/review-grants", { path_kind: kind, path_id: id, project_id: p.id, can_review: cb.checked }); await rvGrants(true); toast(cb.checked ? "Can review " + p.title : "Can no longer review " + p.title); }
        catch (err) { cb.checked = !cb.checked; toast(err.message); }
        finally { cb.disabled = false; }
      });
      return h("label", { class: "rv-grant" }, cb, "Can review " + p.title);
    });
    box.replaceChildren(h("details", { class: "rv-grants-d" }, h("summary", { text: "Review permission" + (rows.some(function (r) { return r.firstChild.checked; }) ? " · on" : "") }),
      h("p", { class: "muted small", text: "Lets this connection approve or reject other authors' edits in documents that require review. It never approves its own." }), rows));
  });
  return box;
}
