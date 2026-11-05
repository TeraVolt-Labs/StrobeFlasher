import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("offline single-file production build", () => {
  it("inlines application assets and contains no network access", () => {
    const files = readdirSync("dist");
    const html = readFileSync("dist/index.html", "utf8");

    expect(files).toEqual(["index.html"]);
    expect(html).toContain("<style");
    expect(html).toMatch(/<script[^>]*type="module"[^>]*>/);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link[^>]+\bhref=/i);
    expect(html).not.toMatch(/\bfetch\s*\(/i);
    expect(html).not.toMatch(/https?:\/\//i);
  });
});