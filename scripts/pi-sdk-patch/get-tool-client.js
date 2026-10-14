                    getClient: async (toolCallId, args, signal) => {
                        const expected = JSON.stringify(tool);
                        const current = findServer(server);
                        const client = current?.connection;
                        const validate = () => {
                            signal?.throwIfAborted();
                            const live = findServer(server);
                            const offered = client?.tools.find((candidate) => candidate.name === tool.name);
                            if (session.signal.aborted || options.canConnect?.() === false ||
                                !live || !isEnabled(live) || live !== current || live.connection !== client ||
                                !client || client.state !== "connected" || !offered ||
                                JSON.stringify(offered) !== expected ||
                                getMcpToolExposure(live.entry.config, tool.name) === "hidden" ||
                                options.filterTool?.(live.entry, offered) === false) {
                                throw new Error(`MCP tool "${server}/${tool.name}" is no longer available; retry with its current definition.`);
                            }
                            return offered;
                        };
                        if (!client || !current || !isEnabled(current) || session.signal.aborted)
                            throw new Error(`MCP server "${server}" is unavailable.`);
                        return {
                            callTool: (name, params, requestOptions) => client.callToolGuarded(name, params, requestOptions, async (connectionId) => {
                                const offered = validate();
                                await options.authorizeTool?.({
                                    entry: current.entry, tool: offered, name: definition.name,
                                    toolCallId, args: args ?? {}, signal, connectionId,
                                });
                                validate();
                            }),
                        };
                    },
