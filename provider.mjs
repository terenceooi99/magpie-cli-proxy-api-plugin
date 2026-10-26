import {
  PROVIDER,
  SDK,
  normalizeOptions,
  cpaBaseUrl,
  cpaV1Url,
  fetchMagpieModels,
  buildMagpieProviderModels,
  configModels,
} from "./models.mjs";
import {
  checkCpaHealth,
  syncMagpieUpstreamToCpa,
  listCredentials,
  startOAuthLogin,
  pollOAuthStatus,
  resetCooldown,
  getLogs,
  getApiKeyUsage,
  getLatestVersion,
} from "./management.mjs";
import {
  ensureDaemonRunning,
  stopManagedDaemon,
  getDaemonState,
  downloadCliProxyBinary,
  generateV8ConfigYaml,
  resolveRuntimeDir,
  resolveConfigPath,
  resolveAuthDir,
  findLocalBinary,
  registerVsCodeAgent,
  detectEasyCliProxyApi,
} from "./daemon.mjs";

const OAUTH_PROVIDERS = [
  { label: "OpenAI Codex (GPT-6 / GPT-5)", value: "codex" },
  { label: "Anthropic Claude Code", value: "claude" },
  { label: "Google Antigravity (Gemini 4 / Claude)", value: "antigravity" },
  { label: "Kimi Code (.com)", value: "kimi" },
  { label: "Kimi Global (.ai)", value: "kimi-ai" },
  { label: "xAI Grok Build", value: "xai" },
  { label: "Devin CLI", value: "devin" },
  { label: "Meta Muse Code", value: "meta" },
];

