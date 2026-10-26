import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __pluginDir = dirname(fileURLToPath(import.meta.url));
import {
  normalizeOptions,
  cpaBaseUrl,
  fetchMagpieModels,
  buildMagpieCompatibilityGroup,
} from "./models.mjs";
import { checkCpaHealth, syncMagpieUpstreamToCpa } from "./management.mjs";

const GITHUB_LATEST_RELEASE = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";

let managedProcess = null;
let managedPid = null;
let managedPort = null;
let startingPromise = null;
let exitHookRegistered = false;

function spawnTerminationWatchdog(cpaPid) {
  if (!cpaPid) return;
  if (process.platform === "win32") {
    const bunPid = process.pid;
    const magpiePid = process.ppid;
    const script = `
$cpaPid = ${cpaPid};
$bunPid = ${bunPid};
$magpiePid = ${magpiePid};
while ($true) {
  Start-Sleep -Seconds 2;
  $b = Get-Process -Id $bunPid -ErrorAction SilentlyContinue;
  $m = Get-Process -Id $magpiePid -ErrorAction SilentlyContinue;
  $anyMagpie = Get-Process -Name 'magpie-windows-amd64' -ErrorAction SilentlyContinue;
  if (-not $b -or (-not $m -and -not $anyMagpie)) {
    Stop-Process -Id $cpaPid -Force -ErrorAction SilentlyContinue;
    break;
  }
}
`;
    try {
      const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      ps.unref();
    } catch {}
  } else {
    try {
      const bunPid = process.pid;
      const magpiePid = process.ppid;
      const cmd = `while kill -0 ${bunPid} 2>/dev/null && kill -0 ${magpiePid} 2>/dev/null; do sleep 2; done; kill -9 ${cpaPid} 2>/dev/null`;
      const sh = spawn("sh", ["-c", cmd], {
        detached: true,
        stdio: "ignore",
      });
      sh.unref();
    } catch {}
  }
}

export async function killOrphanedProcesses() {
  if (process.platform === "win32") {
    try {
      if (managedPid) {
        execFile("taskkill.exe", ["/F", "/PID", String(managedPid)], () => {});
      }
    } catch {}
  }
}

function registerExitCleanup() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  const cleanup = () => {
    if (managedProcess && !managedProcess.killed) {
      try {
        managedProcess.kill("SIGKILL");
      } catch {}
    }
    if (managedPid) {
      if (process.platform === "win32") {
        try {
          execFile("taskkill.exe", ["/F", "/T", "/PID", String(managedPid)], () => {});
        } catch {}
      } else {
        try {
          process.kill(managedPid, "SIGKILL");
        } catch {}
      }
    }
    managedProcess = null;
    managedPid = null;
  };
  process.on("exit", cleanup);
  process.on("beforeExit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

function isFile(p) {
  try {
    return Boolean(p && statSync(p).isFile());
  } catch {
    return false;
  }
}

export function resolveRuntimeDir(worktree) {
  // 1. If explicit worktree or directory provided, prefer its cli-proxy-api subfolder
  if (worktree && typeof worktree === "string") {
    const candidate = join(worktree, "cli-proxy-api");
    mkdirSync(candidate, { recursive: true });
    return candidate;
  }

  // 2. Default directly to plugin repository folder: D:\Software\Magpie\magpie-cli-proxy-api-plugin\cli-proxy-api
  const pluginLocal = join(__pluginDir, "cli-proxy-api");
  mkdirSync(pluginLocal, { recursive: true });
  return pluginLocal;
}

export function resolveAuthDir(options = {}, worktree) {
  const opts = normalizeOptions(options);
  if (opts.authDir && isAbsolute(opts.authDir)) {
    mkdirSync(opts.authDir, { recursive: true });
    return opts.authDir;
  }
  const defaultUserCpa = join(homedir(), ".cli-proxy-api");
  if (existsSync(defaultUserCpa)) {
    return defaultUserCpa;
  }
  const managedAuth = join(resolveRuntimeDir(worktree), "auths");
  mkdirSync(managedAuth, { recursive: true });
  return managedAuth;
}

export function resolveConfigPath(options = {}, worktree) {
  const opts = normalizeOptions(options);
  if (opts.configPath && isAbsolute(opts.configPath)) {
    mkdirSync(dirname(opts.configPath), { recursive: true });
    return opts.configPath;
  }
  return join(resolveRuntimeDir(worktree), "config.yaml");
}

export function findLocalBinary(options = {}, worktree) {
  const opts = normalizeOptions(options);
  const exeNames =
    process.platform === "win32"
      ? ["cli-proxy-api.exe", "cliproxyapi.exe", "CLIProxyAPI.exe"]
      : ["cli-proxy-api", "cliproxyapi", "CLIProxyAPI"];

  const candidates = [];
  if (opts.binaryPath) candidates.push(opts.binaryPath);
  if (process.env.CLIPROXYAPI_BIN) candidates.push(process.env.CLIPROXYAPI_BIN);

  const runtimeBinDir = join(resolveRuntimeDir(worktree), "bin");
  const pluginBinDir = join(__pluginDir, "cli-proxy-api", "bin");
  for (const name of exeNames) {
    candidates.push(join(pluginBinDir, name));
    candidates.push(join(__pluginDir, "cli-proxy-api", name));
    candidates.push(join(runtimeBinDir, name));
    candidates.push(join("d:\\Software\\Magpie", name));
    candidates.push(join(homedir(), ".cli-proxy-api", name));
    candidates.push(join(homedir(), ".config", "cli-proxy-api", "bin", name));
  }

  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of exeNames) {
      candidates.push(join(trimmed, name));
    }
  }

  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) {
      return resolve(candidate);
    }
  }
  return "";
}

