import { describe, expect, it } from "vitest";
import type { ProjectItem, RoutineItem } from "../daemon/protocol";
import { placeOf } from "../layout/history";
import { activity, checkDraft, cronToSchedule, curlExample, describeSchedule, fieldsOf, fireUrl, formatWhen, newDraft, routineFile, runState, scheduleToCron } from "./RoutinesPage";

const routine = (extra: Partial<RoutineItem> = {}): RoutineItem => ({
  id: "r1",
  error: null,
  name: "Daily check",
  prompt: "Check it",
  cwd: "C:/p",
  provider: null,
  model: null,
  permission_mode: "default",
  schedule: "0 9 * * *",
  enabled: true,
  created_at: 1,
  updated_at: 1,
  last_fire_at: 1,
  next_fire_at: 2,
  last_run: null,
  running: false,
  queued: false,
  ...extra,
});

const run = (status: "running" | "waiting" | "done" | "failed" | "skipped") => ({
  id: "x",
  routine_id: "r1",
  session_id: "s1",
  fire_at: 1,
  started_at: 1,
  ended_at: null,
  status,
  error: null,
});

describe("the schedule", () => {
  it("makes cron text from a choice and back", () => {
    for (const cron of ["15 * * * *", "30 9 * * *", "0 8 * * 1-5", "45 17 * * 5", "*/10 * * * *", "0 9 1 * *"]) {
      expect(scheduleToCron(cronToSchedule(cron))).toBe(cron);
    }
    expect(cronToSchedule("0 8 * * 1-5").kind).toBe("weekdays");
    expect(cronToSchedule("45 17 * * 7")).toMatchObject({ kind: "weekly", day: 0 });
    expect(cronToSchedule("*/10 * * * *").kind).toBe("custom");
  });

  it("describes a schedule in words", () => {
    expect(describeSchedule("0 * * * *")).toBe("Every hour");
    expect(describeSchedule("5 * * * *")).toBe("Every hour at :05");
    expect(describeSchedule("30 9 * * *")).toBe("Every day at 09:30");
    expect(describeSchedule("0 8 * * 1-5")).toBe("Every weekday at 08:00");
    expect(describeSchedule("0 8 * * 1")).toBe("Every Monday at 08:00");
    expect(describeSchedule("0 9 1 * *")).toBe("Cron: 0 9 1 * *");
  });
});

describe("the form", () => {
  const projects: ProjectItem[] = [
    { id: "a", name: "gone", path: "C:/gone", exists: false, sessions: 0, created_at: 1, last_used: 2 },
    { id: "b", name: "app", path: "C:/app", exists: true, sessions: 0, created_at: 1, last_used: 1 },
  ];

  it("starts a new routine in the first folder that exists", () => {
    expect(newDraft(projects).cwd).toBe("C:/app");
  });

  it("starts a new routine in the default permission mode of the settings", () => {
    expect(newDraft(projects).permission_mode).toBe("default");
    expect(newDraft(projects, "acceptEdits").permission_mode).toBe("acceptEdits");
  });

  it("finds the errors", () => {
    const d = { ...newDraft([]), schedule: { kind: "custom" as const, minute: 0, hour: 9, day: 1, cron: "0 9 *" } };
    expect(checkDraft(d)).toEqual({
      name: "Enter a name.",
      prompt: "Enter the prompt.",
      cwd: "Choose a folder.",
      schedule: "A cron expression has 5 fields, for example 0 9 * * 1-5.",
    });
    const ok = { ...newDraft(projects), name: " Daily ", prompt: "Do it" };
    expect(checkDraft(ok)).toEqual({});
    expect(fieldsOf(ok)).toMatchObject({ name: "Daily", model: null, schedule: "0 9 * * 1-5", cwd: "C:/app" });
  });
});

describe("the state of a routine", () => {
  it("is active or inactive", () => {
    expect(activity(routine())).toBe("active");
    expect(activity(routine({ enabled: false }))).toBe("inactive");
    expect(activity(routine({ error: "schedule: bad" }))).toBe("inactive");
  });

  it("shows the run state next to it", () => {
    expect(runState(routine())).toBeNull();
    expect(runState(routine({ last_run: run("done") }))).toBeNull();
    expect(runState(routine({ last_run: run("failed") }))).toBe("failed");
    expect(runState(routine({ running: true, last_run: run("running") }))).toBe("running");
    expect(runState(routine({ running: true, last_run: run("waiting") }))).toBe("waiting");
    expect(runState(routine({ queued: true, enabled: false }))).toBe("queued");
    expect(runState(routine({ error: "bad", running: true }))).toBe("file_error");
  });

  it("names the file of a routine", () => {
    expect(routineFile("C:\\Users\\me\\.harness\\routines", "daily")).toBe("C:\\Users\\me\\.harness\\routines\\daily.md");
    expect(routineFile("/home/me/.harness/routines/", "daily")).toBe("/home/me/.harness/routines/daily.md");
  });

  it("formats times near today", () => {
    const now = new Date(2026, 10, 4, 12, 0).getTime() / 1000;
    expect(formatWhen(new Date(2026, 10, 4, 9, 5).getTime() / 1000, now)).toBe("Today at 09:05");
    expect(formatWhen(new Date(2026, 10, 5, 9, 0).getTime() / 1000, now)).toBe("Tomorrow at 09:00");
    expect(formatWhen(new Date(2026, 10, 3, 23, 0).getTime() / 1000, now)).toBe("Yesterday at 23:00");
  });

  it("is a place in the history", () => {
    expect(placeOf("routines", null)).toEqual({ screen: "routines" });
  });
});

describe("the API trigger of a routine", () => {
  it("gives the fire URL and the example request", () => {
    const url = fireUrl("http://127.0.0.1:47615", "daily check");
    expect(url).toBe("http://127.0.0.1:47615/routines/daily%20check/fire");
    const curl = curlExample(url);
    expect(curl.split("\n")[0]).toBe(`curl -X POST ${url} \\`);
    expect(curl).toContain('-H "Authorization: Bearer $TOKEN"');
    expect(curl).toContain(`-d '{"text": "optional extra text after the prompt"}'`);
  });
});
