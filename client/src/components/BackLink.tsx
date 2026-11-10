// The one back link of a detail view (audit C12): a small ghost button with a left arrow and the
// name of the view that it goes back to ("Routines", "Skills", "Your Harness", "Search results").

import { ArrowLeft } from "lucide-react";

export function BackLink({ to, onClick }: { to: string; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-small btn-ghost cap-back" onClick={onClick} aria-label={`Back to ${to}`}>
      <ArrowLeft size={14} aria-hidden />
      {to}
    </button>
  );
}
