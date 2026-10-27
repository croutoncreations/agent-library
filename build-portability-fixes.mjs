// Portable deployment patch: configured API base for the UI, and operator-configured extra OAuth callbacks.
// Every replacement must match an exact number of times; preserve every other byte and all other auth policy.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = 'src/index.js';
const input = readFileSync(file, 'utf8');
let result = input;
const replacements = [
  ['return json({ principal: ctx.principal, csrf: ctx.csrf ?? null });', 'return json({ principal: ctx.principal, csrf: ctx.csrf ?? null, api_base: ctx.env.MCP_HOST ? originFor(ctx.env.MCP_HOST) + "/v1" : null });', 1],
  ['S.me = me.principal;', 'API_BASE_HINT = me.api_base || "See your installation configuration"; S.me = me.principal;', 2],
  // OAUTH_EXTRA_REDIRECT_URIS: exact https callbacks an installation trusts in addition to the built-in public
  // client callbacks (for example a self-run MCP gateway). Exact string match only: no wildcards, query or fragment.
  ['function allowedRedirect(u) {\n  return HOSTED_CALLBACKS.has(u) || ',
   '// Module-level is safe: vars belong to a Worker version and an isolate runs exactly one version, so every request\n' +
   '// in an isolate sees the same value. (The OAuth library does not pass env to clientRegistrationCallback.)\n' +
   'var EXTRA_CALLBACKS = /* @__PURE__ */ new Set(), extraCallbacksRaw = "";\n' +
   'function configureExtraCallbacks(env) {\n' +
   '  const raw = typeof env?.OAUTH_EXTRA_REDIRECT_URIS === "string" ? env.OAUTH_EXTRA_REDIRECT_URIS : "";\n' +
   '  if (raw === extraCallbacksRaw) return;\n' +
   '  extraCallbacksRaw = raw;\n' +
   '  EXTRA_CALLBACKS = new Set(raw.split(/[\\s,]+/).filter((u) => /^https:\\/\\/[a-z0-9.-]+(:\\d{1,5})?\\/[A-Za-z0-9\\/_.~-]*$/.test(u)));\n' +
   '}\n' +
   'function allowedRedirect(u) {\n  return HOSTED_CALLBACKS.has(u) || EXTRA_CALLBACKS.has(u) || ', 1],
  ['async function handleOAuthHost(req, env, ctx, host) {\n  const origin = originFor(host);\n',
   'async function handleOAuthHost(req, env, ctx, host) {\n  configureExtraCallbacks(env);\n  const origin = originFor(host);\n', 1],
];
for (const [before, after, count] of replacements) {
  if (result.split(before).length !== count + 1) throw Error('Portable deployment patch drift: ' + before);
  result = result.replaceAll(before, after);
}
const sha = s => createHash('sha256').update(s).digest('hex');
writeFileSync(file, result);
writeFileSync('portability-fixes-preservation.json', JSON.stringify({ input: sha(input), output: sha(result), replacements: replacements.map(([before,,count])=>({ before, count })) }, null, 2) + '\n');
