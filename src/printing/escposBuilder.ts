// src/printing/escposBuilder.ts

// A tiny helper to build ESC/POS commands as bytes
export type TextAlign = "left" | "center" | "right";

export type TextStyleOptions = {
  align?: TextAlign;
  bold?: boolean;
  doubleWidth?: boolean;
  doubleHeight?: boolean;
};

export class EscPosBuilder {
  private bytes: number[] = [];

  constructor() {
    this.init();
  }

  private push(...vals: number[]) {
    this.bytes.push(...vals);
  }

  private init() {
    // ESC @ → initialize
    this.push(0x1b, 0x40);
  }

  setAlign(align: TextAlign) {
    // ESC a n
    const n = align === "left" ? 0 : align === "center" ? 1 : 2;
    this.push(0x1b, 0x61, n);
  }

  setBold(on: boolean) {
    // ESC E n
    this.push(0x1b, 0x45, on ? 1 : 0);
  }

  setSize(opts?: { doubleWidth?: boolean; doubleHeight?: boolean }) {
    // GS ! n
    const dw = opts?.doubleWidth ? 0x10 : 0x00;
    const dh = opts?.doubleHeight ? 0x01 : 0x00;
    const n = dw | dh;
    this.push(0x1d, 0x21, n);
  }

  text(line: string, opts?: TextStyleOptions) {
    if (opts?.align) this.setAlign(opts.align);
    if (typeof opts?.bold === "boolean") this.setBold(opts.bold);
    this.setSize({
      doubleWidth: opts?.doubleWidth,
      doubleHeight: opts?.doubleHeight,
    });

    // Simple: send as UTF-8 bytes + LF
    // NOTE: for Arabic or special chars, you may need code-page mapping.
    const encoder = new TextEncoder();
    const encoded = Array.from(encoder.encode(line));
    this.push(...encoded, 0x0a);

    // reset style after each line
    this.setBold(false);
    this.setSize({ doubleWidth: false, doubleHeight: false });
    this.setAlign("left");
  }

  blank(lines: number = 1) {
    for (let i = 0; i < lines; i++) this.push(0x0a);
  }

  horizontalLine(width: number = 42) {
    this.text("-".repeat(width));
  }

  cut() {
    // GS V m – partial cut
    this.push(0x1d, 0x56, 0x42, 0x00);
  }

  // Minimal QR (not all printers support the same commands)
  qr(data: string) {
    // This is a simplification; real QR support varies by model.
    // For now, you can skip or replace with text.
    this.text(`[QR] ${data}`, { align: "center" });
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}
