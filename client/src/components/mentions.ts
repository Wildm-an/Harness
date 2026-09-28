/** The "@" references of the prompt box: files and folders of the project, and other sessions. */

export interface MentionSession {
  id: string;
  title: string | null;
  cwd: string;
  updated_at: number;
}

export type MentionItem = { kind: "file"; path: string } | { kind: "session"; session: MentionSession };

// The menu shows this many sessions. The daemon gives at most 40 files.
export const MAX_MENTION_SESSIONS = 6;

/** The "@" token at the caret: its start and the text after "@". null if the caret is not in one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** The name of a session in the prompt: its title in quotes. A quote in the title becomes an apostrophe. */
export function sessionLabel(session: MentionSession): string {
  return `"${(session.title ?? "Untitled session").replace(/"/g, "'")}"`;
}

/** The text that a reference adds to the prompt, without the "@". A session shows its name. */
export function mentionToken(item: MentionItem): string {
  return item.kind === "file" ? item.path : sessionLabel(item.session);
}

/** The prompt for the daemon: each @"name" of a known session becomes @session:<id>. */
export function resolveSessionRefs(text: string, refs: ReadonlyMap<string, string>): string {
  return text.replace(/(^|\s)@("[^"\n]*")/g, (whole, space: string, label: string) => {
    const id = refs.get(label);
    return id ? `${space}@session:${id}` : whole;
  });
}

/** Replace the "@query" at ``start`` with the reference. Return the new text and the new caret. */
export function insertMention(text: string, caret: number, start: number, token: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const insert = `@${token}${after.startsWith(" ") ? "" : " "}`;
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length };
}

/** The sessions whose title has the query (no case), in the order of the list. */
export function filterSessions(sessions: MentionSession[], query: string, limit = MAX_MENTION_SESSIONS): MentionSession[] {
  const q = query.toLowerCase();
  return sessions.filter((s) => !q || (s.title ?? "").toLowerCase().includes(q) || s.id.startsWith(q)).slice(0, limit);
}
