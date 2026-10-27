// Session fixes integration step (run AFTER build-consent-fixes.mjs, the last step before it).
// Starts from the consent-fixes bundle and applies exact, once-matching text patches inside the browser UI
// module (// src/ui.ts) and the final request-routing module (the last // src/index.ts, which holds the
// login handlers) only; every byte outside those two modules must stay identical.
// The TypeScript sources are NOT rebuilt (see build-design-bundle.mjs). No config, credentials, database or
// network is used.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const BASE=JSON.parse(readFileSync('consent-fixes-preservation.json','utf8')).integrated_sha256;
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==BASE)throw Error('Input is not the consent-fixes bundle; run build-consent-fixes.mjs first');
const once=(s,needle,what)=>{const i=s.indexOf(needle);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
const uiStart=once(input,'// src/ui.ts\n','ui module start');
const uiEnd=once(input,'\n// src/index.ts\ninit_util();\ninit_links();\n','ui module end')+1;
const srvStart=once(input,'// src/index.ts\nvar SEC_HEADERS = {\n','routing module start');
if(srvStart<uiEnd)throw Error('Unexpected module order');

// Hosted: the app session can end while Cloudflare Access is still signed in. Exchange the Access identity for a
// fresh session (once, shared by concurrent requests), retry the request once as the same user, and only fall
// back to a full reload (so Access can show its own sign-in page) when that fails. The loopback dev login is unchanged.
const RENEW=String.raw`// ---------- hosted session renewal ----------
// Hosted = behind Cloudflare Access; loopback (localhost/127.0.0.1) keeps the local dev passphrase login.
function hostedApp() { return !/^(localhost|127\.0\.0\.1)$/.test(location.hostname); }
var renewing = null, signingOut = false;
// The app session ended but Access may still be signed in: get a new app session for the same user.
function renewSession() {
  if (!hostedApp() || !S.me || signingOut) return Promise.resolve(false);
  if (!renewing) {
    var uid = S.me.id;
    renewing = (async function () {
      try {
        await api("POST", "/auth/access-login", {}, { noAuthRedirect: true });
        var me = await api("GET", "/api/me", undefined, { noAuthRedirect: true });
        if (!S.me || S.me.id !== uid || !me.principal || me.principal.id !== uid) return false;
        S.csrf = me.csrf; return true;
      } catch (e) { return false; }
    })().finally(function () { renewing = null; });
  }
  return renewing;
}
// Access itself expired (or renewal failed): reload so Access shows its sign-in page. At most once a minute,
// so a server-side refusal cannot cause a reload loop.
function reloadForSignIn() {
  try {
    var last = Number(sessionStorage.getItem("al:signin-reload") || 0);
    if (Date.now() - last < 60000) return false;
    sessionStorage.setItem("al:signin-reload", String(Date.now()));
  } catch (e) { return false; }
  location.reload();
  return true;
}

`;
const PATCHES=[
 ['ui: API requests ask Access for a 401 (not a login redirect) when its session has expired',
  '  if (opt.key) headers["idempotency-key"] = opt.key;\n',
  '  if (opt.key) headers["idempotency-key"] = opt.key;\n  headers["x-requested-with"] = "XMLHttpRequest";\n'],
 ['ui: a 401 renews the hosted session and retries once before signing out',
  '  if (res.status === 401 && !opt.noAuthRedirect) onUnauthenticated();\n',
  '  if (res.status === 401 && !opt.noAuthRedirect) {\n    if (!opt.renewed && await renewSession()) return api(method, path, body, Object.assign({}, opt, { renewed: true }));\n    onUnauthenticated();\n  }\n'],
 ['ui: hosted session renewal helpers',
  '// ---------- drafts (scoped by principal/project/artifact; cleared on logout/401) ----------\n',
  RENEW+'// ---------- drafts (scoped by principal/project/artifact; cleared on logout/401) ----------\n'],
 // Sign-out must not race a renewal: block new ones and let an in-flight one finish first, so the server-side
 // logout (which revokes every session of the user) also revokes the session it created.
 ['ui: sign-out waits for an in-flight session renewal and blocks new ones',
  'async function logout() {\n',
  'async function logout() {\n  signingOut = true;\n  if (renewing) await renewing;\n'],
 ['ui: an ended hosted session reloads into Access sign-in instead of the dev login form',
  '  runCleanups(true);\n  viewLogin(wasIn ?',
  // Never during sign-out: logout() must finish clearing drafts and offline copies first.
  '  runCleanups(true);\n  if (wasIn && hostedApp() && !signingOut && reloadForSignIn()) return;\n  viewLogin(wasIn ?'],
 ['ui: the hosted sign-in view offers Access sign-in, never the loopback passphrase form',
  'function viewLogin(note) {\n',
  'function viewLogin(note) {\n  if (hostedApp()) {\n    var again = h("button", { type: "button", onclick: function () { location.reload(); } }, "Sign in");\n    shell([{ t: "Sign in" }], note ? h("p", { class: "banner", text: note }) : null,\n      h("div", { class: "card" }, h("h1", { text: "Sign in" }), h("p", { class: "muted small", text: "Sign in with your Cloudflare Access account to continue." }), again));\n    again.focus();\n    return;\n  }\n'],
];
// Access verifies the owner on every request, so the app session never outlives Access; it lasts as long as
// Access allows (30 days) instead of a fixed 8 hours. A changed Access user ID for the owner must not silently
// create a second, empty library.
const SRV_PATCHES=[
 // verifyAccess has already required the signed Access email to be OWNER_EMAIL. If Access issues the owner a new
 // user ID (e.g. removed and re-added), relink the single existing owner instead of creating an empty library.
 ['server: a new Access user ID for the owner relinks the existing owner account instead of creating another',
  '  if (p && p.kind !== "human") throw new HttpError(403, "forbidden", "Not a human principal");\n  if (!p) {\n    p = { id: randomId("hum") };\n',
  '  if (p && p.kind !== "human") throw new HttpError(403, "forbidden", "Not a human principal");\n  if (!p) {\n    const owners = (await env.DB.prepare("SELECT id FROM principals WHERE kind = \'human\' AND issuer = ?").bind(id.issuer).all()).results;\n    if (owners.length > 1) throw new HttpError(409, "identity_changed", "This sign-in has a new Access user ID and the owner account is ambiguous. No account was created.");\n    if (owners.length === 1) {\n      await env.DB.prepare("UPDATE principals SET subject = ? WHERE id = ?").bind(id.subject, owners[0].id).run();\n      console.log("owner_subject_relinked", owners[0].id);\n      p = { id: owners[0].id };\n    }\n  }\n  if (!p) {\n    p = { id: randomId("hum") };\n'],
 ['server: Access sessions last 30 days (Access still checked on every request)',
  '  await env.DB.prepare("INSERT INTO sessions (id_hash, principal_id, csrf, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(sid), p.id, csrf, nowMs() + 8 * 36e5).run();\n  return json({ ok: true, csrf }, 200, {\n    "set-cookie": `${SESSION_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`\n',
  '  await env.DB.prepare("INSERT INTO sessions (id_hash, principal_id, csrf, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(sid), p.id, csrf, nowMs() + 30 * 864e5).run();\n  return json({ ok: true, csrf }, 200, {\n    "set-cookie": `${SESSION_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`\n'],
];
const apply=(mod,list)=>{for(const [name,find,rep] of list){const i=once(mod,find,name);mod=mod.slice(0,i)+rep+mod.slice(i+find.length);}return mod;};
const oldUi=input.slice(uiStart,uiEnd),oldSrv=input.slice(srvStart);
const ui=apply(oldUi,PATCHES),srv=apply(oldSrv,SRV_PATCHES);
const mid=input.slice(uiEnd,srvStart);
const out=input.slice(0,uiStart)+ui+mid+srv;
if(!out.startsWith(input.slice(0,uiStart))||out.slice(uiStart+ui.length,uiStart+ui.length+mid.length)!==mid)throw Error('Bytes outside the ui and routing modules changed');
writeFileSync('src/index.js',out);
const meta={base_consent_fixes_sha256:BASE,integrated_sha256:sha(out),
 preserved_prefix_sha256:sha(input.slice(0,uiStart)),preserved_between_sha256:sha(mid),
 modules_sha256:{ui:{base:sha(oldUi),candidate:sha(ui)},routing:{base:sha(oldSrv),candidate:sha(srv)}},
 patched_modules:['src/ui.ts','src/index.ts (routing)'],patches:[...PATCHES,...SRV_PATCHES].map(p=>p[0])};
writeFileSync('session-fixes-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(JSON.stringify(meta,null,1));
