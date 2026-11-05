import "./style.css";
import { loadBin } from "./image/bin";
import { crc32 } from "./image/crc32";
import { parseIntelHex } from "./image/ihex";
import { AT_TINY412_FLASH_PAGE_SIZE, AT_TINY412_FLASH_SIZE, FirmwareImage } from "./image/image";
import { NoResponseError, PortError, type SerialPortLike } from "./transport/webserial";
import { LockedError, NvmWriteError, ProtocolError, TimeoutError, VerifyError } from "./updi/errors";
import { formatSignature, WrongDeviceError } from "./updi/link";
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
    deviceResult.textContent = "ATtiny412 detected";
    signatureResult.textContent = `Signature: ${formatSignature(info.signature)}`;
    signatureResult.hidden = false;
    connectionMessage.textContent = `Connected at ${baudRate.value} baud. UPDI revision ${info.updiRevision}.`;
    setConnectionState("connected", "CONNECTED");
    appendLog(`ATtiny412 signature verified (${formatSignature(info.signature)})`);
    appendLog(`reset/break path: ${info.breakPath}`);
    if (portIdentifiers) appendLog(`USB IDs: ${formatUsbId(portIdentifiers.usbVendorId)}:${formatUsbId(portIdentifiers.usbProductId)}`);
    baudRate.disabled = true;
  } catch (error) {
    await candidate?.disconnect().catch(() => undefined);
    lastError = plainError(error);
    deviceResult.textContent = error instanceof WrongDeviceError ? "Different chip detected" : "Not connected";
    signatureResult.textContent = error instanceof WrongDeviceError
      ? `Signature: ${formatSignature(error.signature)}`
      : error instanceof LockedError
        ? "Signature not available; chip is locked"
        : "Signature not available";
    signatureResult.hidden = false;
    connectionMessage.textContent = nextStep(error);
    setConnectionState("error", "NOT CONNECTED");
    showBanner(lastError, "error");
    appendLog(lastError);
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
  signatureResult.textContent = "Signature not available";
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
  showBanner("Preparing the ATtiny412.", "working");

  const pages = firmware.image.toPages(AT_TINY412_FLASH_PAGE_SIZE);
  try {
    await activeProgrammer.enterProgMode();
    if (eraseEntireChip) {
      setProgress(4, "ERASING CHIP");
      appendLog("starting full chip erase after signature verification and confirmation");
      await activeProgrammer.chipErase();
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
    lastError = plainError(error);
    showBanner(`${lastError} ${nextStep(error)}`, "error");
    progressLabel.textContent = "FAILED";
    appendLog(`flash failed: ${lastError}`);
    await activeProgrammer.leaveProgMode().catch(() => undefined);
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
  if (error instanceof NoResponseError) return "No response on the UPDI line. Check the 3-wire connection and that the module is powered.";
  if (error instanceof WrongDeviceError) return "This tool only programs the ATtiny412 and found a different chip.";
  if (error instanceof LockedError) return "This chip is locked and cannot be identified as an ATtiny412. No erase was performed.";
  if (error instanceof VerifyError) return "The data written does not match the file. Try again; if it fails again, check the wiring and power.";
  if (error instanceof NvmWriteError) return "The chip reported a Flash write error. Keep it powered and retry the update.";
  if (error instanceof TimeoutError) return "The chip took too long to respond. Keep it powered, reconnect, and retry.";
  if (error instanceof PortError) return "The serial connection was interrupted. Check the programmer connection and retry.";
  if (error instanceof ProtocolError) return "Communication with the UPDI line failed. Check the wiring and power, then retry.";
  return error instanceof Error ? error.message : "The update could not be completed.";
}

function nextStep(error: unknown): string {
  if (error instanceof LockedError) return "Use an approved recovery workflow for this locked device.";
  if (error instanceof WrongDeviceError) return "Connect an ATtiny412 module to continue.";
  if (error instanceof VerifyError) return "Check the wiring and power, then retry.";
  return "Check the connection and power, then retry.";
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