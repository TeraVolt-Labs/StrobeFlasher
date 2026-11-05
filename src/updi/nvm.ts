import { LockedError, NvmWriteError, TimeoutError, VerifyError } from "./errors";
import { UPDI_KEYS, UPDI_REGISTERS, type UpdiLink } from "./link";

export const TINY412 = {
  flashBase: 0x8000,
  flashSize: 4096,
  flashPageSize: 64,
  nvmctrlBase: 0x1000
} as const;

const NVMCTRL = {
  ctrla: 0x00,
  status: 0x02
} as const;

const NVM_COMMAND = {
  writePage: 0x01,
  erasePage: 0x02,
  eraseWritePage: 0x03,
  pageBufferClear: 0x04,
  chipErase: 0x05
} as const;

const STATUS = {
  flashBusy: 1 << 0,
  eepromBusy: 1 << 1,
  writeError: 1 << 2
} as const;

const SYSTEM_STATUS = {
  nvmProgram: 1 << 3,
  lock: 1 << 0
} as const;

export class NvmController {
  constructor(private readonly link: UpdiLink, private readonly timeoutMs = 1000) {}

  async enterProgMode(): Promise<void> {
    const initialStatus = await this.link.readCs(UPDI_REGISTERS.asiSystemStatus);
    if (initialStatus & SYSTEM_STATUS.nvmProgram) return;
    if (initialStatus & SYSTEM_STATUS.lock) throw new LockedError(await this.readSibText());

    await this.link.reset(true);
    await this.link.sendKey(UPDI_KEYS.nvmProgram);
    const keyStatus = await this.link.readCs(UPDI_REGISTERS.asiKeyStatus);
    if ((keyStatus & (1 << 4)) === 0) {
      throw new Error("The ATtiny412 did not accept the NVM programming key.");
    }

    await this.link.reset(true);
    await this.link.reset(false);
    await this.waitForSystemStatus((status) => (status & SYSTEM_STATUS.nvmProgram) !== 0);
  }

  async chipErase(): Promise<void> {
    await this.requireProgMode();
    await this.waitReady();
    await this.link.writeMemoryByte(TINY412.nvmctrlBase + NVMCTRL.ctrla, NVM_COMMAND.chipErase);
    await this.waitReady();
  }

  async writePage(address: number, data: Uint8Array): Promise<void> {
    if (address < TINY412.flashBase || address >= TINY412.flashBase + TINY412.flashSize) {
      throw new RangeError("Writes are restricted to ATtiny412 Flash.");
    }
    if ((address - TINY412.flashBase) % TINY412.flashPageSize !== 0 || data.length !== TINY412.flashPageSize) {
      throw new RangeError("Flash writes must be one aligned 64-byte page.");
    }
    await this.requireProgMode();
    await this.waitReady();
    await this.link.writeMemoryByte(TINY412.nvmctrlBase + NVMCTRL.ctrla, NVM_COMMAND.pageBufferClear);
    await this.waitReady();
    await this.link.writePointerWords(address, data);
    await this.link.writeMemoryByte(TINY412.nvmctrlBase + NVMCTRL.ctrla, NVM_COMMAND.eraseWritePage);
    await this.waitReady();
  }

  async readMem(address: number, length: number): Promise<Uint8Array> {
    return this.link.readPointerBytes(address, length);
  }

  async verifyMem(address: number, expected: Uint8Array): Promise<void> {
    const actual = await this.readMem(address, expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      if (actual[index] !== expected[index]) {
        throw new VerifyError(address + index, expected[index]!, actual[index]!);
      }
    }
  }

  private async requireProgMode(): Promise<void> {
    const status = await this.link.readCs(UPDI_REGISTERS.asiSystemStatus);
    if (status & SYSTEM_STATUS.lock) throw new LockedError(await this.readSibText());
    if ((status & SYSTEM_STATUS.nvmProgram) === 0) {
      throw new Error("Enter NVM programming mode before modifying Flash.");
    }
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const status = (await this.link.readMemory(TINY412.nvmctrlBase + NVMCTRL.status, 1))[0]!;
      if (status & STATUS.writeError) throw new NvmWriteError(status);
      if ((status & (STATUS.flashBusy | STATUS.eepromBusy)) === 0) return;
      await delay(5);
    }
    throw new TimeoutError("Timed out waiting for the NVM controller.");
  }

  private async waitForSystemStatus(predicate: (status: number) => boolean): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.link.readCs(UPDI_REGISTERS.asiSystemStatus);
      if (status & SYSTEM_STATUS.lock) throw new LockedError(await this.readSibText());
      if (predicate(status)) return;
      await delay(5);
    }
    throw new TimeoutError("Timed out waiting for the chip to enter NVM programming mode.");
  }

  private async readSibText(): Promise<string> {
    const sib = await this.link.readSib();
    return new TextDecoder().decode(sib).replace(/\0/g, "").trim();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}