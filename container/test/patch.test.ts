import { describe, expect, it } from "vitest";
import { applyPatches } from "../src/patch.js";

describe("exact note patches", () => {
  it("applies patches in order", () => {
    expect(
      applyPatches("# Title\nold\n", [
        { type: "replace", old_text: "old", new_text: "new" },
        { type: "insert_after", anchor: "# Title", text: "\nintro" },
        { type: "append", text: "tail\n" },
      ]),
    ).toBe("# Title\nintro\nnew\ntail\n");
  });

  it("fails without making a partial result observable when an anchor count differs", () => {
    expect(() =>
      applyPatches("same same", [
        { type: "prepend", text: "changed " },
        {
          type: "replace",
          old_text: "same",
          new_text: "different",
          expected_occurrences: 1,
        },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "patch_conflict",
        details: { expected: 1, actual: 2 },
      }),
    );
  });
});
