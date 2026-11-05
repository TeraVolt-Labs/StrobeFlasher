import "./style.css";
import { NoResponseError, PortError, WebSerialTransport, type SerialPortLike } from "./transport/webserial";
import { formatSignature, UpdiLink, WrongDeviceError } from "./updi/link";

interface WebSerialApi {
  requestPort(): Promise<SerialPortLike>;
}

interface NavigatorWithSerial extends Navigator {
  serial?: WebSerialApi;
}

const connectButton = getElement<HTMLButtonElement>("connect-button");
const disconnectButton = getElement<HTMLButtonElement>("disconnect-button");
const clearLogButton = getElement<HTMLButtonElement>("clear-log-button");
const connectionState = getElement<HTMLSpanElement>("connection-state");
const browserWarning = getElement<HTMLParagraphElement>("browser-warning");
const deviceResult = getElement<HTMLElement>("device-result");
const signatureResult = getElement<HTMLSpanElement>("signature-result");
const sessionLog = getElement<HTMLPreElement>("session-log");

let transport: WebSerialTransport | null = null;

if (!(navigator as NavigatorWithSerial).serial) {
  browserWarning.hidden = false;
  connectButton.disabled = true;
  setState("error", "WEB SERIAL UNAVAILABLE");
}

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  try {
    const serial = (navigator as NavigatorWithSerial).serial;
    if (!serial) throw new Error("Web Serial is unavailable in this browser.");

    appendLog("opening the browser serial port picker");
    const port = await serial.requestPort();
    transport = await WebSerialTransport.open(port);
    const link = new UpdiLink(transport);
    const info = await link.connect();

    deviceResult.textContent = info.name + " detected";
    signatureResult.textContent = `Signature: ${formatSignature(info.signature)}`;
    setState("connected", "CONNECTED");
    disconnectButton.disabled = false;
    appendLog(`UPDI revision ${info.updiRevision}; signature ${formatSignature(info.signature)}`);
    appendLog(`break path: ${info.breakPath}`);
  } catch (error) {
    deviceResult.textContent = error instanceof WrongDeviceError
      ? "Unsupported device"
      : error instanceof NoResponseError
        ? "No UPDI response"
        : "Connection failed";
    if (error instanceof WrongDeviceError) {
      signatureResult.textContent = `Signature: ${formatSignature(error.signature)}`;
    }
    setState("error", "CHECK CONNECTION");
    appendLog(errorMessage(error));
    if (transport) {
      await transport.close().catch(() => undefined);
      transport = null;
    }
  } finally {
    connectButton.disabled = !(navigator as NavigatorWithSerial).serial || Boolean(transport);
  }
});

disconnectButton.addEventListener("click", async () => {
  if (!transport) return;
  await transport.close().catch((error: unknown) => appendLog(errorMessage(error)));
  transport = null;
  deviceResult.textContent = "No device connected";
  signatureResult.textContent = "Signature: -- -- --";
  disconnectButton.disabled = true;
  connectButton.disabled = false;
  setState("idle", "NOT CONNECTED");
  appendLog("serial port closed");
});

clearLogButton.addEventListener("click", () => {
  sessionLog.textContent = "$ log cleared";
});

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing page element: ${id}`);
  return element as T;
}

function setState(state: "idle" | "connected" | "error", label: string): void {
  connectionState.dataset.state = state;
  connectionState.textContent = label;
}

function appendLog(message: string): void {
  sessionLog.textContent = `${sessionLog.textContent}\n$ ${message}`;
  sessionLog.scrollTop = sessionLog.scrollHeight;
}

function errorMessage(error: unknown): string {
  if (error instanceof WrongDeviceError) return `wrong device signature: ${formatSignature(error.signature)}`;
  if (error instanceof NoResponseError) return "no response; check power, wiring, and the UPDI connection";
  if (error instanceof PortError) return error.message;
  return error instanceof Error ? error.message : "unexpected connection error";
}