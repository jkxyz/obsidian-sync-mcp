import { describe, expect, it } from "vitest";
import { sameSafetyObservation } from "../src/service.js";
import type { GitSafetyEvent } from "../src/protocol.js";

function event(overrides: Partial<GitSafetyEvent> = {}): GitSafetyEvent {
  return {
    event_id: "11111111-1111-4111-8111-111111111111",
    phase: "remote_mirror",
    created_at: "2026-08-29T16:30:00.000Z",
    safe_tree: "a".repeat(40),
    candidate_tree: "b".repeat(40),
    remote_head: "c".repeat(40),
    remote_version: 1444,
    remote_digest: "d".repeat(64),
    previous_files: 300,
    candidate_files: 3,
    deleted_files: 297,
    previous_bytes: 10_000_000,
    deleted_bytes: 9_000_000,
    reasons: ["at_least_half_of_paths", "at_least_quarter_of_bytes"],
    paths: ["Notes/A.md", "Notes/B.md"],
    path_count: 297,
    ...overrides,
  };
}

describe("scheduled safety confirmation", () => {
  it("confirms the same stable destructive observation", () => {
    const first = {
      event: event(),
      paths: ["Notes/B.md", "Notes/A.md", "Notes/C.md"],
    };
    const second = {
      event: event({
        event_id: "22222222-2222-4222-8222-222222222222",
        created_at: "2026-08-29T16:31:00.000Z",
        reasons: ["at_least_quarter_of_bytes", "at_least_half_of_paths"],
      }),
      paths: ["Notes/C.md", "Notes/A.md", "Notes/B.md"],
    };

    expect(sameSafetyObservation(first, second)).toBe(true);
  });

  it("does not confirm a refreshed candidate from a different Sync version", () => {
    const first = { event: event(), paths: ["Notes/A.md"] };
    const refreshed = {
      event: event({
        event_id: "22222222-2222-4222-8222-222222222222",
        created_at: "2026-08-29T16:31:00.000Z",
        remote_version: 1445,
      }),
      paths: ["Notes/A.md"],
    };

    expect(sameSafetyObservation(first, refreshed)).toBe(false);
  });

  it("does not confirm a different deletion manifest", () => {
    const first = { event: event(), paths: ["Notes/A.md", "Notes/B.md"] };
    const refreshed = {
      event: event({
        event_id: "22222222-2222-4222-8222-222222222222",
        created_at: "2026-08-29T16:31:00.000Z",
      }),
      paths: ["Notes/A.md", "Notes/C.md"],
    };

    expect(sameSafetyObservation(first, refreshed)).toBe(false);
  });
});
