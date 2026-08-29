import { describe, expect, it } from "vitest";
import { adminPage, homePage } from "../src/auth/pages.js";

const SOURCE_URL = "https://github.com/jkxyz/obsidian-sync-mcp";

describe("interactive source offer", () => {
  it("links the public source and AGPL license from public pages", async () => {
    const html = await homePage().text();

    expect(html).toContain(`href="${SOURCE_URL}"`);
    expect(html).toContain("AGPL-3.0-or-later");
    expect(html).toContain("No warranty");
  });

  it("links the public source from the authenticated admin page", async () => {
    const html = await adminPage({
      email: "owner@example.com",
      csrf: "csrf",
      configured: false,
    }).text();

    expect(html).toContain(`href="${SOURCE_URL}"`);
  });
});
