// The Changelog page of the Settings dialog: CHANGELOG.md at the root of the repository, built
// into the app. The page shows the file from its first version heading: the page has its own title.

import changelog from "../../../CHANGELOG.md?raw";
import { Markdown } from "./Markdown";

const start = changelog.search(/^## /m);
const body = start >= 0 ? changelog.slice(start) : changelog;

export function ChangelogPage({ appVersion }: { appVersion: string | null }) {
  return (
    <div className="settings-page changelog-page">
      <div className="settings-page-head">
        <h2 className="settings-page-title">Changelog</h2>
        {appVersion && <span className="settings-status">This version: {appVersion}</span>}
      </div>
      <Markdown text={body} />
    </div>
  );
}
