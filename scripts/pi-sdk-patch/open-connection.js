    async open() {
        this.state = "connecting";
        this.changed();
        const deadline = new AbortController();
        const signal = AbortSignal.any([this.shutdown.signal, deadline.signal]);
        const timeoutMs = this.startupTimeoutMs ?? this.timeoutMs;
        const timeoutError = new Error(`Startup timed out after ${timeoutMs} ms`);
        const timer = setTimeout(() => deadline.abort(timeoutError), timeoutMs);
        const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
        try {
            for (let attempt = 0;; attempt++) {
                this.stderrTail = undefined;
                try {
                    if (this.canConnect?.() === false)
                        throw new Error("MCP connections are currently disabled by the host.");
                    return await this.connectOnce(signal);
                }
                catch (error) {
                    if (deadline.signal.aborted)
                        throw this.connectFailed(timeoutError);
                    const delay = retries[attempt];
                    if (this.closed || delay === undefined || !isTransientError(error))
                        throw this.connectFailed(error);
                    await sleep(delay, undefined, { signal }).catch(() => undefined);
                    if (signal.aborted)
                        throw this.connectFailed(deadline.signal.aborted ? timeoutError : error);
                }
            }
        }
        finally {
            clearTimeout(timer);
        }
    }
