// The logos of the connectors (connectors.py), for the Connectors tab and the MCP server rows.
// Each connector shows the logo of its service. A connector with no logo here shows the plug icon.
//
// To add a logo: take the official mark from the service (its press kit or its own icon set),
// keep it as one SVG path with fill="currentColor", and list its source and license in
// THIRD_PARTY_LICENSES.md (section 5).
//
// Exception: Microsoft does not permit its product icons without a license, so Microsoft Outlook
// shows a generic mail icon (lucide "Mail") next to its full name. The user chose this.
//
// GitHub: "mark-github-24" from Primer Octicons 19.42.0 (https://github.com/primer/octicons),
// MIT License, Copyright (c) 2026 GitHub Inc. The GitHub logo is a trademark of GitHub, Inc.
// Harness uses it only to name the GitHub connector.

import { Mail, Plug, type LucideIcon } from "lucide-react";

/** Connectors that show a generic icon, because the terms of the brand do not permit its logo. */
const GLYPHS: Record<string, LucideIcon> = {
  outlook: Mail,
};

const LOGOS: Record<string, { viewBox: string; path: string }> = {
  github: {
    viewBox: "0 0 24 24",
    path:
      "M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943",
  },
};

/** True if Harness has a logo for the connector. */
export function hasConnectorLogo(id: string | null | undefined): boolean {
  return !!id && id in LOGOS;
}

/** The logo of a connector, in the text color. The plug icon for a connector with no logo. */
export function ConnectorLogo({ id, size = 16 }: { id: string | null | undefined; size?: number }) {
  const logo = id ? LOGOS[id] : undefined;
  if (!logo) {
    const Glyph = (id && GLYPHS[id]) || Plug;
    return <Glyph size={size - 1} aria-hidden />;
  }
  return (
    <svg width={size} height={size} viewBox={logo.viewBox} fill="currentColor" aria-hidden focusable="false">
      <path d={logo.path} />
    </svg>
  );
}
