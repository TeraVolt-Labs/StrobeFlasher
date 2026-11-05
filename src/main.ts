import "./style.css";
import { loadBin } from "./image/bin";
import { crc32 } from "./image/crc32";
import { parseIntelHex } from "./image/ihex";
import { AT_TINY412_FLASH_PAGE_SIZE, AT_TINY412_FLASH_SIZE, FirmwareImage } from "./image/image";
import { NoResponseError, PortError, type SerialPortLike } from "./transport/webserial";
import { LockedError, NvmWriteError, ProtocolError, TimeoutError, VerifyError } from "./updi/errors";
import { WrongDeviceError } from "./updi/link";
import { SerialUpdiProgrammer, TINY412 } from "./updi/programmer";

interface WebSerialApi {
  requestPort(): Promise<SerialPortLike>;
}

interface NavigatorWithSerial extends Navigator {
  serial?: WebSerialApi;
}

interface SelectedFirmware {
  file: File;
  image: FirmwareImage;
  crc: number;
}

const serial = (navigator as NavigatorWithSerial).serial;
const app = getElement<HTMLElement>("app");
const browserCheck = getElement<HTMLElement>("browser-check");
const connectButton = getElement<HTMLButtonElement>("connect-button");
const disconnectButton = getElement<HTMLButtonElement>("disconnect-button");
const flashButton = getElement<HTMLButtonElement>("flash-button");
const fileInput = getElement<HTMLInputElement>("firmware-file");
const dropZone = getElement<HTMLLabelElement>("drop-zone");
const fileSummary = getElement<HTMLElement>("file-summary");
const fileName = getElement<HTMLElement>("file-name");
const fileMetadata = getElement<HTMLElement>("file-metadata");
const fileCrc = getElement<HTMLElement>("file-crc");
const fileError = getElement<HTMLElement>("file-error");
const connectionState = getElement<HTMLSpanElement>("connection-state");
const connectionMessage = getElement<HTMLElement>("connection-message");
const deviceResult = getElement<HTMLElement>("device-result");
const signatureResult = getElement<HTMLElement>("signature-result");
const flashProgress = getElement<HTMLProgressElement>("flash-progress");
const progressLabel = getElement<HTMLElement>("progress-label");
const resultBanner = getElement<HTMLElement>("result-banner");
const sessionLog = getElement<HTMLPreElement>("session-log");
const baudRate = getElement<HTMLSelectElement>("baud-rate");
const forceChipErase = getElement<HTMLInputElement>("force-chip-erase");
const rawDump = getElement<HTMLElement>("raw-dump");
const copyDiagnostics = getElement<HTMLButtonElement>("copy-diagnostics");
const clearLogButton = getElement<HTMLButtonElement>("clear-log-button");

let programmer: SerialUpdiProgrammer | null = null;
let selectedFirmware: SelectedFirmware | null = null;
let isBusy = false;
let lastError = "";
let portIdentifiers: { usbVendorId?: number; usbProductId?: number } | null = null;

if (!serial) {
  browserCheck.hidden = false;
  app.hidden = true;
} else {
  app.hidden = false;
  connectButton.addEventListener("click", connectToDevice);
  disconnectButton.addEventListener("click", disconnectFromDevice);
  flashButton.addEventListener("click", flashFirmware);
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void loadFirmware(file);
  });
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.dataset.dragging = "true";
  });
  dropZone.addEventListener("dragleave", () => { delete dropZone.dataset.dragging; });
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    delete dropZone.dataset.dragging;
    const file = event.dataTransfer?.files[0];
    if (file) void loadFirmware(file);
  });
  copyDiagnostics.addEventListener("click", copyDiagnosticReport);
  clearLogButton.addEventListener("click", () => { sessionLog.textContent = "Ready. No data leaves this browser."; });
  forceChipErase.addEventListener("change", () => {
    if (forceChipErase.checked) {
      showBanner("Full chip erase is enabled. Existing Flash and EEPROM will be erased after you confirm.", "working");
    } else {
      hideBanner();
    }
  });
  refreshFlashButton();
}

async function connectToDevice(): Promise<void> {
  if (!serial || isBusy) return;
  connectButton.disabled = true;
  setConnectionState("idle", "OPENING PORT");
  connectionMessage.textContent = "Choose the USB serial programmer in the browser dialog.";
  appendLog("opening the serial port picker");

  let candidate: SerialUpdiProgrammer | null = null;
  try {
    const port = await serial.requestPort();
    candidate = new SerialUpdiProgrammer(port, Number(baudRate.value));
    const info = await candidate.connect();
    programmer = candidate;
    portIdentifiers = candidate.portInfo;
    deviceResult.textContent = "StrobeIT-Pro detected";
    signatureResult.textContent = "Device identity verified";
    signatureResult.hidden = false;
    connectionMessage.textContent = `Connected at ${baudRate.value} baud.`;
    setConnectionState("connected", "CONNECTED");
    appendLog("StrobeIT-Pro identity verified");
    appendLog(`reset method: ${info.breakPath === "signals" ? "signal reset" : "slow-speed reset"}`);
    if (portIdentifiers) appendLog(`USB IDs: ${formatUsbId(portIdentifiers.usbVendorId)}:${formatUsbId(portIdentifiers.usbProductId)}`);
    baudRate.disabled = true;
  } catch (error) {
    await candidate?.disconnect().catch(() => undefined);
    lastError = plainError(error);
    deviceResult.textContent = error instanceof WrongDeviceError ? "Unsupported device" : "Not connected";
    signatureResult.textContent = error instanceof WrongDeviceError
      ? "Device identity could not be verified"
      : error instanceof LockedError
        ? "Device is locked"
        : "Identity not available";
    signatureResult.hidden = false;
    connectionMessage.textContent = nextStep(error);
    setConnectionState("error", "NOT CONNECTED");
    showBanner(lastError, "error");
    appendLog(`connection failed: ${lastError}${diagnosticHint(error)}`);
  } finally {
    connectButton.disabled = Boolean(programmer);
    refreshFlashButton();
  }
}

