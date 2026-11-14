// Settings > General > "Local sandbox" (docs/UI_RULES.md 9.3, docs/SANDBOX.md). The label is the label of the
// Claude app. The switch writes sandbox.enabled in ~/.harness/settings.json (daemon "sandbox.set"). The other
// sandbox keys (the domains, the folders, the excluded commands) stay in the settings file.

import { useEffect, useState } from "react";
import type { SandboxStatus } from "../daemon/protocol";
import { Row } from "./SettingsDialog";
import { Switch } from "./Switch";

export const SANDBOX_LABEL = "Local sandbox";
export const SANDBOX_HELP =
  "The bash commands of the agent run with limits: writes only in the project folder, and no network except the allowed domains. Applies to the next command.";

const BACKENDS: Record<string, string> = { seatbelt: "Seatbelt", bubblewrap: "bubblewrap" };

/** The help text of the row: the description, then the state of the daemon computer. */
export function sandboxHelp(status: SandboxStatus | null | undefined): string {
  if (!status) return SANDBOX_HELP;
  if (status.state === "ready") return `${SANDBOX_HELP} Ready (${BACKENDS[status.backend] ?? status.backend}): ${status.reason}`;
  if (status.state === "unavailable" || status.available === false) return `${SANDBOX_HELP} Not available: ${status.reason}`;
  return SANDBOX_HELP;
}

/** The reason that the switch cannot turn the sandbox on (rule R5), or null. A switch that is on can always turn off. */
export function sandboxLock(status: SandboxStatus | null | undefined): string | null {
  if (!status) return "Update the daemon to change this setting.";
  if (status.state === "off" && status.available === false) return status.reason;
  return null;
}

/** The "Local sandbox" row. status: from the user_settings message. null: loading, an older daemon, or no connection. */
export function SandboxSetting({ status, disabled, onSet }: {
  status: SandboxStatus | null | undefined;
  disabled: boolean; // Not connected, or the values load.
  onSet: (enabled: boolean) => void;
}) {
  const on = status ? status.state !== "off" : false;
  // The value that the user chose, until the daemon sends the new status. An error leaves the old status.
  const [saving, setSaving] = useState<boolean | null>(null);
  useEffect(() => setSaving(null), [status]);
  useEffect(() => {
    if (saving === null) return;
    const timer = window.setTimeout(() => setSaving(null), 5000);
    return () => window.clearTimeout(timer);
  }, [saving]);
  const lock = on || disabled ? null : sandboxLock(status);
  return (
    <Row label={SANDBOX_LABEL} help={sandboxHelp(status)} title={lock ?? undefined}>
      <Switch
        checked={saving ?? on}
        label={SANDBOX_LABEL}
        disabled={disabled || saving !== null || lock !== null}
        onChange={(next) => {
          setSaving(next);
          onSet(next);
        }}
      />
    </Row>
  );
}
