// Test entry: core with the PLAN_LIMITS entitlements (as the hosted Worker uses them) and no external sign-in.
import { createWorker, planEntitlements } from "../../packages/core/src/index.js";

export default createWorker({ entitlements: planEntitlements });
