// ---------- nested folders (docs/folders.md; build-folders.mjs) ----------
// The project view browses one folder at a time: #/p/<pid> is the project root, #/p/<pid>/f/<folder_id> a folder.
// Breadcrumbs follow the folder path; subfolders are listed above the folder's documents. Search stays project-wide.
// New documents and uploads land in the folder being viewed. Rename, move and delete are owner actions.
var FD = { cache: {} };
function fdLoad(pid, force) {
  if (!force && FD.cache[pid]) return FD.cache[pid];
  FD.cache[pid] = api("GET", "/api/projects/" + enc(pid) + "/folders", undefined, { noAuthRedirect: true })
    .then(function (r) { return r.folders || []; }, function (e) { delete FD.cache[pid]; throw e; });
  return FD.cache[pid];
}
function fdInvalidate(pid) { delete FD.cache[pid]; }
function fdHref(pid, fid) { return "#/p/" + enc(pid) + (fid ? "/f/" + enc(fid) : ""); }
// Breadcrumb items for a folder: project, then each ancestor (by path prefix), then the folder itself.
function fdCrumbs(pid, folders, fid, extra) {
  var items = [{ t: projectTitles[pid] || pid, href: "#/p/" + enc(pid) }];
  var f = fid ? folders.filter(function (x) { return x.id === fid; })[0] : null;
  if (f) {
    var byPath = Object.create(null);
    folders.forEach(function (x) { byPath[x.path.toLowerCase()] = x; });
    var segs = f.path.split("/"), acc = "";
    segs.forEach(function (s, i) {
      acc = acc ? acc + "/" + s : s;
      var a = byPath[acc.toLowerCase()];
      items.push({ t: s, href: a ? fdHref(pid, a.id) : null });
    });
  }
  return items.concat(extra || []);
}
// A <select> of every folder of the project (paths), with "Project root" first.
function fdSelect(folders, value, exclude, label) {
  var sel = h("select", { "aria-label": label || "Folder" }, h("option", { value: "", text: "Project root" }));
  folders.forEach(function (f) {
    if (exclude && (f.id === exclude.id || f.path.toLowerCase().indexOf(exclude.path.toLowerCase() + "/") === 0)) return;
    sel.append(h("option", { value: f.id, text: f.path }));
  });
  sel.value = value || "";
  return sel;
}
// Folder header for the project view: a "Folder actions" group (New folder at the root; inside a folder New
// subfolder / Rename / Move / Delete folder), then the subfolder rows. On desktop the group is an inline labelled
// box; on narrow screens (CSS, max-width 760px) it collapses behind one "Folder actions" menu button.
function fdPanel(pid, fid, msg, onChange) {
  if (!ICONS.chevdown) ICONS.chevdown = ["M6 9l6 6 6-6"];
  // Folders change outside this view too (a Details move to a new path, agents, uploads, other tabs): every time a
  // project or folder view opens, it re-reads the tree once.
  fdInvalidate(pid);
  var box = h("div", { class: "fd-panel" });
  var sub = h("ul", { class: "list fd-sub", "aria-label": "Folders" });
  var form = h("div", { class: "card", hidden: true });
  var group = h("div", { class: "fd-group", role: "group", "aria-label": "Folder actions" }, h("span", { class: "fd-label", "aria-hidden": "true" }, "Folder actions"));
  var menuBtn = h("button", { type: "button", class: "secondary fd-menu-btn", "aria-expanded": "false", "aria-haspopup": "true",
    onclick: function (e) { e.stopPropagation(); bar.classList.contains("open") ? closeMenu() : openMenu(); } }, "Folder actions", icon("chevdown"));
  var bar = h("div", { class: "fd-actions" }, menuBtn, group);
  var cur = null;
  function items() { return Array.prototype.slice.call(group.querySelectorAll("button")); }
  function onDoc(e) { if (!group.contains(e.target)) closeMenu(); }
  function onKey(e) {
    if (e.key === "Escape") { closeMenu(); menuBtn.focus(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); var xs = items(), i = xs.indexOf(document.activeElement);
      xs[(i + (e.key === "ArrowDown" ? 1 : xs.length - 1)) % xs.length].focus();
    }
  }
  function openMenu() { bar.classList.add("open"); menuBtn.setAttribute("aria-expanded", "true"); document.addEventListener("click", onDoc); document.addEventListener("keydown", onKey); var f = items()[0]; if (f) f.focus(); }
  function closeMenu() { bar.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); }
  // Every action closes the narrow-screen menu first.
  function act(fn) { return function (e) { closeMenu(); return fn(e); }; }
  function closeForm() { form.hidden = true; form.replaceChildren(); }
  function nameForm(title, initial, submitText, onSubmit) {
    closeForm();
    var name = h("input", { type: "text", maxLength: 80, required: true, value: initial || "", "aria-label": title });
    var btn = h("button", { type: "submit" }, submitText);
    form.append(h("form", { class: "row", onsubmit: async function (e) {
      e.preventDefault(); var v = name.value.trim(); if (!v) return;
      btn.disabled = true;
      try { await onSubmit(v); closeForm(); } catch (err) { showErr(msg, err); }
      btn.disabled = false;
    } }, h("label", null, title, name), btn, h("button", { type: "button", class: "secondary", onclick: closeForm }, "Cancel")));
    form.hidden = false; name.focus();
  }
  var newBtn = h("button", { type: "button", class: "secondary", onclick: act(function () {
    nameForm("New folder name", "", "Create folder", async function (v) {
      var r = await api("POST", "/api/projects/" + enc(pid) + "/folders", fid ? { name: v, parent_id: fid } : { name: v }, { key: uuid() });
      fdInvalidate(pid); showMsg(msg, "Created folder \u201C" + r.path + "\u201D.", true); onChange();
    });
  }) }, icon("plus"), fid ? "New subfolder" : "New folder");
  group.append(newBtn);
  if (fid) {
    group.append(
      h("button", { type: "button", class: "secondary", onclick: act(function () {
        if (!cur) return;
        nameForm("Rename folder", cur.name, "Rename", async function (v) {
          var r = await api("PATCH", "/api/projects/" + enc(pid) + "/folders/" + enc(fid), { name: v, expected_path: cur.path }, { key: uuid() });
          fdInvalidate(pid); showMsg(msg, "Renamed to \u201C" + r.path + "\u201D.", true); onChange();
        });
      }) }, "Rename"),
      h("button", { type: "button", class: "secondary", onclick: act(async function () {
        if (!cur) return;
        closeForm();
        var all = await fdLoad(pid);
        var sel = fdSelect(all, cur.parent_id, cur, "Move into");
        var btn = h("button", { type: "submit" }, "Move");
        form.append(h("form", { class: "row", onsubmit: async function (e) {
          e.preventDefault(); btn.disabled = true;
          try {
            var r = await api("PATCH", "/api/projects/" + enc(pid) + "/folders/" + enc(fid), { parent_id: sel.value || "root", expected_path: cur.path }, { key: uuid() });
            fdInvalidate(pid); closeForm(); showMsg(msg, "Moved to \u201C" + r.path + "\u201D.", true); onChange();
          } catch (err) { showErr(msg, err); }
          btn.disabled = false;
        } }, h("label", null, "Move into", sel), btn, h("button", { type: "button", class: "secondary", onclick: closeForm }, "Cancel")));
        form.hidden = false; sel.focus();
      }) }, "Move"),
      h("button", { type: "button", class: "danger", onclick: act(async function () {
        if (!cur || !confirm("Delete the empty folder \u201C" + cur.path + "\u201D?")) return;
        try {
          await api("DELETE", "/api/projects/" + enc(pid) + "/folders/" + enc(fid), undefined, { key: uuid() });
          fdInvalidate(pid); toast("Deleted folder " + cur.path); location.hash = fdHref(pid, cur.parent_id);
        } catch (err) { showErr(msg, err); }
      }) }, "Delete folder"));
  }
  box.append(bar, form, sub);
  return {
    el: box,
    // Re-render subfolders of fid; resolves the current folder (or null at the root) for the caller.
    render: async function (term) {
      var all = await fdLoad(pid);
      cur = fid ? all.filter(function (x) { return x.id === fid; })[0] || null : null;
      if (fid && !cur) throw Object.assign(new Error("Folder not found"), { status: 404 });
      sub.replaceChildren();
      var kids = all.filter(function (x) { return (x.parent_id || null) === (fid || null); });
      sub.hidden = !!term || !kids.length;
      kids.forEach(function (f) {
        var n = f.item_count + f.folder_count;
        sub.append(h("li", { class: "link" }, h("span", { class: "ficon-sm", "aria-hidden": "true" }, icon("folder")),
          h("div", { class: "grow" }, rowLink(fdHref(pid, f.id), f.name), h("span", { class: "meta", text: n ? (f.folder_count ? f.folder_count + " folder" + (f.folder_count === 1 ? "" : "s") + (f.item_count ? " · " : "") : "") + (f.item_count ? f.item_count + " item" + (f.item_count === 1 ? "" : "s") : "") : "Empty" })),
          h("span", { class: "badge", text: "Folder" })));
      });
      return { all: all, cur: cur, kids: kids };
    }
  };
}
// Folder path suggestions for a text input (the Details editor). Typing a new path creates it on save.
var fdListSeq = 0;
function fdDatalist(pid, input) {
  var id = "fd-paths-" + (++fdListSeq);
  var dl = h("datalist", { id: id });
  input.setAttribute("list", id);
  input.setAttribute("placeholder", "e.g. Reports/2026 (blank = project root)");
  fdLoad(pid).then(function (all) { all.forEach(function (f) { dl.append(h("option", { value: f.path })); }); }, function () {});
  return dl;
}
// Document breadcrumbs: project / folder path (each folder linked) / document title.
function fdArtifactCrumbs(pid, meta) {
  if (!meta || !meta.folder) return;
  fdLoad(pid).then(function (all) {
    var f = all.filter(function (x) { return x.path.toLowerCase() === meta.folder.toLowerCase(); })[0];
    if (f && location.hash.indexOf(enc(meta.id)) >= 0) setCrumbs(fdCrumbs(pid, all, f.id, [{ t: meta.title }]));
  }, function () {});
}
