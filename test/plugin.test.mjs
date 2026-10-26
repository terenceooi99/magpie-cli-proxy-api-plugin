import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as entryMod from "../index.mjs";
import { _internal } from "../index.mjs";
import { buildCpaUpstreamModels, buildMagpieCompatibilityGroup } from "../models.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const expect = (actual) => ({
  toBe(expected) {
    assert.strictEqual(actual, expected);
  },
  toBeDefined() {
    assert.notStrictEqual(actual, undefined);
  },
  toBeGreaterThan(n) {
    assert.ok(actual > n, `Expected ${actual} > ${n}`);
  },
  toBeGreaterThanOrEqual(n) {
    assert.ok(actual >= n, `Expected ${actual} >= ${n}`);
  },
  toContain(sub) {
    if (Array.isArray(actual)) {
      assert.ok(actual.includes(sub), `Expected array to contain ${sub}`);
    } else {
      assert.ok(String(actual).includes(sub), `Expected string to contain ${sub}`);
    }
  },
});

describe("magpie-cli-proxy-api-plugin contract & unit tests", () => {
  it("exports exactly one plugin function in index.mjs (per Magpie spec)", () => {
    const exportedFunctions = Object.values(entryMod).filter((v) => typeof v === "function");
    expect(exportedFunctions.length).toBe(1);
    expect(typeof entryMod.CLIProxyAPIPlugin).toBe("function");
    expect(typeof entryMod._internal).toBe("object");
  });

  it("returns valid Magpie/OpenCode hooks (config, auth, provider, chat.headers, tool)", async () => {
    process.env.MAGPIE_CPA_NO_AUTOSTART = "1";
    const client = {
      app: { log: async () => {} },
      auth: { set: async () => {} },
      tui: { showToast: async () => {} },
      config: { get: async () => ({ data: {} }) },
    };

    const hooks = await entryMod.CLIProxyAPIPlugin(
      { client, directory: rootDir, worktree: rootDir, project: {} },
      { autoStart: false, port: 8080, defaultModel: "group/gpt-6.1-sol" },
    );

    // Check config hook
    expect(typeof hooks.config).toBe("function");
    const cfg = { provider: {} };
    await hooks.config(cfg);
    expect(cfg.provider.cliproxyapi).toBeDefined();
    expect(cfg.provider.cliproxyapi.npm).toBe("@ai-sdk/openai-compatible");
    expect(cfg.provider.cliproxyapi.api).toBe("http://127.0.0.1:8080/v1");
    expect(Object.keys(cfg.provider.cliproxyapi.models)).toContain("group/gpt-6.1-sol");

    // Check auth hook
    expect(hooks.auth).toBeDefined();
    expect(hooks.auth.provider).toBe("cliproxyapi");
    expect(Array.isArray(hooks.auth.methods)).toBe(true);
    expect(hooks.auth.methods.length).toBeGreaterThanOrEqual(2);
    expect(typeof hooks.auth.loader).toBe("function");
    expect(typeof hooks.auth.usage).toBe("function");

    // Check provider.models hook
    expect(hooks.provider?.id).toBe("cliproxyapi");
    expect(typeof hooks.provider?.models).toBe("function");

    // Check tools hook
    expect(hooks.tool).toBeDefined();
    for (const [toolName, toolDef] of Object.entries(hooks.tool)) {
      expect(/^[A-Za-z0-9_-]{1,48}$/.test(toolName)).toBe(true);
      expect(typeof toolDef.description).toBe("string");
      expect(typeof toolDef.execute).toBe("function");
      expect(typeof toolDef.args).toBe("object");
    }
  });

  it("maps group/gpt-6.1-sol and Copilot aliases into CLIProxyAPI upstream config", () => {
    const magpieModels = [
      { id: "group/gpt-6.1-sol", display_name: "GPT-6.1 Sol Group", context_window: 200000 },
      { id: "anthropic/claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", context_window: 200000 },
    ];
    const models = buildCpaUpstreamModels(magpieModels, {
      defaultModel: "group/gpt-6.1-sol",
      copilotAliases: ["gpt-4o", "gpt-4", "copilot-chat"],
      syncAllMagpieModels: true,
    });

    const aliases = models.map((m) => m.alias);
    expect(aliases).toContain("group/gpt-6.1-sol");
    expect(aliases).toContain("gpt-6.1-sol");
    expect(aliases).toContain("gpt-4o");
    expect(aliases).toContain("gpt-4");
    expect(aliases).toContain("copilot-chat");
    expect(aliases).toContain("anthropic/claude-sonnet-4-5");

    const gpt4oEntry = models.find((m) => m.alias === "gpt-4o");
    expect(gpt4oEntry.name).toBe("group/gpt-6.1-sol");

    const group = buildMagpieCompatibilityGroup(magpieModels, {
      magpieBaseUrl: "http://127.0.0.1:3425/v1",
      magpieApiKey: "magpie",
      defaultModel: "group/gpt-6.1-sol",
    });
    expect(group["base-url"]).toBe("http://127.0.0.1:3425/v1");
    expect(group.keys[0]["api-key"]).toBe("magpie");
  });

  it("generates a valid CLIProxyAPI v8 config.yaml pointing to Magpie", () => {
    const yaml = _internal.generateV8ConfigYaml(
      [{ id: "group/gpt-6.1-sol", display_name: "GPT-6.1 Sol" }],
      {
        host: "127.0.0.1",
        port: 8080,
        magpieBaseUrl: "http://127.0.0.1:3425/v1",
        magpieApiKey: "magpie",
        defaultModel: "group/gpt-6.1-sol",
      },
      rootDir,
    );

    expect(yaml).toContain("config-version: 8");
    expect(yaml).toContain("port: 8080");
    expect(yaml).toContain('base-url: "http://127.0.0.1:3425/v1"');
    expect(yaml).toContain('api-key: "magpie"');
    expect(yaml).toContain('name: "group/gpt-6.1-sol"');
    expect(yaml).toContain('alias: "gpt-4o"');
  });

  it("complies with Magpie sandboxed page rules (no inline scripts, declared permissions)", () => {
    const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
    expect(pkg.magpie?.page?.file).toBe("page/index.html");
    expect(existsSync(join(rootDir, pkg.magpie.page.file))).toBe(true);
    expect(existsSync(join(rootDir, pkg.magpie.page.icon))).toBe(true);

    const html = readFileSync(join(rootDir, "page/index.html"), "utf8");
    expect(html).toContain('_magpie/bridge.js');
    // Ensure no inline script bodies exist
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scriptTags) {
      expect(attrs).toContain("src=");
      expect(body.trim()).toBe("");
    }
  });

  it("locates binary inside plugin cli-proxy-api folder and generates VS Code Custom Endpoint snippet", () => {
    const bin = _internal.findLocalBinary({}, rootDir);
    expect(bin).toBeDefined();
    expect(bin.toLowerCase()).toContain("magpie-cli-proxy-api-plugin");
    expect(bin.toLowerCase()).toContain("cli-proxy-api");

    const viewJs = readFileSync(join(rootDir, "page/view.js"), "utf8");
    expect(viewJs).toContain('name: "Magpie"');
    expect(viewJs).toContain('vendor: "customendpoint"');
    expect(viewJs).toContain('apiType: "chat-completions"');
  });

  it("supports EasyCLIProxyAPI auto-registration for Agent Configuration tab", async () => {
    expect(typeof _internal.registerVsCodeAgent).toBe("function");
    expect(typeof _internal.detectEasyCliProxyApi).toBe("function");

    const reg = _internal.registerVsCodeAgent({
      easyCliProxyApi: true,
      easyCliProxyApiPort: 8317,
      defaultModel: "group/gpt-6.1-sol",
    });
    expect(reg.success).toBe(true);
    expect(reg.targetUrl).toContain("8317");
    expect(reg.registeredModels.length).toBeGreaterThanOrEqual(1);

    const st = await _internal.detectEasyCliProxyApi({ easyCliProxyApiPort: 8317 });
    expect(typeof st.running).toBe("boolean");
    expect(st.port).toBe(8317);
  });
});
