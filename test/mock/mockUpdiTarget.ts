import type { SerialOptions, SerialPortLike } from "../../src/transport/webserial";
import { UPDI, UPDI_REGISTERS } from "../../src/updi/link";

export interface MockUpdiTargetOptions {
  signature?: readonly number[];
  noResponse?: boolean;
  supportsBreakSignals?: boolean;
  locked?: boolean;
  writeError?: boolean;
  corruptFlashReadback?: boolean;
  disconnectDuringPageWrite?: boolean;
}

export class MockUpdiTarget {
  readonly memory = new Uint8Array(0x10000).fill(0xff);
  readonly controlRegisters = new Uint8Array(16);
  readonly port: MockSerialPort;
  noResponse: boolean;
  writeError: boolean;
  corruptFlashReadback: boolean;
  disconnectDuringPageWrite: boolean;
  private pointer = 0;
  private repeatCount = 0;
  private repeatedStoreSize = 0;
  private repeatedStoreCount = 0;
  private pendingDirectAddress: number | null = null;
  private keyRequested = false;
  private nvmProgramArmed = false;
  private chipEraseArmed = false;
  private resetPending = false;
  private pageAddress: number | null = null;
  private pageBuffer = new Uint8Array(64).fill(0xff);
  private readbackCorrupted = false;
  private disconnected = false;

  constructor(options: MockUpdiTargetOptions = {}) {
    const signature = options.signature ?? [0x1e, 0x92, 0x23];
    this.memory.set(signature.slice(0, 3), 0x1100);
    this.controlRegisters[UPDI_REGISTERS.statusA] = 0x20;
    this.controlRegisters[UPDI_REGISTERS.asiSystemStatus] = options.locked ? 0x01 : 0x00;
    this.noResponse = options.noResponse ?? false;
    this.writeError = options.writeError ?? false;
    this.corruptFlashReadback = options.corruptFlashReadback ?? false;
    this.disconnectDuringPageWrite = options.disconnectDuringPageWrite ?? false;
    this.memory[0x1002] = 0x00;
    this.port = new MockSerialPort(this, options.supportsBreakSignals ?? true);
  }

  handleWrite(bytes: Uint8Array, output: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.disconnected) return;
    output.enqueue(bytes.slice());

    if (this.keyRequested && bytes[0] !== UPDI.sync) {
      this.acceptKey(bytes);
      return;
    }
    if (this.pendingDirectAddress !== null && bytes[0] !== UPDI.sync) {
      this.writeDirectData(bytes, output);
      return;
    }
    if (this.repeatedStoreSize > 0 && bytes[0] !== UPDI.sync) {
      this.writeRepeatedData(bytes, output);
      return;
    }
    if (bytes.length === 1 && bytes[0] === 0x00) {
      this.resetProtocol();
      return;
    }
    if (this.noResponse || bytes.length < 2 || bytes[0] !== UPDI.sync) return;

    const instruction = bytes[1]!;
    if ((instruction & 0xf0) === UPDI.stcs && bytes.length === 3) {
      this.controlRegisters[instruction & 0x0f] = bytes[2]!;
      if ((instruction & 0x0f) === UPDI_REGISTERS.asiResetRequest) {
        this.handleResetRequest(bytes[2]!);
      }
      return;
    }

    if ((instruction & 0xf0) === UPDI.ldcs && bytes.length === 2) {
      output.enqueue(Uint8Array.of(this.controlRegisters[instruction & 0x0f]!));
      return;
    }

    if ((instruction & 0xf0) === UPDI.key && bytes.length === 2) {
      if (instruction & 0x04) {
        const sib = new TextEncoder().encode("tinyAVR 1 P:0 UPDI mock");
        const response = new Uint8Array(32).fill(0x20);
        response.set(sib.slice(0, response.length));
        output.enqueue(response);
      } else {
        this.keyRequested = true;
      }
      return;
    }