export function platformAssetSuffix() {
  const osMap = {
    win32: "windows",
    darwin: "darwin",
    linux: "linux",
    freebsd: "freebsd",
  };
  const archMap = {
    x64: "amd64",
    arm64: "aarch64",
  };
  const os = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) {
    throw new Error(`Unsupported platform/arch for CLIProxyAPI auto-download: ${process.platform}/${process.arch}`);
  }
  const ext = os === "windows" ? "zip" : "tar.gz";
  return { os, arch, ext, suffix: `_${os}_${arch}.${ext}` };
}

function runExecFile(cmd, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(cmd, args, { timeout: 60000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        rejectPromise(new Error(`${cmd} failed: ${stderr || stdout || err.message}`));
      } else {
        resolvePromise({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    });
  });
}

function findExtractedBinary(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = findExtractedBinary(full);
      if (sub) return sub;
    } else if (
      entry.isFile() &&
      /^(cli-proxy-api|cliproxyapi)(\.exe)?$/i.test(entry.name)
    ) {
      return full;
    }
  }
  return "";
}

export async function downloadCliProxyBinary(worktree, logger) {
  const runtimeDir = resolveRuntimeDir(worktree);
  const binDir = join(runtimeDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const { os, ext, suffix } = platformAssetSuffix();
  logger?.(`Checking latest CLIProxyAPI release for ${suffix}...`);

  const releaseRes = await fetch(GITHUB_LATEST_RELEASE, {
    headers: {
      "user-agent": "magpie-cli-proxy-api-plugin/0.1.0",
      accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!releaseRes.ok) {
    throw new Error(`GitHub Releases API returned HTTP ${releaseRes.status}`);
  }
  const release = await releaseRes.json();
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find(
    (a) =>
      typeof a?.name === "string" &&
      a.name.endsWith(suffix) &&
      !a.name.includes("no-plugin"),
  ) || assets.find((a) => typeof a?.name === "string" && a.name.endsWith(suffix));

  if (!asset?.browser_download_url) {
    throw new Error(`No CLIProxyAPI release asset matching ${suffix} in ${release?.tag_name || "latest"}`);
  }

  const archivePath = join(binDir, asset.name);
  logger?.(`Downloading ${asset.name} (${release.tag_name})...`);
  const dlRes = await fetch(asset.browser_download_url, {
    headers: { "user-agent": "magpie-cli-proxy-api-plugin/0.1.0" },
    signal: AbortSignal.timeout(120000),
  });
  if (!dlRes.ok) {
    throw new Error(`Failed to download ${asset.name}: HTTP ${dlRes.status}`);
  }
  const bytes = Buffer.from(await dlRes.arrayBuffer());

  // Verify SHA-256 against checksums.txt when available
  const checksumAsset = assets.find((a) => a?.name === "checksums.txt");
  if (checksumAsset?.browser_download_url) {
    const csRes = await fetch(checksumAsset.browser_download_url, {
      headers: { "user-agent": "magpie-cli-proxy-api-plugin/0.1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (csRes.ok) {
      const csText = await csRes.text();
      const line = csText
        .split(/\r?\n/)
        .find((l) => l.trim().endsWith(asset.name));
      const expectedHash = line?.trim().split(/\s+/)[0]?.toLowerCase();
      if (expectedHash && /^[0-9a-f]{64}$/.test(expectedHash)) {
        const actualHash = createHash("sha256").update(bytes).digest("hex").toLowerCase();
        if (actualHash !== expectedHash) {
          throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${expectedHash}, got ${actualHash}`);
        }
      }
    }
  }

  writeFileSync(archivePath, bytes);
  const extractDir = join(binDir, "extract_tmp");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  try {
    if (ext === "zip" && os === "windows") {
      await runExecFile("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
      ]);
    } else {
      await runExecFile("tar", ["-xzf", archivePath, "-C", extractDir]);
    }

    const foundBin = findExtractedBinary(extractDir);
    if (!foundBin) {
      throw new Error(`Archive ${asset.name} did not contain cli-proxy-api binary`);
    }

    const targetBin = join(binDir, os === "windows" ? "cli-proxy-api.exe" : "cli-proxy-api");
    writeFileSync(targetBin, readFileSync(foundBin));
    if (os !== "windows") {
      chmodSync(targetBin, 0o755);
    }
    writeFileSync(
      join(binDir, "version.json"),
      JSON.stringify({ version: release.tag_name, asset: asset.name, installedAt: new Date().toISOString() }, null, 2),
    );
    return targetBin;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(archivePath, { force: true });
  }
}

function yamlStr(val) {
  return JSON.stringify(String(val ?? ""));
}

// Generate CLIProxyAPI v8 config.yaml pointing to Magpie (http://127.0.0.1:3425/v1)
export function generateV8ConfigYaml(magpieModels = [], options = {}, worktree) {
  const opts = normalizeOptions(options);
  const authDir = resolveAuthDir(opts, worktree).replace(/\\/g, "/");
  const group = buildMagpieCompatibilityGroup(magpieModels, opts);

  const lines = [
    "# Auto-generated by magpie-cli-proxy-api-plugin",
    "# Bridges VS Code GitHub Copilot & CLI tools -> CLIProxyAPI -> Magpie Gateway",
    "config-version: 8",
    "",
    "server:",
    `  host: ${yamlStr(opts.host)}`,
    `  port: ${opts.port}`,
    "",
    "management:",
    "  allow-remote: false",
    "  disable-control-panel: false",
    "",
    "access:",
    "  api-keys:",
    ...opts.clientApiKeys.map((k) => `    - ${yamlStr(k)}`),
    "",
    "routing:",
    `  strategy: ${yamlStr(opts.routingStrategy)}`,
    `  session-affinity: ${opts.sessionAffinity ? "true" : "false"}`,
    "  retry:",
    `    request-retry: ${opts.requestRetry}`,
    "",
    "requests:",
    `  proxy-url: ${yamlStr(opts.proxyUrl)}`,
    "",
    "oauth:",
    `  auth-dir: ${yamlStr(authDir)}`,
    "",
    "observability:",
    "  logs:",
    "    debug: false",
    "    logging-to-file: true",
    "    request-log: false",
    "  usage:",
    "    usage-statistics-enabled: true",
    "",
    "api-keys:",
    "  openai-compatibility:",
    `    - name: ${yamlStr(group.name)}`,
    "      disabled: false",
    `      base-url: ${yamlStr(group["base-url"])}`,
    "      support-prompt-cache-key: true",
    "      disable-cooling: true",
    `      request-retry: ${group["request-retry"]}`,
    "      keys:",
    ...group.keys.map(
      (k) =>
        `        - api-key: ${yamlStr(k["api-key"])}\n          weight: ${k.weight}\n          proxy-url: ${yamlStr(k["proxy-url"])}`,
    ),
    "      models:",
    ...group.models.map((m) => {
      const levels = (m.thinking?.levels || ["low", "medium", "high", "xhigh"])
        .map((l) => yamlStr(l))
        .join(", ");
      const inMods = (m["input-modalities"] || ["text", "image"])
        .map((x) => yamlStr(x))
        .join(", ");
      return [
        `        - name: ${yamlStr(m.name)}`,
        `          alias: ${yamlStr(m.alias)}`,
        `          display-name: ${yamlStr(m["display-name"])}`,
        `          max-context-length: ${m["max-context-length"] || 200000}`,
        `          input-modalities: [${inMods}]`,
        `          output-modalities: ["text"]`,
        "          thinking:",
        `            levels: [${levels}]`,
      ].join("\n");
    }),
    "",
  ];

  return lines.join("\n");
}

export async function ensureDaemonRunning(options = {}, worktree, logger) {
  const opts = normalizeOptions(options);
  registerExitCleanup();

  // 1. Check if CLIProxyAPI is already healthy on the target port
  const currentHealth = await checkCpaHealth(opts);
  if (currentHealth.ok) {
    // Sync Magpie models into the running instance via v8 Management API
    try {
      const magpieModels = await fetchMagpieModels(opts);
      if (magpieModels.length > 0) {
        await syncMagpieUpstreamToCpa(magpieModels, opts);
      }
    } catch {}
    return {
      running: true,
      managed: Boolean(managedProcess && managedPort === opts.port),
      pid: managedPid,
      port: opts.port,
      url: cpaBaseUrl(opts),
      modelsCount: currentHealth.models.length,
    };
  }

  if (opts.autoStart === false) {
    return {
      running: false,
      managed: false,
      pid: null,
      port: opts.port,
      url: cpaBaseUrl(opts),
      reason: "autoStart is disabled",
    };
  }

  if (startingPromise) {
    return startingPromise;
  }

  startingPromise = (async () => {
    try {
      // Clean up any lingering/orphan processes from previous computer boot or crash
      await killOrphanedProcesses();

      // 2. Locate or download CLIProxyAPI binary
      let binPath = findLocalBinary(opts, worktree);
      if (!binPath && opts.autoDownload !== false) {
        binPath = await downloadCliProxyBinary(worktree, logger);
      }
      if (!binPath) {
        throw new Error(
          "cli-proxy-api binary not found. Enable autoDownload or set binaryPath in plugin options.",
        );
      }

      // 3. Discover live Magpie models with retry / fallback
      let magpieModels = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        magpieModels = await fetchMagpieModels(opts);
        if (magpieModels.length > 0) break;
        await new Promise((r) => setTimeout(r, 600));
      }
      // If Magpie is still initializing, use resilient fallback models so CPA starts immediately
      if (magpieModels.length === 0) {
        magpieModels = [
          { id: opts.defaultModel || "group/gpt-6.1-sol" },
          { id: "group/free-model-magpie" },
        ];
      }

      const configPath = resolveConfigPath(opts, worktree);
      const yaml = generateV8ConfigYaml(magpieModels, opts, worktree);
      writeFileSync(configPath, yaml, "utf8");

      // Stop previous managed child if port changed
      if (managedProcess && !managedProcess.killed) {
        try {
          managedProcess.kill("SIGKILL");
        } catch {}
        managedProcess = null;
        managedPid = null;
      }

      // 4. Spawn cli-proxy-api
      const childEnv = {
        ...process.env,
        MANAGEMENT_PASSWORD: opts.managementKey,
      };
      const child = spawn(
        binPath,
        ["-config", configPath],
        {
          cwd: dirname(configPath),
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );

      managedProcess = child;
      managedPid = child.pid ?? null;
      managedPort = opts.port;

      // Spawn external watchdog to terminate CPA instantly when Magpie quits
      if (child.pid) {
        spawnTerminationWatchdog(child.pid);
      }

      let lastLog = "";
      const onOut = (chunk) => {
        const line = chunk.toString().trim();
        if (line) lastLog = line.split(/\r?\n/).at(-1) || lastLog;
      };
      child.stdout?.on("data", onOut);
      child.stderr?.on("data", onOut);
      child.on("exit", () => {
        if (managedProcess === child) {
          managedProcess = null;
          managedPid = null;
        }
      });

      // 5. Poll until CLIProxyAPI is ready on /v1/models
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (child.exitCode !== null) {
          throw new Error(`cli-proxy-api exited with code ${child.exitCode}: ${lastLog}`);
        }
        const health = await checkCpaHealth(opts);
        if (health.ok) {
          return {
            running: true,
            managed: true,
            pid: managedPid,
            port: opts.port,
            url: cpaBaseUrl(opts),
            binaryPath: binPath,
            configPath,
            modelsCount: health.models.length,
          };
        }
      }

      throw new Error(`Timed out waiting for CLIProxyAPI on ${cpaBaseUrl(opts)} (${lastLog || "no output"})`);
    } finally {
      startingPromise = null;
    }
  })();

  return startingPromise;
}

export async function stopManagedDaemon() {
  if (managedProcess && !managedProcess.killed) {
    try {
      managedProcess.kill("SIGKILL");
    } catch {}
  }
  if (managedPid) {
    if (process.platform === "win32") {
      try {
        await runExecFile("taskkill.exe", ["/F", "/T", "/PID", String(managedPid)]);
      } catch {}
    } else {
      try {
        process.kill(managedPid, "SIGKILL");
      } catch {}
    }
  }
  await killOrphanedProcesses();
  managedProcess = null;
  managedPid = null;
  managedPort = null;
  return { stopped: true };
}

export function getDaemonState(options = {}, worktree) {
  const opts = normalizeOptions(options);
  const binDir = join(resolveRuntimeDir(worktree), "bin");
  let installedVersion = "";
  try {
    const vFile = join(binDir, "version.json");
    if (existsSync(vFile)) {
      installedVersion = JSON.parse(readFileSync(vFile, "utf8"))?.version || "";
    }
  } catch {}
  return {
    managedRunning: Boolean(managedProcess && !managedProcess.killed),
    pid: managedPid,
    port: opts.port,
    url: cpaBaseUrl(opts),
    magpieBaseUrl: opts.magpieBaseUrl,
    defaultModel: opts.defaultModel,
    copilotAliases: opts.copilotAliases,
    binaryPath: findLocalBinary(opts, worktree),
    configPath: resolveConfigPath(opts, worktree),
    authDir: resolveAuthDir(opts, worktree),
    installedVersion,
  };
}

export function resolveVsCodeConfigPath() {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "Code", "User", "chatLanguageModels.json");
  } else if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  } else {
    return join(home, ".config", "Code", "User", "chatLanguageModels.json");
  }
}

export async function detectEasyCliProxyApi(options = {}) {
  const opts = normalizeOptions(options);
  const port = opts.easyCliProxyApiPort || 8317;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) return { running: true, port };
  } catch {}
  return { running: false, port };
}

export function registerVsCodeAgent(options = {}, models = []) {
  const opts = normalizeOptions(options);
  const filePath = resolveVsCodeConfigPath();
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const host = opts.host === "0.0.0.0" || opts.host === "" ? "127.0.0.1" : opts.host;
  const port = opts.easyCliProxyApi ? (opts.easyCliProxyApiPort || 8317) : opts.port;
  const endpointUrl = `http://${host}:${port}/v1/chat/completions`;

  const modelList = (models && models.length ? models : [
    { id: opts.defaultModel || "group/gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "group/free-model-magpie", name: "Free Model Magpie" },
  ]).map((m) => {
    const id = m.id || m.apiId || m.name;
    const name = m.name || m.display_name || id;
    return {
      id,
      name: name.includes("CLIProxyAPI") || name.includes("Magpie") || name.includes("EasyCLIProxyAPI")
        ? name
        : `${name} (Proxy)`,
      url: endpointUrl,
      toolCalling: true,
      vision: true,
      maxInputTokens: 1000000,
      maxPromptTokens: 1000000,
      maxContextWindowTokens: 1000000,
      maxOutputTokens: 128000,
    };
  });

  let existing = [];
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed)) {
        existing = parsed.filter((p) => p && p.name !== "CLIProxyAPI" && p.name !== "EasyCLIProxyAPI");
      }
    }
  } catch {}

  const entry = {
    name: opts.easyCliProxyApi ? "EasyCLIProxyAPI" : "CLIProxyAPI",
    vendor: "customendpoint",
    apiType: "chat-completions",
    models: modelList,
  };

  const updated = [entry, ...existing];
  writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");

  return {
    success: true,
    path: filePath,
    registeredModels: modelList.map((m) => m.id),
    targetUrl: endpointUrl,
  };
}
