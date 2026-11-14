// The microphone button of the prompt box, at the right of Send (docs/UI_RULES.md C2a). A click or a press
// records, and the prompt box gets the text at the caret. A right-click opens the menu: "Microphone", "Language",
// "Hold to record", and "Push to talk". The speech engine and the cleanup model are in lib/dictationEngine.ts.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Check, ChevronRight, LoaderCircle, Mic } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import {
  dictationHost,
  formatDuration,
  HOLD_MS,
  LANGUAGES,
  languageName,
  listMicrophones,
  MAX_RECORD_MS,
  microphoneError,
  onSpeechDownload,
  Recording,
  saveHold,
  savePushToTalk,
  savedPushToTalk,
  saveLanguage,
  saveMicrophone,
  savedHold,
  savedLanguage,
  savedMicrophone,
  transcribe,
  type Microphone,
} from "../lib/dictationEngine";

/** The key of dictation. In "Hold to record", a long press records until the release. */
export const DICTATION_KEY = "Ctrl+Shift+Space";

export function isDictationKey(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "Space";
}

type State = "idle" | "starting" | "recording" | "transcribing" | "cleaning";

/** A push-to-talk press shorter than this records nothing: the box gets no "No speech was heard" error. */
const PUSH_MIN_MS = 300;

// -- push to talk -------------------------------------------------------------------------------------------
// With "Push to talk" on, the window takes the key from any place (also the terminal and the editor). The key goes
// to the prompt box that had the focus last. A box that never had the focus counts by the time it came.

interface PushTarget {
  activeAt: number;
  disabled: () => boolean;
  down: () => void;
  up: () => void;
}

const targets = new Set<PushTarget>();
let held: PushTarget | null = null;
let listening = false;

/** The prompt box for push to talk: the one that had the focus last, and is not disabled. */
export function pushTarget<T extends { activeAt: number; disabled: () => boolean }>(list: Iterable<T>): T | null {
  let best: T | null = null;
  for (const t of list) if (!t.disabled() && (!best || t.activeAt >= best.activeAt)) best = t;
  return best;
}

function listenForPush(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const end = () => {
    const t = held;
    held = null;
    t?.up();
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if (!savedPushToTalk() || !isDictationKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || held) return;
      held = pushTarget(targets);
      held?.down();
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (held && (e.code === "Space" || e.key === "Shift" || e.key === "Control" || e.key === "Meta")) end();
    },
    true,
  );
  // The window lost the focus during the press: the release does not come, so stop now.
  window.addEventListener("blur", end);
}

/** The state of a dictation for the prompt box. ``listening``: the microphone records (the box shows the sound wave). */
export interface DictationStatus {
  text: string;
  listening: boolean;
}

/** The controls of the prompt box for the key and Esc. */
export interface DictationControls {
  press: () => void; // The key goes down, or a click.
  release: () => void; // The key goes up.
  cancel: () => boolean; // Esc: stops a recording and drops it. False: nothing was recording.
  focused: () => void; // The text box got the focus: push to talk goes to this box.
}

