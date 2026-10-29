    /** Replace Pi compaction policy with the host's safe-point implementation. */
    setHostCompaction(handler: (request: { reason: "manual" | "threshold" | "overflow"; customInstructions?: string; signal: AbortSignal }) => Promise<CompactionResult>): void;
    runHostCompaction(reason: "manual" | "threshold" | "overflow", customInstructions?: string, signal?: AbortSignal): Promise<CompactionResult>;
    prepareHostCheckpointSystem(): Promise<import("@earendil-works/pi-ai").SystemMessage>;
    activateHostCheckpoint(): void;
    /** Continue already-persisted pending input without synthesizing another user query. */
    continueHostInput(): Promise<void>;
