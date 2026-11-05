import { AT_TINY412_FLASH_SIZE, FirmwareImage, type ImageSegment } from "./image";

export class IntelHexError extends Error {
  constructor(readonly line: number, message: string) {
    super(`Line ${line}: ${message}`);
    this.name = "IntelHexError";
  }
}

export function parseIntelHex(text: string): FirmwareImage {
  const memory = new Map<number, number>();
  let addressBase = 0;
  let sawEndOfFile = false;
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const line = lines[lineIndex]!.trim();
    if (line.length === 0) continue;
    if (sawEndOfFile) throw new IntelHexError(lineNumber, "data appears after the end-of-file record.");
    if (!line.startsWith(":")) throw new IntelHexError(lineNumber, "record must start with ':'.");

    const record = parseRecord(line.slice(1), lineNumber);
    const [byteCount, addressHigh, addressLow, recordType] = record;
    const address = (addressHigh! << 8) | addressLow!;
    const data = record.slice(4, 4 + byteCount!);

    switch (recordType) {
      case 0x00:
        for (let offset = 0; offset < data.length; offset += 1) {
          const absoluteAddress = addressBase + address + offset;
          const flashAddress = normalizeFlashAddress(absoluteAddress, lineNumber);
          if (memory.has(flashAddress)) {
            throw new IntelHexError(lineNumber, `duplicate data at Flash address 0x${flashAddress.toString(16)}.`);
          }
          memory.set(flashAddress, data[offset]!);
        }
        break;
      case 0x01:
        if (byteCount !== 0 || address !== 0) {
          throw new IntelHexError(lineNumber, "invalid end-of-file record.");
        }
        sawEndOfFile = true;
        break;
      case 0x02:
        if (byteCount !== 2 || address !== 0) {
          throw new IntelHexError(lineNumber, "invalid extended segment address record.");
        }
        addressBase = ((data[0]! << 8) | data[1]!) << 4;
        break;
      case 0x04:
        if (byteCount !== 2 || address !== 0) {
          throw new IntelHexError(lineNumber, "invalid extended linear address record.");
        }
        addressBase = ((data[0]! << 8) | data[1]!) << 16;
        break;
      case 0x03:
      case 0x05:
        if (byteCount !== 4 || address !== 0) {
          throw new IntelHexError(lineNumber, "invalid start-address record.");
        }
        break;
      default:
        throw new IntelHexError(lineNumber, `unsupported record type 0x${recordType!.toString(16)}.`);
    }
  }

  if (!sawEndOfFile) throw new IntelHexError(lines.length || 1, "missing end-of-file record.");
  if (memory.size === 0) throw new IntelHexError(lines.length || 1, "record set contains no Flash data.");
  return new FirmwareImage(toSegments(memory));
}

function parseRecord(hex: string, lineNumber: number): number[] {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new IntelHexError(lineNumber, "record contains invalid hexadecimal data.");
  }

  const bytes = Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  );
  if (bytes.length < 5) throw new IntelHexError(lineNumber, "record is too short.");

  const expectedLength = bytes[0]! + 5;
  if (bytes.length !== expectedLength) {
    throw new IntelHexError(lineNumber, `record length is ${bytes.length}, expected ${expectedLength}.`);
  }
  if (bytes.reduce((sum, byte) => sum + byte, 0) & 0xff) {
    throw new IntelHexError(lineNumber, "checksum is invalid.");
  }
  return bytes;
}

function normalizeFlashAddress(address: number, lineNumber: number): number {
  const relativeAddress = address >= 0x8000 && address < 0x8000 + AT_TINY412_FLASH_SIZE
    ? address - 0x8000
    : address;
  if (relativeAddress < 0 || relativeAddress >= AT_TINY412_FLASH_SIZE) {
    throw new IntelHexError(lineNumber, `address 0x${address.toString(16)} is outside ATtiny412 Flash.`);
  }
  return relativeAddress;
}

function toSegments(memory: Map<number, number>): ImageSegment[] {
  const entries = Array.from(memory).sort(([left], [right]) => left - right);
  const segments: ImageSegment[] = [];
  let current: ImageSegment | undefined;

  for (const [address, value] of entries) {
    if (!current || address !== current.addr + current.data.length) {
      current = { addr: address, data: Uint8Array.of(value) };
      segments.push(current);
    } else {
      const extended = new Uint8Array(current.data.length + 1);
      extended.set(current.data);
      extended[extended.length - 1] = value;
      current.data = extended;
    }
  }

  return segments;
}