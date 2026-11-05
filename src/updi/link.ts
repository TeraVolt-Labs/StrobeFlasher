import { NoResponseError, PortError, type BreakPath, WebSerialTransport } from "../transport/webserial";
import { ProtocolError } from "./errors";

export const UPDI = {
  sync: 0x55,
  ack: 0x40,
  lds: 0x00,
  sts: 0x40,
  ld: 0x20,
  st: 0x60,
  ldcs: 0x80,
  stcs: 0xc0,
  repeat: 0xa0,
  key: 0xe0
} as const;

export const UPDI_REGISTERS = {
  statusA: 0x00,
  statusB: 0x01,
  controlA: 0x02,
  controlB: 0x03,
  asiKeyStatus: 0x07,
  asiResetRequest: 0x08,
  asiControlA: 0x09,
  asiSystemControlA: 0x0a,
  asiSystemStatus: 0x0b,
  asiCrcStatus: 0x0c
} as const;

export const UPDI_KEYS = {
  nvmProgram: "NVMProg ",
  chipErase: "NVMErase",
  userRowWrite: "NVMUs&te"
} as const;

export type AddressSize = 0 | 1 | 2;
export type DataSize = 0 | 1 | 2;
export type PointerMode = 0 | 1 | 2;

export function encodeLds(addressSize: AddressSize, dataSize: DataSize): number {
  return UPDI.lds | (addressSize << 2) | dataSize;
}

export function encodeSts(addressSize: AddressSize, dataSize: DataSize): number {
  return UPDI.sts | (addressSize << 2) | dataSize;
}

export function encodeLd(pointerMode: PointerMode, dataSize: DataSize): number {
  return UPDI.ld | (pointerMode << 2) | dataSize;
}

export function encodeSt(pointerMode: PointerMode, dataSize: DataSize): number {
  return UPDI.st | (pointerMode << 2) | dataSize;
}

export function encodeLdcs(register: number): number {
  return encodeRegisterOpcode(UPDI.ldcs, register);
}

export function encodeStcs(register: number): number {
  return encodeRegisterOpcode(UPDI.stcs, register);
}

export function encodeRepeat(dataSize: 0 | 1): number {
  return UPDI.repeat | dataSize;
}

export function encodeKey(size: 0 | 1 | 2): number {
  return UPDI.key | size;
}

export class WrongDeviceError extends Error {
  constructor(readonly signature: Uint8Array) {
    super(`Unexpected device signature: ${formatSignature(signature)}.`);
    this.name = "WrongDeviceError";
  }
}

export interface DeviceInfo {
  name: "ATtiny412";
  signature: Uint8Array;
  updiRevision: number;
  breakPath: BreakPath;
}

export class UpdiLink {
  private breakPath: BreakPath = "signals";
  private initialized = false;

  constructor(private readonly transport: WebSerialTransport) {}

  get breakPathUsed(): BreakPath {
    return this.breakPath;
  }

  async initialize(): Promise<number> {
    this.breakPath = await this.transport.sendBreak();
    try {
      return await this.initializeAfterBreak();
    } catch (error) {
      if (!(error instanceof NoResponseError) && !(error instanceof PortError)) throw error;
      this.breakPath = await this.transport.sendBreak(true);
      return this.initializeAfterBreak();
    }
  }

  private async initializeAfterBreak(): Promise<number> {
    await this.writeCs(UPDI_REGISTERS.controlB, 0x08);
    await this.writeCs(UPDI_REGISTERS.controlA, 0x80);

    const statusA = await this.readCs(UPDI_REGISTERS.statusA);
    if (statusA === 0) throw new NoResponseError("UPDI responded with an invalid STATUSA value.");
    this.initialized = true;
    return statusA;
  }

  async connect(): Promise<DeviceInfo> {
    const statusA = await this.initialize();
    const signature = await this.readMemory(0x1100, 3);
    if (!isAttiny412Signature(signature)) throw new WrongDeviceError(signature);

    return {
      name: "ATtiny412",
      signature,
      updiRevision: statusA >>> 4,
      breakPath: this.breakPath
    };
  }

  async readCs(register: number): Promise<number> {
    await this.transport.send(Uint8Array.of(UPDI.sync, encodeLdcs(register)));
    return (await this.transport.read(1, undefined, "UPDI control/status response"))[0]!;
  }

  async writeCs(register: number, value: number): Promise<void> {
    await this.transport.send(Uint8Array.of(UPDI.sync, encodeStcs(register), value & 0xff));
  }

