import type { ToggleChoice, UserInterface } from "../app/types.js";
import type { SkillsManager } from "../integrations/skills.js";

export async function browseSkills(options: {
  ui: UserInterface; skills: SkillsManager; active: () => boolean; canManage: () => boolean; changed: () => void;
}): Promise<void> {
  const { ui, skills } = options;
  const toggles = (): ToggleChoice[] => skills.items.map((item) => ({ value: item.path, label: item.name,
    description: `${item.scope}${item.shadowed ? " · shadowed by a higher priority Skill" : ""} · ${item.description}`,
    detail: item.path, enabled: item.enabled,
  }));
  while (options.active()) {
    const action = await ui.choose("Skills", [
      { value: "list", label: "List skills", description: "Choose a Skill · also available through @", tone: "accent" },
      ...(options.canManage() ? [{ value: "manage", label: "Enable/Disable Skills", description: "Save which Skills are available", tone: "positive" as const }] : []),
      ...(options.canManage() ? [{ value: "reload", label: "Reload skills", description: "Rescan .agents/skills sources", tone: "directory" as const }] : []),
      { value: "sources", label: "Sources and diagnostics", tone: "muted" },
    ], { transient: true, hint: "↑/↓ select · Enter open · Esc/Ctrl+C back" });
    if (!action || !options.active()) return;
    if (action === "list") {
      const selected = await ui.choose("List skills", skills.available.map((item) => ({ value: item.name, label: item.name,
        description: `${item.scope} · ${item.description}`, tone: "accent" })), {
        transient: true, hint: "↑/↓ select · Enter add to draft · Esc back", notice: skills.available.length ? undefined : "No enabled Skills. Use Enable/Disable Skills or inspect sources.",
      });
      if (selected && options.active()) { ui.setDraft(`${ui.draft()}${ui.draft() && !/\s$/.test(ui.draft()) ? " " : ""}@skill:${selected} `); return; }
    } else if (action === "manage" && ui.toggleList) {
      await ui.toggleList("Enable/Disable Skills", toggles(), async (path) => {
        if (!options.active() || !options.canManage()) throw new Error("Wait until the current run and queued inputs finish before changing Skills.");
        const item = skills.items.find((item) => item.path === path);
        if (!item) throw new Error("Skill no longer exists. Reload the list.");
        skills.setEnabled(path, !item.enabled);
        options.changed();
        return toggles();
      });
    } else if (action === "reload") {
      if (!options.canManage()) throw new Error("Wait until the current run finishes before reloading Skills.");
      skills.reload(); options.changed();
    } else await ui.inspect("Skill sources", skills.statusText());
  }
}
