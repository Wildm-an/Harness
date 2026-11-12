// A field for a secret (a token, an API key, a password) with a show and hide button (audit C10), as
// the API key field of a provider. The button keeps the focus in the field, so a field that saves when
// the focus leaves it does not save on the click. With `copy`, a second button copies the secret.
// The built-in reveal button of the WebView is hidden (styles.css): it cannot show a value that the
// app filled in, and two eye buttons confused the user.

import { useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";

export function SecretInput({ what = "the text", copy = false, ...input }: InputHTMLAttributes<HTMLInputElement> & {
  what?: string; // For the button labels: "Show the token", "Copy the token".
  copy?: boolean; // Add a copy button at the right of the show button.
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const label = `${shown ? "Hide" : "Show"} ${what}`;
  const value = typeof input.value === "string" ? input.value : "";
  const copyValue = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span className={`key-field secret-field${copy ? " has-copy" : ""}`}>
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
      {copy && (
        <button
          type="button"
          className="icon-btn ghost key-field-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={copyValue}
          disabled={!value.trim() || input.disabled}
          aria-label={`Copy ${what}`}
          title={copied ? "Copied" : `Copy ${what}`}
        >
          {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
        </button>
      )}
    </span>
  );
}

/**
 * A multi-line secret, for example a private key. An input cannot keep line breaks, so this is a
 * textarea. While it is hidden, CSS draws each character as a dot (`.secret-hidden`).
 */
export function SecretTextArea({ what = "the text", className, ...area }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  what?: string; // For the button label: "Show the private key".
}) {
  const [shown, setShown] = useState(false);
  const label = `${shown ? "Hide" : "Show"} ${what}`;
  return (
    <span className="key-field secret-field secret-area">
      <textarea
        rows={4}
        spellCheck={false}
        autoComplete="off"
        {...area}
        className={`mono${shown ? "" : " secret-hidden"}${className ? ` ${className}` : ""}`}
      />
      <button
        type="button"
        className="icon-btn ghost key-field-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((v) => !v)}
        disabled={!area.value || area.disabled}
        aria-pressed={shown}
        aria-label={label}
        title={label}
      >
        {shown ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
      </button>
    </span>
  );
}
