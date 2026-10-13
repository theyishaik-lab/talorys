import { describe, expect, it } from "vitest";
import { createSseParser } from "../src/lib/api";

describe("SSE parser", () => {
  it("parses frames split across chunks and ignores event lines", () => {
    const events: unknown[] = [];
    const feed = createSseParser((e) => events.push(e));
    feed('event: start\ndata: {"type":"start","conversation_id":"c1","user_message_id":"u1","assistant_message_id":"a1"}\n\nevent: text\ndata: {"type":"te');
    expect(events).toHaveLength(1);
    feed('xt","delta":"שלום"}\n\n');
    expect(events).toEqual([
      { type: "start", conversation_id: "c1", user_message_id: "u1", assistant_message_id: "a1" },
      { type: "text", delta: "שלום" },
    ]);
  });

  it("skips malformed frames and keeps going", () => {
    const events: unknown[] = [];
    const feed = createSseParser((e) => events.push(e));
    feed("data: not json\n\ndata: {\"type\":\"text\",\"delta\":\"ok\"}\n\n");
    expect(events).toEqual([{ type: "text", delta: "ok" }]);
  });
});
