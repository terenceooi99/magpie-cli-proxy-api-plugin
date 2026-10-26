export const PROVIDER = "cliproxyapi";

export const SDK = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
};

export const DEFAULT_OPTIONS = {
  autoStart: true,
  autoDownload: true,
  host: "127.0.0.1",
  port: 8080,
  magpieBaseUrl: "http://127.0.0.1:3425/v1",
  magpieApiKey: "magpie",
  defaultModel: "group/gpt-6.1-sol",
  extraModels: [],
  syncAllMagpieModels: true,
  copilotAliases: [
    "gpt-4o",
    "gpt-4",
    "gpt-4.1",
    "claude-3-5-sonnet",
    "copilot-chat",
  ],
  clientApiKeys: ["magpie"],
  managementKey: "magpie-cpa-mgmt",
  routingStrategy: "round-robin",
  requestRetry: 3,
  sessionAffinity: true,
  proxyUrl: "",
  binaryPath: "",
  configPath: "",
  authDir: "",
  lastUpdateCheck: 0,
  installedVersion: "v8.0.43",
  triggerUpdateAt: 0,
  easyCliProxyApi: false,
  easyCliProxyApiPort: 8317,
  autoRegisterVsCode: false,
};

export function normalizeOptions(raw = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...(raw && typeof raw === "object" ? raw : {}) };
  opts.port = Number(opts.port) > 0 && Number(opts.port) <= 65535 ? Number(opts.port) : DEFAULT_OPTIONS.port;
  opts.host = typeof opts.host === "string" && opts.host.trim() ? opts.host.trim() : DEFAULT_OPTIONS.host;
  opts.magpieBaseUrl = (
    typeof opts.magpieBaseUrl === "string" && opts.magpieBaseUrl.trim()
      ? opts.magpieBaseUrl.trim()
      : DEFAULT_OPTIONS.magpieBaseUrl
  ).replace(/\/+$/, "");
  opts.magpieApiKey =
    typeof opts.magpieApiKey === "string" && opts.magpieApiKey.trim()
      ? opts.magpieApiKey.trim()
      : DEFAULT_OPTIONS.magpieApiKey;
  opts.defaultModel =
    typeof opts.defaultModel === "string" && opts.defaultModel.trim()
      ? opts.defaultModel.trim()
      : DEFAULT_OPTIONS.defaultModel;
  if (typeof opts.extraModels === "string") {
    opts.extraModels = opts.extraModels
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (!Array.isArray(opts.extraModels)) {
    opts.extraModels = [];
  }
  opts.managementKey =
    typeof opts.managementKey === "string" && opts.managementKey.trim()
      ? opts.managementKey.trim()
      : DEFAULT_OPTIONS.managementKey;
  if (typeof opts.copilotAliases === "string") {
    opts.copilotAliases = opts.copilotAliases
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (!Array.isArray(opts.copilotAliases)) {
    opts.copilotAliases = [...DEFAULT_OPTIONS.copilotAliases];
  }
  if (typeof opts.clientApiKeys === "string") {
    opts.clientApiKeys = opts.clientApiKeys
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (!Array.isArray(opts.clientApiKeys) || !opts.clientApiKeys.length) {
    opts.clientApiKeys = [opts.magpieApiKey, ...DEFAULT_OPTIONS.clientApiKeys];
  }
  opts.clientApiKeys = [...new Set([opts.magpieApiKey, ...opts.clientApiKeys.filter(Boolean)])];
  opts.requestRetry = Number.isInteger(Number(opts.requestRetry))
    ? Math.max(0, Number(opts.requestRetry))
    : DEFAULT_OPTIONS.requestRetry;
  opts.easyCliProxyApi = Boolean(opts.easyCliProxyApi);
  opts.easyCliProxyApiPort = Number(opts.easyCliProxyApiPort) > 0 ? Number(opts.easyCliProxyApiPort) : 8317;
  opts.autoRegisterVsCode = Boolean(opts.autoRegisterVsCode);
  return opts;
}

export function cpaBaseUrl(options = {}) {
  const opts = normalizeOptions(options);
  const host = opts.host === "0.0.0.0" || opts.host === "" ? "127.0.0.1" : opts.host;
  return `http://${host}:${opts.port}`;
}

export function cpaV1Url(options = {}) {
  return `${cpaBaseUrl(options)}/v1`;
}

// Fetch live models served by the user's Magpie gateway (e.g. http://127.0.0.1:3425/v1/models)
export async function fetchMagpieModels(options = {}, signal) {
  const opts = normalizeOptions(options);
  const timeout = AbortSignal.timeout(5000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(`${opts.magpieBaseUrl}/models`, {
      headers: {
        authorization: `Bearer ${opts.magpieApiKey}`,
        accept: "application/json",
      },
      signal: combinedSignal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return list.filter(
      (m) =>
        m &&
        typeof m.id === "string" &&
        m.id.trim() &&
        // Avoid routing loop back to cliproxyapi provider itself
        !m.id.startsWith(`${PROVIDER}/`) &&
        !m.id.startsWith(`${PROVIDER}-plugin/`) &&
        m.owned_by !== PROVIDER &&
        m.owned_by !== `${PROVIDER}-plugin`,
    );
  } catch {
    return [];
  }
}

// Build CLIProxyAPI v8 openai-compatibility model entries pointing to Magpie
export function buildCpaUpstreamModels(magpieModels = [], options = {}) {
  const opts = normalizeOptions(options);
  const entries = [];
  const seenAliases = new Set();

  const addEntry = (upstreamName, alias, displayName, meta = {}) => {
    if (!upstreamName || !alias || seenAliases.has(alias)) return;
    seenAliases.add(alias);
    const contextLength = Number(meta.context_window || meta.context_length) || 1000000;
    const rawModalities = Array.isArray(meta.modalities)
      ? meta.modalities
      : Array.isArray(meta.input_modalities)
        ? meta.input_modalities
        : ["text", "image"];
    const inputModalities = rawModalities.includes("image") ? ["text", "image"] : ["text"];
    const levels = Array.isArray(meta.reasoning_levels) && meta.reasoning_levels.length
      ? meta.reasoning_levels
      : ["low", "medium", "high", "xhigh"];

    entries.push({
      name: upstreamName,
      alias,
      "display-name": displayName || alias,
      "max-context-length": contextLength,
      "input-modalities": inputModalities,
      "output-modalities": ["text"],
      thinking: { levels },
    });
  };

  const defaultModelMeta =
    magpieModels.find((m) => m.id === opts.defaultModel) || {
      id: opts.defaultModel,
      display_name: `Magpie (${opts.defaultModel})`,
      context_window: 1000000,
    };

  // 1. Primary default model (e.g., "group/gpt-6.1-sol")
  addEntry(
    opts.defaultModel,
    opts.defaultModel,
    defaultModelMeta.display_name || `Magpie ${opts.defaultModel}`,
    defaultModelMeta,
  );

  // Also expose a flat alias without "group/" prefix if defaultModel has a slash (e.g. "gpt-6.1-sol")
  if (opts.defaultModel.includes("/")) {
    const shortAlias = opts.defaultModel.split("/").slice(1).join("/");
    if (shortAlias) {
      addEntry(
        opts.defaultModel,
        shortAlias,
        `${defaultModelMeta.display_name || opts.defaultModel} (${shortAlias})`,
        defaultModelMeta,
      );
    }
  }

  // 2. Copilot / IDE model aliases mapped to defaultModel (e.g., gpt-4o -> group/gpt-6.1-sol)
  for (const alias of opts.copilotAliases) {
    addEntry(
      opts.defaultModel,
      alias,
      `${alias} -> ${opts.defaultModel}`,
      defaultModelMeta,
    );
  }

  // 3. User configured extra/manual Magpie models (e.g. group/free-model-magpie, etc.)
  for (const extra of opts.extraModels || []) {
    const modelId = typeof extra === "string" ? extra : extra?.id;
    if (!modelId) continue;
    const displayName = typeof extra === "object" && (extra.display_name || extra.name) ? (extra.display_name || extra.name) : modelId;
    addEntry(modelId, modelId, displayName, typeof extra === "object" ? extra : { id: modelId });
  }

  // 4. All other active models/groups discovered from Magpie's /v1/models
  if (opts.syncAllMagpieModels) {
    for (const m of magpieModels) {
      addEntry(m.id, m.id, m.display_name || m.id, m);
    }
  }

  return entries;
}

// Build the openai-compatibility provider group object for CLIProxyAPI v8 config
export function buildMagpieCompatibilityGroup(magpieModels = [], options = {}) {
  const opts = normalizeOptions(options);
  return {
    name: "magpie-gateway",
    disabled: false,
    "base-url": opts.magpieBaseUrl,
    "support-prompt-cache-key": true,
    "disable-cooling": true,
    "request-retry": opts.requestRetry,
    keys: [
      {
        "api-key": opts.magpieApiKey,
        weight: 10,
        "proxy-url": "direct",
      },
    ],
    models: buildCpaUpstreamModels(magpieModels, opts),
  };
}

// Bootstrap models registered in Magpie's provider catalog
export function buildMagpieProviderModels(cpaModels = [], options = {}) {
  const opts = normalizeOptions(options);
  const url = cpaV1Url(opts);
  const defaultEfforts = ["low", "medium", "high", "xhigh"];
  const variants = Object.fromEntries(defaultEfforts.map((e) => [e, { reasoningEffort: e }]));

  const seedIds = cpaModels.length
    ? cpaModels
    : [
        { id: opts.defaultModel, name: `CLIProxyAPI -> ${opts.defaultModel}` },
        ...(opts.extraModels || []).map((m) => {
          const id = typeof m === "string" ? m : m?.id;
          return { id, name: `${id} (via CLIProxyAPI)` };
        }),
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol (via CLIProxyAPI)" },
        { id: "gpt-4o", name: "Copilot Alias gpt-4o (via CLIProxyAPI)" },
      ];

  const result = {};
  for (const item of seedIds) {
    const id = typeof item === "string" ? item : item?.id;
    if (!id || typeof id !== "string" || id === "__proto__") continue;
    const name = (typeof item === "object" && (item.display_name || item.name)) || id;
    result[id] = {
      id,
      providerID: PROVIDER,
      name,
      api: { id, url, npm: SDK.chat },
      limit: {
        context: Number(item?.context_window || item?.max_context_length) || 200000,
        output: Number(item?.max_output_tokens) || 32000,
      },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      variants,
      options: {},
      headers: {},
      status: "active",
      release_date: "",
      free: true,
    };
  }
  return result;
}

export function configModels(models) {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [
      id,
      {
        id,
        name: model.name,
        provider: { npm: model.api.npm, api: model.api.url },
        limit: model.limit,
        reasoning: model.capabilities.reasoning,
        tool_call: model.capabilities.toolcall,
        attachment: model.capabilities.attachment,
        modalities: {
          input: Object.keys(model.capabilities.input).filter((k) => model.capabilities.input[k]),
          output: Object.keys(model.capabilities.output).filter((k) => model.capabilities.output[k]),
        },
        cost: { input: 0, output: 0 },
        variants: model.variants,
        free: true,
      },
    ]),
  );
}
