import { NoResponseError, type BreakPath, WebSerialTransport } from "../transport/webserial";

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

  async initialize(): Promise<number> {
    this.breakPath = await this.transport.sendBreak();
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
    return (await this.transport.read(1))[0]!;
  }

  async writeCs(register: number, value: number): Promise<void> {
    await this.transport.send(Uint8Array.of(UPDI.sync, encodeStcs(register), value & 0xff));
  }

  async readMemory(address: number, length: number): Promise<Uint8Array> {
    if (!this.initialized) throw new Error("Initialize the UPDI link before reading memory.");
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
      throw new RangeError("UPDI address must fit in 16 bits.");
    }
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