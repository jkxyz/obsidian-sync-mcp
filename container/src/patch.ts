import type { PatchOperation } from "./protocol.js";
import { VaultOperationError } from "./protocol.js";

function occurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while (true) {
    const found = text.indexOf(needle, position);
    if (found < 0) return count;
    count += 1;
    position = found + needle.length;
  }
}

function assertOccurrences(
  text: string,
  needle: string,
  expected: number,
): void {
  const actual = occurrences(text, needle);
  if (actual !== expected) {
    throw new VaultOperationError(
      "patch_conflict",
      `Patch anchor matched ${actual} times; expected ${expected}`,
      { expected, actual },
    );
  }
}

export function applyPatches(
  original: string,
  patches: PatchOperation[],
): string {
  let current = original;
  for (const operation of patches) {
    switch (operation.type) {
      case "prepend":
        current = operation.text + current;
        break;
      case "append":
        current += operation.text;
        break;
      case "replace": {
        const expected = operation.expected_occurrences ?? 1;
        assertOccurrences(current, operation.old_text, expected);
        current = current.split(operation.old_text).join(operation.new_text);
        break;
      }
      case "insert_before": {
        const expected = operation.expected_occurrences ?? 1;
        assertOccurrences(current, operation.anchor, expected);
        current = current
          .split(operation.anchor)
          .join(`${operation.text}${operation.anchor}`);
        break;
      }
      case "insert_after": {
        const expected = operation.expected_occurrences ?? 1;
        assertOccurrences(current, operation.anchor, expected);
        current = current
          .split(operation.anchor)
          .join(`${operation.anchor}${operation.text}`);
        break;
      }
    }
  }
  return current;
}
