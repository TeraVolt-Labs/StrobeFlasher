# UPDI Web Flasher: Build Spec for an AI Coding Agent

## 0. Kickoff prompt (paste this to the agent)

> Read AGENT_PLAN.md fully. Build the project phase by phase (Section 9). After each phase: run the tests, commit, and report which acceptance criteria pass. Do not start the next phase until the current one passes. Never claim something is verified on real hardware unless it was actually run on hardware; state clearly what is only verified against the mock target. Verify every protocol constant in Section 4 against the ATtiny212/412 datasheet and the pymcuprog source before relying on it; if something here disagrees with those, trust them and note the discrepancy in `docs/DEVIATIONS.md`.

---

## 1. Goal

A **single self-contained HTML file** (no CDN, no external requests, works offline) that runs in Chrome/Edge, connects to a USB-serial UPDI programmer through the Web Serial API, and flashes a **locally chosen firmware file** (Intel HEX, optionally raw BIN) onto an **ATtiny412**, then verifies it.

End users are customers who received our modules and a programmer. They are not embedded engineers, so the tool must be foolproof and its errors must be plain language.

## 2. Non-negotiable requirements

1. Zero runtime dependencies. The final build is one `.html` file with JS and CSS inlined.
2. No network access at runtime. No analytics, fonts or CDN links.
3. Only the ATtiny412 is allowed by default. Check the signature `1E 92 23` before any write. Refuse anything else with a clear message.
4. **Never write fuses or lock bits** in the default flow. This stops customers from accidentally disabling the UPDI pin or locking the chip. Fuse access, if added, is behind a clearly marked "Advanced" section and is off by default.
5. Every flash operation ends with a read-back verify. The UI never shows success without it.
6. Failures leave the device recoverable: the customer can retry without help.
7. Programmer access is behind a `Programmer` interface (Section 5) so a jtag2updi driver can be added later without changing the UI.

## 3. Tech stack and repo layout

- Plain ES modules, TypeScript preferred. Vite plus `vite-plugin-singlefile`, or esbuild with a custom inliner. Vitest for tests.
- Keep dependencies to dev-only tooling.

```
/src
  transport/webserial.ts     # Web Serial wrapper, echo handling, timeouts, break
  updi/link.ts               # UPDI instructions, CS registers, keys
  updi/nvm.ts                # tinyAVR 0/1 NVMCTRL operations
  updi/programmer.ts         # Programmer interface + SerialUpdiProgrammer
  image/ihex.ts              # Intel HEX parser
  image/bin.ts               # BIN loader
  image/image.ts             # FirmwareImage: sparse segments -> padded pages
  ui/                        # UI components, log, progress
  app.ts                     # wiring
/test
  mock/mockUpdiTarget.ts     # simulated ATtiny412 on the UPDI wire
  *.test.ts
/docs
  DEVIATIONS.md  PROTOCOL_NOTES.md  CUSTOMER_QUICKSTART.md
```

## 4. Protocol reference (VERIFY ALL OF THESE against datasheet and pymcuprog)

### 4.1 Physical and framing
- UPDI is a half-duplex UART, **8 data bits, even parity, 2 stop bits (8E2)**. Start at 115200 baud, optionally raise to 230400 after connect.
- Every frame starts with SYNC `0x55`.
- Adapter wiring: USB-serial TX → 4.7k resistor → UPDI pin; USB-serial RX connects directly to the UPDI pin. Because of this, **every transmitted byte is echoed on RX** and must be read and discarded before reading the response.
- Web Serial supports `dataBits: 8, parity: 'even', stopBits: 2`.

### 4.2 Break (reset/sync)
- Preferred: `port.setSignals({ break: true })`, hold about 25 ms, then `{ break: false }`. Send a double break.
- Fallback if that does not work on a given driver: close the port, reopen at about 300 baud 8E1, send `0x00`, close, and reopen at the working baud.
- After a break, send SYNC and write CTRLA/CTRLB settings (Section 4.4).

### 4.3 Instructions (after SYNC 0x55)
| Instruction | Opcode | Notes |
|---|---|---|
| LDS | `0x00 \| (addrSize<<2) \| dataSize` | addrSize: 0=8-bit, 1=16-bit, 2=24-bit; dataSize: 0=byte, 1=word. LDS 16-bit address, byte data = `0x04` |
| STS | `0x40 \| (addrSize<<2) \| dataSize` | STS 16-bit address, byte data = `0x44`; address bytes, then wait for ACK `0x40`, then data byte, then ACK |
| LD | `0x20 \| (ptrMode<<2) \| size` | ptrMode: 0=`*ptr`, 1=`*ptr++`, 2=`ptr` |
| ST | `0x60 \| (ptrMode<<2) \| size` | ST ptr (set address, 16-bit) = `0x69` |
| LDCS | `0x80 \| reg` | read control/status register |
| STCS | `0xC0 \| reg` | write control/status register |
| REPEAT | `0xA0 \| size` | repeat count follows; the next instruction runs count+1 times |
| KEY | `0xE0 \| size` | size 0 = 64-bit key, sent **LSB first (ASCII reversed)** |