async function disconnectFromDevice(): Promise<void> {
  if (!programmer || isBusy) return;
  await programmer.disconnect().catch((error: unknown) => appendLog(plainError(error)));
  programmer = null;
  portIdentifiers = null;
  deviceResult.textContent = "No device connected";
  signatureResult.textContent = "Identity not available";
  signatureResult.hidden = true;
  connectionMessage.textContent = "Connect the programmer to the powered module.";
  setConnectionState("idle", "NOT CONNECTED");
  baudRate.disabled = false;
  appendLog("serial port closed");
  refreshFlashButton();
}

async function loadFirmware(file: File): Promise<void> {
  fileError.hidden = true;
  hideBanner();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extension = file.name.split(".").pop()?.toLowerCase();
    const image = extension === "bin"
      ? loadBin(bytes)
      : extension === "hex" || extension === "ihex"
        ? parseIntelHex(new TextDecoder().decode(bytes))
        : unsupportedFile();
    if (image.size === 0) throw new Error("The firmware file contains no Flash data.");

    selectedFirmware = { file, image, crc: crc32(denseFlashImage(image)) };
    fileName.textContent = file.name;
    fileMetadata.textContent = `${formatBytes(file.size)} file · ${image.size} Flash bytes · ${image.segments.length} segment(s)`;
    fileCrc.textContent = `CRC32 ${selectedFirmware.crc.toString(16).padStart(8, "0").toUpperCase()}`;
    fileSummary.hidden = false;
    appendLog(`loaded ${image.size} Flash bytes from local firmware`);
    refreshFlashButton();
  } catch (error) {
    selectedFirmware = null;
    fileSummary.hidden = true;
    lastError = plainError(error);
    fileError.textContent = lastError;
    fileError.hidden = false;
    appendLog(`firmware rejected: ${lastError}`);
    refreshFlashButton();
  }
}

async function flashFirmware(): Promise<void> {
  if (!programmer || !selectedFirmware || isBusy) return;
  const activeProgrammer = programmer;
  const firmware = selectedFirmware;
  const eraseEntireChip = forceChipErase.checked;
  if (eraseEntireChip && !window.confirm("This erases all existing Flash and EEPROM before programming. Continue?")) return;

  isBusy = true;
  lastError = "";
  flashButton.disabled = true;
  fileInput.disabled = true;
  connectButton.disabled = true;
  disconnectButton.disabled = true;
  flashProgress.value = 0;
  rawDump.textContent = "Reading back...";
  showBanner("Preparing StrobeIT-Pro.", "working");

  const pages = firmware.image.toPages(AT_TINY412_FLASH_PAGE_SIZE);
  try {
    setProgress(2, "PREPARING DEVICE");
    appendLog("preparing device for update");
    await activeProgrammer.enterProgMode();
    appendLog("device ready for programming");
    if (eraseEntireChip) {
      setProgress(4, "ERASING DEVICE");
      appendLog("starting full erase after device verification and confirmation");
      await activeProgrammer.chipErase();
      appendLog("full chip erase completed");
    }

    for (let index = 0; index < pages.length; index += 1) {
      const percent = 5 + Math.floor(((index + 1) / pages.length) * 62);
      setProgress(percent, `ERASING & WRITING PAGE ${index + 1}/${pages.length}`);
      const page = pages[index]!;
      await activeProgrammer.writePage(TINY412.flashBase + page.addr, page.data);
    }

    for (let index = 0; index < pages.length; index += 1) {
      const percent = 68 + Math.floor(((index + 1) / pages.length) * 29);
      setProgress(percent, `VERIFYING PAGE ${index + 1}/${pages.length}`);
      const page = pages[index]!;
      await activeProgrammer.verifyMem(TINY412.flashBase + page.addr, page.data);
    }

    const firstBytes = await activeProgrammer.readMem(TINY412.flashBase, 16);
    rawDump.textContent = formatHex(firstBytes);
    await activeProgrammer.leaveProgMode();
    setProgress(100, "COMPLETE");
    showBanner("Flashed and verified", "success");
    appendLog(`completed read-back verification for ${firmware.image.size} Flash bytes`);
  } catch (error) {
    const failedStage = progressLabel.textContent || "unknown stage";
    lastError = plainError(error);
    showBanner(`${lastError} ${nextStep(error)}`, "error");
    progressLabel.textContent = "FAILED";
    const diagnostic = diagnosticHint(error);
    appendLog(`flash failed during ${failedStage}: ${lastError}${diagnostic}`);
    await activeProgrammer.leaveProgMode().catch(() => undefined);
    if (requiresReconnect(error)) {
      await activeProgrammer.disconnect().catch((disconnectError: unknown) => appendLog(plainError(disconnectError)));
      if (programmer === activeProgrammer) {
        programmer = null;
        portIdentifiers = null;
        deviceResult.textContent = "No device connected";
        signatureResult.textContent = "Signature not available";
        signatureResult.hidden = true;
        connectionMessage.textContent = "Reconnect the programmer before retrying.";
        setConnectionState("error", "RECONNECT REQUIRED");
        baudRate.disabled = false;
        appendLog("serial port closed after communication failure; reconnect before retrying");
      }
    }
  } finally {
    isBusy = false;
    connectButton.disabled = Boolean(programmer);
    disconnectButton.disabled = !programmer;
    fileInput.disabled = false;
    refreshFlashButton();
  }
}

