// A field for a secret (a token, an API key, a password) with a show and hide button (audit C10), as
// the API key field of a provider. The button keeps the focus in the field, so a field that saves when
// the focus leaves it does not save on the click.

import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

export function SecretInput({ what = "the text", ...input }: InputHTMLAttributes<HTMLInputElement> & {
  what?: string; // For the button label: "Show the token".
}) {
  const [shown, setShown] = useState(false);
  const label = `${shown ? "Hide" : "Show"} ${what}`;
  return (
    <span className="key-field secret-field">
      <input {...input} type={shown ? "text" : "password"} />
      <button
        type="button"
        className="icon-btn ghost key-field-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((v) => !v)}
        disabled={!input.value || input.disabled}
        aria-pressed={shown}
        aria-label={label}
        title={label}
      >
        {shown ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
      </button>
    </span>
  );
}
