import { cpaBaseUrl, cpaV1Url, normalizeOptions, buildMagpieCompatibilityGroup } from "./models.mjs";

function mgmtHeaders(managementKey, extra = {}) {
  const headers = {
    accept: "application/json",
    ...extra,
  };
  if (managementKey) {
    headers.authorization = `Bearer ${managementKey}`;
    headers["x-management-key"] = managementKey;
  }
  return headers;
}

export async function checkCpaHealth(options = {}, signal) {
  const opts = normalizeOptions(options);
  const v1 = cpaV1Url(opts);
  const apiKey = opts.clientApiKeys[0] || opts.magpieApiKey || "magpie";
  const timeout = AbortSignal.timeout(3000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(`${v1}/models`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: combined,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, models: [] };
    }
    const body = await res.json();
    const models = Array.isArray(body?.data) ? body.data : [];
    return { ok: true, status: res.status, models };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err), models: [] };
  }
}

export async function getManagementConfig(options = {}, signal) {
  const opts = normalizeOptions(options);
  const base = cpaBaseUrl(opts);
  const timeout = AbortSignal.timeout(4000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(`${base}/v8/management/config`, {
    headers: mgmtHeaders(opts.managementKey),
    signal: combined,
  });
  if (!res.ok) {
    throw new Error(`CLIProxyAPI management config returned HTTP ${res.status}`);
  }
  return res.json();
}

export async function syncMagpieUpstreamToCpa(magpieModels = [], options = {}, signal) {
  const opts = normalizeOptions(options);
  const base = cpaBaseUrl(opts);
  const group = buildMagpieCompatibilityGroup(magpieModels, opts);
  const timeout = AbortSignal.timeout(5000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  // Read existing openai-compatibility groups so we preserve any non-Magpie custom groups
  let existingGroups = [];
  try {
    const res = await fetch(`${base}/v8/management/config/api-keys/openai-compatibility`, {
      headers: mgmtHeaders(opts.managementKey),
      signal: combined,
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        existingGroups = data.filter((g) => g && g.name !== "magpie-gateway");
      }
    }
  } catch {}

  const updatedGroups = [group, ...existingGroups];
  const putRes = await fetch(`${base}/v8/management/config/api-keys/openai-compatibility`, {
    method: "PUT",
    headers: mgmtHeaders(opts.managementKey, { "content-type": "application/json" }),
    body: JSON.stringify(updatedGroups),
    signal: combined,
  });

  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`Failed to sync Magpie models to CLIProxyAPI (${putRes.status}): ${text.slice(0, 200)}`);
  }

  // Also ensure client access.api-keys includes opts.clientApiKeys
  await fetch(`${base}/v8/management/config/access/api-keys`, {
    method: "PUT",
    headers: mgmtHeaders(opts.managementKey, { "content-type": "application/json" }),
    body: JSON.stringify(opts.clientApiKeys),
    signal: combined,
  }).catch(() => {});

  return {
    ok: true,
    syncedModelsCount: group.models.length,
    models: group.models.map((m) => ({ alias: m.alias, upstream: m.name })),
  };
}

export async function listCredentials(options = {}, signal) {
  const opts = normalizeOptions(options);
  const base = cpaBaseUrl(opts);
  const timeout = AbortSignal.timeout(5000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(`${base}/v8/management/credentials`, {
    headers: mgmtHeaders(opts.managementKey),
    signal: combined,
  });
  if (!res.ok) {
    throw new Error(`GET /v8/management/credentials returned HTTP ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data?.files) ? data.files : [];
}

export async function startOAuthLogin(provider, options = {}, signal) {
  const opts = normalizeOptions(options);
  const base = cpaBaseUrl(opts);
  const timeout = AbortSignal.timeout(10000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = `${base}/v8/management/oauth/auth-url?provider=${encodeURIComponent(provider)}&is_webui=true`;
  const res = await fetch(url, {
    headers: mgmtHeaders(opts.managementKey),
    signal: combined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.url) {
    throw new Error(data?.error || data?.message || `Failed to start OAuth login for ${provider} (HTTP ${res.status})`);
  }
  return data;
}

export async function pollOAuthStatus(state, options = {}, signal) {
  const opts = normalizeOptions(options);
  const base = cpaBaseUrl(opts);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("OAuth login aborted");
    const res = await fetch(`${base}/v8/management/oauth/status?state=${encodeURIComponent(state)}`, {
      headers: mgmtHeaders(opts.managementKey),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.status === "ok") return { ok: true, data };
      if (data.status === "error") return { ok: false, error: data.error || "OAuth authentication failed" };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, error: "OAuth login timed out after 5 minutes" };
}

export async function resetCooldown(authIndex, options = {}) {
  const opts = normalizeOptions(options);
  const base = cpaBaseUrl(opts);
  const res = await fetch(`${base}/v8/management/routing/cooldown/reset`, {
    method: "POST",
    headers: mgmtHeaders(opts.managementKey, { "content-type": "application/json" }),
    body: JSON.stringify({ auth_index: authIndex }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

export async function getLogs(limit = 50, options = {}) {
  const opts = normalizeOptions(options);
  const base = cpaBaseUrl(opts);
  const res = await fetch(`${base}/v8/management/observability/logs?limit=${encodeURIComponent(limit)}`, {
    headers: mgmtHeaders(opts.managementKey),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { lines: [], error: data?.error || `HTTP ${res.status}` };
  }
  return {
    lines: Array.isArray(data?.lines) ? data.lines : [],
    lineCount: data?.["line-count"] ?? 0,
    latestTimestamp: data?.["latest-timestamp"] ?? 0,
  };
}

export async function getApiKeyUsage(options = {}) {
  const opts = normalizeOptions(options);
  const base = cpaBaseUrl(opts);
  const res = await fetch(`${base}/v8/management/observability/usage/api-keys`, {
    headers: mgmtHeaders(opts.managementKey),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return {};
  return res.json().catch(() => ({}));
}

export async function getLatestVersion(options = {}) {
  const opts = normalizeOptions(options);
  const base = cpaBaseUrl(opts);
  try {
    const res = await fetch(`${base}/v8/management/server/latest-version`, {
      headers: mgmtHeaders(opts.managementKey),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      return data?.["latest-version"] || "";
    }
  } catch {}
  return "";
}
