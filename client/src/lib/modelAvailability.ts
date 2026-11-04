import type { ModelList } from "../components/ModelMenu";

/** The provider part of "provider/model". */
export function providerOf(spec: string): string {
  const slash = spec.indexOf("/");
  return slash > 0 ? spec.slice(0, slash) : "";
}

/** Ollama gives "name:latest" for a model that the user can also call "name". */
function sameModel(a: string, b: string): boolean {
  const plain = (s: string) => (s.endsWith(":latest") ? s.slice(0, -":latest".length) : s);
  return a === b || plain(a) === plain(b);
}

/** The model of the list that is the same as ``spec``, or null. */
export function listedModel(spec: string, models: ModelList | null): string | null {
  return models?.items.find((m) => sameModel(m, spec)) ?? null;
}

/**
 * True when no provider gives the model of the session now:
 *
 * - The daemon found that the provider of the model is gone or off (``daemonReason``).
 * - Or the provider gives a model list, and the model is not in it (for example, a deleted Ollama model).
 *
 * A provider that did not answer, or that gives no list (a plugin provider), is not a reason: the model can still work.
 */
export function isModelUnavailable(spec: string, models: ModelList | null, daemonReason?: string | null): boolean {
  if (!spec || listedModel(spec, models)) return false;
  if (daemonReason) return true;
  if (!models) return false;
  const provider = providerOf(spec);
  return models.items.some((m) => providerOf(m) === provider);
}

/**
 * The model by network ("Preferred providers" in Settings > Providers), or null if it is off.
 * The online model when its provider gives it now, else the local model. The model list shows which
 * providers answer, as the connection check of the daemon does for a new session.
 */
export function networkModel(
  settings: { auto_model?: boolean; online_model?: string | null; offline_model?: string | null } | null,
  models: ModelList | null,
): string | null {
  if (!settings?.auto_model || !models) return null;
  for (const spec of [settings.online_model, settings.offline_model]) {
    const found = spec ? listedModel(spec, models) : null;
    if (found) return found;
  }
  return null;
}

/** The model to propose: the first preferred model in the list, else the first model of the list. */
export function proposedModel(models: ModelList | null, preferred: string[]): string {
  if (!models) return "";
  for (const spec of preferred) {
    const found = spec ? listedModel(spec, models) : null;
    if (found) return found;
  }
  return models.items[0] ?? "";
}
