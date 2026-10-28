function searchEntry() {
  var link = h("a", { class: "btn", href: "#/search", hidden: true }, icon("search"), "Search library");
  api("GET", "/api/search/status").then(function (r) { link.hidden = !r.ready; }).catch(function () {});
  return link;
}
// ---------- global ranked search ----------
async function viewSearch() {
  var alive = true, seq = 0, cursor = null, active = null;
  S.cleanups.push(function () { alive = false; seq++; });
  shell([{t:"Home",href:"#/"},{t:"Search"}], h("p", {role:"status",text:"Checking search availability…"}));
  try {
    var availability = await api("GET", "/api/search/status");
    if (!alive) return;
    if (!availability.ready) {
      shell([{t:"Home",href:"#/"},{t:"Search"}], stateBox("", "search", "Search is being prepared", "An administrator needs to finish indexing existing documents. Refresh after indexing is complete."));
      return;
    }
  } catch(e) { if (alive) shell([{t:"Search"}], stateBox("error", "alert", "Search unavailable", "Refresh to check again.")); return; }

  var query = h("input", { type: "search", name: "query", required: true, maxLength: 200, placeholder: "Search titles and stored text", "aria-label": "Search library", class: "grow" });
  var project = h("select", { name: "project", "aria-label": "Project filter" }, h("option", { value: "", text: "All projects" }));
  var submit = h("button", { type: "submit" }, icon("search"), "Search");
  var status = h("p", { role: "status", "aria-live": "polite", class: "muted" });
  var list = h("ol", { class: "search-results", "aria-label": "Search results" });
  var more = h("button", { type: "button", class: "secondary", hidden: true, onclick: function () { load(true); } }, "More results");
  var form = h("form", { class: "search-form card", role: "search", onsubmit: function (e) { e.preventDefault(); load(false); } },
    h("label", { class: "sr", htmlFor: "global-search-query", text: "Search library" }), query,
    h("label", { class: "small muted", htmlFor: "global-search-project", text: "Project" }), project, submit);
  query.id = "global-search-query"; project.id = "global-search-project";
  project.addEventListener("change", function () { if (query.value.trim()) load(false); });
  function highlight(text, words) {
    var fragment = document.createDocumentFragment(), terms = words.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) || [];
    if (!terms.length) { fragment.append(document.createTextNode(text)); return fragment; }
    var re = new RegExp("(" + terms.join("|") + ")", "giu"), last = 0, match;
    while ((match = re.exec(text))) { fragment.append(document.createTextNode(text.slice(last, match.index)), h("mark", { text: match[0] })); last = match.index + match[0].length; }
    fragment.append(document.createTextNode(text.slice(last))); return fragment;
  }
  async function load(append) {
    var my = ++seq, requested = append ? active : { query: query.value.trim(), project: project.value };
    if (!requested || !requested.query) return;
    if (!append) { active = requested; cursor = null; list.replaceChildren(); }
    more.hidden = true; submit.disabled = true; list.setAttribute("aria-busy", "true"); status.textContent = "Searching…";
    var params = new URLSearchParams({ query: requested.query });
    if (requested.project) params.set("project_ids", requested.project);
    if (append && cursor) params.set("cursor", cursor);
    try {
      var result = await api("GET", "/api/search?" + params);
      if (!alive || my !== seq) return;
      result.results.forEach(function (r) {
        list.append(h("li", { class: "card search-hit" },
          h("a", { class: "search-title", href: r.preview_url || r.web_url || "/p/" + enc(r.project_id) + "/a/" + enc(r.artifact_id) + "/preview?v=" + r.revision }, highlight(r.title, requested.query)),
          h("p", { class: "meta", text: r.project_title + " · " + kindLabel(r) + " · Version " + r.revision + " · " + fmtDate(r.updated_at) }),
          h("p", { class: "search-snippet" }, highlight(r.snippet, requested.query)),
          !r.indexed_body ? h("p", { class: "muted small", text: "Title match only · No indexed body" }) : null));
      });
      cursor = result.next_cursor; more.hidden = !result.has_more;
      status.textContent = list.children.length ? list.children.length + " results shown" + (result.has_more ? " · More available" : "") : "No matches. Try fewer words or choose another project.";
    } catch (e) {
      if (!alive || my !== seq) return;
      status.textContent = "Search couldn't load. " + (e.message || "Try again.");
      if (append) more.hidden = false;
    } finally { if (alive && my === seq) { submit.disabled = false; list.removeAttribute("aria-busy"); } }
  }
  shell([{ t: "Home", href: "#/" }, { t: "Search" }], pageHead("Search library", { sub: "Find documents across your projects. Searches stored words in titles and text; all words must match. This does not interpret questions." }), form, status, list, more);
  status.textContent = "Enter words to search all your projects.";
  try {
    var projects = await api("GET", "/api/projects");
    if (!alive) return;
    projects.projects.forEach(function (p) { project.append(h("option", { value: p.id, text: p.title })); });
  } catch (e) { if (alive) status.textContent = "Project filters couldn't load. Search all projects or refresh to retry."; }
  if (alive) query.focus();
}
