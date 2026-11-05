import { describe, expect, it } from "vitest";
import { crc32 } from "../src/image/crc32";

describe("CRC32", () => {
  it("matches the standard IEEE test vector", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});