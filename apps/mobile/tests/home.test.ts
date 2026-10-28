import type { Automation, Notification, Project, Task } from "@talorys/shared";
import { describe, expect, it } from "vitest";
import { filterCatalog } from "../src/lib/connections";
import { buildUpcoming } from "../src/lib/home";
import { withOpenCounts } from "../src/lib/projects";
import { MAIN_THREAD_ID, mergeNotices, notificationThreadId, projectThreadId } from "../src/lib/threads";
import { describeWeather, parseWeather, weatherUrl } from "../src/lib/weather";

const NOW = Date.parse("2026-10-28T10:00:00Z");
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();
const task = (over: Partial<Task>): Task => ({ id: "t", title: "T", description: "", status: "todo", priority: "medium", due_at: null, project_id: null, created_at: iso(-999), updated_at: iso(-999), completed_at: null, ...over });
const auto = (over: Partial<Automation>): Automation =>
  ({ id: "a", name: "A", kind: "reminder", message: "", schedule: { type: "once", at: iso(60) }, schedule_description: "", enabled: true, status: "active", schedule_id: null, next_run: iso(60), last_run: null, last_result: null, last_error: null, run_count: 0, created_at: iso(-999), updated_at: iso(-999), ...over }) as Automation;
const note = (over: Partial<Notification>): Notification => ({ id: "n", title: "N", body: "", automation_id: null, read_at: null, created_at: iso(0), ...over });

describe("weather (Open-Meteo)", () => {
  it("asks for current conditions and today's high/low, no key", () => {
    const url = weatherUrl(32.0853, 34.7818);
    expect(url).toContain("api.open-meteo.com/v1/forecast");
    expect(url).toContain("latitude=32.085");
    expect(url).toContain("temperature_2m_max");
    expect(url).not.toMatch(/key|apikey/i);
  });
  it("parses a response and tolerates missing parts", () => {
    const w = parseWeather({ current: { time: "2026-10-28T12:00", temperature_2m: 24.4, apparent_temperature: 25.1, weather_code: 2, is_day: 1 }, daily: { temperature_2m_max: [27.2], temperature_2m_min: [18.9] } });
    expect(w).toMatchObject({ temperature: 24.4, code: 2, isDay: true, high: 27.2, low: 18.9 });
    expect(parseWeather({})).toBeNull();
    expect(parseWeather({ current: { temperature_2m: 10 } })).toMatchObject({ high: null, low: null, code: -1 });
  });
  it("maps WMO codes to labels and day/night icons", () => {
    expect(describeWeather(0, true)).toEqual({ key: "weather.clear", icon: "sun" });
    expect(describeWeather(0, false).icon).toBe("moon");
    expect(describeWeather(63).key).toBe("weather.rain");
    expect(describeWeather(95).icon).toBe("thunder");
    expect(describeWeather(1234).key).toBe("weather.unknown");
  });
});

describe("main chat with inline notifications", () => {
  it("uses the agent's thread ids", () => {
    expect(MAIN_THREAD_ID).toBe("main");
    expect(projectThreadId("p1")).toBe("project-p1");
    expect(notificationThreadId(null)).toBe("updates-inbox");
    expect(notificationThreadId("a/b")).toBe("updates-ab");
  });
  it("merges recent notifications into the messages by time", () => {
    const m = (id: string, at: number) => ({ id, conversation_id: "main", role: "user" as const, content: id, tools: [], status: "complete" as const, error: null, created_at: iso(at) });
    const rows = mergeNotices([m("m1", -30), m("m2", 0)], [note({ id: "n1", created_at: iso(-10) }), note({ id: "old", created_at: iso(-60 * 24 * 30) })], NOW);
    expect(rows.map((r) => r.id)).toEqual(["m1", "notice-n1", "m2"]);
    expect(mergeNotices([m("m1", 0)], [], NOW).map((r) => r.id)).toEqual(["m1"]);
  });
});

describe("Home: today & upcoming", () => {
  it("lists open tasks (overdue first by time) and reminders in the next 48 hours", () => {
    const items = buildUpcoming(
      [task({ id: "late", due_at: iso(-120) }), task({ id: "soon", due_at: iso(30) }), task({ id: "done", status: "done", due_at: iso(-5) })],
      [auto({ id: "r1", next_run: iso(45), message: "Call mom" }), auto({ id: "far", next_run: iso(60 * 72) }), auto({ id: "digest", kind: "task_digest", next_run: iso(10) }), auto({ id: "off", enabled: false, next_run: iso(5) })],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(["t-late", "t-soon", "a-r1"]);
    expect(items[0]).toMatchObject({ overdue: true });
    expect(items[2]).toMatchObject({ kind: "reminder", title: "Call mom" });
  });
});

describe("projects and connections", () => {
  it("counts open tasks per project", () => {
    const p = (id: string): Project => ({ id, name: id, description: "", status: "active", created_at: iso(0), updated_at: iso(0) });
    const rows = withOpenCounts([p("a"), p("b")], [task({ project_id: "a" }), task({ project_id: "a" }), task({ project_id: "a", status: "done" }), task({ project_id: null })]);
    expect(rows.map((r) => r.openTasks)).toEqual([2, 0]);
  });
  it("filters the catalog by English or Hebrew name and hides connected services", () => {
    const cat = [{ id: "gmail", name: "Gmail", he: "ג'ימייל" }, { id: "notion", name: "Notion", he: "נושן" }, { id: "github", name: "GitHub", he: "גיטהאב" }];
    expect(filterCatalog(cat, new Set(["github"]), "").map((s) => s.id)).toEqual(["gmail", "notion"]);
    expect(filterCatalog(cat, new Set(), "נוש").map((s) => s.id)).toEqual(["notion"]);
    expect(filterCatalog(cat, new Set(), "GIT").map((s) => s.id)).toEqual(["github"]);
  });
});
