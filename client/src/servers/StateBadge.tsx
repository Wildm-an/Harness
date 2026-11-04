import { Circle, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import type { ServerState } from "../daemon/protocol";

const STATE_LABEL: Record<ServerState, string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  crashed: "Crashed",
};

/** The state as an icon and a word: the color is not the only sign. */
export function StateBadge({ state }: { state: ServerState }) {
  const Icon = state === "running" ? CircleCheck : state === "crashed" ? CircleX : state === "starting" ? LoaderCircle : Circle;
  return (
    <span className={`server-state state-${state}`}>
      <Icon size={13} aria-hidden className={state === "starting" ? "spin" : undefined} />
      {STATE_LABEL[state]}
    </span>
  );
}
