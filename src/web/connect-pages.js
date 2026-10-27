// Connect (OAuth consent) pages: readable source for build-consent-fixes.mjs, which splices each region below
// into the pinned OAuth server module (// src/oauth/server.ts) of src/index.js. Not loaded on its own: the code runs
// in that module's scope (esc, page, errorPage, nowMs, nowIso, randomId, sha, SCOPES, NEW_PROJECT_SLOTS,
// liveConnection, oidcConfig, ...). Pages have no scripts (CSP default-src 'none'); interactivity is CSS only.
// Each "//== region: <name>" section replaces exactly one hash-pinned region (see build-consent-fixes.mjs).
//== region: toClient
function toClient(location, headers, clientHost) {
  const u = new URL(location);
  if (!/^https?:$/.test(u.protocol)) return errorPage("This app's callback address is not allowed to connect.");
  const href = esc(location);
  const denied = u.searchParams.has("error");
  return page(denied ? "Cancelled" : "Connected", `<meta http-equiv="refresh" content="0;url=${href}">
${cxShell(`<div class="state ${denied ? "neutral" : "on"}"><span class="big" aria-hidden="true">${cxIcon(denied ? "x" : "check")}</span>
<h1>${denied ? "Cancelled" : "Connected"}</h1><p class="lede">${denied ? "Nothing was shared. " : ""}Taking you back to <strong>${esc(clientHost)}</strong>\u2026</p>
<p class="fine"><a href="${href}">Continue to ${esc(clientHost)}</a> if nothing happens.</p></div>`, !denied)}`, headers, 200);
}
//== region: helpers
// ---- connect page building blocks ----
function cxIcon(name) {
  const P = {
    check: "M20 6 9 17l-5-5",
    x: "M18 6 6 18M6 6l12 12",
    alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
    back: "M9 10l-5 5 5 5M20 4v7a4 4 0 0 1-4 4H4",
    plus: "M12 5v14M5 12h14",
    chev: "M9 6l6 6-6 6",
    next: "M5 12h14M13 6l6 6-6 6",
    redo: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
    lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z"
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${P[name]}"/></svg>`;
}
function cxShell(inner, foot = true) {
  return `<header class="top"><span class="mark" aria-hidden="true"></span><span>Agent Library</span></header>
<main class="card">${inner}</main>${foot ? `
<p class="foot">${cxIcon("lock")}You can disconnect apps any time in Agent Library settings.</p>` : ""}`;
}
// A fixable mistake, shown above the form it belongs to.
function cxErr(msg) {
  return msg ? `<div class="callout bad" role="alert">${cxIcon("alert")}<div>${esc(msg)}</div></div>` : "";
}
// The app's initial on a tile coloured from its name, joined to the Library mark.
function cxPair(name) {
  const s = String(name ?? "").trim();
  const ch = (s.match(/[A-Za-z0-9]/) ?? ["?"])[0].toUpperCase();
  let hue = 0;
  for (const c of s) hue = (hue * 31 + c.codePointAt(0)) % 360;
  return `<div class="pair" aria-hidden="true"><span class="av" style="--h:${hue}">${esc(ch)}</span><span class="link"><i></i><i></i><i></i></span><span class="mark lg"></span></div>`;
}
function cxChip(kind, icon, text) {
  return `<span class="chip${kind ? " " + kind : ""}">${cxIcon(icon)}<span>${text}</span></span>`;
}
function cxDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const opts = { month: "short", day: "numeric", timeZone: "UTC" };
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}
// Projects whose titles collide also show their id.
function cxDupes(list) {
  const n = /* @__PURE__ */ new Map();
  for (const p of list) n.set(p.title.trim().toLowerCase(), (n.get(p.title.trim().toLowerCase()) ?? 0) + 1);
  return (p) => n.get(p.title.trim().toLowerCase()) > 1;
}
// Enter in a text field submits with the form's first submit button. This off-screen copy of Connect comes first, so
// Enter connects (not cancels) while the visible buttons keep their on-screen order for Tab.
var CX_ENTER = '<button name="decision" value="approve" class="enter" tabindex="-1" aria-hidden="true">Connect</button>';
function cxBar(lead) {
  return `<div class="bar">${lead}<button name="decision" value="deny">Cancel</button><button name="decision" value="approve" class="primary">Connect</button></div>`;
}
function cxStart(handle) {
  return `<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(handle)}"><input type="hidden" name="step" value="signin">
<div class="bar"><button name="decision" value="deny">Cancel</button><button name="decision" value="approve" class="primary">Continue${cxIcon("next")}</button></div></form>`;
}
function clientFacts(d) {
  const chips = [
    d.clientDomain ? cxChip("ok", "check", `Verified \u00B7 ${esc(d.clientDomain)}`) : cxChip("warn", "alert", "Name not verified"),
    cxChip("", "back", `Returns to ${esc(d.redirectHost)}`)
  ];
  return `<div class="chips">${chips.join("")}</div>${d.redirectIsLoopback ? `<div class="callout warn">${cxIcon("alert")}<div><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it.</div></div>` : ""}`;
}
// The owner's most recent live connection for this exact client_id. Never matched by name: client names are
// self-asserted, so a look-alike registration must not inherit another app's access or be offered its replacement.
async function cxPreviousConnection(env, principalId, request) {
  const row = await env.DB.prepare(
    `SELECT id FROM oauth_connections WHERE owner_principal_id = ? AND client_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(principalId, request.clientId, nowMs()).first();
  return row ? await liveConnection(env, row.id) : null;
}
function cxSeg(name, label, value, withNone) {
  const opts = (withNone ? [["none", "Off"]] : []).concat([["read", "Read"], ["write", "Edit"]]);
  return `<span class="seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, t]) => `<label><input type="radio" name="${esc(name)}" value="${v}"${v === value ? " checked" : ""}><span>${t}</span></label>`).join("")}</span>`;
}
// values: the submitted form when re-rendering after a fixable mistake (choices kept), else null.
function cxGrantPage(d, email, projects, prev, consent, values = null, error = "", status = 200) {
  const was = new Map((prev?.projects ?? []).map((p) => [p.id, p.can_write ? "write" : "read"]));
  const pick = (name, fallback) => values ? String(values.get(name) ?? fallback) : fallback;
  const dupe = cxDupes(projects);
  const rows = projects.map((p) => `<li class="proj"><span class="pname">${esc(p.title)}${dupe(p) ? ` <small>${esc(p.id)}</small>` : ""}</span>${cxSeg(`access:${p.id}`, `Access to ${p.title}`, pick(`access:${p.id}`, values ? "none" : was.get(p.id) ?? "none"), true)}</li>`).join("");
  // Rows reveal one at a time: every filled row stays visible, plus exactly one empty row (CSS).
  const fresh = Array.from({ length: NEW_PROJECT_SLOTS }, (_, k) => {
    const sfx = k === 0 ? "" : `_${k + 1}`;
    return `<div class="newp"><input type="text" name="new_title${sfx}" maxlength="200" pattern=".*\\S.*" value="${esc(pick(`new_title${sfx}`, ""))}" placeholder="${rows ? "New project (optional)" : "Project name"}" aria-label="New project ${k + 1} name">${cxSeg(`new_access${sfx}`, `Access to new project ${k + 1}`, pick(`new_access${sfx}`, "read"), false)}</div>`;
  }).join("");
  const welcome = prev && !values ? `<div class="callout info">${cxIcon("redo")}<div><strong>Welcome back.</strong> Access from your earlier connection (${esc(cxDate(prev.created_at))}) is already picked. Adjust anything below.</div></div>` : "";
  const replaceOn = values ? values.get("replace") === prev?.id : true;
  const replace = prev ? `<label class="check"><input type="checkbox" name="replace" value="${esc(prev.id)}"${replaceOn ? " checked" : ""}><span><strong>Replace the earlier connection</strong><small>Its old sign-in stops working as soon as you click Connect, so you don't end up with duplicates.</small></span></label>` : "";
  return page("Choose what to share", cxShell(`${cxPair(d.clientName)}
<h1>Choose what ${esc(d.clientName)} can use</h1><p class="lede">Signed in as ${esc(email)}</p>
${clientFacts(d)}${welcome}${cxErr(error)}
<form method="post" action="/authorize" class="grant"><input type="hidden" name="handle" value="${esc(consent.handle)}"><input type="hidden" name="step" value="grant">${CX_ENTER}
<section class="sec"><h2>Projects</h2>${rows ? `<ul class="list">${rows}</ul>` : ""}
<h3 class="sub">${cxIcon("plus")}${rows ? "Or create a project" : "Create a project to share"}</h3>${fresh}</section>
${replace}
<p class="fine"><strong>Read</strong>: view documents and files (images, PDFs, videos) and their history, and download files. <strong>Edit</strong>: also create and change documents, and upload new files and new versions of files. Comments, trash and settings are never shared.</p>
${cxBar('<span class="count"><span class="some"><b class="n"></b> selected</span><span class="none">Pick at least one project</span></span>')}</form>`), consent.headers, status);
}
//== region: authorizeGet
async function authorizeGet(req, env, as, origin) {
  const oauth = as.getOAuthApi(env);
  const parsed = await oauth.parseAuthRequest(req);
  if (!parsed.codeChallenge || parsed.codeChallengeMethod !== "S256")
    throw new AuthorizationError("invalid_request", { description: "PKCE S256 is required", redirectUri: parsed.redirectUri, state: parsed.state, issuer: parsed.issuer });
  const pubCheck = await checkPublisherRequest(env, parsed, origin);
  if (pubCheck?.error) return errorPage(pubCheck.error);
  if (pubCheck?.app) {
    if (!parsed.state) return errorPage("state is required.");
    // Optional destination hint from the app (agentlib_project / agentlib_folder). It only pre-fills the owner's
    // choices; keyed by the request's unique PKCE challenge so it survives the owner sign-in round trip.
    const hint = cxPublishHint(new URL(req.url).searchParams);
    if (hint) await env.OAUTH_KV.put(`pubhint:${await sha(parsed.clientId + " " + parsed.codeChallenge)}`, JSON.stringify(hint), { expirationTtl: 900 });
    const consent2 = await oauth.beginConsent(parsed);
    const targets2 = [new URL(oidcConfig(env).authorization).origin];
    const app = pubCheck.app;
    return page("Connect an app to Agent Library", cxShell(`${cxPair(app.display_name)}
<h1>Connect ${esc(app.display_name)}</h1><p class="lede">It wants to publish its own files to your library. Sign in to choose where they go. Nothing is shared yet.</p>
<div class="chips">${cxChip("ok", "check", "Registered by you")}${cxChip("", "back", `Returns to ${esc(new URL(parsed.redirectUri).host)}`)}</div>
${cxStart(consent2.handle)}`), consent2.headers, 200, targets2);
  }
  if (!allowedRedirect(parsed.redirectUri)) return errorPage("This app's callback address is not allowed to connect.");
  const details = await oauth.describeConsent(parsed);
  const consent = await oauth.beginConsent(parsed);
  const targets = [new URL(oidcConfig(env).authorization).origin];
  return page("Connect an app to Agent Library", cxShell(`${cxPair(details.clientName)}
<h1>Connect ${esc(details.clientName)}</h1><p class="lede">It wants to use documents in your library. Sign in to pick which projects. Nothing is shared yet.</p>
${clientFacts(details)}
${cxStart(consent.handle)}`), consent.headers, 200, targets);
}
//== region: grantSave
  if (step === "grant") {
    const sess = await env.OAUTH_KV.get(`consentctx:${await sha(handle)}`, "json");
    if (!sess) return errorPage("This consent page expired. Start connecting again from the app.");
    if (sess.app_client_id) return errorPage("This app connects as a publisher. Start connecting again from the app.");
    const owned = await env.DB.prepare("SELECT id, title FROM projects WHERE owner_id = ? ORDER BY created_at LIMIT 500").bind(sess.principal_id).all();
    // A fixable mistake re-renders the page with the owner's choices kept: the consent handle is still unused, and
    // the browser's Back button can't help (the sign-in callback that rendered the page is single-use).
    const retry = /* @__PURE__ */ __name((msg) => sess.view ? cxGrantPage(sess.view.d, sess.view.email, owned.results, sess.view.prev, { handle, headers: new Headers() }, form, msg, 400) : errorPage(msg), "retry");
    const chosen = [];
    for (const p of owned.results) {
      const a = String(form.get(`access:${p.id}`) ?? "none");
      if (a === "read" || a === "write") chosen.push({ id: p.id, write: a === "write" });
      else if (a !== "none") return retry("Unexpected access choice. Pick Off, Read or Edit for each project.");
    }
    const seenTitles = /* @__PURE__ */ new Set();
    for (let i = 1; i <= NEW_PROJECT_SLOTS; i++) {
      const sfx = i === 1 ? "" : `_${i}`;
      const newTitle = String(form.get(`new_title${sfx}`) ?? "").trim();
      const newAccess = String(form.get(`new_access${sfx}`) ?? "");
      if (!newTitle) continue;
      if (newTitle.length > 200) return retry("A new project name is too long (200 characters max).");
      if (newAccess !== "read" && newAccess !== "write") return retry(`Choose Read or Edit for new project \u201C${newTitle.slice(0, 60)}\u201D.`);
      if (seenTitles.has(newTitle.toLowerCase())) return retry(`\u201C${newTitle.slice(0, 60)}\u201D is listed twice. Remove the duplicate.`);
      seenTitles.add(newTitle.toLowerCase());
      chosen.push({ id: randomId("prj"), write: newAccess === "write", isNew: newTitle });
    }
    if (!chosen.length) return retry("Pick at least one project, or create one.");
    if (chosen.length > MAX_CONN_PROJECTS) return retry(`Pick at most ${MAX_CONN_PROJECTS} projects.`);
    const anyWrite = chosen.some((c) => c.write);
    const scope = anyWrite ? [SCOPES.read, SCOPES.write, SCOPES.offline] : [SCOPES.read, SCOPES.offline];
    // Replacing is offered only for the connection the consent page showed (stored server-side with the handle).
    // The predecessor must still be live: if another tab already replaced it, connecting here would leave two.
    const replaceId = String(form.get("replace") ?? "");
    let replaced = null;
    if (replaceId) {
      if (replaceId !== sess.replace_candidate) return retry("That earlier connection can't be replaced.");
      replaced = await env.DB.prepare("SELECT id, project_id FROM oauth_connections WHERE id = ? AND owner_principal_id = ? AND revoked_at IS NULL").bind(replaceId, sess.principal_id).first();
      // Audit the revoke in every project it covered, like revoking from settings shows per project.
      if (replaced) replaced.projects = (await env.DB.prepare("SELECT project_id FROM oauth_connection_projects WHERE connection_id = ?").bind(replaced.id).all()).results.map((r) => r.project_id);
      if (!replaced) return errorPage("That earlier connection was already replaced, perhaps in another tab. Start connecting again from the app.");
    }
    const approved = await oauth.approveConsent(req, handle, { scope });
    await env.OAUTH_KV.delete(`consentctx:${await sha(handle)}`);
    const ar = approved.request;
    const client = await oauth.lookupClient(ar.clientId);
    const connectionId = randomId("oac", 18);
    const at = nowIso(), rid = randomId("req", 9);
    const audit2 = /* @__PURE__ */ __name((projectId, action, object, result) => env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(at, sess.principal_id, projectId, action, object, result, rid), "audit");
    // Replacing claims the predecessor first, in the same transaction as the new rows. Revoking before the app
    // redeems its code is deliberate (fails closed): if the app never finishes, the new connection still exists, so
    // connecting again from the same app prefills it and offers to replace it.
    const claim = replaced ? env.DB.prepare("UPDATE oauth_connections SET revoked_at = ? WHERE id = ? AND owner_principal_id = ? AND revoked_at IS NULL").bind(nowMs(), replaced.id, sess.principal_id) : null;
    // Audited only if this request's claim won. The batch runs in order in one transaction, so changes() is 1 right
    // after a winning claim and stays 1 through each audit insert; a losing tab's claim changes 0 rows, so it
    // writes no "replaced" rows (no audits scan needed).
    const auditReplaced = /* @__PURE__ */ __name((pid) => env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id)
      SELECT ?, ?, ?, 'oauth.revoke', ?, 'ok:replaced', ? WHERE changes() = 1`).bind(at, sess.principal_id, pid, replaced.id, rid), "auditReplaced");
    const res = await env.DB.batch([
      ...claim ? [claim, ...(replaced.projects.length ? replaced.projects : [replaced.project_id]).map(auditReplaced)] : [],
      ...chosen.filter((c) => c.isNew).flatMap((c) => [
        env.DB.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)").bind(c.id, sess.principal_id, c.isNew, at),
        audit2(c.id, "project.create", c.id, "ok:oauth-consent")
      ]),
      // file_access = 1 only when the page the owner saw offered files (offered: "files", set when it was shown). A page
      // opened before files were offered keeps documents only (migration 0013; build-file-tools-fixes.mjs).
      env.DB.prepare(`INSERT INTO oauth_connections (id, owner_principal_id, project_id, client_id, client_name, redirect_uri, resource, can_read, can_write, file_access, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).bind(connectionId, sess.principal_id, chosen[0].id, ar.clientId, (client?.clientName ?? ar.clientId).slice(0, 200), ar.redirectUri, `${origin}/mcp`, anyWrite ? 1 : 0, sess.offered === "files" ? 1 : 0, at, nowMs() + CONNECTION_TTL_MS),
      ...chosen.flatMap((c) => [
        env.DB.prepare("INSERT INTO oauth_connection_projects (connection_id, project_id, can_write) VALUES (?, ?, ?)").bind(connectionId, c.id, c.write ? 1 : 0),
        audit2(c.id, "oauth.connect", connectionId, c.write ? "ok:read+write" : "ok:read")
      ])
    ]);
    // Lost a race with another tab replacing the same connection: withdraw this one before any code is issued, so
    // exactly one live successor remains. (New projects made here stay; they are the owner's and empty.)
    if (claim && !res[0].meta.changes) {
      await env.DB.batch([
        env.DB.prepare("UPDATE oauth_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowMs(), connectionId),
        audit2(chosen[0].id, "oauth.revoke", connectionId, "ok:lost-replace-race")
      ]);
      return errorPage("That earlier connection was just replaced in another tab. Use that connection, or start again from the app.");
    }
    if (replaced) {
      try {
        const old = await oauth.listUserGrants(replaced.id);
        for (const g of old.items) await oauth.revokeGrant(g.id, replaced.id);
      } catch {
        console.log("oauth_replace_grant_pending");
      }
    }
//== region: grantPage
  const details = await oauth.describeConsent(resumed.request);
  const consent = await oauth.beginConsent(resumed.request);
  const prev = await cxPreviousConnection(env, principalId, resumed.request);
  // view: what the page needs to re-render itself after a fixable mistake (owner-only data, same 10-minute TTL).
  const view = { email: ident.email, d: { clientName: details.clientName, clientDomain: details.clientDomain, redirectHost: details.redirectHost, redirectIsLoopback: details.redirectIsLoopback },
    prev: prev ? { id: prev.id, created_at: prev.created_at, projects: prev.projects.map((p) => ({ id: p.id, can_write: p.can_write })) } : null };
  await env.OAUTH_KV.put(`consentctx:${await sha(consent.handle)}`, JSON.stringify({ principal_id: principalId, view, offered: "files", ...prev ? { replace_candidate: prev.id } : {} }), { expirationTtl: 600 });
  for (const [k, v] of resumed.headers) if (k.toLowerCase() === "set-cookie") consent.headers.append("set-cookie", v);
  return cxGrantPage(details, ident.email, projects.results, prev, consent);
}
//== region: publishConsentPage
async function publishConsentPage(env, oauth, resumed, app, principalId, email, projects) {
  const consent = await oauth.beginConsent(resumed.request);
  // Suggested destination: the app's own hint for this request wins over the owner-set registration default.
  const hintKey = `pubhint:${await sha(resumed.request.clientId + " " + resumed.request.codeChallenge)}`;
  const reqHint = resumed.request.codeChallenge ? await env.OAUTH_KV.get(hintKey, "json") : null;
  if (reqHint) await env.OAUTH_KV.delete(hintKey);
  const suggest = { project: reqHint?.project ?? app.suggested_project ?? null, folder: reqHint?.folder ?? app.suggested_folder ?? null };
  await env.OAUTH_KV.put(`consentctx:${await sha(consent.handle)}`, JSON.stringify({ principal_id: principalId, app_client_id: app.id, email, suggest }), { expirationTtl: 600 });
  for (const [k, v] of resumed.headers) if (k.toLowerCase() === "set-cookie") consent.headers.append("set-cookie", v);
  return cxPublishPage(env, app, principalId, email, projects, consent, null, "", 200, suggest);
}
// App-supplied destination hint: bounded, plain strings only; anything invalid is ignored (never an error).
function cxPublishHint(params) {
  const clean = (v, max) => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.length <= max && !/[\/\u0000-\u001f\u007f]/.test(t) ? t : null;
  };
  const project = clean(params.get("agentlib_project"), 80), folder = clean(params.get("agentlib_folder"), 80);
  return project || folder ? { project, folder } : null;
}
// A suggested project matches by id, else by title (case-insensitive); otherwise the first project.
function cxSuggestedProject(projects, hint) {
  if (!hint) return null;
  const k = hint.trim().toLowerCase();
  return projects.find((p) => p.id === hint) ?? projects.find((p) => p.title.trim().toLowerCase() === k) ?? null;
}
// values/error: the submitted form and the mistake to show when re-rendering (choices kept).
async function cxPublishPage(env, app, principalId, email, projects, consent, values = null, error = "", status = 200, suggest = null) {
  const pick = (n, fallback) => values ? String(values.get(n) ?? fallback) : fallback;
  const name = app.display_name;
  if (!projects.length) return page("Choose where this app publishes", cxShell(`${cxPair(name)}<div class="state neutral"><h1>Create a project first</h1>
<p class="lede">${esc(name)} publishes into one of your projects, and you don't have any yet. Create one in Agent Library, then connect again from the app.</p></div>`), consent.headers, status);
  const chosenProject = pick("project_id", (cxSuggestedProject(projects, suggest?.project) ?? projects[0]).id);
  const dupe = cxDupes(projects);
  const projOpts = projects.map((p) => `<option value="${esc(p.id)}"${p.id === chosenProject ? " selected" : ""}>${esc(p.title)}${dupe(p) ? ` (${esc(p.id)})` : ""}</option>`).join("");
  const folders = await env.DB.prepare(`SELECT f.id, f.name, f.project_id FROM folders f JOIN projects p ON p.id = f.project_id WHERE p.owner_id = ? ORDER BY f.name_key LIMIT 500`).bind(principalId).all();
  const byProject = /* @__PURE__ */ new Map();
  for (const f of folders.results) byProject.set(f.project_id, [...byProject.get(f.project_id) ?? [], f]);
  // One folder field for all projects (a hidden control still submits, and /authorize caps bodies at 16 KiB), with
  // one labelled group per project; CSS shows only the chosen project's group. The server re-checks the pairing.
  // A suggested folder that already exists in the suggested project is pre-selected instead of "New folder".
  const suggestedFolder = suggest?.folder ? (byProject.get(chosenProject) ?? []).find((f) => f.name.trim().toLowerCase() === suggest.folder.toLowerCase()) : null;
  const cur = pick("destination", suggestedFolder ? `folder:${suggestedFolder.id}` : "new");
  const opt = (v, t) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(t)}</option>`;
  const folderGroups = projects.map((p, i) => byProject.has(p.id) ? `<optgroup label="Folders in ${esc(p.title)}" data-i="${i}">${byProject.get(p.id).map((f) => opt(`folder:${f.id}`, f.name)).join("")}</optgroup>` : "").join("");
  const folderSelect = `<select name="destination" aria-label="Folder">${opt("new", "New folder")}${opt("root", "No folder (project root)")}${folderGroups}</select>`;
  const prev = await env.DB.prepare(
    `SELECT pb.id, pb.created_at, pb.resumed_at, pb.current_source_revision, pb.revoked_at, p.title AS project_title, f.name AS folder_name FROM publishers pb
     JOIN projects p ON p.id = pb.project_id LEFT JOIN folders f ON f.id = pb.folder_id WHERE pb.app_client_id = ? AND pb.owner_principal_id = ? ORDER BY pb.created_at DESC LIMIT 20`
  ).bind(app.id, principalId).all();
  // Most recently used first. Nothing is resumed unless the owner picks it: resuming signs out the app's older session.
  const active = prev.results.filter((r) => r.revoked_at === null).sort((a, b) => String(b.resumed_at ?? b.created_at).localeCompare(String(a.resumed_at ?? a.created_at)));
  const resume = pick("resume", "new");
  const cards = active.map((r) => `<label class="choice"><input type="radio" name="resume" value="${esc(r.id)}"${resume === r.id ? " checked" : ""}><span><strong>Keep publishing to ${esc(r.project_title)} / ${r.folder_name ? esc(r.folder_name) : "project root"}</strong>
