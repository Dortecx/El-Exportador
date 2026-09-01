import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const server = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

describe("manual add partial-success safety", () => {
  it("only returns success when the backend confirms every submitted unique video ID", () => {
    expect(server).toContain("result?.success !== true || !Number.isInteger(addedCount) || addedCount !== videoIds.length");
    expect(server).toContain('res.status(502).json({ error: "Could not confirm all selected tracks were added" })');
    expect(server).toContain("res.json({ success: true, count: addedCount })");
  });

  it("keeps the manual review unchanged unless the full submitted set is confirmed", () => {
    const confirmation = "if (!response.ok || payload?.success !== true || !Number.isInteger(payload?.count) || payload.count !== tracks.length)";
    const confirmationIndex = html.indexOf(confirmation);
    const clearSelectionsIndex = html.indexOf("manualSelections.clear();", confirmationIndex);

    expect(confirmationIndex).toBeGreaterThan(-1);
    expect(html).toContain("const addedCount = payload.count;");
    expect(clearSelectionsIndex).toBeGreaterThan(confirmationIndex);
  });
});
