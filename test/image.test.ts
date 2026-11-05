import { describe, expect, it } from "vitest";
import { loadBin } from "../src/image/bin";
import { parseIntelHex, IntelHexError } from "../src/image/ihex";
import { FirmwareImage } from "../src/image/image";

describe("Intel HEX parser", () => {
  it("parses data, EOF, and data-space Flash addresses", () => {
    const image = parseIntelHex([
      ":040000008001020376",
      ":00000001FF"
    ].join("\n"));

    expect(image.segments).toEqual([{ addr: 0, data: Uint8Array.of(0x80, 1, 2, 3) }]);
  });

  it("handles extended linear and segment address records", () => {
    const image = parseIntelHex([
      ":020000040000FA",
      ":020000020010EC",
      ":01000000A55A",
      ":00000001FF"
    ].join("\n"));

    expect(image.segments[0]).toEqual({ addr: 0x100, data: Uint8Array.of(0xa5) });
  });

  it("reports checksum errors with their line number", () => {
    expect(() => parseIntelHex(":010000000000\n:00000001FF"))
      .toThrow(new IntelHexError(1, "checksum is invalid."));
  });

  it("rejects out-of-range data and records after EOF", () => {
    expect(() => parseIntelHex(":0110000001EE\n:00000001FF"))
      .toThrow("Line 1: address 0x1000 is outside ATtiny412 Flash.");
    expect(() => parseIntelHex(":00000001FF\n:0100000000FF"))
      .toThrow("Line 2: data appears after the end-of-file record.");
  });
});

describe("FirmwareImage", () => {
  it("pads sparse data with 0xFF and sorts pages", () => {
    const image = new FirmwareImage([
      { addr: 66, data: Uint8Array.of(0x22) },
      { addr: 1, data: Uint8Array.of(0x11) }
    ]);

    const pages = image.toPages(64);
    expect(pages.map((page) => page.addr)).toEqual([0, 64]);
    expect(pages[0]!.data[0]).toBe(0xff);
    expect(pages[0]!.data[1]).toBe(0x11);
    expect(pages[1]!.data[2]).toBe(0x22);
    expect(pages[1]!.data[0]).toBe(0xff);
  });

  it("loads BIN at offset zero and enforces the Flash capacity", () => {
    expect(loadBin(Uint8Array.of(0x01, 0x02)).segments[0]).toEqual({
      addr: 0,
      data: Uint8Array.of(0x01, 0x02)
    });
    expect(() => loadBin(new Uint8Array(4097))).toThrow("larger than the 4 KB ATtiny412 Flash");
  });
});