import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import { inQuietHours, runProactiveScan } from "../src/proactive/engine";

const ns = () => (env as unknown as { TalorysAgent: DurableObjectNamespace<TalorysAgent> }).TalorysAgent;

function freshAgent() {
  const name = `proactive-${crypto.randomUUID()}`;
  return async <R>(fn: (agent: TalorysAgent, state: DurableObjectState) => R | Promise<R>): Promise<R> =>
    runInDurableObject(await getAgentByName(ns(), name), async (agent: TalorysAgent, state: DurableObjectState) => fn(agent, state));
}

const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/** Quiet hours disabled (start === end). */
function enableProactive(agent: TalorysAgent) {
  agent.services.settings.update({ proactive: { enabled: true, quietStartHour: 0, quietEndHour: 0, maxPerRun: 5 } });
}

describe("inQuietHours", () => {
  it("is false when start === end (disabled)", () => {
    expect(inQuietHours(3, 0, 0)).toBe(false);
  });
  it("handles a same-day window", () => {
    expect(inQuietHours(10, 9, 17)).toBe(true);
    expect(inQuietHours(8, 9, 17)).toBe(false);
  });
  it("wraps past midnight", () => {
    expect(inQuietHours(23, 22, 7)).toBe(true);
    expect(inQuietHours(3, 22, 7)).toBe(true);
    expect(inQuietHours(12, 22, 7)).toBe(false);
  });
});

describe("proactive engine (Phase 1, no AI)", () => {
  it("is skipped when disabled", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const res = await runProactiveScan(agent.services);
      expect(res.status).toBe("skipped");
      expect(agent.services.suggestions.list()).toHaveLength(0);
    });
  });

  it("surfaces suggestions for overdue and due-today tasks, and dedupes on re-scan", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      enableProactive(agent);
      agent.services.tasks.create({ title: "Pay rent", due_at: daysFromNow(-2), priority: "high" });
      agent.services.tasks.create({ title: "Call dentist", due_at: daysFromNow(0), priority: "medium" });

      const first = await runProactiveScan(agent.services);
      expect(first.status).toBe("success");
      const items = agent.services.suggestions.list();
      expect(items.length).toBe(2);
      // Overdue outranks due-today.
      expect(items[0]?.title).toContain("Overdue");

      // A one-time "new suggestions" notification was created.
      expect(agent.services.notifications.unreadCount()).toBeGreaterThan(0);

      // Re-scanning the same signals creates nothing new (dedupe by signal_hash).
      const second = await runProactiveScan(agent.services);
      expect(second.status).toBe("success");
      expect(agent.services.suggestions.list().length).toBe(2);
    });
  });

  it("respects maxPerRun", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      agent.services.settings.update({ proactive: { enabled: true, quietStartHour: 0, quietEndHour: 0, maxPerRun: 1 } });
      agent.services.tasks.create({ title: "A", due_at: daysFromNow(-1), priority: "urgent" });
      agent.services.tasks.create({ title: "B", due_at: daysFromNow(-1), priority: "low" });
      await runProactiveScan(agent.services);
      expect(agent.services.suggestions.list().length).toBe(1);
    });
  });

  it("dismiss hides a suggestion from the open list", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      enableProactive(agent);
      agent.services.tasks.create({ title: "Pay rent", due_at: daysFromNow(-2), priority: "high" });
      await runProactiveScan(agent.services);
      const [first] = agent.services.suggestions.list();
      expect(first).toBeTruthy();
      agent.services.suggestions.setStatus(first!.id, "dismissed");
      expect(agent.services.suggestions.list().some((s) => s.id === first!.id)).toBe(false);
    });
  });
});
