// "Model by network" at the top of Settings > Providers: a default model for an online computer, and
// a local model for an offline computer. The daemon checks the provider of the online model when a
// session starts with "Default model" (server.py default_model_for_network). Off: the choice is manual.

import { useEffect } from "react";
import type { ProviderItem, UserSettings } from "../daemon/protocol";
import type { ModelList } from "./ModelMenu";

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;

/** True for a provider on this computer, for example Ollama or llama.cpp on localhost. */
export function isLocalProvider(p: Pick<ProviderItem, "base_url" | "ssh">): boolean {
  if (p.ssh) return false;
  try {
    return LOCAL_HOSTS.test(new URL(p.base_url).hostname);
  } catch {
    return false;
  }
}

/** The models of the local providers, from a list of "provider/model" items. */
export function localModels(models: readonly string[], providers: readonly ProviderItem[]): string[] {
  const local = new Set(providers.filter(isLocalProvider).map((p) => p.name));
  return models.filter((m) => local.has(m.split("/")[0]));
}

function ModelSelect({ id, value, options, empty, disabled, onChange }: {
  id: string;
  value: string | null | undefined;
  options: string[];
  empty: string;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  // A saved model that the list does not have (for example a provider that is off) stays a choice.
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select id={id} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{empty}</option>
      {all.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

export function ModelChoice({ values, models, providers, onRequestModels, onSet }: {
  values: UserSettings | null; // null: not connected.
  models: ModelList | null;
  providers: ProviderItem[] | null;
  onRequestModels: () => void;
  onSet: (changes: Partial<UserSettings>) => void;
}) {
  useEffect(() => {
    if (models === null) onRequestModels();
  }, [models === null]);
  const off = values === null;
  const auto = values?.auto_model === true;
  const all = models?.items ?? [];
  const local = localModels(all, providers ?? []);
  return (
    <div className="model-choice" aria-labelledby="model-choice-title">
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label" id="model-choice-title">
            Preferred providers
          </span>
          <span className="setting-help">
            On: a new session with "Default model" uses the default model. With no connection to its provider (for example with no Wi-Fi), it uses the
            local model. An old session whose model is not available changes to one of these models when it opens. Off: you choose the model for
            each session.
          </span>
        </div>
        <div className="setting-control">
          <button
            type="button"
            role="switch"
            aria-checked={auto}
            aria-label="Preferred providers"
            disabled={off}
            className={`switch${auto ? " on" : ""}`}
            onClick={() => onSet({ auto_model: !auto })}
          >
            <span className="switch-knob" aria-hidden />
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <label htmlFor="setting-online-model">Default model</label>
          <span className="setting-help">The model when the computer is online. It can be from any provider.</span>
        </div>
        <div className="setting-control">
          <ModelSelect
            id="setting-online-model"
            value={values?.online_model}
            options={all}
            empty={models === null ? "Loading…" : "Not set"}
            disabled={off || !auto}
            onChange={(v) => onSet({ online_model: v })}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <label htmlFor="setting-offline-model">Local model</label>
          <span className="setting-help">
            {local.length === 0 && models !== null
              ? "No local model is on. Add one on the Local Models page (Ollama or llama.cpp on this computer)."
              : "The model when the default model cannot connect. It runs on this computer."}
          </span>
        </div>
        <div className="setting-control">
          <ModelSelect
            id="setting-offline-model"
            value={values?.offline_model}
            options={local}
            empty={models === null ? "Loading…" : "Not set"}
            disabled={off || !auto}
            onChange={(v) => onSet({ offline_model: v })}
          />
        </div>
      </div>
    </div>
  );
}