async function copyDiagnosticReport(): Promise<void> {
  const report = {
    appVersion: "0.1.0",
    browser: navigator.userAgent,
    baudRate: baudRate.value,
    usbVendorId: portIdentifiers?.usbVendorId ?? null,
    usbProductId: portIdentifiers?.usbProductId ?? null,
    error: lastError || null,
    log: sessionLog.textContent
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    appendLog("diagnostics copied");
  } catch {
    showBanner("Clipboard access is unavailable. Select and copy the session log instead.", "error");
  }
}

function denseFlashImage(image: FirmwareImage): Uint8Array {
  const dense = new Uint8Array(AT_TINY412_FLASH_SIZE).fill(0xff);
  for (const segment of image.segments) dense.set(segment.data, segment.addr);
  return dense;
}

function unsupportedFile(): never {
  throw new Error("Choose an Intel HEX (.hex, .ihex) or raw BIN (.bin) firmware file.");
}

function refreshFlashButton(): void {
  flashButton.disabled = isBusy || !programmer || !selectedFirmware;
}

function setConnectionState(state: "idle" | "connected" | "error", label: string): void {
  connectionState.dataset.state = state;
  connectionState.textContent = label;
}

function setProgress(value: number, label: string): void {
  flashProgress.value = value;
  progressLabel.textContent = label;
}

function showBanner(message: string, state: "working" | "success" | "error"): void {
  resultBanner.dataset.state = state;
  resultBanner.textContent = message;
  resultBanner.hidden = false;
}

function hideBanner(): void {
  resultBanner.hidden = true;
}

function appendLog(message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  sessionLog.textContent = `${sessionLog.textContent}\n${timestamp}  ${message}`;
  sessionLog.scrollTop = sessionLog.scrollHeight;
}

function plainError(error: unknown): string {
  if (error instanceof NoResponseError) return "No response from the device. Check the programmer connection and module power.";
  if (error instanceof WrongDeviceError) return "This device is not a supported StrobeIT-Pro module.";
  if (error instanceof LockedError) return "This device is locked and cannot be verified. No erase was performed.";
  if (error instanceof VerifyError) return "Firmware verification failed. Check the connection and retry.";
  if (error instanceof NvmWriteError) return "The device reported a programming error. Keep it powered and retry.";
  if (error instanceof TimeoutError) return "The device took too long to respond. Keep it powered, reconnect, and retry.";
  if (error instanceof PortError) return "The programmer connection was interrupted. Check the connection and retry.";
  if (error instanceof ProtocolError) return "Device communication failed. Check the programmer connection and power, then retry.";
  if (error instanceof Error) return error.message.replace(/ATtiny412/gi, "StrobeIT-Pro device").replace(/UPDI/gi, "device interface");
  return "The update could not be completed.";
}

function nextStep(error: unknown): string {
  if (error instanceof LockedError) return "Use an approved recovery workflow for this locked device.";
  if (error instanceof WrongDeviceError) return "Connect a supported StrobeIT-Pro module to continue.";
  if (error instanceof VerifyError) return "Check the wiring and power, then retry.";
  return "Check the connection and power, then retry.";
}

function diagnosticHint(error: unknown): string {
  if (!(error instanceof NoResponseError)) return "";
  if (error.message.includes("USB-serial TX echo")) return " (programmer echo timeout)";
  if (error.message.includes("USB-serial BREAK echo")) return " (programmer reset timeout)";
  if (error.message.includes("ACK")) return " (device write acknowledgement timeout)";
  return " (device response timeout)";
}

function requiresReconnect(error: unknown): boolean {
  return error instanceof NoResponseError
    || error instanceof PortError
    || error instanceof ProtocolError
    || error instanceof TimeoutError
    || error instanceof LockedError;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function formatUsbId(value: number | undefined): string {
  return value === undefined ? "unknown" : value.toString(16).padStart(4, "0").toUpperCase();
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing page element: ${id}`);
  return element as T;
}