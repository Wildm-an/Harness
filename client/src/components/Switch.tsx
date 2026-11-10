// The one switch of the app (audit C3). The label names the setting, not its state: screen readers
// read the state from aria-checked ("Prompt suggestions, switch, on").

export function Switch({ checked, label, disabled, onChange }: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden />
    </button>
  );
}