    if ((instruction & 0xf0) === UPDI.repeat && bytes.length === 3) {
      this.repeatCount = bytes[2]! + 1;
      return;
    }

    if ((instruction & 0xe0) === UPDI.lds && bytes.length === 4) {
      const address = bytes[2]! | (bytes[3]! << 8);
      const count = (instruction & 0x03) === 1 ? 2 : 1;
      output.enqueue(this.readAddress(address, count));
      return;
    }

    if ((instruction & 0xe0) === UPDI.sts && bytes.length === 4) {
      this.pendingDirectAddress = bytes[2]! | (bytes[3]! << 8);
      output.enqueue(Uint8Array.of(UPDI.ack));
      return;
    }

    if ((instruction & 0xe0) === UPDI.st && bytes.length === 4 && ((instruction >>> 2) & 0x03) === 2) {
      this.pointer = bytes[2]! | (bytes[3]! << 8);
      output.enqueue(Uint8Array.of(UPDI.ack));
      return;
    }

    if ((instruction & 0xe0) === UPDI.st && bytes.length === 2 && ((instruction >>> 2) & 0x03) === 1) {
      this.repeatedStoreSize = (instruction & 0x03) === 1 ? 2 : 1;
      this.repeatedStoreCount = this.repeatCount || 1;
      this.repeatCount = 0;
      return;
    }

