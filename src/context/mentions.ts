import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { convertToPng, detectSupportedImageMimeTypeFromFile, resizeImage } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { workspacePath } from "../tools/workspace.js";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export function displayUserText(text: string): string {
  const legacyAttachment = /\n<file path="[^"\n]+">\n/.exec(text);
  return legacyAttachment && /(?:^|\s)@(?:"[^"]+"|[^\s]+)/.test(text.slice(0, legacyAttachment.index))
    ? text.slice(0, legacyAttachment.index)
    : text;
}

export async function prepareMentions(text: string, cwd: string, supportsImages: boolean): Promise<{ text: string; images: ImageContent[] }> {
  const matches = [...text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s]+))/g)];
  if (matches.length > 8) throw new Error("At most 8 file references per input.");
  const images: ImageContent[] = [];
  for (const match of matches) {
    const name = match[1] ?? match[2];
    if (!name) continue;
    const path = await workspacePath(cwd, name);
    const info = await stat(path);
    if (info.isDirectory()) continue;
    if (!info.isFile()) throw new Error(`File reference is not a regular file: ${name}`);
    const mimeType = await detectSupportedImageMimeTypeFromFile(path);
    if (!mimeType) {
      if (imageExtensions.has(extname(name).toLowerCase())) throw new Error(`Unsupported or invalid image: ${name}`);
      continue;
    }
    if (!supportsImages) throw new Error(`Current model does not support images: ${name}. Select an image-capable model.`);
    const source = (await readFile(path)).toString("base64");
    const normalized = mimeType === "image/bmp" ? await convertToPng(source, mimeType) : { data: source, mimeType };
    if (!normalized) throw new Error(`Could not process image: ${name}`);
    const resized = await resizeImage(Buffer.from(normalized.data, "base64"), normalized.mimeType);
    if (!resized) throw new Error(`Could not resize image for model input: ${name}`);
    images.push({ type: "image", mimeType: resized.mimeType, data: resized.data });
  }
  return { text, images };
}
