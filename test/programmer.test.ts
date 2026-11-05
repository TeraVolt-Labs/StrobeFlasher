import { afterEach, describe, expect, it, vi } from "vitest";
import { NoResponseError, PortError } from "../src/transport/webserial";
import { LockedError, NvmWriteError, VerifyError } from "../src/updi/errors";
import { FirmwareImage } from "../src/image/image";
import { SerialUpdiProgrammer } from "../src/updi/programmer";
import { NvmController, TINY412 } from "../src/updi/nvm";
import { WrongDeviceError, type UpdiLink } from "../src/updi/link";
import { MockUpdiTarget, type MockUpdiTargetOptions } from "./mock/mockUpdiTarget";

const programmers: SerialUpdiProgrammer[] = [];

afterEach(async () => {
  await Promise.all(programmers.splice(0).map((programmer) => programmer.disconnect().catch(() => undefined)));
});

describe("SerialUpdiProgrammer", () => {
  it("writes and verifies a full 4 KB image against the mock", async () => {
    const target = new MockUpdiTarget();
    const programmer = await connectProgrammer(target);
    const contents = Uint8Array.from({ length: TINY412.flashSize }, (_, index) => (index * 37 + 11) & 0xff);
    const image = new FirmwareImage([{ addr: 0, data: contents }]);

    await programmer.enterProgMode();
    await programmer.chipErase();
    for (const page of image.toPages(TINY412.flashPageSize)) {
      await programmer.writePage(TINY412.flashBase + page.addr, page.data);
    }
    await programmer.verifyMem(TINY412.flashBase, contents);
  });

  it("reports no response and refuses a non-ATtiny412 signature", async () => {
    const absentTarget = new MockUpdiTarget({ noResponse: true });
    const absentProgrammer = new SerialUpdiProgrammer(absentTarget.port, 115_200, 10);
    programmers.push(absentProgrammer);
    await expect(absentProgrammer.connect()).rejects.toBeInstanceOf(NoResponseError);

    const wrongTarget = new MockUpdiTarget({ signature: [0x1e, 0x91, 0x22] });
    const wrongProgrammer = new SerialUpdiProgrammer(wrongTarget.port);
    programmers.push(wrongProgrammer);
    await expect(wrongProgrammer.connect()).rejects.toBeInstanceOf(WrongDeviceError);
  });

  it("refuses to erase a locked chip whose exact signature cannot be read", async () => {
    const target = new MockUpdiTarget({ locked: true });
    const originalFlash = target.memory.slice(TINY412.flashBase, TINY412.flashBase + 64);
    const programmer = new SerialUpdiProgrammer(target.port);
    programmers.push(programmer);

    await expect(programmer.connect()).rejects.toBeInstanceOf(LockedError);
    await expect(programmer.chipErase()).rejects.toBeInstanceOf(PortError);
    expect(target.memory.slice(TINY412.flashBase, TINY412.flashBase + 64)).toEqual(originalFlash);
  });

  it("surfaces a mid-page serial disconnect", async () => {
    const target = new MockUpdiTarget({ disconnectDuringPageWrite: true });
    const programmer = await connectProgrammer(target);
    await programmer.enterProgMode();

    await expect(programmer.writePage(TINY412.flashBase, new Uint8Array(64).fill(0x5a)))
      .rejects.toBeInstanceOf(PortError);
  });

  it("detects readback mismatch and NVM WRERROR", async () => {
    const mismatchTarget = new MockUpdiTarget({ corruptFlashReadback: true });
    const mismatchProgrammer = await connectProgrammer(mismatchTarget);
    await mismatchProgrammer.enterProgMode();
    const page = new Uint8Array(64).fill(0x35);
    await mismatchProgrammer.writePage(TINY412.flashBase, page);
    await expect(mismatchProgrammer.verifyMem(TINY412.flashBase, page)).rejects.toBeInstanceOf(VerifyError);

    const errorTarget = new MockUpdiTarget({ writeError: true });
    const errorProgrammer = await connectProgrammer(errorTarget);
    await errorProgrammer.enterProgMode();
    await expect(errorProgrammer.writePage(TINY412.flashBase, page)).rejects.toBeInstanceOf(NvmWriteError);
  });
});

describe("NVM programming mode entry", () => {
  it("waits for LOCKSTATUS to clear after the programming key is accepted", async () => {
    const statuses = [0, 1 << 4, 1, 1 << 3];
    const link = {
      readCs: vi.fn(async () => statuses.shift() ?? (1 << 3)),
      reset: vi.fn().mockResolvedValue(undefined),
      sendKey: vi.fn().mockResolvedValue(undefined)
    } as unknown as UpdiLink;

    await new NvmController(link).enterProgMode();

    expect(link.readCs).toHaveBeenCalledTimes(4);
  });
});

async function connectProgrammer(options: MockUpdiTargetOptions): Promise<SerialUpdiProgrammer> {
  const target = new MockUpdiTarget(options);
  const programmer = new SerialUpdiProgrammer(target.port);
  programmers.push(programmer);
  await programmer.connect();
  return programmer;
}