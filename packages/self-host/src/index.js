// Self-hosted Agent Library: core with no usage limits beyond core's own. Sign-in: Cloudflare Access (one owner) by
// default, or any OpenID Connect provider when OIDC_ISSUER is set (docs/self-hosting.md#sign-in-with-oidc).
// This is the entry `npm run build` bundles into dist/worker/index.js.
import { createWorker } from "../../core/src/index.js";
import { selfHostIdentity } from "./access-identity.js";

export default createWorker({ identity: selfHostIdentity });