<small>${r.current_source_revision == null ? "No exports yet" : `Last export: revision ${esc(r.current_source_revision)}`} \u00B7 connected ${esc(cxDate(r.created_at))}${active.length > 1 ? ` \u00B7 <code>${esc(r.id)}</code>` : ""}</small></span></label>`).join("");
  const audiences = await Promise.all(projects.map(async (p) => [p.id, await readerAudience(env, principalId, p.id)]));
  const audienceHtml = audiences.map(([pid, a], i) => `<p class="aud" data-i="${i}"><strong>${esc(projects.find((p) => p.id === pid).title)}</strong>: ${a.length ? a.map((x) => `${esc(x.kind)} \u201C${esc(x.name)}\u201D (${x.can_write ? "read & edit" : "read"})`).join(", ") : "no connected apps or API keys yet"}</p>`).join("");
  // Show only the chosen project's folder list and readers (CSS; pages have no scripts).
  const projectCss = projects.map((_, i) => `.fresh:has(select[name=project_id] option:nth-child(${i + 1}):checked) :is(.aud,optgroup)[data-i="${i}"]{display:block}`).join("");
  const defaultFolder = suggest?.folder || name.replace(/\s*\(.*\)\s*$/, "").trim() || name;
  return page("Choose where this app publishes", cxShell(`${cxPair(name)}
