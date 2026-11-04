import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { ModelMenu, type ModelList } from "./ModelMenu";

/**
 * The prompt in the chat for a session whose model no provider gives now. The user selects an
 * available model and clicks "Switch", or dismisses the prompt. The switch applies to the next turn.
 */
export function ModelUnavailable({
  model,
  reason,
  models,
  proposed,
  disabled,
  onRequestModels,
  onSwitch,
  onDismiss,
  onManage,
}: {
  model: string; // "provider/model" of the session.
  reason: string | null; // Why the daemon cannot use the model, if it knows.
  models: ModelList | null;
  proposed: string; // The model that the menu shows first.
  disabled: boolean;
  onRequestModels: () => void;
  onSwitch: (spec: string) => void;
  onDismiss: () => void;
  onManage: () => void;
}) {
  const [choice, setChoice] = useState(proposed);
  useEffect(() => {
    // A new list can remove the chosen model: use the proposed model again.
    if (!choice || !models?.items.includes(choice)) setChoice(proposed);
  }, [proposed, models]);

  return (
    <section className="wrapup-box model-unavailable" aria-label="Model not available">
      <p className="wrapup-ask model-unavailable-title">
        <TriangleAlert size={15} aria-hidden />
        <span>
          {/* The full name: the short name can be the same as the name of an available model. */}
          The model <span className="mono">{model}</span> is not available
        </span>
      </p>
      <p className="wrapup-recap">
        {reason ? `${reason.replace(/\.?$/, ".")} ` : "Its provider does not give it now. "}
        Switch this session to an available model?
      </p>
      <div className="wrapup-actions">
        {models && models.items.length === 0 ? (
          <button type="button" className="btn btn-small btn-primary" onClick={onManage}>
            Manage the connections
          </button>
        ) : (
          <>
            <ModelMenu value={choice} models={models} allowDefault={false} up onOpen={onRequestModels} onSelect={setChoice} onManage={onManage} />
            <button type="button" className="btn btn-small btn-primary" disabled={disabled || !choice} onClick={() => onSwitch(choice)}>
              Switch
            </button>
          </>
        )}
        <button type="button" className="btn btn-small" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </section>
  );
}
