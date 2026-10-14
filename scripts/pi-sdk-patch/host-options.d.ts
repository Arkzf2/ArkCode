    /** Host data directory, including OAuth credentials and MCP logs. */
    agentDir?: string;
    /** Disable resource tools when the host has no per-resource authorization policy. */
    resources?: boolean;
    canConnect?: () => boolean;
    filterTool?: (entry: McpServerEntry, tool: import("@earendil-works/pi-mcp").Tool) => boolean;
    startupTimeoutMs?: (entry: McpServerEntry) => number;
    sanitizeDiagnostic?: (entry: McpServerEntry, text: string) => string;
    /** Called for the actual live client before every dispatch, including SDK session retries. */
    authorizeTool?: (call: McpToolInvocation) => Promise<void>;
    onController?: (controller: McpHostController) => void;
