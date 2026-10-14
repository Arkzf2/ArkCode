        let hostQueue = Promise.resolve();
        const enqueueHostAction = (action) => {
            const work = hostQueue.then(action);
            hostQueue = work.catch(() => undefined);
            return track(work);
        };
        const reloadHost = async (name) => {
            if (!hostContext || session.signal.aborted)
                throw new Error("MCP session is not active.");
            const loaded = (options.loadConfig ?? defaultLoadConfig)(hostContext);
            configErrors = loaded.errors;
            projectConfig = loaded.projectConfig;
            autoEnableCodemode = loaded.autoEnableCodemode ?? true;
            configuredEntries = loaded.servers;
            const registered = registeredServers();
            overridden = registered.overridden;
            const replacements = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers]
                .filter((server) => name === undefined || server.entry.name === name);
            const removed = servers.filter((server) => name === undefined || server.entry.name === name);
            if (name !== undefined && removed.length === 0 && replacements.length === 0)
                throw new Error(`No MCP server named "${name}".`);
            servers = servers.filter((server) => !removed.includes(server));
            for (const server of removed) {
                server.attempt = undefined;
                hideTools(server.entry.name);
            }
            emitChange();
            await Promise.all(removed.map(async (server) => {
                await server.connection?.close();
                await server.ready;
            }));
            if (session.signal.aborted)
                return;
            servers.push(...replacements);
            ensureDiscoveryActive(hostContext);
            emitChange();
            pending = Promise.all(replacements.filter(isEnabled).map((server) => startConnection(server))).then(() => undefined);
            await pending;
        };
        const closeHost = async () => {
            session.abort();
            const closing = servers;
            servers = [];
            for (const server of closing) {
                server.attempt = undefined;
                hideTools(server.entry.name);
            }
            emitChange();
            await Promise.all([
                pending?.catch(() => undefined), ...backgroundActions,
                ...closing.map(async (server) => {
                    await server.connection?.close();
                    await server.ready;
                }),
            ]);
        };
        options.onController?.({
            snapshot: () => ({
                servers: servers.map((server) => ({
                    entry: server.entry,
                    state: isEnabled(server) ? (server.connection?.state ?? "starting") : "disabled",
                    error: server.connection?.error,
                    hasResources: server.connection?.hasResources ?? false,
                    tools: (server.connection?.tools ?? []).flatMap((tool) => {
                        if (options.filterTool?.(server.entry, tool) === false)
                            return [];
                        const owner = `${server.entry.name}\0${tool.name}`;
                        const name = [...(serverTools.get(server.entry.name) ?? [])].find((candidate) => toolOwners.get(candidate) === owner);
                        return name ? [{ name, tool, exposure: getMcpToolExposure(server.entry.config, tool.name) }] : [];
                    }),
                })),
                errors: [...configErrors],
            }),
            subscribe,
            waitReady: async () => {
                await hostQueue;
                await pending;
                await waitForServers(servers, session.signal);
            },
            reload: (name) => enqueueHostAction(() => reloadHost(name)),
            reconnect: (name) => enqueueHostAction(() => reloadHost(name)),
            cancelConnecting: async () => {
                const connecting = servers.filter((server) => !server.connection || server.connection.state === "connecting");
                for (const server of connecting)
                    server.attempt = undefined;
                await Promise.all(connecting.map(async (server) => {
                    await server.connection?.close();
                    await server.ready;
                }));
            },
            close: closeHost,
            login: (name, prompt, signal) => enqueueHostAction(async () => {
                const server = findServer(name);
                if (!server || !isEnabled(server) || session.signal.aborted || options.canConnect?.() === false)
                    throw new Error(`MCP server "${name}" is unavailable.`);
                return signIn(server, prompt, signal);
            }),
            logout: (name) => enqueueHostAction(async () => {
                const server = findServer(name);
                if (!server)
                    throw new Error(`No MCP server named "${name}".`);
                return signOut(server);
            }),
        });
