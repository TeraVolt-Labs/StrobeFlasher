import type { SerialOptions, SerialPortLike } from "../../src/transport/webserial";
import { UPDI, UPDI_REGISTERS } from "../../src/updi/link";

export interface MockUpdiTargetOptions {
  signature?: readonly number[];
  noResponse?: boolean;
  supportsBreakSignals?: boolean;
}

export class MockUpdiTarget {
  readonly memory = new Uint8Array(0x10000).fill(0xff);
  readonly controlRegisters = new Uint8Array(16);
  readonly port: MockSerialPort;
  noResponse: boolean;

  constructor(options: MockUpdiTargetOptions = {}) {
    const signature = options.signature ?? [0x1e, 0x92, 0x23];
    this.memory.set(signature.slice(0, 3), 0x1100);
    this.controlRegisters[UPDI_REGISTERS.statusA] = 0x20;
    this.controlRegisters[UPDI_REGISTERS.asiSystemStatus] = 0x01;
    this.noResponse = options.noResponse ?? false;
    this.port = new MockSerialPort(this, options.supportsBreakSignals ?? true);
  }

  handleWrite(bytes: Uint8Array, output: ReadableStreamDefaultController<Uint8Array>): void {
    output.enqueue(bytes.slice());

    if (bytes.length === 1 && bytes[0] === 0x00) {
      this.resetProtocol();
      return;
    }
    if (this.noResponse || bytes.length < 2 || bytes[0] !== UPDI.sync) return;

    const instruction = bytes[1]!;
    if ((instruction & 0xf0) === UPDI.stcs && bytes.length === 3) {
      this.controlRegisters[instruction & 0x0f] = bytes[2]!;
      return;
    }

    if ((instruction & 0xf0) === UPDI.ldcs && bytes.length === 2) {
      output.enqueue(Uint8Array.of(this.controlRegisters[instruction & 0x0f]!));
      return;
    }

    if ((instruction & 0xc0) === UPDI.lds && bytes.length === 4) {
      const address = bytes[2]! | (bytes[3]! << 8);
      output.enqueue(Uint8Array.of(this.memory[address]!));
    }
  }

  resetProtocol(): void {
    this.controlRegisters[UPDI_REGISTERS.controlA] = 0;
    this.controlRegisters[UPDI_REGISTERS.controlB] = 0;
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