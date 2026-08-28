import { describe, expect, it } from "vitest";
import { isMutation, type VaultOperation } from "../src/shared/protocol.js";

describe("vault protocol", () => {
  it("classifies every write operation as a mutation", () => {
    const operations: VaultOperation[] = [
      { kind: "vault_status" },
      { kind: "read_note", path: "Note.md" },
      {
        kind: "create_note",
        request_id: crypto.randomUUID(),
        path: "Note.md",
        content: "",
      },
      {
        kind: "delete_file",
        request_id: crypto.randomUUID(),
        path: "Note.md",
        expected_revision: "0".repeat(64),
      },
    ];
    expect(operations.map(isMutation)).toEqual([false, false, true, true]);
  });
});
