import { z } from "zod";

export const permissionSchema = z.enum(["always-ask", "ask-when-needed", "never-ask"]);
export type Permission = z.infer<typeof permissionSchema>;
export const permissionLabels: Record<Permission, string> = {
  "always-ask": "Always Ask",
  "ask-when-needed": "Ask When Needed",
  "never-ask": "Never Ask",
};

export function parsePermission(value: unknown): Permission {
  if (value === "read-only") throw new Error("Read Only has been removed. Choose always-ask, ask-when-needed, or never-ask explicitly.");
  return permissionSchema.parse(value === "ask" ? "always-ask" : value === "full-access" ? "never-ask" : value);
}

export const configuredPermissionSchema = z.unknown().transform((value, ctx) => {
  try { return parsePermission(value); }
  catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});
