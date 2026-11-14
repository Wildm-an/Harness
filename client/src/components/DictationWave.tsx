// The dictation meter under the prompt box (docs/UI_RULES.md C2a): the status ("Listening 0:05"), then the sound
// wave while the microphone records. The wave has thin bars of the sound level: the newest level is at the right,
// and the bars move to the left. In a narrow window, only the wave shows (the status text goes to a hidden line).

import { useEffect, useState } from "react";
import { onSoundLevel } from "../lib/dictationEngine";

export const WAVE_BARS = 20;

/** The heights of the bars, from 0 to 1: the old levels move to the left, and the new level comes in at the right. */
export function nextLevels(levels: readonly number[], level: number): number[] {
  return [...levels.slice(1 - WAVE_BARS), level];
}

export function DictationWave() {
  const [levels, setLevels] = useState<number[]>(() => Array(WAVE_BARS).fill(0));
  useEffect(() => onSoundLevel((level) => setLevels((old) => nextLevels(old, level))), []);
  return (
    <div className="dictation-wave" role="img" aria-label="Sound level of the microphone">
      {levels.map((level, i) => (
        <span key={i} style={{ height: `${Math.round(3 + level * 11)}px` }} />
      ))}
    </div>
  );
}

/** The status and the wave. The items go from the right (row-reverse), and an item that does not fit wraps to a
 * second line that does not show: the wave stays, and the status text goes first. */
export function DictationMeter({ status, listening }: { status: string; listening: boolean }) {
  return (
    <div className={`dictation-meter${listening ? " listening" : ""}`} aria-hidden>
      {listening && <DictationWave />}
      <span className="dictation-meter-status">{status}</span>
    </div>
  );
}