### 4.4 CS registers
STATUSA `0x00`, STATUSB `0x01`, CTRLA `0x02`, CTRLB `0x03`, ASI_KEY_STATUS `0x07`, ASI_RESET_REQ `0x08`, ASI_CTRLA `0x09`, ASI_SYS_CTRLA `0x0A`, ASI_SYS_STATUS `0x0B`, ASI_CRC_STATUS `0x0C`.
- Reset: write `0x59` to ASI_RESET_REQ, then `0x00` to release.
- After connecting, set CTRLB so the guard time is sensible and CTRLA inter-byte delay is set. Take values from pymcuprog and SerialUPDI.

### 4.5 Keys (ASCII, sent reversed)
- NVM programming: `"NVMProg "`
- Chip erase: `"NVMErase"`
- User row write: `"NVMUs&te"`

Enter programming mode: send the NVMProg key, check ASI_KEY_STATUS, reset, poll ASI_SYS_STATUS until NVMPROG is set (with timeout).

### 4.6 ATtiny412 memory map (data space)
- Flash: starts at `0x8000`, 4 KB, **64-byte pages**
- EEPROM: `0x1400`, 128 bytes, 32-byte pages
- User row: `0x1300`, 32 bytes
- Signature row: `0x1100`, expected `1E 92 23`
- Fuses: `0x1280` (do not touch in the default flow)
- NVMCTRL base `0x1000`: CTRLA `+0x00`, STATUS `+0x02` (FBUSY bit0, EEBUSY bit1, WRERROR bit2)
- NVMCTRL commands: `NOOP 0x00, WP 0x01, ER 0x02, ERWP 0x03, PBC 0x04, CHER 0x05, EEER 0x06, WFU 0x07`

### 4.7 Operation sequences
- **Connect:** break, SYNC, set CTRLA/CTRLB, read STATUSA (UPDI revision), read SIB or device ID, read signature, compare with `1E 92 23`.
- **Locked chip:** if ASI_SYS_STATUS LOCKSTATUS is set, only chip erase is possible. Ask the user for confirmation in the UI ("This will erase the existing firmware") before doing it.
- **Chip erase:** send the NVMErase key, reset, poll LOCKSTATUS clear, then re-enter programming mode.
- **Page write:** issue PBC (page buffer clear), set the pointer to the page address, REPEAT n, ST `*ptr++` word writes of the whole page, then issue WP (or ERWP if the page is not known to be erased). Poll NVMCTRL STATUS until FBUSY clears, and check WRERROR.
- **Verify:** read the flash back using REPEAT + LD `*ptr++` in blocks and compare it with the image.
- **Finish:** release reset (ASI_RESET_REQ `0x59`, then `0x00`) so the new firmware starts. Optionally set UPDIDIS in CTRLB. Default: leave UPDI enabled.

## 5. Interfaces

```ts
interface Programmer {
  connect(): Promise<DeviceInfo>;          // opens, syncs, reads signature
  enterProgMode(): Promise<void>;
  chipErase(): Promise<void>;
  readMem(addr: number, len: number): Promise<Uint8Array>;
  writePage(addr: number, data: Uint8Array): Promise<void>;
  leaveProgMode(): Promise<void>;          // reset and release
  disconnect(): Promise<void>;
}

interface FirmwareImage {
  segments: { addr: number; data: Uint8Array }[];   // flash-relative
  toPages(pageSize: number): { addr: number; data: Uint8Array }[]; // padded with 0xFF
}
```
All errors are typed (`NoResponseError`, `WrongDeviceError`, `LockedError`, `VerifyError`, `TimeoutError`, `PortError`) and each maps to a plain-language UI message.

## 6. Image handling
- **Intel HEX:** record types 00, 01, 02, 04 (and 03/05 ignored). Verify checksums and report line numbers on error. Reject data outside flash (`0x0000–0x0FFF` flash-relative, or `0x8000–0x8FFF` if the toolchain emits data-space addresses; autodetect by range).
- **BIN:** load at flash offset 0. Reject if larger than 4096 bytes.
- Pad partial pages with `0xFF`. Show size and a CRC32 of the image in the UI before flashing.
- Optional later: ELF `.text` and `.data` sections.

## 7. UI spec
Single page, minimal, large buttons, works at phone width.
1. **Connect:** button opens the browser serial port picker. Show the detected chip ("ATtiny412 detected") or an error.
2. **File:** drag and drop or file picker, showing name, size and CRC32.
3. **Flash:** one button. A progress bar covers erase, write and verify. A final banner reads "Flashed and verified" or shows a plain-language error with the next step.
4. **Log:** collapsible, copyable log with a "Copy diagnostics" button (versions, browser, serial IDs, error text, no personal data).
5. **Browser check:** if `navigator.serial` is missing, show a full-page "Please use Chrome or Edge on desktop" message.
6. **Advanced** (collapsed): baud selection, force chip erase, raw hex dump of the first bytes read back.

