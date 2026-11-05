import { NoResponseError, PortError, WebSerialTransport, type SerialPortLike } from "../transport/webserial";
import { LockedError } from "./errors";
import { NvmController, TINY412 } from "./nvm";
import { isAttiny412Signature, UPDI_REGISTERS, UpdiLink, WrongDeviceError, type DeviceInfo } from "./link";

export interface Programmer {
  connect(): Promise<DeviceInfo>;
  enterProgMode(): Promise<void>;
  chipErase(): Promise<void>;
  readMem(addr: number, len: number): Promise<Uint8Array>;
  writePage(addr: number, data: Uint8Array): Promise<void>;
  leaveProgMode(): Promise<void>;
  disconnect(): Promise<void>;
}

export class SerialUpdiProgrammer implements Programmer {
  private transport: WebSerialTransport | null = null;
  private link: UpdiLink | null = null;
  private nvm: NvmController | null = null;
  private verifiedDevice = false;

  constructor(
    private readonly port: SerialPortLike,
    private readonly baudRate = 115_200,
    private readonly timeoutMs = 1000
  ) {}

  get portInfo(): { usbVendorId?: number; usbProductId?: number } | null {
    return this.port.getInfo?.() ?? null;
  }

  async connect(): Promise<DeviceInfo> {
    if (this.link) throw new Error("The programmer is already connected.");
    this.transport = await WebSerialTransport.open(this.port, this.baudRate, this.timeoutMs);
    this.link = new UpdiLink(this.transport);
    this.nvm = new NvmController(this.link);

    try {
      const statusA = await this.link.initialize();
      const systemStatus = await this.link.readCs(UPDI_REGISTERS.asiSystemStatus);
      if (systemStatus & 1) {
        const sib = new TextDecoder().decode(await this.link.readSib()).replace(/\0/g, "").trim();
        throw new LockedError(sib);
      }

      const signature = await this.link.readMemory(0x1100, 3);
      if (!isAttiny412Signature(signature)) throw new WrongDeviceError(signature);
      this.verifiedDevice = true;

      return {
        name: "ATtiny412",
        signature,
        updiRevision: statusA >>> 4,
        breakPath: this.link.breakPathUsed
      };
    } catch (error) {
      await this.disconnect().catch(() => undefined);
      throw error;
    }
  }

  async enterProgMode(): Promise<void> {
    this.requireVerifiedDevice();
    await this.requireNvm().enterProgMode();
  }

  async chipErase(): Promise<void> {
    this.requireVerifiedDevice();
    await this.requireNvm().chipErase();
  }

  async readMem(addr: number, len: number): Promise<Uint8Array> {
    this.requireVerifiedDevice();
    return this.requireNvm().readMem(addr, len);
  }

  async writePage(addr: number, data: Uint8Array): Promise<void> {
    this.requireVerifiedDevice();
    await this.requireNvm().writePage(addr, data);
  }

  async verifyMem(addr: number, data: Uint8Array): Promise<void> {
    this.requireVerifiedDevice();
    await this.requireNvm().verifyMem(addr, data);
  }

  async leaveProgMode(): Promise<void> {
    this.requireVerifiedDevice();
    const link = this.requireLink();
    await link.reset(true);
    await link.reset(false);
  }

  async disconnect(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.link = null;
    this.nvm = null;
    this.verifiedDevice = false;
    if (transport) await transport.close();
  }

  private requireVerifiedDevice(): void {
    if (!this.verifiedDevice) throw new PortError("Connect to a verified ATtiny412 before programming.");
  }

  private requireLink(): UpdiLink {
    if (!this.link) throw new NoResponseError("Connect to an ATtiny412 before programming.");
    return this.link;
  }

  private requireNvm(): NvmController {
    if (!this.nvm) throw new NoResponseError("Connect to an ATtiny412 before programming.");
    return this.nvm;
  }
}

export { LockedError, TINY412 };