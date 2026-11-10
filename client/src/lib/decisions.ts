// The text of each answer to a permission request (docs/UI_RULES.md M8). The answered card and the
// tool row of the call (audit R1) use it.

import type { Decision } from "../daemon/protocol";

export const DECIDED: Record<Decision, string> = {
  allow_once: "Allowed once",
  allow_always: "Always allowed",
  deny: "Denied",
};
