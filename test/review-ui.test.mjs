// Review gating in the owner's browser (Chrome via Puppeteer): Home "Needs review" only when something waits, the review
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
    assert.equal(await page.evaluate(() => /Edits by apps and agents wait for your approval/.test(document.querySelector(".rv-docmode").textContent)), true);
    assert.equal((await owner.req("GET", base + "/artifacts/" + doc)).body.artifact.review, undefined, "choosing alone saves nothing");
    let asked = ""; page.once("dialog", (d) => { asked = d.message(); d.accept(); });
    await page.evaluate(() => [...document.querySelectorAll(".rv-docmode button")].find((b) => b.textContent === "Save review setting").click());
    await page.waitForFunction(() => /Review is now required/i.test(document.querySelector(".rv-docmode")?.textContent || "") || /Review required/.test(document.querySelector(".rv-chip")?.textContent || ""));
    assert.match(asked, /Version 1 counts as reviewed/);
    await page.waitForFunction(() => /Review required/.test(document.querySelector(".rv-chip")?.textContent || ""));
    assert.equal((await owner.req("GET", base + "/artifacts/" + doc)).body.artifact.review.mode, "required");
    await shot(page, "doc-setting");
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
    await page.goto(h.appUi + "/#/");
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
    await page.click('.rv-settings input[value="required"]');
    await page.evaluate(() => [...document.querySelectorAll(".rv-settings button")].find((b) => b.textContent === "Save").click());
    await page.waitForFunction(() => /Saved/.test(document.querySelector(".rv-settings .msg").textContent));
    assert.equal((await owner.req("GET", base + "/review-settings")).body.default, "required");
    await shot(page, "project-review-mobile");
    // Apply uses what the page shows (not a stale saved value), and says what it changes before it does.
    await page.click('.rv-settings input[value="off"]');
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
      await page.waitForSelector(".rv-newdoc:not([hidden]) select");
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
    // Connections: Can review toggle (owner only, per project).
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