export const DictationButton = forwardRef<DictationControls, {
  disabled: boolean;
  onText: (text: string) => void; // The text for the caret of the prompt box.
  onStatus: (status: DictationStatus | null) => void; // "Listening 0:05", "Transcribing…", or null.
}>(function DictationButton({ disabled, onText, onStatus }, ref) {
  const [state, setState] = useState<State>("idle");
  const [menu, setMenu] = useState(false);
  const [sub, setSub] = useState(false); // The "Language" submenu.
  const [mics, setMics] = useState<Microphone[] | null>(null);
  const [mic, setMic] = useState(savedMicrophone);
  const [language, setLanguage] = useState(savedLanguage);
  const [hold, setHold] = useState(savedHold);
  const [push, setPush] = useState(savedPushToTalk);
  const [elapsed, setElapsed] = useState(0);
  const [download, setDownload] = useState<number | null>(null); // The percent of the first download of the speech model.
  const root = useRef<HTMLDivElement>(null);
  const recording = useRef<Recording | null>(null);
  const pressedAt = useRef<number | null>(null); // The time of the press that started the recording.
  const stateRef = useRef<State>("idle");
  stateRef.current = state;
  const languageRef = useRef(language);
  languageRef.current = language;
  useOverlay(menu);

  // The status for the prompt box.
  useEffect(() => {
    const status =
      state === "starting"
        ? "Starting the microphone…"
        : state === "recording"
          ? `Listening ${formatDuration(elapsed)}`
          : state === "transcribing"
            ? download !== null && download < 100
              ? `Downloading the speech model ${download}%`
              : "Transcribing…"
            : state === "cleaning"
              ? "Cleaning up…"
              : null;
    onStatus(status === null ? null : { text: status, listening: state === "recording" });
  }, [state, elapsed, download]);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => {
      const ms = Date.now() - (recording.current?.started ?? Date.now());
      setElapsed(ms);
      if (ms >= MAX_RECORD_MS) void finish();
    }, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => onSpeechDownload((p) => setDownload(p.total ? Math.floor((p.loaded / p.total) * 100) : null)), []);

  // A prompt box that goes away stops its recording.
  useEffect(
    () => () => {
      recording.current?.cancel();
      recording.current = null;
      onStatus(null);
    },
    [],
  );

  const showError = (text: string) => dictationHost()?.showError(text);

  const start = async () => {
    setState("starting");
    setElapsed(0);
    try {
      const rec = await Recording.start(mic);
      // A release or Esc during the start: stop at once.
      if (stateRef.current !== "starting") {
        rec.cancel();
        return;
      }
      recording.current = rec;
      setState("recording");
    } catch (e) {
      setState("idle");
      showError(microphoneError(e));
    }
  };

  const finish = async () => {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    pressedAt.current = null;
    setState("transcribing");
    try {
      const audio = await rec.stop();
      const raw = await transcribe(audio, languageRef.current || null);
      if (!raw) {
        showError("No speech was heard. Check the microphone: right-click the microphone button to choose another one.");
        return;
      }
      let text = raw;
      const host = dictationHost();
      if (host?.cleanupOn()) {
        setState("cleaning");
        const cleaned = await host.clean(raw);
        if (cleaned.error) showError(`The dictation was not cleaned up, so the box has the text as it was heard. ${cleaned.error}`);
        text = cleaned.text || raw;
      }
      onText(text);
    } catch (e) {
      showError(`The dictation did not work: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setState("idle");
      setDownload(null);
    }
  };

  const cancel = (): boolean => {
    if (stateRef.current === "starting") {
      setState("idle");
      return true;
    }
    if (stateRef.current !== "recording") return false;
    recording.current?.cancel();
    recording.current = null;
    pressedAt.current = null;
    setState("idle");
    return true;
  };

  const press = () => {
    if (disabled) return;
    if (stateRef.current === "idle") {
      pressedAt.current = Date.now();
      void start();
    } else if (stateRef.current === "recording") void finish();
  };

  // With "Hold to record", a long press stops at the release. A short press is a click: it records until the next click.
  const release = () => {
    const at = pressedAt.current;
    if (at === null) return;
    if (!hold || Date.now() - at < HOLD_MS) {
      pressedAt.current = null;
      return;
    }
    if (stateRef.current === "starting") cancel();
    else if (stateRef.current === "recording") void finish();
  };

  // Push to talk: the key down starts, and the key up stops, also after a short press.
  const pushDown = () => {
    if (disabled || stateRef.current !== "idle") return;
    pressedAt.current = Date.now();
    void start();
  };
  const pushUp = () => {
    const at = pressedAt.current;
    pressedAt.current = null;
    if (stateRef.current === "starting") cancel();
    else if (stateRef.current === "recording") {
      if (at !== null && Date.now() - at < PUSH_MIN_MS) cancel();
      else void finish();
    }
  };
  const pushRef = useRef({ down: pushDown, up: pushUp, disabled });
  pushRef.current = { down: pushDown, up: pushUp, disabled };
  const target = useRef<PushTarget | null>(null);
  useEffect(() => {
    const t: PushTarget = {
      activeAt: Date.now(),
      disabled: () => pushRef.current.disabled,
      down: () => pushRef.current.down(),
      up: () => pushRef.current.up(),
    };
    target.current = t;
    targets.add(t);
    listenForPush();
    return () => {
      targets.delete(t);
      if (held === t) held = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    press,
    release,
    cancel,
    focused: () => {
      if (target.current) target.current.activeAt = Date.now();
    },
  }));

  // The menu.
  useEffect(() => {
    if (!menu) return;
    void listMicrophones().then(setMics, () => setMics([]));
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener("mousedown", onDown);
    root.current?.querySelector<HTMLButtonElement>(".dictation-menu button")?.focus();
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu]);

  const closeMenu = () => {
    setMenu(false);
    setSub(false);
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (!menu) return;
    const inSub = !!(e.target as HTMLElement).closest(".model-submenu");
    if (e.key === "Escape" || (inSub && e.key === "ArrowLeft")) {
      e.preventDefault();
      e.stopPropagation();
      if (sub) {
        setSub(false);
        root.current?.querySelector<HTMLButtonElement>("[data-sub='language']")?.focus();
      } else {
        closeMenu();
        root.current?.querySelector<HTMLButtonElement>(".dictation-btn")?.focus();
      }
      return;
    }
    if (!inSub && (e.target as HTMLElement).dataset.sub && e.key === "ArrowRight") {
      e.preventDefault();
      setSub(true);
      window.setTimeout(() => {
        const panel = root.current?.querySelector(".model-submenu");
        (panel?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? panel?.querySelector<HTMLButtonElement>("button"))?.focus();
      });
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const scope = inSub ? ".model-submenu" : ".dictation-menu-main";
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>(`${scope} button`) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const chooseMic = (id: string) => {
    setMic(id);
    saveMicrophone(id);
    closeMenu();
  };
  // A saved microphone that is gone: the default microphone (the first one with no "default" entry) has the check mark.
  const checkedMic = mics?.some((m) => m.id === mic) ? mic : (mics?.find((m) => m.id === "default") ?? mics?.[0])?.id;

  const busy = state === "transcribing" || state === "cleaning";
  const live = state === "recording" || state === "starting";
  const tip = live
    ? hold
      ? `Stop and add the text (release, or click, ${DICTATION_KEY})`
      : `Stop and add the text (${DICTATION_KEY})`
    : busy
      ? "Transcribing"
      : hold
        ? `Dictate: hold, or click to start and stop (${push ? `hold ${DICTATION_KEY} to talk` : DICTATION_KEY})`
        : `Dictate (${push ? `hold ${DICTATION_KEY} to talk` : DICTATION_KEY})`;

  return (
    <div className="dictation" ref={root} onKeyDown={onMenuKey}>
      <button
        type="button"
        className={`icon-btn dictation-btn${live ? " recording" : ""}${menu ? " active" : ""}`}
        disabled={disabled || busy}
        aria-label={live ? "Stop dictation" : "Dictate"}
        aria-pressed={live}
        aria-haspopup="menu"
        aria-expanded={menu}
        title={tip}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault(); // Keep the focus in the text box.
          e.currentTarget.setPointerCapture(e.pointerId);
          press();
        }}
        onPointerUp={(e) => e.button === 0 && release()}
        onPointerCancel={() => release()}
        onClick={(e) => {
          // Enter or Space on the focused button (a pointer click has a detail of 1 or more).
          if (e.detail === 0) press();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!live) setMenu((v) => !v);
        }}
      >
        {busy ? <LoaderCircle size={16} className="spin" aria-hidden /> : <Mic size={16} aria-hidden />}
      </button>
      {menu && (
        <div className="menu model-dropdown up right dictation-menu" role="menu" aria-label="Dictation">
          <div className="dictation-menu-main">
            <div className="menu-heading">Microphone</div>
            {mics === null ? (
              <p className="menu-note">
                <LoaderCircle size={14} className="spin" aria-hidden /> Looking for microphones.
              </p>
            ) : mics.length === 0 ? (
              <p className="menu-note">No microphone is connected.</p>
            ) : (
              mics.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={m.id === checkedMic}
                  onClick={() => chooseMic(m.id)}
                  onMouseEnter={() => setSub(false)}
                  title={m.label}
                >
                  <span className="model-menu-name">{m.label}</span>
                  <span className="model-menu-end">{m.id === checkedMic && <Check size={15} className="model-menu-check" aria-hidden />}</span>
                </button>
              ))
            )}
            <div className="menu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              data-sub="language"
              aria-haspopup="menu"
              aria-expanded={sub}
              onClick={() => setSub((v) => !v)}
              onMouseEnter={() => setSub(true)}
            >
              <span className="model-menu-name">Language</span>
              <span className="model-menu-end">
                <span className="model-menu-detail">{languageName(language)}</span>
                <ChevronRight size={15} aria-hidden />
              </span>
            </button>
            <div className="menu-sep" role="separator" />
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={hold}
              onClick={() => {
                setHold(!hold);
                saveHold(!hold);
              }}
              onMouseEnter={() => setSub(false)}
            >
              <span className="model-menu-name">Hold to record</span>
              <span className="model-menu-end">
                <span className={`switch${hold ? " on" : ""}`} aria-hidden>
                  <span className="switch-knob" />
                </span>
              </span>
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={push}
              title={`The microphone records while you hold ${DICTATION_KEY}, from any place in the window.`}
              onClick={() => {
                setPush(!push);
                savePushToTalk(!push);
              }}
              onMouseEnter={() => setSub(false)}
            >
              <span className="model-menu-name">Push to talk</span>
              <span className="model-menu-end">
                <span className={`switch${push ? " on" : ""}`} aria-hidden>
                  <span className="switch-knob" />
                </span>
              </span>
            </button>
          </div>
          {sub && (
            <div className="menu model-submenu dictation-languages" role="menu" aria-label="Language">
              {LANGUAGES.map(([code, name]) => (
                <button
                  key={code || "auto"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={code === language}
                  onClick={() => {
                    setLanguage(code);
                    saveLanguage(code);
                    closeMenu();
                  }}
                >
                  <span className="model-menu-name">{name}</span>
                  <span className="model-menu-end">{code === language && <Check size={15} className="model-menu-check" aria-hidden />}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
