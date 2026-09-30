// The icon of skills: the literal "/" character, as the / commands. It takes the props of a
// lucide icon, so it fits where a lucide icon goes (the top bar, the pane tabs).

import type { LucideIcon, LucideProps } from "lucide-react";

function Slash({ size = 24, className }: LucideProps) {
  const px = typeof size === "number" ? size : parseFloat(String(size)) || 24;
  return (
    <span
      className={`glyph-icon${className ? ` ${className}` : ""}`}
      style={{ width: px, height: px, fontSize: Math.round(px * 1.05) }}
      aria-hidden
    >
      /
    </span>
  );
}

export const SlashIcon = Slash as unknown as LucideIcon;
