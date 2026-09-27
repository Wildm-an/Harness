// API keys of model providers (SPEC.md section 9).
//
// The keys are in the keychain of the operating system, one for each daemon connection and
// provider name. The daemon gets a key over the connection after it connects, and keeps it in
// memory only. In a normal browser (development) there is no keychain: the key stays in session
// storage and is lost when the tab closes.

import { isTauri, secretDelete, secretGet, secretSet } from "./tauri";

const name = (connectionId: string, provider: string) => `provider:${connectionId}:${provider}`;

export async function loadProviderKey(connectionId: string, provider: string): Promise<string | null> {
  if (isTauri()) return secretGet(name(connectionId, provider));
  try {
    return window.sessionStorage.getItem(`harness.${name(connectionId, provider)}`);
  } catch {
    return null;
  }
}

export async function saveProviderKey(connectionId: string, provider: string, key: string): Promise<void> {
  if (isTauri()) return secretSet(name(connectionId, provider), key);
  try {
    window.sessionStorage.setItem(`harness.${name(connectionId, provider)}`, key);
  } catch {
    // No storage: the daemon keeps the key until it stops.
  }
}

export async function deleteProviderKey(connectionId: string, provider: string): Promise<void> {
  if (isTauri()) return secretDelete(name(connectionId, provider));
  try {
    window.sessionStorage.removeItem(`harness.${name(connectionId, provider)}`);
  } catch {
    // Nothing to remove.
  }
}

/** The Hugging Face token of a daemon connection (the Cookbook). It uses the same storage as the provider keys. */
export const loadHfToken = (connectionId: string) => loadProviderKey(connectionId, "__huggingface__");
export const saveHfToken = (connectionId: string, token: string) => saveProviderKey(connectionId, "__huggingface__", token);
export const deleteHfToken = (connectionId: string) => deleteProviderKey(connectionId, "__huggingface__");

/** Moves a key to a new provider name. */
export async function renameProviderKey(connectionId: string, from: string, to: string): Promise<void> {
  const key = await loadProviderKey(connectionId, from);
  if (!key) return;
  await saveProviderKey(connectionId, to, key);
  await deleteProviderKey(connectionId, from);
}
