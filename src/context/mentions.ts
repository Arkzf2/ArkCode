import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { convertToPng, detectSupportedImageMimeTypeFromFile, resizeImage, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { workspacePath } from "../tools/workspace.js";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export function displayUserText(text: string): string {
  const loadedSkill = /^User activated the skill "[^"\n]+"\. Follow the loaded skill instructions\.\n\n<skill-loaded name="[^"\n]+">\n[\s\S]*?\n<\/skill-loaded>\n\n/;
  let loaded = loadedSkill.exec(text);
  while (loaded) { text = text.slice(loaded[0].length); loaded = loadedSkill.exec(text); }
  let skill = parseSkillBlock(text);
  while (skill?.userMessage) { text = skill.userMessage; skill = parseSkillBlock(text); }
  const legacyAttachment = /\n<file path="[^"\n]+">\n/.exec(text);
  return legacyAttachment && /(?:^|\s)@(?:"[^"]+"|[^\s]+)/.test(text.slice(0, legacyAttachment.index))
    ? text.slice(0, legacyAttachment.index)
    : text;
}

export function fileMention(path: string): string {
  return /[\s"<>`]/u.test(path) ? `@${JSON.stringify(path)}` : `@${path}`;
}

export function withFileMentions(text: string, files: readonly string[]): string {
  const mentioned = new Set([...text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|([^\s]+))/g)].map((match) => match[1] ?? match[2]));
  const references = [...new Set(files)].filter((path) => !mentioned.has(path)).map(fileMention);
  return [text, ...references].filter(Boolean).join("\n\n");
}

export async function prepareAttachments(text: string, files: readonly string[], cwd: string, supportsImages: boolean): Promise<{ text: string; images: ImageContent[] }> {
  const attachments = [...new Set(files)];
  if (attachments.length > 8) throw new Error("At most 8 file attachments per input.");
  const images: ImageContent[] = [];
  for (const name of attachments) {
    if (!name) throw new Error("File attachment path cannot be empty.");
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
