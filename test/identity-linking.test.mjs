// Link a new sign-in identity to an existing person by verified email (packages/core/src/identity/accounts.js,
// identity.linkVerifiedEmail): the real principalForIdentity against every migration (node:sqlite, test/sqlite-world.mjs).
// No listener. Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorker } from "./load-worker.mjs";
import * as W from "./sqlite-world.mjs";

const lib = await loadWorker({ "identity/accounts.js": ["principalForIdentity"], "adapters.js": ["withAdapters", "resolveAdapters"] });
const GOOGLE = "https://google.example.test", SUPA = "https://supabase.example.test/auth/v1", GITHUB = "https://github.example.test";

/** A world and an env whose identity adapter opts in (or not) to linking, with open sign-up like hosted. */
function setup({ link = true } = {}) {
  const world = W.mkWorld();
  const identity = { browserSignIn: () => true, createAccounts: () => true, ...(link ? { linkVerifiedEmail: () => true } : {}) };
  const env = lib.withAdapters({ DB: world.DB }, lib.resolveAdapters({ identity }));
  return { world, env };
}
const ident = (issuer, subject, email, emailVerified = true) => ({ issuer, subject, email, emailVerified });
const people = (world) => W.one(world, "SELECT COUNT(*) AS n FROM principals WHERE kind = 'human'").n;
const links = (world, principal) => W.all(world, "SELECT issuer, subject, email FROM upstream_identities WHERE principal_id = ? ORDER BY issuer", principal);
const audits = (world) => W.all(world, "SELECT actor_id, action, object_id, result FROM audits WHERE action = 'identity.linked'");

test("a verified email matching exactly one person links the new sign-in to that person, once, with an audit row", async () => {
  const { world, env } = setup();
  const first = await lib.principalForIdentity(env, ident(SUPA, "sb-ada", "ada@example.test"));
  assert.equal(first.created, true);
  const viaGoogle = await lib.principalForIdentity(env, ident(GOOGLE, "g-ada", "ada@example.test"));
  assert.deepEqual(viaGoogle, { principalId: first.principalId, created: false });
  assert.equal(people(world), 1);
  assert.deepEqual(links(world, first.principalId), [
    { issuer: GOOGLE, subject: "g-ada", email: "ada@example.test" }, { issuer: SUPA, subject: "sb-ada", email: "ada@example.test" }]);
  // The audit names the person and the provider, never the email address.
  assert.deepEqual(audits(world), [{ actor_id: first.principalId, action: "identity.linked", object_id: GOOGLE, result: "ok" }]);
  // Signing in again through the new link is the same person and writes no second audit row.
  assert.equal((await lib.principalForIdentity(env, ident(GOOGLE, "g-ada", "ada@example.test"))).principalId, first.principalId);
  assert.equal(audits(world).length, 1);
  // A third provider links the same way.
  assert.equal((await lib.principalForIdentity(env, ident(GITHUB, "gh-ada", "ada@example.test"))).principalId, first.principalId);
  assert.equal(audits(world).length, 2);
});

test("an unverified email never links (and never creates an account)", async () => {
  const { world, env } = setup();
  const ada = await lib.principalForIdentity(env, ident(SUPA, "sb-ada", "ada@example.test"));
  await assert.rejects(lib.principalForIdentity(env, ident(GOOGLE, "g-ada", "ada@example.test", false)), { code: "email_unverified" });
  assert.equal(people(world), 1);
  assert.deepEqual(links(world, ada.principalId).map((l) => l.issuer), [SUPA]);
  assert.deepEqual(audits(world), []);
});

test("two people with the same email are ambiguous: no link, the sign-in becomes its own account", async () => {
  const { world, env } = setup();
  const a = await lib.principalForIdentity(env, ident(SUPA, "sb-1", "shared@example.test"));
  // A second person holding the same address (a case this code never creates, so the fixture writes it).
  W.run(world, "INSERT INTO principals (id, kind, issuer, subject, label, created_at, email) VALUES ('hum_other', 'human', 'synthetic', 'other', 'Other', '2026-11-11T00:00:00.000Z', 'Shared@example.test')");
  const g = await lib.principalForIdentity(env, ident(GOOGLE, "g-1", "shared@example.test"));
  assert.equal(g.created, true);
  assert.notEqual(g.principalId, a.principalId);
  assert.notEqual(g.principalId, "hum_other");
  assert.deepEqual(links(world, a.principalId).map((l) => l.issuer), [SUPA]);
  assert.deepEqual(audits(world), []);
});

test("a person who already has a link from the same issuer is never linked to a different subject of it", async () => {
  const { world, env } = setup();
  const first = await lib.principalForIdentity(env, ident(GOOGLE, "g-old-owner", "work@example.test"));
  // Through another provider the same person gets a second link, so the email is verified twice over.
  assert.equal((await lib.principalForIdentity(env, ident(SUPA, "sb-work", "work@example.test"))).principalId, first.principalId);
  // The address was reassigned: Google now says a different human (new subject) holds it. They must not inherit the library.
  const newHolder = await lib.principalForIdentity(env, ident(GOOGLE, "g-new-owner", "work@example.test"));
  assert.equal(newHolder.created, true);
  assert.notEqual(newHolder.principalId, first.principalId);
  assert.deepEqual(links(world, first.principalId).map((l) => l.subject), ["g-old-owner", "sb-work"]);
  assert.deepEqual(audits(world).map((a) => a.object_id), [SUPA]);
});

test("without the adapter's opt-in (self-host) a matching verified email creates a separate account", async () => {
  const { world, env } = setup({ link: false });
  const a = await lib.principalForIdentity(env, ident(SUPA, "sb-ada", "ada@example.test"));
  const g = await lib.principalForIdentity(env, ident(GOOGLE, "g-ada", "ada@example.test"));
  assert.equal(g.created, true);
  assert.notEqual(g.principalId, a.principalId);
  assert.equal(people(world), 2);
  assert.deepEqual(audits(world), []);
});

test("a person without a link carrying their email (restored or local account) is not matched", async () => {
  const { world, env } = setup();
  W.run(world, "INSERT INTO principals (id, kind, issuer, subject, label, created_at, email) VALUES ('hum_restored', 'human', 'restored', 'r1', 'Restored', '2026-11-11T00:00:00.000Z', 'ada@example.test')");
  const g = await lib.principalForIdentity(env, ident(GOOGLE, "g-ada", "ada@example.test"));
  assert.equal(g.created, true);
  assert.notEqual(g.principalId, "hum_restored");
  assert.deepEqual(audits(world), []);
});

test("an existing link records the verified email (so accounts made before linking can be matched later)", async () => {
  const { world, env } = setup();
  const a = await lib.principalForIdentity(env, ident(SUPA, "sb-ada", "ada@example.test"));
  W.run(world, "UPDATE upstream_identities SET email = '' WHERE subject = 'sb-ada'");
  await lib.principalForIdentity(env, ident(SUPA, "sb-ada", "ada@example.test"));
  assert.deepEqual(links(world, a.principalId), [{ issuer: SUPA, subject: "sb-ada", email: "ada@example.test" }]);
  assert.equal((await lib.principalForIdentity(env, ident(GOOGLE, "g-ada", "ada@example.test"))).principalId, a.principalId);
});
