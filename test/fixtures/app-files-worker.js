// Test entry for App Files: the self-host Worker (Access sign-in) with PLAN_LIMITS entitlements, so a workspace's
// storage limit can be reached (402) in the App Connect harness. Plans not listed in PLAN_LIMITS are unlimited.
import { createWorker, planEntitlements } from "../../packages/core/src/index.js";
import { selfHostIdentity } from "../../packages/self-host/src/access-identity.js";

export default createWorker({ identity: selfHostIdentity, entitlements: planEntitlements });