  async sendKey(key: string): Promise<void> {
    const bytes = new TextEncoder().encode(key);
    if (bytes.length !== 8) throw new RangeError("UPDI activation keys must contain exactly 8 bytes.");
    await this.transport.send(Uint8Array.of(UPDI.sync, encodeKey(0)));
    await this.transport.send(bytes.slice().reverse());
  }

  async readSib(): Promise<Uint8Array> {
    await this.transport.send(Uint8Array.of(UPDI.sync, UPDI.key | 0x04 | 0x02));
    return this.transport.read(32, undefined, "UPDI SIB response");
  }

  async reset(assertReset: boolean): Promise<void> {
    await this.writeCs(UPDI_REGISTERS.asiResetRequest, assertReset ? 0x59 : 0x00);
  }

  async writeMemoryByte(address: number, value: number): Promise<void> {
    this.validateAddress(address);
    await this.transport.send(Uint8Array.of(
      UPDI.sync,
      encodeSts(1, 0),
      address & 0xff,
      (address >>> 8) & 0xff
    ));
    await this.expectAck();
    await this.transport.send(Uint8Array.of(value & 0xff));
    await this.expectAck();
  }

  async writePointerWords(address: number, data: Uint8Array): Promise<void> {
    this.validateAddress(address);
    if (data.length === 0 || data.length % 2 !== 0 || data.length > 512) {
      throw new RangeError("Repeated UPDI word writes require 1-256 complete words.");
    }

    const words = data.length / 2;
    await this.setPointer(address);
    await this.transport.send(Uint8Array.of(UPDI.sync, encodeRepeat(0), words - 1));
    await this.writeCs(UPDI_REGISTERS.controlA, 0x88);
    try {
      await this.transport.send(Uint8Array.of(UPDI.sync, encodeSt(1, 1)));
      await this.transport.send(data);
    } finally {
      await this.writeCs(UPDI_REGISTERS.controlA, 0x80);
    }
  }

  async readPointerBytes(address: number, length: number): Promise<Uint8Array> {
    this.validateAddress(address);
    if (!Number.isInteger(length) || length < 0 || address + length > 0x10000) {
      throw new RangeError("Read length is outside the 16-bit data space.");
    }

    const data = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const count = Math.min(256, length - offset);
      await this.setPointer(address + offset);
      if (count > 1) {
        await this.transport.send(Uint8Array.of(UPDI.sync, encodeRepeat(0), count - 1));
      }
      await this.transport.send(Uint8Array.of(UPDI.sync, encodeLd(1, 0)));
      data.set(await this.transport.read(count), offset);
      offset += count;
    }
    return data;
  }

  async readMemory(address: number, length: number): Promise<Uint8Array> {
    if (!this.initialized) throw new Error("Initialize the UPDI link before reading memory.");
    this.validateAddress(address);
    if (!Number.isInteger(length) || length < 0 || address + length > 0x10000) {
      throw new RangeError("Read length is outside the 16-bit data space.");
    }

    const data = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 1) {
      const currentAddress = address + offset;
      await this.transport.send(Uint8Array.of(
        UPDI.sync,
        encodeLds(1, 0),
        currentAddress & 0xff,
        (currentAddress >>> 8) & 0xff
      ));
      data[offset] = (await this.transport.read(1))[0]!;
    }
    return data;
  }

  private async setPointer(address: number): Promise<void> {
    await this.transport.send(Uint8Array.of(
      UPDI.sync,
      encodeSt(2, 1),
      address & 0xff,
      (address >>> 8) & 0xff
    ));
    await this.expectAck();
  }

  private async expectAck(): Promise<void> {
    const response = await this.transport.read(1, undefined, "UPDI write ACK");
    if (response[0] !== UPDI.ack) {
      throw new ProtocolError(`Expected UPDI ACK 0x40, received 0x${response[0]!.toString(16)}.`);
    }
  }

  private validateAddress(address: number): void {
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
      throw new RangeError("UPDI address must fit in 16 bits.");
    }
  }
}

export function isAttiny412Signature(signature: Uint8Array): boolean {
  return signature.length === 3 && signature[0] === 0x1e && signature[1] === 0x92 && signature[2] === 0x23;
}

export function formatSignature(signature: Uint8Array): string {
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function encodeRegisterOpcode(base: number, register: number): number {
  if (!Number.isInteger(register) || register < 0 || register > 0x0f) {
    throw new RangeError("UPDI control/status register address must be in the range 0-15.");
  }
  return base | register;
}