import { afterEach, describe, expect, it } from "vitest";
import { NoResponseError, WebSerialTransport } from "../src/transport/webserial";
import {
  encodeKey,
  encodeLd,
  encodeLdcs,
  encodeLds,
  encodeRepeat,
  encodeSt,
  encodeStcs,
  encodeSts,
  UpdiLink
} from "../src/updi/link";
import { MockUpdiTarget } from "./mock/mockUpdiTarget";

const transports: WebSerialTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close().catch(() => undefined)));
});

describe("UPDI instruction encodings", () => {
  it("matches the datasheet instruction fields", () => {
    expect(encodeLds(1, 0)).toBe(0x04);
    expect(encodeSts(1, 0)).toBe(0x44);
    expect(encodeLd(0, 0)).toBe(0x20);
    expect(encodeLd(1, 1)).toBe(0x25);
    expect(encodeSt(2, 1)).toBe(0x69);
    expect(encodeLdcs(0x0f)).toBe(0x8f);
    expect(encodeStcs(0x0f)).toBe(0xcf);
    expect(encodeRepeat(0)).toBe(0xa0);
    expect(encodeKey(0)).toBe(0xe0);
  });
});

describe("UPDI link over Web Serial transport", () => {
  it("reads the ATtiny412 signature from the mock target", async () => {
    const target = new MockUpdiTarget();
    const transport = await WebSerialTransport.open(target.port);
    transports.push(transport);
    const link = new UpdiLink(transport);

    const device = await link.connect();

    expect(Array.from(device.signature)).toEqual([0x1e, 0x92, 0x23]);
    expect(device.name).toBe("ATtiny412");
    expect(device.updiRevision).toBe(2);
    expect(device.breakPath).toBe("signals");
    expect(target.port.openOptions[0]).toEqual({
      baudRate: 115_200,
      dataBits: 8,
      parity: "even",
      stopBits: 2
    });
    expect(target.controlRegisters[3]).toBe(0x08);
    expect(target.controlRegisters[2]).toBe(0x80);
  });

  it("uses the 300-baud break fallback and restores 8E2", async () => {
    const target = new MockUpdiTarget({ supportsBreakSignals: false });
    const transport = await WebSerialTransport.open(target.port);
    transports.push(transport);

    await expect(transport.sendBreak()).resolves.toBe("baud-trick");
    expect(target.port.openOptions.map(({ baudRate, stopBits }) => [baudRate, stopBits])).toEqual([
      [115_200, 2],
      [300, 1],
      [115_200, 2]
    ]);
  });

  it("times out when the target echoes but does not respond", async () => {
    const target = new MockUpdiTarget({ noResponse: true });
    const transport = await WebSerialTransport.open(target.port, 115_200, 10);
    transports.push(transport);
    const link = new UpdiLink(transport);

    await expect(link.initialize()).rejects.toBeInstanceOf(NoResponseError);
  });
});