export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class LockedError extends Error {
  constructor(readonly sib: string) {
    super("The chip is locked. Its exact ATtiny model cannot be verified, so erase was refused.");
    this.name = "LockedError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class NvmWriteError extends Error {
  constructor(readonly status: number) {
    super(`The NVM controller reported WRERROR (STATUS 0x${status.toString(16).padStart(2, "0")}).`);
    this.name = "NvmWriteError";
  }
}

export class VerifyError extends Error {
  constructor(readonly address: number, readonly expected: number, readonly actual: number) {
    super(`Readback mismatch at 0x${address.toString(16)}: expected 0x${expected.toString(16)}, received 0x${actual.toString(16)}.`);
    this.name = "VerifyError";
  }
}