export interface ImageSegment {
  addr: number;
  data: Uint8Array;
}

export interface ImagePage {
  addr: number;
  data: Uint8Array;
}

export const AT_TINY412_FLASH_SIZE = 4096;
export const AT_TINY412_FLASH_PAGE_SIZE = 64;

export class FirmwareImage {
  readonly segments: ImageSegment[];

  constructor(segments: readonly ImageSegment[]) {
    this.segments = segments
      .filter((segment) => segment.data.length > 0)
      .map((segment) => ({ addr: segment.addr, data: segment.data.slice() }))
      .sort((left, right) => left.addr - right.addr);

    let previousEnd = 0;
    for (const [index, segment] of this.segments.entries()) {
      if (!Number.isInteger(segment.addr) || segment.addr < 0 || segment.addr >= AT_TINY412_FLASH_SIZE) {
        throw new RangeError(`Segment address 0x${segment.addr.toString(16)} is outside ATtiny412 Flash.`);
      }
      const end = segment.addr + segment.data.length;
      if (end > AT_TINY412_FLASH_SIZE) {
        throw new RangeError("Firmware data extends beyond the 4 KB ATtiny412 Flash.");
      }
      if (index > 0 && segment.addr < previousEnd) {
        throw new RangeError("Firmware segments overlap.");
      }
      previousEnd = end;
    }
  }

  get size(): number {
    return this.segments.reduce((total, segment) => total + segment.data.length, 0);
  }

  toPages(pageSize: number): ImagePage[] {
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new RangeError("Page size must be a positive integer.");
    }

    const pages = new Map<number, Uint8Array>();
    for (const segment of this.segments) {
      for (let index = 0; index < segment.data.length; index += 1) {
        const address = segment.addr + index;
        const pageAddress = Math.floor(address / pageSize) * pageSize;
        let page = pages.get(pageAddress);
        if (!page) {
          page = new Uint8Array(pageSize).fill(0xff);
          pages.set(pageAddress, page);
        }
        page[address - pageAddress] = segment.data[index]!;
      }
    }

    return Array.from(pages, ([addr, data]) => ({ addr, data }))
      .sort((left, right) => left.addr - right.addr);
  }
}