async function server(input = {}, rawOptions = {}) {
  const opts = normalizeOptions(rawOptions);
  const worktree = input?.worktree || input?.directory;
  const logInfo = (message) => {
    try {
      input?.client?.app?.log?.({
        body: { service: PROVIDER, level: "info", message: String(message) },
      });
    } catch {}
  };

  let knownModels = buildMagpieProviderModels([], opts);

  // Auto-register VS Code agent configuration if requested or when paired with EasyCLIProxyAPI
  if (opts.autoRegisterVsCode || opts.easyCliProxyApi) {
    try {
      registerVsCodeAgent(opts);
    } catch {}
  }

  // If update was triggered from options
  if (opts.triggerUpdateAt && opts.triggerUpdateAt > 0) {
    stopManagedDaemon()
      .then(() => new Promise((r) => setTimeout(r, 600)))
      .then(() => downloadCliProxyBinary(worktree, logInfo))
      .then((bin) => ensureDaemonRunning({ ...opts, binaryPath: bin }, worktree, logInfo))
      .catch((err) => logInfo(`Update execution failed: ${err?.message || err}`));
  } else if (opts.autoStart !== false && process.env.MAGPIE_CPA_NO_AUTOSTART !== "1") {
    ensureDaemonRunning(opts, worktree, logInfo).catch((err) => {
      logInfo(`CLIProxyAPI background startup note: ${err?.message || err}`);
    });

    // Keep-alive watchdog: ensure daemon stays running as long as Magpie is alive
    setInterval(async () => {
      if (opts.autoStart === false) return;
      try {
        const health = await checkCpaHealth(opts);
        if (!health.ok) {
          logInfo("CLIProxyAPI is offline, auto-restarting managed daemon...");
          await ensureDaemonRunning(opts, worktree, logInfo);
        }
      } catch {}
    }, 8000);
  }

  async function discover(signal) {
    await ensureDaemonRunning(opts, worktree, logInfo).catch(() => {});
    const health = await checkCpaHealth(opts, signal);
    if (!health.ok || !health.models.length) {
      const fallback = { ...knownModels };
      fallback[Symbol.for("magpie.fellBack")] = true;
      return fallback;
    }
    const discovered = buildMagpieProviderModels(health.models, opts);
    knownModels = discovered;
    return discovered;
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "CLIProxyAPI",
        npm: SDK.chat,
        api: cpaV1Url(opts),
        models: configModels(knownModels),
      };
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 16,
      methods: [
        {
          type: "api",
          keyless: true,
          label: `Start & Connect Managed CLIProxyAPI (${cpaBaseUrl(opts)} -> ${opts.magpieBaseUrl} [${opts.defaultModel}])`,
          placeholder: opts.magpieApiKey,
          async authorize() {
            try {
              const status = await ensureDaemonRunning(opts, worktree, logInfo);
              if (!status.running) {
                return {
                  type: "failed",
                  error: status.reason || `CLIProxyAPI did not start on ${cpaBaseUrl(opts)}`,
                };
              }
              return {
                type: "success",
                key: opts.clientApiKeys[0] || opts.magpieApiKey,
                metadata: {
                  baseURL: cpaV1Url(opts),
                  defaultModel: opts.defaultModel,
                  email: `local:${opts.port}->${opts.defaultModel}`,
                },
              };
            } catch (err) {
              return {
                type: "failed",
                error: err?.message || String(err),
              };
            }
          },
        },
        {
          type: "oauth",
          label: "Sign in Upstream CLI Account in CLIProxyAPI (Codex, Claude, Antigravity, Kimi, Grok, Devin, Meta)",
          prompts: [
            {
              type: "select",
              key: "oauthProvider",
              message: "Select upstream CLI account to authenticate in CLIProxyAPI",
              options: OAUTH_PROVIDERS,
            },
          ],
          async authorize(inputs = {}) {
            const oauthProvider = inputs?.oauthProvider || "codex";
            await ensureDaemonRunning(opts, worktree, logInfo);
            const session = await startOAuthLogin(oauthProvider, opts);
            const codeHint = session.user_code ? ` (Code: ${session.user_code})` : "";
            return {
              url: session.url,
              instructions: `Complete the ${oauthProvider} sign-in in your browser${codeHint}. CLIProxyAPI will capture the token automatically.`,
              method: "auto",
              async callback() {
                const polled = await pollOAuthStatus(session.state, opts);
                if (!polled.ok) {
                  return { type: "failed", error: polled.error || "OAuth sign-in failed" };
                }
                return {
                  type: "success",
                  key: opts.clientApiKeys[0] || opts.magpieApiKey,
                  accountId: `${oauthProvider}@cliproxyapi`,
                  metadata: {
                    email: `${oauthProvider}@cliproxyapi`,
                    oauthProvider,
                    baseURL: cpaV1Url(opts),
                  },
                };
              },
            };
          },
        },
        {
          type: "api",
          label: "CLIProxyAPI Client API Key",
          placeholder: "magpie",
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        const apiKey = auth.key || opts.clientApiKeys[0] || opts.magpieApiKey;
        const baseURL = auth.metadata?.baseURL || cpaV1Url(opts);

        return {
          baseURL,
          apiKey,
          async fetch(reqInput, init) {
            await ensureDaemonRunning(opts, worktree, logInfo).catch(() => {});
            const headers = new Headers(init?.headers);
            headers.set("authorization", `Bearer ${apiKey}`);
            return fetch(reqInput, { ...init, headers });
          },
        };
      },

      async usage() {
        const health = await checkCpaHealth(opts);
        if (!health.ok) {
          return {
            plan: `CLIProxyAPI (Offline on :${opts.port})`,
            windows: [],
          };
        }
        let creds = [];
        try {
          creds = await listCredentials(opts);
        } catch {}
        const readyCreds = creds.filter((c) => !c.disabled && !c.unavailable);
        const usageMap = await getApiKeyUsage(opts).catch(() => ({}));
        let totalSuccess = 0;
        let totalFailed = 0;
        for (const group of Object.values(usageMap || {})) {
          if (group && typeof group === "object") {
            for (const entry of Object.values(group)) {
              totalSuccess += Number(entry?.success) || 0;
              totalFailed += Number(entry?.failed) || 0;
            }
          }
        }
        const totalCalls = totalSuccess + totalFailed;
        return {
          plan: `CLIProxyAPI :${opts.port} -> ${opts.defaultModel}`,
          user: `${health.models.length} models · ${readyCreds.length} OAuth creds`,
          balance: `${totalSuccess} ok / ${totalFailed} err`,
          windows: [
            {
              name: "Bridge Health",
              used: totalCalls > 0 ? Math.round((totalFailed / totalCalls) * 100) : 0,
              display: `${totalSuccess} succeeded / ${totalCalls} total calls`,
              span: 5 * 3600,
              aside: true,
            },
          ],
        };
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        return discover();
      },
    },

    async "chat.headers"(hookInput, output) {
      if (
        ![PROVIDER, `${PROVIDER}-plugin`].includes(hookInput?.model?.providerID) ||
        !hookInput?.sessionID
      ) {
        return;
      }
      output.headers["x-session-id"] = hookInput.sessionID;
      output.headers["x-session-affinity"] = hookInput.sessionID;
    },

    tool: {
      status: {
        description:
          "Check the status of the embedded CLIProxyAPI server, its port, PID, upstream Magpie target (http://127.0.0.1:3425/v1), default model (group/gpt-6.1-sol), and active models.",
        args: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          const daemon = getDaemonState(opts, worktree);
          const health = await checkCpaHealth(opts);
          const latestVersion = health.ok ? await getLatestVersion(opts) : "";
          return {
            ...daemon,
            healthy: health.ok,
            modelsServed: health.models.map((m) => m.id),
            latestReleaseVersion: latestVersion,
          };
        },
      },

      sync_models: {
        description:
          "Synchronize Magpie's live model catalog (including group/gpt-6.1-sol and Copilot model aliases) into the running CLIProxyAPI instance.",
        args: {
          type: "object",
          properties: {
            defaultModel: {
              type: "string",
              description: "Optional override for the target Magpie model (e.g. group/gpt-6.1-sol)",
            },
          },
          additionalProperties: false,
        },
        async execute(args = {}) {
          const mergedOpts = args?.defaultModel
            ? normalizeOptions({ ...opts, defaultModel: args.defaultModel })
            : opts;
          await ensureDaemonRunning(mergedOpts, worktree, logInfo);
          const magpieModels = await fetchMagpieModels(mergedOpts);
          const synced = await syncMagpieUpstreamToCpa(magpieModels, mergedOpts);
          return {
            status: "ok",
            cpaEndpoint: cpaV1Url(mergedOpts),
            magpieUpstream: mergedOpts.magpieBaseUrl,
            defaultModel: mergedOpts.defaultModel,
            ...synced,
          };
        },
      },

      test_bridge: {
        description:
          "Send a test chat completion through CLIProxyAPI (:8080/v1) -> Magpie (:3425/v1) using group/gpt-6.1-sol (or a specified model/alias) to verify VS Code GitHub Copilot compatibility.",
        args: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description: "Model or alias to test (default: group/gpt-6.1-sol or gpt-4o)",
            },
            prompt: {
              type: "string",
              description: "Prompt message to send (default: 'hi')",
            },
          },
          additionalProperties: false,
        },
        async execute(args = {}) {
          await ensureDaemonRunning(opts, worktree, logInfo);
          const model = args?.model || opts.defaultModel;
          const prompt = args?.prompt || "hi";
          const apiKey = opts.clientApiKeys[0] || opts.magpieApiKey;
          const started = Date.now();
          const res = await fetch(`${cpaV1Url(opts)}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              stream: false,
            }),
            signal: AbortSignal.timeout(30000),
          });
          const latencyMs = Date.now() - started;
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            return {
              ok: false,
              status: res.status,
              latencyMs,
              error: data?.error || data,
            };
          }
          return {
            ok: true,
            status: res.status,
            latencyMs,
            requestedModel: model,
            respondedModel: data?.model,
            reply: data?.choices?.[0]?.message?.content ?? "",
          };
        },
      },

      credentials: {
        description:
          "List OAuth credentials stored in CLIProxyAPI or reset quota/cooldown for a credential auth_index.",
        args: {
          type: "object",
          properties: {
            resetAuthIndex: {
              type: "string",
              description: "Optional auth_index to clear quota/cooldown state for",
            },
          },
          additionalProperties: false,
        },
        async execute(args = {}) {
          await ensureDaemonRunning(opts, worktree, logInfo);
          if (args?.resetAuthIndex) {
            return resetCooldown(args.resetAuthIndex, opts);
          }
          const files = await listCredentials(opts);
          return { count: files.length, credentials: files };
        },
      },

      logs: {
        description: "Retrieve recent log lines from the managed CLIProxyAPI server.",
        args: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Max log lines to return (default 50)",
            },
          },
          additionalProperties: false,
        },
        async execute(args = {}) {
          const limit = Number(args?.limit) > 0 ? Number(args.limit) : 50;
          return getLogs(limit, opts);
        },
      },

      service: {
        description:
          "Manage the embedded CLIProxyAPI service process: start, stop, restart, or update binary from GitHub Releases.",
        args: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["start", "stop", "restart", "update"],
              description: "Service lifecycle action to perform",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(args = {}) {
          const action = args?.action || "start";
          if (action === "stop") {
            return stopManagedDaemon();
          }
          if (action === "restart") {
            await stopManagedDaemon();
            return ensureDaemonRunning(opts, worktree, logInfo);
          }
          if (action === "update") {
            await stopManagedDaemon();
            await new Promise((r) => setTimeout(r, 600));
            const bin = await downloadCliProxyBinary(worktree, logInfo);
            const state = await ensureDaemonRunning({ ...opts, binaryPath: bin }, worktree, logInfo);
            return { updatedBinary: bin, ...state };
          }
          return ensureDaemonRunning(opts, worktree, logInfo);
        },
      },

      register_vscode_agent: {
        description:
          "Automatically registers VS Code custom endpoint configuration for EasyCLIProxyAPI / CLIProxyAPI so it appears ready in the EasyCLIProxyAPI Agent Configuration tab.",
        args: {
          type: "object",
          properties: {
            port: {
              type: "number",
              description: "Optional proxy port override (e.g. 8317 for EasyCLIProxyAPI or 8080)",
            },
          },
          additionalProperties: false,
        },
        async execute(args = {}) {
          const targetPort = args?.port || (opts.easyCliProxyApi ? opts.easyCliProxyApiPort : opts.port);
          const models = await fetchMagpieModels(opts).catch(() => []);
          const result = registerVsCodeAgent({ ...opts, port: targetPort }, models);
          return {
            status: "ok",
            ...result,
            easyCliProxyApiActive: (await detectEasyCliProxyApi(opts)).running,
          };
        },
      },
    },
  };
}

export const _internal = {
  PROVIDER,
  SDK,
  normalizeOptions,
  cpaBaseUrl,
  cpaV1Url,
  fetchMagpieModels,
  buildMagpieProviderModels,
  configModels,
  generateV8ConfigYaml,
  ensureDaemonRunning,
  stopManagedDaemon,
  getDaemonState,
  resolveRuntimeDir,
  resolveConfigPath,
  resolveAuthDir,
  findLocalBinary,
  checkCpaHealth,
  syncMagpieUpstreamToCpa,
  registerVsCodeAgent,
  detectEasyCliProxyApi,
};

export default { id: PROVIDER, server };