    if ((instruction & 0xe0) === UPDI.ld && bytes.length === 2) {
      const pointerMode = (instruction >>> 2) & 0x03;
      const dataSize = (instruction & 0x03) === 1 ? 2 : 1;
      const count = this.repeatCount || 1;
      const response = this.readAddress(this.pointer, count * dataSize);
      output.enqueue(response);
      if (pointerMode === 1) this.pointer += response.length;
      this.repeatCount = 0;
    }
  }

  resetProtocol(): void {
    this.controlRegisters[UPDI_REGISTERS.controlA] = 0;
    this.controlRegisters[UPDI_REGISTERS.controlB] = 0;
  }

  private acceptKey(bytes: Uint8Array): void {
    this.keyRequested = false;
    const key = String.fromCharCode(...Array.from(bytes).reverse());
    if (key === "NVMProg " && (this.controlRegisters[UPDI_REGISTERS.asiSystemStatus]! & 1) === 0) {
      this.nvmProgramArmed = true;
      this.controlRegisters[UPDI_REGISTERS.asiKeyStatus] = 1 << 4;
    } else if (key === "NVMErase") {
      this.chipEraseArmed = true;
      this.controlRegisters[UPDI_REGISTERS.asiKeyStatus] = 1 << 3;
    }
  }

  private writeDirectData(bytes: Uint8Array, output: ReadableStreamDefaultController<Uint8Array>): void {
    const address = this.pendingDirectAddress!;
    this.pendingDirectAddress = null;
    this.writeAddress(address, bytes[0]!);
    output.enqueue(Uint8Array.of(UPDI.ack));
  }

  private writeRepeatedData(bytes: Uint8Array, output: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.disconnectDuringPageWrite) {
      this.disconnected = true;
      output.error(new Error("Mock target disconnected during page write."));
      return;
    }

    const acknowledgements = new Uint8Array(Math.floor(bytes.length / this.repeatedStoreSize)).fill(UPDI.ack);
    for (let index = 0; index + this.repeatedStoreSize <= bytes.length; index += this.repeatedStoreSize) {
      for (let byte = 0; byte < this.repeatedStoreSize; byte += 1) {
        this.writeAddress(this.pointer + byte, bytes[index + byte]!);
      }
      this.pointer += this.repeatedStoreSize;
      this.repeatedStoreCount -= 1;
    }
    this.repeatedStoreSize = 0;
    output.enqueue(acknowledgements);
  }

  private writeAddress(address: number, value: number): void {
    if (address >= 0x8000 && address < 0x9000) {
      if (this.pageAddress === null) this.pageAddress = Math.floor(address / 64) * 64;
      if (Math.floor(address / 64) !== this.pageAddress / 64) {
        this.memory[0x1002] = 1 << 2;
        return;
      }
      this.pageBuffer[address - this.pageAddress] = value;
      return;
    }

    this.memory[address] = value;
    if (address === 0x1000) this.executeNvmCommand(value);
  }

  private executeNvmCommand(command: number): void {
    if (command === 0x04) {
      this.pageBuffer.fill(0xff);
      this.pageAddress = null;
      this.memory[0x1002] = 0;
      return;
    }

    if (command === 0x01 || command === 0x03) {
      if (this.pageAddress === null) {
        this.memory[0x1002] = 1 << 2;
        return;
      }
      if (this.writeError) {
        this.memory[0x1002] = 1 << 2;
      } else {
        if (command === 0x03) this.memory.fill(0xff, this.pageAddress, this.pageAddress + 64);
        this.memory.set(this.pageBuffer, this.pageAddress);
        this.memory[0x1002] = 0;
      }
      this.pageBuffer.fill(0xff);
      this.pageAddress = null;
      return;
    }

    if (command === 0x02 && this.pageAddress !== null) {
      this.memory.fill(0xff, this.pageAddress, this.pageAddress + 64);
      this.pageBuffer.fill(0xff);
      this.pageAddress = null;
      this.memory[0x1002] = 0;
      return;
    }

    if (command === 0x05) {
      this.eraseChipMemory();
    }
  }

  private handleResetRequest(value: number): void {
    if (value === 0x59) {
      this.resetPending = true;
      return;
    }
    if (value !== 0x00 || !this.resetPending) return;

    this.resetPending = false;
    if (this.chipEraseArmed) {
      this.eraseChipMemory();
      this.controlRegisters[UPDI_REGISTERS.asiSystemStatus] = 0;
      this.controlRegisters[UPDI_REGISTERS.asiKeyStatus] = 0;
      this.chipEraseArmed = false;
    } else if (this.nvmProgramArmed) {
      this.controlRegisters[UPDI_REGISTERS.asiSystemStatus] = 1 << 3;
      this.controlRegisters[UPDI_REGISTERS.asiKeyStatus] = 0;
      this.nvmProgramArmed = false;
    } else {
      this.controlRegisters[UPDI_REGISTERS.asiSystemStatus] &= ~(1 << 3);
    }
  }

  private eraseChipMemory(): void {
    this.memory.fill(0xff, 0x8000, 0x9000);
    this.memory.fill(0xff, 0x1400, 0x1480);
    this.memory[0x1002] = 0;
  }

  private readAddress(address: number, length: number): Uint8Array {
    const result = this.memory.slice(address, address + length);
    if (this.corruptFlashReadback && !this.readbackCorrupted && address >= 0x8000 && result.length > 0) {
      result[0] ^= 0x01;
      this.readbackCorrupted = true;
    }
    return result;
  }
}

class MockSerialPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  readonly openOptions: SerialOptions[] = [];
  private output: ReadableStreamDefaultController<Uint8Array> | null = null;
  private isOpen = false;

  constructor(private readonly target: MockUpdiTarget, private readonly supportsBreakSignals: boolean) {}

  async open(options: SerialOptions): Promise<void> {
    if (this.isOpen) throw new Error("Mock serial port is already open.");
    this.isOpen = true;
    this.openOptions.push({ ...options });
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => { this.output = controller; }
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (!this.output) throw new Error("Mock serial output is not available.");
        this.target.handleWrite(chunk, this.output);
      }
    });
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.isOpen = false;
    try {
      this.output?.close();
    } catch {
      // The reader can cancel the stream during a timeout.
    }
    this.output = null;
    this.readable = null;
    this.writable = null;
  }

  async setSignals(signals: { break?: boolean }): Promise<void> {
    if (!this.supportsBreakSignals) throw new Error("Break signals are unsupported.");
    if (signals.break) this.target.resetProtocol();
  }
}