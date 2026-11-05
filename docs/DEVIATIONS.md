# Protocol Review

Reviewed against Microchip's official [ATtiny212/214/412/414/416 online datasheet](https://onlinedocs.microchip.com/oxy/GUID-FA7143A4-373D-4A47-8178-62D2D9163DA2-en-US-6/index.html) and the [pymcuprog SerialUPDI implementation](https://github.com/microchip-pic-avr-tools/pymcuprog/tree/main/pymcuprog/serialupdi). The vendor PDF endpoint returned HTTP 403 in this environment; the manufacturer-hosted HTML chapters were available and used for this review.

The protocol values used by Phase 1 agree between those sources. Confirmed details include 8E2 frames, the `0x55` SYNCH character, the UPDI instruction families and field encodings, the `0x1E 0x92 0x23` ATtiny412 signature, the `0x8000` Flash data-space base, the UPDI and NVMCTRL register maps, key values, and the P:0 NVM command and status bit values.

## Clarifications

- `SYNCH` is required before each new instruction. It does not prefix every data byte: operands and repeated data follow the instruction framing, and `REPEAT` suppresses further instruction frames after the first repeated instruction.
- The guard-time field is `UPDI.CTRLA.GTVAL` (default 128 UPDI clock cycles), not `UPDI.CTRLB`. pymcuprog's tinyAVR session setup disables contention detection with `CTRLB=0x08` and enables inter-byte delay with `CTRLA=0x80`; this project preserves the default guard time.
- The datasheet specifies two consecutive BREAK characters for reliable recovery. The Web Serial signal path holds BREAK low for 25 ms per pulse; the fallback reopens at 300 baud with 8E1 for the zero-byte break pulses, then restores 115200 8E2. These are transport-level ways to produce the required line condition, not different UPDI opcodes.
- Datasheet key signatures are presented as 64-bit values. The physical key bytes are sent least-significant byte first; pymcuprog implements this by reversing each key's byte sequence. The ASCII key names in the plan are the human-readable, unreversed strings.
- NVMCTRL command `WP` (0x01) is valid only after the Flash page has been erased. Use `ERWP` (0x03) when the erased state is not known. Phase 1 does not issue either command.

## Sources

- Microchip UPDI frame formats, instruction set, CS registers, reset and key status: [UPDI section](https://onlinedocs.microchip.com/oxy/GUID-FA7143A4-373D-4A47-8178-62D2D9163DA2-en-US-6/GUID-E0945716-9866-4A58-9882-71A3D4CF7361.html), [instruction set](https://onlinedocs.microchip.com/oxy/GUID-FA7143A4-373D-4A47-8178-62D2D9163DA2-en-US-6/GUID-C69516E1-3C82-4ADC-9FB2-028313F62EE5.html), [UART framing](https://onlinedocs.microchip.com/oxy/GUID-FA7143A4-373D-4A47-8178-62D2D9163DA2-en-US-6/GUID-16CB7807-73F1-4E26-8684-D26D81F5D2E7.html), and [NVMCTRL commands](https://onlinedocs.microchip.com/oxy/GUID-FA7143A4-373D-4A47-8178-62D2D9163DA2-en-US-6/GUID-62B4850D-B2C4-463B-B46C-D6BD65754BF7.html).
- pymcuprog instruction/register/key definitions: [`constants.py`](https://github.com/microchip-pic-avr-tools/pymcuprog/blob/main/pymcuprog/serialupdi/constants.py), [`link.py`](https://github.com/microchip-pic-avr-tools/pymcuprog/blob/main/pymcuprog/serialupdi/link.py), [`physical.py`](https://github.com/microchip-pic-avr-tools/pymcuprog/blob/main/pymcuprog/serialupdi/physical.py), [`application.py`](https://github.com/microchip-pic-avr-tools/pymcuprog/blob/main/pymcuprog/serialupdi/application.py), [`nvmp0.py`](https://github.com/microchip-pic-avr-tools/pymcuprog/blob/main/pymcuprog/serialupdi/nvmp0.py), and [`attiny412.py`](https://github.com/microchip-pic-avr-tools/pymcuprog/blob/main/pymcuprog/deviceinfo/devices/attiny412.py).

No real-hardware behavior has been verified. Phase 1 verification is against the software mock only.