    _hostCompaction;
    _hostCheckpointPrompt;
    setHostCompaction(handler) {
        this._hostCompaction = handler;
        this.settingsManager.setCompactionEnabled(false);
    }
    async runHostCompaction(reason, customInstructions, signal) {
        if (!this._hostCompaction)
            throw new Error("No host compaction handler is installed.");
        if (this._compactionAbortController || this._autoCompactionAbortController)
            throw new Error("Compaction is already in progress.");
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        if (reason === "manual") this._compactionAbortController = controller;
        else this._autoCompactionAbortController = controller;
        const release = () => {
            if (this._compactionAbortController === controller) this._compactionAbortController = undefined;
            if (this._autoCompactionAbortController === controller) this._autoCompactionAbortController = undefined;
            this._resolveIdleWaitIfIdle();
        };
        this._emit({ type: "compaction_start", reason });
        try {
            controller.signal.throwIfAborted();
            const result = await this._hostCompaction({ reason, customInstructions, signal: controller.signal });
            release();
            this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry: reason === "overflow" });
            return result;
        } catch (error) {
            release();
            const requiresRecovery = error && typeof error === "object" && "code" in error && error.code === "activation";
            this._emit({ type: "compaction_end", reason, result: undefined,
                aborted: controller.signal.aborted, willRetry: false,
                errorMessage: controller.signal.aborted && !requiresRecovery ? undefined : `Compaction failed: ${error instanceof Error ? error.message : String(error)}` });
            throw error;
        } finally {
            signal?.removeEventListener("abort", abort);
            release();
            this._hostCheckpointPrompt = undefined;
        }
    }
    async prepareHostCheckpointSystem() {
        const result = await this._extensionRunner.emitBeforeAgentStart({
            messageType: "custom", message: { role: "custom", customType: "arkcode-checkpoint-preparation", content: "", display: false, timestamp: Date.now() }
        }, this._baseSystemPromptOptions);
        if (result.messages.length)
            throw new Error("Checkpoint preparation cannot inject new task messages.");
        const options = result.systemPromptOptions;
        options.selectedTools = this.getActiveToolNames();
        this._preparePromptAndToolLoadout(options);
        this._hostCheckpointPrompt = options;
        const previous = getCurrentSystemMessage(this.messages);
        return { role: "system", content: previous?.content ?? "", sections: buildSystemPromptSections(options),
            toolsAdded: this.agent.state.tools.filter((tool) => !this._hiddenDeclarations.has(tool.name)).map(toToolDeclaration), timestamp: Date.now() };
    }
    activateHostCheckpoint() {
        this._refreshFinalizedContext();
        if (this._hostCheckpointPrompt) this._runSystemPromptOptions = this._hostCheckpointPrompt;
    }
    async continueHostInput() {
        if (!this.isIdle) throw new Error("Wait until the current run finishes.");
        await this._startRun({ messageType: "continuation" });
    }
    async _recoverHostOverflow(message, skipAbortedCheck) {
        if (!skipAbortedCheck || message.stopReason !== "error" || !isContextOverflow(message) || !this._modelForMessage(message))
            return false;
        if (this._overflowRecoveryAttempted) {
            this._emit({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: false,
                errorMessage: "Context overflow persists after one compact-and-retry attempt. The task is paused; change the model or retry compact." });
            return false;
        }
        this._overflowRecoveryAttempted = true;
        try {
            await this.runHostCompaction("overflow", undefined, this.agent.signal);
            this._failedResponse = message;
            return true;
        } catch { return false; }
    }
