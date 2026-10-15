import { z } from "zod";
import type { ToolExposure } from "@earendil-works/pi-coding-agent";

export const toolModeSchema = z.enum(["direct", "codemode", "codemode-only"]);
export type ToolMode = z.infer<typeof toolModeSchema>;

export function builtinExposure(mode: ToolMode): ToolExposure {
  switch (mode) {
    case "direct": return "model-only";
    case "codemode": return "direct";
    case "codemode-only": return "codemode";
  }
}