<h1>${active.length ? `Connect ${esc(name)} again` : `Where should ${esc(name)} publish?`}</h1>
<p class="lede">It can create files and update only the ones it made. Nothing else in your library is visible to it. Signed in as ${esc(email)}.</p>${cxErr(error)}
<form method="post" action="/authorize" class="${active.length ? "has-prev" : ""}"><input type="hidden" name="handle" value="${esc(consent.handle)}"><input type="hidden" name="step" value="publish">${CX_ENTER}
${active.length ? `<section class="sec"><h2>Destination</h2>${cards}<label class="choice"><input type="radio" name="resume" value="new"${resume === "new" ? " checked" : ""}><span><strong>Somewhere new</strong><small>Start a separate set of files.</small></span></label>
<p class="fine">Continuing an earlier destination keeps its files and signs out the app's older session.</p></section>` : '<input type="hidden" name="resume" value="new">'}
<section class="sec fresh">${active.length ? "<h2>New destination</h2>" : ""}<style>${projectCss}</style>
<label class="field"><span>Project</span><select name="project_id" aria-label="Project">${projOpts}</select></label>
<label class="field"><span>Folder</span>${folderSelect}</label>
<label class="field newname"><span>Folder name</span><input type="text" name="new_folder_name" maxlength="80" value="${esc(pick("new_folder_name", defaultFolder))}" aria-label="New folder name"></label>
<details class="more"><summary>${cxIcon("chev")}Who else can read this project</summary><div class="inner"><p class="fine">They will be able to read this app's files, <strong>including future exports</strong>, and <strong>cannot edit them</strong>. Nothing new is granted to them.</p>${audienceHtml}</div></details>
</section>
${cxBar("")}</form>`), consent.headers, status);
}
//== region: publishValidate
async function publishConsentPost(req, env, oauth, form, handle, origin) {
  const sess = await env.OAUTH_KV.get(`consentctx:${await sha(handle)}`, "json");
  if (!sess?.app_client_id) return errorPage("This consent page expired. Start connecting again from the app.");
  const app = await env.DB.prepare("SELECT * FROM app_clients WHERE id = ? AND owner_principal_id = ? AND disabled_at IS NULL").bind(sess.app_client_id, sess.principal_id).first();
  if (!app) return errorPage("This app is no longer registered or has been disabled.");
  // A fixable mistake re-renders the page with the owner's choices kept (the consent handle is still unused).
  const retry = /* @__PURE__ */ __name(async (msg) => {
    if (!sess.email) return errorPage(msg);
    const owned = await env.DB.prepare("SELECT id, title FROM projects WHERE owner_id = ? ORDER BY created_at LIMIT 500").bind(sess.principal_id).all();
    return cxPublishPage(env, app, sess.principal_id, sess.email, owned.results, { handle, headers: new Headers() }, form, msg, 400, sess.suggest ?? null);
  }, "retry");
  const resume = String(form.get("resume") ?? "new");
  const at = nowIso(), rid = randomId("req", 9);
  const audit2 = /* @__PURE__ */ __name((projectId, action, object, result) => env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(at, sess.principal_id, projectId, action, object, result, rid), "audit");
  let publisherId, epoch;
  const stmts = [];
  if (resume !== "new") {
    const prev = await env.DB.prepare("SELECT * FROM publishers WHERE id = ? AND app_client_id = ? AND owner_principal_id = ? AND revoked_at IS NULL").bind(resume, app.id, sess.principal_id).first();
    if (!prev) return retry("That earlier connection can't be resumed. Choose again.");
    publisherId = prev.id;
    epoch = prev.token_epoch + 1;
    stmts.push(
      env.DB.prepare("UPDATE publishers SET token_epoch = ?, resumed_at = ? WHERE id = ? AND token_epoch = ? AND revoked_at IS NULL").bind(epoch, at, publisherId, prev.token_epoch),
      audit2(prev.project_id, "publisher.resume", publisherId, "ok")
    );
  } else {
    const projectId = String(form.get("project_id") ?? "");
    const proj = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND owner_id = ?").bind(projectId, sess.principal_id).first();
    if (!proj) return retry("Choose one of your projects.");
    const dest = String(form.get("destination") ?? "");
    let folderId = null;
    publisherId = randomId("pub", 15);
    epoch = 1;
    const principalId = randomId("agt");
    if (dest === "root") folderId = null;
    else if (dest.startsWith("folder:")) {
      const f = await env.DB.prepare("SELECT id FROM folders WHERE id = ? AND project_id = ?").bind(dest.slice(7), projectId).first("id");
      if (!f) return retry("That folder is in a different project. Pick one of this project's folders, or a new folder.");
      folderId = f;
    } else if (dest === "new") {
      let nm;
      try {
        nm = folderName(form.get("new_folder_name"));
      } catch (e) {
        return retry(`${e.message}. Fix the folder name.`);
      }
      const ex = await env.DB.prepare("SELECT id FROM folders WHERE project_id = ? AND name_key = ?").bind(projectId, nm.key).first("id");
      if (ex) return retry(`A folder named \u201C${nm.name}\u201D already exists in this project. Pick it from the folder list, or choose another name.`);
      folderId = randomId("fld");
      stmts.push(env.DB.prepare("INSERT INTO folders (id, project_id, name, name_key, created_at, created_by, publisher_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(folderId, projectId, nm.name, nm.key, at, sess.principal_id, publisherId), audit2(projectId, "folder.create", folderId, "ok:publisher-consent"));
    } else return retry("Choose a folder option.");
    stmts.push(
      env.DB.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'agent-library-publisher', ?, ?, ?)").bind(principalId, publisherId, `publisher:${app.display_name}`.slice(0, 200), at),
      env.DB.prepare(`INSERT INTO publishers (id, owner_principal_id, principal_id, app_client_id, display_name, project_id, folder_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(publisherId, sess.principal_id, principalId, app.id, app.display_name, projectId, folderId, at),
      audit2(projectId, "publisher.connect", publisherId, folderId ? "ok:folder" : "ok:root")
    );
  }
//== region: errorPage
    errorPage = /* @__PURE__ */ __name((msg, status = 400) => page("Cannot connect", cxShell(`<div class="state off"><span class="big" aria-hidden="true">${cxIcon("alert")}</span><h1>Couldn't connect</h1><p class="lede">${esc(msg)}</p><p class="fine">You can close this tab and start again from the app.</p></div>`, false), void 0, status), "errorPage");
