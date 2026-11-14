// Review gating in the browser (Chrome via Puppeteer): Home "Needs review" only when something waits, the review
// screen (diff, why, approve / edit and approve / reject, stale state), the document banner and review setting, History
// marks and "Mark as reviewed", the project Review tab and the Connections "Can review" toggle; desktop and mobile.
// Real Worker, real OAuth agent. Synthetic content only; screenshots go to tmp/test-evidence/.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { key } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const P = "rvui";
const base = `/api/projects/${P}`;
let h, owner, agent;
const shot = (page, name) => page.screenshot({ path: `tmp/test-evidence/review-${name}.png`, fullPage: true });

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["review-ui"] });
  owner = await h.owner();
  assert.equal((await owner.req("POST", "/api/projects", { id: P, title: "Field notes" })).status, 201);
  agent = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Claude" });
});
after(async () => { await h?.stop(); });

test("Chrome: Home hides Needs review when empty and shows it when an edit waits; review, edit-and-approve, reject; settings", { skip: !haveChrome }, async () => {
  const browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewport({ width: 1280, height: 900 });
    const [name, value] = owner.cookie.split("=");
    await page.setCookie({ name, value, url: h.appUi, httpOnly: true });
    const doc = (await owner.req("POST", base + "/artifacts", { title: "Trip plan", body: "# Trip plan\n\nDay 1: arrive\nDay 2: museum\n" })).body.artifact_id;
    // Nothing to review: Home renders no review section at all.
    await page.goto(h.appUi + "/#/");
    await page.waitForSelector(".home-list li[data-artifact-id]");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await page.$eval(".rv-home", (e) => e.hidden), true, "no Needs review section when the queue is empty");
    assert.equal(await page.evaluate(() => /Needs review/i.test(document.querySelector("main").innerText)), false);
    // Owner turns review on from Details (sees what it means first).
    await page.goto(h.appUi + `/p/${P}/a/${doc}`);
    await page.waitForFunction(() => [...document.querySelectorAll("summary")].some((e) => e.textContent === "Details"));
    await page.evaluate(() => [...document.querySelectorAll("summary")].find((e) => e.textContent === "Details").click());
    // Choosing explains first; nothing changes until Save, which confirms that v1 counts as reviewed.
    await page.click('.rv-docmode input[value="required"]');
    assert.equal(await page.evaluate(() => /Edits by apps and agents wait for approval/.test(document.querySelector(".rv-docmode").textContent)), true);
    assert.equal((await owner.req("GET", base + "/artifacts/" + doc)).body.artifact.review, undefined, "choosing alone saves nothing");
    let asked = ""; page.once("dialog", (d) => { asked = d.message(); d.accept(); });
    await page.evaluate(() => [...document.querySelectorAll(".rv-docmode button")].find((b) => b.textContent === "Save review setting").click());
    await page.waitForFunction(() => /Review is now required/i.test(document.querySelector(".rv-docmode")?.textContent || "") || /Review required/.test(document.querySelector(".rv-chip")?.textContent || ""));
    assert.match(asked, /Version 1 counts as reviewed/);
    await page.waitForFunction(() => /Review required/.test(document.querySelector(".rv-chip")?.textContent || ""));
    assert.equal((await owner.req("GET", base + "/artifacts/" + doc)).body.artifact.review.mode, "required");
    await shot(page, "doc-setting");
    // Details order: Review comes before the ID line.
    assert.equal(await page.evaluate(() => { const b = document.querySelector(".rv-docmode"), id = [...b.parentElement.children].find((e) => /^ID art_/.test(e.textContent)); return !!id && !!(b.compareDocumentPosition(id) & Node.DOCUMENT_POSITION_FOLLOWING); }), true, "Review section sits above the ID line");
    // The agent proposes an edit; Home now shows it.
    const s = await agent.call("save_markdown", { project_id: P, artifact_id: doc, expected_revision: 1, body: "# Trip plan\n\nDay 1: arrive\nDay 2: museum\nDay 3: hike\n", change_note: "Added the hike day", idempotency_key: key() });
    assert.equal(s.data.status, "pending_review");
    // History lists the waiting edit above the versions, linked straight to its review.
    await page.goto(h.appUi + `/#/p/${P}/a/${doc}`);
    await page.waitForSelector('[role="tab"]');
    await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "History").click());
    await page.waitForSelector(".vh-list .rv-pending");
    const pendRow = await page.$eval(".vh-list .rv-pending", (e) => ({ text: e.innerText, href: e.querySelector("a.vh-open")?.getAttribute("href"), first: e.previousElementSibling?.textContent }));
    assert.match(pendRow.text, /Claude/); assert.match(pendRow.text, /Added the hike day/); assert.match(pendRow.text, /Pending/);
    assert.equal(pendRow.href, `#/p/${P}/review/${s.data.proposal_id}`);
    assert.equal(pendRow.first, "Waiting for review");
    // Badges and the row's button share one centered group.
    const aligned = await page.$$eval(".vh-list .vh-side", (els) => els.every((g) => { const c = [...g.children].map((x) => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; }); return c.every((y) => Math.abs(y - c[0]) <= 1); }));
    assert.equal(aligned, true, "badges and buttons are vertically centered on each other");
    // Row-level Review is secondary like View/Compare/Restore (one primary action per screen).
    assert.equal(await page.$eval(".rv-pending a.vh-open", (e) => e.classList.contains("secondary")), true);
    // The History tab is in the URL, so Back from the review screen returns to History.
    assert.match(await page.evaluate(() => location.hash), /\?tab=history$/);
    await page.evaluate(() => document.querySelector(".rv-pending a.vh-open").click());
    await page.waitForSelector(".rv-decide");
    await page.goBack();
    await page.waitForSelector(".vh-list .rv-pending");
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.getAttribute("aria-selected") === "true")?.textContent), "History");
    // 320px: every History row stacks the same way and nothing overflows its card.
    await page.setViewport({ width: 320, height: 800 });
    await new Promise((r) => setTimeout(r, 200));
    const fits = await page.$$eval(".vh-list > li", (lis) => lis.every((li) => { const b = li.getBoundingClientRect(); return [...li.querySelectorAll("*")].every((x) => { const r = x.getBoundingClientRect(); return !r.width || r.right <= b.right + 1; }); }));
    assert.equal(fits, true, "History rows fit at 320px");
    await page.setViewport({ width: 1280, height: 900 });
    // A failed load of waiting edits says so (with Try again), and the banner falls back to the project queue.
    await page.setRequestInterception(true);
    const fail = (r) => (/\/proposals\?artifact_id=/.test(r.url()) ? r.respond({ status: 500, contentType: "application/json", body: '{"error":{"code":"internal","message":"boom"}}' }) : r.continue());
    page.on("request", fail);
    // Same URL as now (History is open): reload, so the page loads fresh with the failing request.
    await page.goto(h.appUi + `/#/p/${P}/a/${doc}?tab=history`);
    await page.reload();
    await page.waitForSelector(".vh-list .rv-load-err");
    assert.match(await page.$eval(".rv-load-err", (e) => e.innerText), /Couldn't load the edits waiting for review/);
    await page.evaluate(() => document.querySelector(".rv-banner a").click());
    await page.waitForFunction(() => /\/review$/.test(location.hash));
    page.off("request", fail); await page.setRequestInterception(false);
    // ?tab=history only while History shows: another tab (on any kind, e.g. JSON, whose Preview doesn't rewrite the URL) drops it.
    const json = (await owner.req("POST", base + "/artifacts", { title: "Prices", kind: "json", content: '{"a":1}' })).body.artifact_id;
    await page.goto(h.appUi + `/#/p/${P}/a/${json}?tab=history`);
    await page.waitForSelector(".vh-list li");
    await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Preview").click());
    assert.equal(await page.evaluate(() => location.hash), `#/p/${P}/a/${json}`, "leaving History drops ?tab=history");
    // Offline: a saved document still opens from a URL with a query (?tab=history).
    await page.goto(h.appUi + `/#/p/${P}/a/${doc}`);
    await page.waitForSelector('[aria-label="Make available offline"]');
    await page.click('[aria-label="Make available offline"]');
    await page.waitForSelector('[aria-label^="Available offline"]');
    // No network for the app's API (the page itself still loads), the way the app sees a dropped connection.
    await page.setRequestInterception(true);
    const offline = (r) => (/\/api\/|\/auth\//.test(r.url()) ? r.abort("internetdisconnected") : r.continue());
    page.on("request", offline);
    await page.goto(h.appUi + `/#/p/${P}/a/${doc}?tab=history`);
    await page.reload();
    await page.waitForFunction(() => /offline/i.test(document.querySelector("main")?.innerText || ""));
    const offlineText = await page.$eval("main", (e) => e.innerText);
    page.off("request", offline); await page.setRequestInterception(false);
    assert.doesNotMatch(offlineText, /Not available offline/, "offline routing ignores ?tab=history");
    assert.match(offlineText, /Trip plan/);
    await page.goto(h.appUi + "/#/");
    await page.reload(); // back online: the app re-checks its session at load
    await page.waitForFunction(() => { const e = document.querySelector(".rv-home"); return e && !e.hidden; });
    const homeText = await page.$eval(".rv-home", (e) => e.innerText);
    assert.match(homeText, /Needs review/i); assert.match(homeText, /Trip plan/); assert.match(homeText, /Claude/); assert.match(homeText, /Added the hike day/);
    await shot(page, "home-desktop");
    // Review screen: why, who, diff; approve.
    await page.evaluate(() => document.querySelector(".rv-home a.stretch").click());
    await page.waitForSelector(".rv-decide");
    const reviewText = await page.$eval("main", (e) => e.innerText);
    assert.match(reviewText, /Added the hike day/); assert.match(reviewText, /Claude/); assert.match(reviewText, /1 added, 0 removed/);
    assert.equal(await page.$$eval(".vh-line.add", (els) => els.map((e) => e.innerText).join("")).then((t) => /Day 3: hike/.test(t)), true);
    await shot(page, "proposal-desktop");
    await page.type('[aria-label="Review note"]', "Nice");
    await page.evaluate(() => [...document.querySelectorAll(".rv-decide button")].find((b) => b.textContent.trim() === "Approve").click());
    await page.waitForFunction((id) => location.hash.endsWith("/a/" + id), {}, doc);
    assert.match((await owner.req("GET", base + "/artifacts/" + doc)).body.body, /Day 3: hike/);
    // History shows who proposed and who approved.
    await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "History").click());
    await page.waitForSelector(".rv-badge");
    assert.match(await page.$eval(".vh-list", (e) => e.innerText), /approved by you/);
    // Stale proposal: plain approve is disabled; edit and approve merges onto the current version.
    const s2 = await agent.call("save_markdown", { project_id: P, artifact_id: doc, expected_revision: 2, body: "# Trip plan\n\nDay 1: arrive\nDay 2: museum\nDay 3: hike\nDay 4: beach\n", change_note: "Beach day", idempotency_key: key() });
    assert.equal((await owner.req("PUT", base + "/artifacts/" + doc, { expected_revision: 2, body: "# Trip plan (v3)\n\nDay 1: arrive\nDay 2: museum\nDay 3: hike\n" })).status, 200);
    // The stale row is marked in the project queue.
    await page.goto(h.appUi + `/#/p/${P}/review`);
    await page.waitForSelector(".rv-row");
    assert.equal(await page.$eval(".rv-row .rv-stale", (e) => e.offsetParent !== null), true, "stale marker is visible in the list");
    await page.goto(h.appUi + `/#/p/${P}/review/${s2.data.proposal_id}`);
    await page.waitForSelector(".rv-decide");
    assert.match(await page.$eval("main", (e) => e.innerText), /document changed since this was proposed/i);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll(".rv-decide button")].find((b) => b.textContent.trim() === "Approve").disabled), true);
    await page.evaluate(() => [...document.querySelectorAll(".rv-decide button")].find((b) => b.textContent.startsWith("Edit and approve")).click());
    await page.waitForSelector(".rv-text");
    // Stale: the editor starts from the current version (nothing newer is lost), with the proposal's changes beside it.
    await page.waitForFunction(() => document.querySelector(".rv-text").value.startsWith("# Trip plan (v3)"));
    assert.match(await page.$eval(".rv-edit .rv-ref", (e) => e.innerText), /Day 4: beach/);
    assert.equal(await page.$eval(".rv-decide", (e) => getComputedStyle(e).position), "static", "editor isn't sticky over the page");
    await page.$eval(".rv-text", (e) => { e.value += "Day 4: beach\n"; });
    await shot(page, "edit-approve-desktop");
    await page.evaluate(() => [...document.querySelectorAll(".rv-decide button")].find((b) => b.textContent.includes("Publish my version")).click());
    await page.waitForFunction((id) => location.hash.endsWith("/a/" + id), {}, doc);
    const after2 = (await owner.req("GET", base + "/artifacts/" + doc)).body;
    assert.equal(after2.body, "# Trip plan (v3)\n\nDay 1: arrive\nDay 2: museum\nDay 3: hike\nDay 4: beach\n"); assert.equal(after2.revision.rev, 4);
    // Reject with a note, on a phone; the decision bar stays reachable.
    const s3 = await agent.call("save_markdown", { project_id: P, artifact_id: doc, expected_revision: 4, body: "nonsense", change_note: "Oops", idempotency_key: key() });
    // Narrow tablet (bottom tab bar from 760px): the decision bar sits above the tab bar.
    await page.setViewport({ width: 700, height: 900 });
    await page.goto(h.appUi + `/#/p/${P}/review/${s3.data.proposal_id}`);
    await page.waitForSelector(".rv-decide");
    const clear = () => page.evaluate(() => { const d = document.querySelector(".rv-decide").getBoundingClientRect(), t = document.querySelector(".side").getBoundingClientRect(); return d.bottom <= t.top + 1; });
    assert.equal(await clear(), true, "decision bar clears the tab bar at 700px");
    await shot(page, "proposal-700");
    await page.setViewport({ width: 390, height: 844 });
    await page.waitForSelector(".rv-decide");
    assert.equal(await clear(), true, "decision bar clears the tab bar on a phone");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "review screen fits a phone");
    await shot(page, "proposal-mobile");
    page.once("dialog", (d) => d.accept());
    await page.type('[aria-label="Review note"]', "Not this");
    await page.evaluate(() => [...document.querySelectorAll(".rv-decide button")].find((b) => b.textContent.trim() === "Reject").click());
    await page.waitForFunction(() => location.hash.endsWith("/review"));
    assert.equal((await agent.call("read_proposal", { project_id: P, proposal_id: s3.data.proposal_id })).data.review.note, "Not this");
    // Project Review tab: empty state and the default for new documents.
    await page.waitForSelector(".rv-settings .rv-radio");
    assert.match(await page.$eval("main", (e) => e.innerText), /Nothing to review/);
    // On a phone the radio can sit under the bottom tab bar: pick it in the page (like the other clicks here), then check it took.
    const pick = (v) => page.evaluate((x) => { const r = document.querySelector(`.rv-settings input[value="${x}"]`); r.click(); return r.checked; }, v);
    assert.equal(await pick("required"), true);
    await page.evaluate(() => [...document.querySelectorAll(".rv-settings button")].find((b) => b.textContent === "Save").click());
    await page.waitForFunction(() => /Saved|error|couldn't/i.test(document.querySelector(".rv-settings .msg")?.textContent || ""));
    assert.match(await page.$eval(".rv-settings .msg", (e) => e.textContent), /Saved/);
    assert.equal((await owner.req("GET", base + "/review-settings")).body.default, "required");
    await shot(page, "project-review-mobile");
    // Apply uses what the page shows (not a stale saved value), and says what it changes before it does.
    assert.equal(await pick("off"), true);
    let applyMsg = ""; page.once("dialog", (d) => { applyMsg = d.message(); d.dismiss(); });
    await page.evaluate(() => [...document.querySelectorAll(".rv-settings button")].find((b) => b.textContent.startsWith("Save and apply")).click());
    await new Promise((r) => setTimeout(r, 300));
    assert.match(applyMsg, /^Turn review off for 1 document currently requiring review/); assert.match(applyMsg, /go live without approval/);
    assert.equal((await owner.req("GET", base + "/review-settings")).body.default, "required", "dismissed: nothing saved");
    assert.equal((await owner.req("GET", base + "/artifacts/" + doc)).body.artifact.review.mode, "required");
    // New document: Review starts at the project default (required, set above) and can be changed before creating.
    await page.setViewport({ width: 1280, height: 900 });
    const newDoc = async (title, mode) => {
      await page.goto(h.appUi + `/#/p/${P}`);
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /New document/.test(b.textContent)));
      await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /New document/.test(b.textContent)).click());
      // Loaded: the field is revealed (rv-wait removed) once the project default is known.
      await page.waitForSelector(".rv-newdoc:not(.rv-wait) select");
      const shown = await page.$eval(".rv-newdoc select", (e) => ({ value: e.value, label: e.options[e.selectedIndex].text }));
      if (mode) await page.select(".rv-newdoc select", mode);
      await page.type('[aria-label="New document title"]', title);
      await page.evaluate(() => [...document.querySelectorAll("form.template-form button")].find((b) => b.textContent === "Create").click());
      await page.waitForFunction(() => /\/a\/art_[^/]+\/edit$/.test(location.hash));
      const id = await page.evaluate(() => location.hash.split("/a/")[1].split("/")[0]);
      return { shown, review: (await owner.req("GET", base + "/artifacts/" + id)).body.artifact.review };
    };
    const d1 = await newDoc("Default review");
    assert.deepEqual(d1.shown, { value: "required", label: "Required (project default)" });
    assert.equal(d1.review.mode, "required", "project default applied");
    const d2 = await newDoc("Chosen review", "advisory");
    assert.equal(d2.review.mode, "advisory", "the choice on the form wins");
    const d3 = await newDoc("No review", "off");
    assert.equal(d3.review, undefined, "off: no review state");
    // Connections: Can review toggle (workspace admins, per project).
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(h.appUi + "/#/settings/apps");
    await page.waitForSelector(".rv-grants-d");
    await page.evaluate(() => document.querySelector(".rv-grants-d summary").click());
    await page.evaluate(() => document.querySelector(".rv-grant input").click());
    await page.waitForFunction(() => /Can review/.test(document.querySelector(".toast")?.textContent || ""));
    assert.equal((await owner.req("GET", "/api/review-grants")).body.review_grants.length, 1);
    await shot(page, "connections");
    // Back to empty: Home hides the section again.
    await page.goto(h.appUi + "/#/");
    await page.waitForSelector(".home-list li[data-artifact-id]");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await page.$eval(".rv-home", (e) => e.hidden), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("Chrome: in a shared workspace a member reviews but sets nothing; a viewer has no review controls; admins see the settings", { skip: !haveChrome }, async () => {
  const browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const ws = (await owner.req("POST", "/api/workspaces", { name: "Review team" })).body.id;
    const pid = (await owner.req("POST", "/api/projects", { title: "Team review", workspace_id: ws })).body.id;
    const invite = async (user, role) => {
      const inv = (await owner.req("POST", `/api/workspaces/${ws}/invites`, { email: `${user}@example.test`, role })).body;
      const person = await h.person(user);
      assert.equal((await person.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() })).status, 200);
      return person;
    };
    const member = await invite("mia", "member"), viewer = await invite("vic", "viewer");
    const doc = (await owner.req("POST", `/api/projects/${pid}/artifacts`, { title: "Shared plan", body: "one\n" })).body.artifact_id;
    assert.equal((await owner.req("PUT", `/api/projects/${pid}/artifacts/${doc}/review-mode`, { mode: "required", expected_revision: 1 })).status, 200);
    assert.equal((await member.req("PUT", `/api/projects/${pid}/artifacts/${doc}/review-mode`, { mode: "off", expected_revision: 1 })).status, 403, "a member can't change review modes");
    assert.equal((await member.req("PUT", `/api/projects/${pid}/review-settings`, { default: "required" })).status, 403);
    // A person's own edit is never gated, whoever they are.
    assert.equal((await member.req("PUT", `/api/projects/${pid}/artifacts/${doc}`, { expected_revision: 1, body: "one\ntwo\n" })).status, 200);
    const agent2 = await h.connectMcpAgent({ [pid]: "write" }, { clientName: "Team agent" });
    const s = await agent2.call("save_markdown", { project_id: pid, artifact_id: doc, expected_revision: 2, body: "one\ntwo\nthree\n", change_note: "Added three", idempotency_key: key() });
    assert.equal(s.data.status, "pending_review", JSON.stringify(s.data));
    // Each person signs in through the page itself (its own cookie and CSRF token), in an isolated browser context.
    const open = async (user) => {
      const page = await (await browser.createBrowserContext()).newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(h.appUi + "/");
      const st = await page.evaluate(async (passphrase, u) => (await fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, user: u }) })).status, h.passphrase(), user);
      assert.equal(st, 200);
      await page.reload(); // the app reads its session at load
      return page;
    };
    // Member: Needs review lists the agent's edit; the review screen has the decision buttons; no review settings.
    const mp = await open("mia");
    await mp.goto(h.appUi + "/#/");
    await mp.waitForFunction(() => { const e = document.querySelector(".rv-home"); return e && !e.hidden; });
    assert.match(await mp.$eval(".rv-home", (e) => e.innerText), /Shared plan/);
    await mp.goto(h.appUi + `/#/p/${pid}/review/${s.data.proposal_id}`);
    await mp.waitForSelector(".rv-decide");
    await mp.goto(h.appUi + `/#/p/${pid}/review`);
    await mp.waitForSelector(".rv-row");
    await mp.waitForFunction(() => document.querySelector(".rv-settings")?.hidden === true);
    assert.equal(await mp.$(".rv-settings .rv-radio"), null, "a member doesn't see the project review settings");
    await mp.goto(h.appUi + `/#/p/${pid}/a/${doc}`);
    await mp.waitForFunction(() => [...document.querySelectorAll("summary")].some((e) => e.textContent === "Details"));
    await mp.evaluate(() => [...document.querySelectorAll("summary")].find((e) => e.textContent === "Details").click());
    await mp.waitForFunction(() => document.querySelector(".rv-docmode")?.hidden === true);
    assert.equal(await mp.$eval(".rv-docmode", (e) => e.offsetParent === null), true, "a member doesn't see the document review setting");
    // Viewer: the queue and review screens show nothing to decide.
    const vp = await open("vic");
    await vp.goto(h.appUi + `/#/p/${pid}/review/${s.data.proposal_id}`);
    await vp.waitForFunction(() => /isn't available|Couldn't load/.test(document.querySelector("main")?.innerText || ""));
    assert.equal(await vp.$(".rv-decide"), null);
    // Admin (the owner): settings are there.
    const ap = await open("owner");
    await ap.goto(h.appUi + `/#/p/${pid}/review`);
    await ap.waitForSelector(".rv-settings .rv-radio");
    // The member approves; approval is by a person, the proposer stays credited.
    await mp.goto(h.appUi + `/#/p/${pid}/review/${s.data.proposal_id}`);
    await mp.waitForSelector(".rv-decide");
    const state = await mp.evaluate(() => { const b = [...document.querySelectorAll(".rv-decide button")].find((x) => x.textContent.trim() === "Approve"); return { disabled: b.disabled, stale: /changed since this was proposed/.test(document.querySelector("main").innerText) }; });
    assert.deepEqual(state, { disabled: false, stale: false }, "a fresh proposal can be approved by the member");
    await mp.evaluate(() => [...document.querySelectorAll(".rv-decide button")].find((b) => b.textContent.trim() === "Approve").click());
    await mp.waitForFunction((id) => location.hash.endsWith("/a/" + id), {}, doc);
    assert.equal((await owner.req("GET", `/api/projects/${pid}/artifacts/${doc}`)).body.body, "one\ntwo\nthree\n");
  } finally { await browser.close(); }
});