Message examples:
- No response: "No response on the UPDI line. Check the 3-wire connection and that the module is powered."
- Wrong chip: "This tool only programs the ATtiny412 and found a different chip."
- Verify failure: "The data written does not match the file. Try again; if it fails again, check the wiring and power."

## 8. Test strategy
1. **Mock UPDI target** (`test/mock/mockUpdiTarget.ts`): a state machine implementing sync, LDS/STS/LD/ST/LDCS/STCS/REPEAT/KEY, the key and reset sequence, NVMCTRL commands, a 4 KB flash model with page buffer semantics, a lock-status model, and the TX echo on the wire. It plugs in as a fake `SerialPort`.
2. **Unit tests:** HEX parser (valid, bad checksum, extended addresses, out of range), padding, instruction encoding.
3. **Integration tests over the mock:** connect, erase, write a full image, verify, plus the failure cases: no device, wrong signature, locked chip, mid-write disconnect, verify mismatch, WRERROR.
4. **Golden traces:** document how to capture byte traces from pymcuprog or SerialUPDI on a real ATtiny412 and compare them with the browser tool's output. Add them to `test/golden/` when the human provides captures.
5. **Hardware checklist** (`docs/HARDWARE_TEST.md`, run by a human): FT230X, CP2102N and a custom dongle, on Windows, macOS, Linux and Chrome Android, at 115200 and 230400. The agent produces the checklist and does not claim these as done.

## 9. Phases and acceptance criteria

**Phase 1: Transport and link layer**
- Web Serial wrapper with 8E2, echo discard, timeouts, break with fallback.
- UPDI link encoding and a CLI-style debug page that reads the signature.
- Accept: the mock test reads signature `1E 92 23`; instruction byte encodings match Section 4.3; the code compiles with strict typing.

**Phase 2: NVM layer and image parsing**
- Enter prog mode, chip erase, page write, readback, verify; HEX and BIN parsing.
- Accept: a full 4 KB image is written and verified against the mock; all failure-injection tests pass; the parser test suite passes.

**Phase 3: UI and single-file build**
- Full UI per Section 7, typed error mapping, build to one HTML file.
- Accept: the built file opens with no network requests (verify with a test that fails on any `fetch` or external URL in the bundle); works against the mock in the browser; the `navigator.serial` missing-state screen is shown.

**Phase 4: Hardening and docs**
- Baud bump option, retry logic, diagnostics copy, `CUSTOMER_QUICKSTART.md` (one page, with a wiring diagram described in text and an SVG), `HARDWARE_TEST.md`, `PROTOCOL_NOTES.md`.
- Accept: all docs present; the full test suite passes in CI; bundle size reported.

**Phase 5 (optional): Signed firmware package**
- Package format: JSON wrapper with `productId`, `hwRev`, `fwVersion`, `crc32`, the base64 HEX and an Ed25519 signature checked with WebCrypto against a public key embedded at build time. The raw-HEX path stays behind an "Advanced" toggle.
- Provide a Node CLI `pack-firmware` that signs images, with the private key read from an environment variable or file and never committed.
- Accept: tampered or wrong-product packages are rejected in tests; a valid package flashes against the mock.

**Phase 6 (optional): jtag2updi driver**
- JTAG2 framing (start byte `0x1B`, sequence number, size, token `0x0E`, message, CRC16) and the subset of messages: sign-on, get-sync, set-parameter, enter-progmode, read and write memory, erase. Careful DTR handling so an Uno does not auto-reset when the port opens.
- Implements the same `Programmer` interface; a UI dropdown selects the driver.
- Accept: passes the same integration suite against a mock JTAG2 target.

## 10. Out of scope
- Other chips, fuse editing in the default flow, firmware read-back for end users, Firefox and Safari support, and cloud services of any kind.

## 11. Defaults chosen (change if wrong)
- Chrome/Edge desktop plus Android Chrome only.
- Serial UPDI is the primary driver; jtag2updi is optional.
- Firmware protection (signing, no read-back for customers) is optional Phase 5. The UPDI lock bit set at manufacture remains the stronger protection, but it is a production-line decision, not part of this tool.

## 12. Known risks the agent should surface rather than hide
- Web Serial availability on `file://` in the customers' browsers. Test it, and document hosting over HTTPS as the fallback.
- `setSignals({break})` behavior differs by USB-serial driver. Keep the baud-trick fallback and report which path was used in the log.
- USB-serial latency on Windows with FTDI parts. Keep writes batched per page.
