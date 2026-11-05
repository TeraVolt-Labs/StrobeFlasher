export const DEFAULT_BAUD_RATE = 115_200;
const BREAK_BAUD_RATE = 300;
const BREAK_HOLD_MS = 25;

export interface SerialOptions {
  baudRate: number;
  dataBits: 8;
  parity: "even";
  stopBits: 1 | 2;
}

export interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: { break?: boolean }): Promise<void>;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

export type BreakPath = "signals" | "baud-trick";

export class PortError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortError";
  }
}

export class NoResponseError extends Error {
  constructor(message = "No response from the UPDI target before the timeout.") {
    super(message);
    this.name = "NoResponseError";
  }
}

export class WebSerialTransport {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly received: number[] = [];
  private baudRate: number;
  private stopBits: 1 | 2 = 2;

  private constructor(
    private readonly port: SerialPortLike,
    baudRate: number,
    private readonly timeoutMs: number
  ) {
    this.baudRate = baudRate;
  }

  static async open(
    port: SerialPortLike,
    baudRate = DEFAULT_BAUD_RATE,
    timeoutMs = 1000
  ): Promise<WebSerialTransport> {
    const transport = new WebSerialTransport(port, baudRate, timeoutMs);
    await transport.openAt(baudRate, 2);
    return transport;
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new PortError("The serial port is not open.");

    try {
      await this.writer.write(bytes);
      const echo = await this.read(bytes.length, this.timeoutMs, "USB-serial TX echo");
      if (!bytesEqual(bytes, echo)) {
        throw new PortError("The serial echo did not match the transmitted bytes.");
      }
    } catch (error) {
      if (error instanceof NoResponseError || error instanceof PortError) throw error;
      throw new PortError("Could not write to the serial port.", { cause: error });
    }
  }

  async read(length: number, timeoutMs = this.timeoutMs, waitingFor = "UPDI response"): Promise<Uint8Array> {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError("Read length must be a non-negative integer.");
    }

    while (this.received.length < length) {
      await this.readChunk(timeoutMs, waitingFor);
    }

    return Uint8Array.from(this.received.splice(0, length));
  }

  async sendBreak(forceBaudBreak = false): Promise<BreakPath> {
    if (forceBaudBreak) {
      await this.sendBaudBreaks();
      return "baud-trick";
    }

    try {
      if (!this.port.setSignals) throw new Error("Break signals are unavailable.");
      await this.pulseBreakSignal();
      return "signals";
    } catch {
      await this.sendBaudBreaks();
      return "baud-trick";
    }
  }

  async close(): Promise<void> {
    await this.releaseStreams();
    try {
      await this.port.close();
    } catch (error) {
      throw new PortError("Could not close the serial port.", { cause: error });
    }
  }

  private async pulseBreakSignal(): Promise<void> {
    for (let pulse = 0; pulse < 2; pulse += 1) {
      await this.port.setSignals?.({ break: true });
      await delay(BREAK_HOLD_MS);
      await this.port.setSignals?.({ break: false });
      if (pulse === 0) await delay(5);
    }
  }

  private async sendBaudBreaks(): Promise<void> {
    await this.reopenAt(BREAK_BAUD_RATE, 1);
    try {
      for (let pulse = 0; pulse < 2; pulse += 1) {
        if (!this.writer) throw new PortError("The serial port is not open.");
        await this.writer.write(Uint8Array.of(0x00));
        await this.read(1, this.timeoutMs, "USB-serial BREAK echo");
        if (pulse === 0) await delay(100);
      }
    } finally {
      await this.reopenAt(this.baudRate, 2);
    }
  }

  private async openAt(baudRate: number, stopBits: 1 | 2): Promise<void> {
    try {
      await this.port.open({ baudRate, dataBits: 8, parity: "even", stopBits });
      if (!this.port.readable || !this.port.writable) {
        throw new Error("The serial port did not expose readable and writable streams.");
      }
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.baudRate = baudRate === BREAK_BAUD_RATE ? this.baudRate : baudRate;
      this.stopBits = stopBits;
      this.received.length = 0;
    } catch (error) {
      if (error instanceof PortError) throw error;
      throw new PortError("Could not open the serial port with the requested settings.", { cause: error });
    }
  }

  private async reopenAt(baudRate: number, stopBits: 1 | 2): Promise<void> {
    await this.releaseStreams();
    try {
      await this.port.close();
    } catch {
      // Some drivers report an error when closing an already-closed port.
    }
    await this.openAt(baudRate, stopBits);
  }

  private async releaseStreams(): Promise<void> {
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // The stream may already have been canceled by a timeout or unplug.
      }
      try {
        this.reader.releaseLock();
      } catch {
        // A closed stream may have released its lock already.
      }
      this.reader = null;
    }

    if (this.writer) {
      try {
        await this.writer.close();
      } catch {
        // The port can disappear while closing.
      }
      try {
        this.writer.releaseLock();
      } catch {
        // A closed stream may have released its lock already.
      }
      this.writer = null;
    }
  }

  private async readChunk(timeoutMs: number, waitingFor: string): Promise<void> {
    if (!this.reader) throw new PortError("The serial port is not open.");

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NoResponseError(`Timed out waiting for ${waitingFor}.`)), timeoutMs);
      });
      const result = await Promise.race([this.reader.read(), timeout]);
      if (result.done || !result.value) {
        throw new NoResponseError(`The serial connection closed while waiting for ${waitingFor}.`);
      }
      this.received.push(...result.value);
    } catch (error) {
      if (error instanceof NoResponseError) {
        void this.reader.cancel();
        throw error;
      }
      throw new PortError("Could not read from the serial port.", { cause: error });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}