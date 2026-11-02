// Self-hosted Agent Library: core with the Cloudflare Access identity adapter and no usage limits beyond core's own.
// This is the entry `npm run build` bundles into dist/worker/index.js.
import { createWorker } from "../../core/src/index.js";
import { accessIdentity } from "./access-identity.js";

export default createWorker({ identity: accessIdentity });
