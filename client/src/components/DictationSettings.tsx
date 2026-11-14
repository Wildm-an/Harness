// Settings > General > Dictation (docs/UI_RULES.md, the setting map). The speech engine needs no setting:
// the user can always dictate. "Clean up dictation" adds a model of a provider or a local model that cleans
// the text before it goes in the prompt box.

import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { ProviderItem, UserSettings } from "../daemon/protocol";
import { loadSpeechModel, onSpeechDownload, SPEECH_MODEL_LABEL, speechModelCached } from "../lib/dictationEngine";
import { localModels } from "./ModelChoice";
import type { ModelList } from "./ModelMenu";
import { Row, Switch } from "./SettingsDialog";
import { RowsPending } from "./Skeleton";

/** The choices of "Cleanup model": the models of the providers on the internet, then the local models. */
export function cleanupChoices(models: readonly string[], providers: readonly ProviderItem[]): { online: string[]; local: string[] } {
  const local = localModels(models, providers);
  return { online: models.filter((m) => !local.includes(m)), local };
}

function SpeechModelRow() {
  // null: checking the cache. A number: the percent of a download that runs.
  const [cached, setCached] = useState<boolean | null>(null);
  const [download, setDownload] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void speechModelCached().then(setCached);
    return onSpeechDownload((p) => setDownload(p.total ? Math.floor((p.loaded / p.total) * 100) : 0));
  }, []);
  const start = () => {
    setError(null);
    setDownload(0);
    loadSpeechModel().then(
      () => {
        setDownload(null);
        setCached(true);
      },
      (e: unknown) => {
        setDownload(null);
        setError(`The download did not finish: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };
  return (
    <>
      <Row
        label="Speech model"
        help={`${SPEECH_MODEL_LABEL} changes your speech to text on this computer. The app downloads it (about 100 MB) the first time you dictate. Then dictation works offline. It uses the GPU when the computer has one. Right-click the microphone button to choose the microphone and the language.`}
      >
        {download !== null ? (
          <span className="setting-value">
            <LoaderCircle size={13} className="spin" aria-hidden /> Downloading {download}%
          </span>
        ) : cached === null ? (
          <span className="setting-value">Checking…</span>
        ) : cached ? (
          <span className="setting-value">Downloaded</span>
        ) : (
          <button type="button" className="btn btn-small" onClick={start}>
            Download
          </button>
        )}
      </Row>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function DictationSettings({ values, connected, models, providers, onRequestModels, onSet }: {
  values: UserSettings | null; // null: loading, or not connected.
  connected: boolean;
  models: ModelList | null; // null: not loaded yet.
  providers: ProviderItem[] | null;
  onRequestModels: () => void;
  onSet: (changes: Partial<UserSettings>) => void;
}) {
  const off = !connected || values === null;
  const on = values?.dictation_cleanup === true;
  useEffect(() => {
    if (on && models === null && connected) onRequestModels();
  }, [on, models === null, connected]);
  const { online, local } = cleanupChoices(models?.items ?? [], providers ?? []);
  const value = values?.dictation_model ?? "";
  const missing = value && !online.includes(value) && !local.includes(value);
  return (
    <>
      <h3 className="settings-section">Dictation</h3>
      <SpeechModelRow />
      <RowsPending.Provider value={connected && values === null}>
        <Row
          label="Clean up dictation"
          help="A model removes filler words, fixes the punctuation, and writes code words as code. Off: the prompt box gets the text as it was heard."
        >
          <Switch checked={on} label="Clean up dictation" disabled={off} onChange={(next) => onSet({ dictation_cleanup: next })} />
        </Row>
        {on && (
          <Row
            label="Cleanup model"
            child
            htmlFor="setting-dictation-model"
            help={
              value
                ? "A small, fast model works best. A local model keeps your words on this computer."
                : "Choose a model. Until then, the prompt box gets the text as it was heard."
            }
          >
            <select id="setting-dictation-model" value={value} disabled={off} onChange={(e) => onSet({ dictation_model: e.target.value || null })}>
              <option value="">{models === null ? "Loading…" : "Not set"}</option>
              {missing && <option value={value}>{value} (not available)</option>}
              {online.length > 0 && (
                <optgroup label="Providers">
                  {online.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              )}
              {local.length > 0 && (
                <optgroup label="Local models">
                  {local.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Row>
        )}
      </RowsPending.Provider>
    </>
  );
}
