import { describe, expect, it } from "vitest";
import { MIGRATIONS, LATEST_SCHEMA_VERSION, migrate } from "../src/db/migrations";
import { runProactiveScan } from "../src/proactive/engine";
import { syncProactiveSchedule } from "../src/proactive/schedule";
import { rankCandidates } from "../src/proactive/ranker";
import type { AIProvider } from "../src/ai/provider";
import { client, inAgent, loggedIn } from "./helpers";

describe("audit regressions", () => {
  it("rejects cross-task and completion proposals and preserves the deterministic fallback", async () => {
    await inAgent(async (a) => {
      const candidates = [{ kind: "reminder", title: "Review", body: "Due", signalHash: "audit-rank", score: 100, meta: { taskId: "task-one" } }];
      const provider = (value: unknown) => ({ id: "mock", generate: async () => ({ text: JSON.stringify(value), usage: { inputTokens: 1, outputTokens: 1 } }) }) as AIProvider;
      const call = (value: unknown) => rankCandidates(candidates, provider(value), a.services.usage, a.services.settings.get().limits);
      expect((await call([{ signalHash: "audit-rank", score: 90, proposed_tool: "update_task", proposed_input: { task: "other", due: "2026-11-01" } }]))[0]?.proposedTool).toBeNull();
      expect((await call([{ signalHash: "audit-rank", score: 90, proposed_tool: "complete_task", proposed_input: { task: "task-one" } }]))[0]?.proposedTool).toBeNull();
      expect((await call([{ signalHash: "audit-rank", score: 90, proposed_tool: "update_task", proposed_input: { task: "task-one", due: "2026-11-01" } }]))[0]?.proposedTool).toBe("update_task");
      expect(await call({ not: "an array" })).toEqual(candidates);
    });
  });
  it("applies the action log after v10 without losing stored tasks", async () => {
    await inAgent((a) => {
      const db = a.services.db;
      const task = a.services.tasks.create({ title: "Keep during upgrade" });
      db.run("DROP TABLE IF EXISTS tal_action_log");
      db.run("UPDATE tal_schema SET version = 10 WHERE id = 1");
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.one("SELECT name FROM sqlite_master WHERE name = 'tal_action_log'")).toBeTruthy();
      expect(a.services.tasks.get(task.id)?.title).toBe(task.title);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(MIGRATIONS.every((m, i) => !i || m.version > MIGRATIONS[i - 1]!.version)).toBe(true);
    });
  });

  it("routes the catalog independently of connection status and enforces auth", async () => {
    expect((await client().call("/api/connections/catalog")).status).toBe(401);
    const c = await loggedIn();
    const response = await c.call("/api/connections/catalog");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false, services: expect.any(Array) });
    expect((await c.call("/api/suggestions?limit=5")).status).toBe(200);
    expect((await c.call("/api/suggestions?limit=oops")).status).toBe(400);
  });

  it("creates one managed schedule, updates its interval, and disables it", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      s.settings.update({ proactive: { enabled: true, scanEveryHours: 2 } });
      await syncProactiveSchedule(s);
      await syncProactiveSchedule(s);
      let scans = s.automations.list().filter((item) => item.name === "Talorys proactive scan");
      expect(scans).toHaveLength(1);
      expect(scans[0]?.schedule).toEqual({ type: "interval", minutes: 120 });
      expect(scans[0]?.schedule_id).toBeTruthy();
      s.settings.update({ proactive: { scanEveryHours: 4 } });
      await syncProactiveSchedule(s);
      expect(s.automations.get(scans[0]!.id)?.schedule).toEqual({ type: "interval", minutes: 240 });
      s.settings.update({ proactive: { enabled: false } });
      await syncProactiveSchedule(s);
      scans = s.automations.list().filter((item) => item.name === "Talorys proactive scan");
      expect(scans[0]?.enabled).toBe(false);
      expect(scans[0]?.schedule_id).toBeNull();
    });
  });

  it("does not resurface a dismissed signal or let duplicates starve other tasks", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      s.settings.update({ proactive: { enabled: true, quietStartHour: 0, quietEndHour: 0, maxPerRun: 1 } });
      s.tasks.create({ title: "First audit task", due_at: "2000-01-01T00:00:00.000Z" });
      s.tasks.create({ title: "Second audit task", due_at: "2000-01-02T00:00:00.000Z" });
      await runProactiveScan(s);
      const first = s.suggestions.list()[0]!;
      s.suggestions.setStatus(first.id, "dismissed");
      await runProactiveScan(s);
      expect(s.suggestions.get(first.id)?.status).toBe("dismissed");
      expect(s.suggestions.list().some((item) => item.title === first.title)).toBe(false);
      expect(s.suggestions.list().length).toBeGreaterThan(0);
      const stale = s.suggestions.create({ kind: "reminder", title: "Expired", body: "old", signalHash: crypto.randomUUID(), ttlMs: -1 });
      expect(s.suggestions.list().some((item) => item.id === stale?.id)).toBe(false);
      s.settings.update({ proactive: { enabled: false } });
      await syncProactiveSchedule(s);
    });
  });
});
