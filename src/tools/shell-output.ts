import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { truncateTail } from "@earendil-works/pi-coding-agent";

export interface CapturePosition { bytes: number; newlines: number; openLine: boolean }
const utf8 = (data: Buffer, side: "head" | "tail") => {
  if (side === "head") return new TextDecoder().decode(data, { stream: true });
  let start = 0;
  while (start < data.length && ((data[start] ?? 0) & 0xc0) === 0x80) start++;
  return data.subarray(start).toString("utf8");
};
async function readBytes(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.read(buffer, offset, length - offset, start + offset);
    if (read.bytesRead === 0) throw new Error("Shell log ended before its capture watermark.");
    offset += read.bytesRead;
  }
  return buffer;
}

export class ShellOutput {
  private position: CapturePosition = { bytes: 0, newlines: 0, openLine: false };
  private failure: Error | undefined;
  private exported: { bytes: number; path: string } | undefined;
  private exports = 0;
  private constructor(readonly path: string, private stream: WriteStream) {
    stream.on("error", (error) => { this.failure = error; });
  }
  static async create(): Promise<ShellOutput> {
    const directory = await mkdtemp(join(tmpdir(), "arkcode-shell-"));
    const path = join(directory, "capture.log");
    const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
    await once(stream, "open");
    return new ShellOutput(path, stream);
  }
  get watermark(): CapturePosition { return { ...this.position }; }
  get error(): Error | undefined { return this.failure; }
  append(text: string): boolean {
    const size = Buffer.byteLength(text);
    if (!size || this.failure) return true;
    this.position.bytes += size;
    for (const char of text) if (char === "\n") this.position.newlines++;
    this.position.openLine = !text.endsWith("\n");
    return this.stream.write(text);
  }
  drained(resume: () => void): void { this.stream.once("drain", resume); }
  async flush(): Promise<void> {
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => this.stream.write("", (error) => error ? reject(error) : resolve()));
    if (this.failure) throw this.failure;
  }
  async project(previous: CapturePosition, final = false) {
    const end = this.watermark;
    await this.flush();
    const bytes = end.bytes - previous.bytes;
    const lines = bytes === 0 ? 0 : end.newlines - previous.newlines + Number(end.openLine);
    const totalLines = end.newlines + Number(end.openLine);
    const file = await open(this.path, "r");
    try {
      const tailBuffer = await readBytes(file, Math.max(previous.bytes, end.bytes - 128 * 1024), Math.min(bytes, 128 * 1024));
      const tailText = utf8(tailBuffer, "tail");
      const tail = truncateTail(tailText);
      const displayTruncated = bytes > 51200 || lines > 2000;
      let output: string;
      let shownBytes = bytes;
      const truncated = bytes > 1024 * 1024;
      if (!truncated) output = (await readBytes(file, previous.bytes, bytes)).toString("utf8");
      else {
        const head = utf8(await readBytes(file, previous.bytes, 512 * 1024), "head");
        const endText = utf8(await readBytes(file, end.bytes - 512 * 1024, 512 * 1024), "tail");
        shownBytes = Buffer.byteLength(head) + Buffer.byteLength(endText);
        output = `${head}\n\n[... ${bytes - shownBytes} bytes omitted ...]\n\n${endText}`;
      }
      let outputFile = this.exported?.bytes === end.bytes ? this.exported.path : undefined;
      if (displayTruncated || truncated || this.exported && final) {
        if (!outputFile) {
          outputFile = join(this.path, "..", `snapshot-${++this.exports}.log`);
          const destination = await open(outputFile, "wx", 0o400);
          try {
            for (let offset = 0; offset < end.bytes;) {
              const data = await readBytes(file, offset, Math.min(64 * 1024, end.bytes - offset));
              let written = 0;
              while (written < data.length) written += (await destination.write(data, written)).bytesWritten;
              offset += data.length;
            }
          } catch (error) {
            await destination.close(); await rm(outputFile, { force: true }); throw error;
          }
          await destination.close();
          this.exported = { bytes: end.bytes, path: outputFile };
        }
      }
      return { end, output, outputFile, truncated, truncation: {
        mode: "head_tail", reason: "bytes", total_lines: Math.max(totalLines, 1), total_bytes: end.bytes,
        observation_bytes: bytes, shown_bytes: shownBytes, omitted_bytes: bytes - shownBytes,
      }, display: { ...tail, content: bytes === 0 ? "" : tail.content, truncated: displayTruncated,
        startLine: Math.max(1, totalLines - tail.outputLines + 1), endLine: totalLines, totalLines },
    };
    } finally { await file.close(); }
  }
  async close(): Promise<void> {
    if (!this.stream.closed) {
      await new Promise<void>((resolve) => { this.stream.once("close", resolve); this.stream.destroy(); });
    }
    await rm(this.path, { force: true });
  }
}
