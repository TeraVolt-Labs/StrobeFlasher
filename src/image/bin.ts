import { AT_TINY412_FLASH_SIZE, FirmwareImage } from "./image";

export function loadBin(data: Uint8Array): FirmwareImage {
  if (data.length === 0) throw new RangeError("The BIN file is empty.");
  if (data.length > AT_TINY412_FLASH_SIZE) {
    throw new RangeError("The BIN file is larger than the 4 KB ATtiny412 Flash.");
  }
  return new FirmwareImage([{ addr: 0, data }]);
}