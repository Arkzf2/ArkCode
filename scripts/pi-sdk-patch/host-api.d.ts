export interface McpToolInvocation {
    entry: McpServerEntry;
    tool: import("@earendil-works/pi-mcp").Tool;
    name: string;
    toolCallId: string;
    args: Record<string, unknown>;
    signal: AbortSignal | undefined;
    connectionId: string;
}
export interface McpHostSnapshot {
    servers: Array<{
        entry: McpServerEntry;
        state: "starting" | "disabled" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";
        error: string | undefined;
        tools: Array<{ name: string; tool: import("@earendil-works/pi-mcp").Tool; exposure: import("./config.ts").McpExposure }>;
        hasResources: boolean;
        canSignIn: boolean;
        canSignOut: boolean;
    }>;
    errors: string[];
}
export interface McpHostController {
    snapshot(): McpHostSnapshot;
    subscribe(listener: () => void): () => void;
    waitReady(): Promise<void>;
    reload(name?: string): Promise<void>;
    reconnect(name?: string): Promise<void>;
    cancelConnecting(): Promise<void>;
    close(): Promise<void>;
    login(name: string, prompt: import("./oauth.ts").McpSignInPrompt, signal?: AbortSignal): Promise<string | undefined>;
    logout(name: string): Promise<boolean>;
}
