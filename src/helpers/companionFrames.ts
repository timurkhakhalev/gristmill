import { TextDecoder } from "node:util";
import type { Writable } from "node:stream";
import { COMPANION_MAX_MESSAGE_BYTES } from "../contracts/companion.js";

/** Length is checked before buffering payload; fragmented and batched frames share one decoder. */
export class CompanionFrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload: Buffer | null = null;
  private payloadBytes = 0;
  constructor(private readonly receive: (value: unknown) => void) {}
  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes !== 4) continue;
        const length = this.header.readUInt32LE();
        if (!length || length > COMPANION_MAX_MESSAGE_BYTES) throw new Error("Invalid companion frame length");
        this.payload = Buffer.alloc(length);
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count);
      offset += count;
      this.payloadBytes += count;
      if (this.payloadBytes !== this.payload.length) continue;
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.payload));
      this.payload = null;
      this.payloadBytes = this.headerBytes = 0;
      this.receive(value);
    }
  }
  finish(): void {
    if (this.headerBytes || this.payloadBytes) throw new Error("Incomplete companion frame");
  }
}

export function writeCompanionFrame(stream: Writable, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  if (!payload.length || payload.length > COMPANION_MAX_MESSAGE_BYTES || stream.writableLength > 4 * COMPANION_MAX_MESSAGE_BYTES) {
    throw new Error("Companion output limit exceeded");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length);
  payload.copy(frame, 4);
  stream.write(frame);
}
