globalThis.CpaBridgeView = (() => {
  const PERIODS = ["today", "7d", "30d"];

  const TEXT = {
    en: {
      title: "CLIProxyAPI Bridge",
      subtitle: "VS Code GitHub Copilot ➔ CLIProxyAPI ➔ Magpie Gateway",
      today: "Today",
      "7d": "7 days",
      "30d": "30 days",
      nodeClient: "VS Code GitHub Copilot",
      nodeProxy: "CLIProxyAPI (Plugin)",
      nodeMagpie: "Your Magpie Gateway",
      configTitle: "Bridge Configuration",
      configHint: "Changes automatically save to Magpie and reload the managed CLIProxyAPI server.",
      hostLabel: "CLIProxyAPI Host",
      portLabel: "CLIProxyAPI Port",
      magpieUrlLabel: "Magpie Gateway Base URL",
      magpieKeyLabel: "Magpie API Key",
      extraModelsLabel: "Configured Magpie Models (one per line or comma-separated)",
      extraModelsHint: "Live gateway models auto-detect when Magpie runs. You can also manually list your models (e.g. group/gpt-6.1-sol, group/free-model-magpie) below:",
      autoStartLabel: "Auto-start CLIProxyAPI with Magpie (auto-stops when Magpie exits)",
      autoDownloadLabel: "Auto-download CLIProxyAPI binary if missing",
      syncAllLabel: "Expose all detected Magpie models in CLIProxyAPI",
      vscodeTitle: "VS Code GitHub Copilot Setup",
      snippetCustomEndpoint: "VS Code Custom Endpoint (Recommended)",
      snippetCustomEndpointHint: "Paste into your VS Code Copilot custom endpoints array in settings.json:",
      snippetSdk: "OpenAI SDK via CLIProxyAPI",
      snippetDirect: "Direct Magpie Endpoint",
      copyBtn: "Copy",
      copiedBtn: "Copied!",
      savedMsg: "Saved options — CLIProxyAPI reloading with updated config.",
      callsTile: "Gateway Calls",
      tokensTile: "Total Tokens",
      providerTile: "Bridge Service",
      targetTile: "Detected Models",
      updateBtn: "Check for Updates",
      updateChecking: "Checking...",
      updateUpToDate: "Up to date",
      updateAvailable: "Update to",
      updateRunning: "Updating...",
      updateSuccess: "Updated to",
      updateFail: "Update check failed",
      clientsTitle: "Connected Clients & Software",
      clientActive: "Active",
      clientEndpoint: "Connected via Custom Endpoint",
      clientProxy: "Connected to CLIProxyAPI (:8080)",
      tabJs: "Node.js",
      tabPython: "Python",
      tabCurl: "cURL",
    },
    zh: {
      title: "CLIProxyAPI 代理桥接",
      subtitle: "VS Code GitHub Copilot ➔ CLIProxyAPI ➔ Magpie 网关",
      today: "今天",
      "7d": "7 天",
      "30d": "30 天",
      nodeClient: "VS Code GitHub Copilot",
      nodeProxy: "CLIProxyAPI (内置插件)",
      nodeMagpie: "Magpie 本地网关",
      configTitle: "桥接与代理设置",
      configHint: "修改后自动保存到 Magpie 并热重载内置的 CLIProxyAPI 服务。",
      hostLabel: "CLIProxyAPI 监听地址",
      portLabel: "CLIProxyAPI 端口",
      magpieUrlLabel: "Magpie 网关地址",
      magpieKeyLabel: "Magpie API 密钥",
      extraModelsLabel: "配置的 Magpie 模型 (每行一个或逗号分隔)",
      extraModelsHint: "Magpie 网关运行时将自动检测可用模型。您也可以在下方手动登记模型列表 (如 group/gpt-6.1-sol, group/free-model-magpie)：",
      autoStartLabel: "随 Magpie 自动启动与自动停止 CLIProxyAPI",
      autoDownloadLabel: "缺失时自动下载 CLIProxyAPI 二进制文件",
      syncAllLabel: "自动同步 Magpie 所有检测到的模型到 CLIProxyAPI",
      vscodeTitle: "VS Code GitHub Copilot 接入配置",
      snippetCustomEndpoint: "VS Code 自定义端点 (推荐)",
      snippetCustomEndpointHint: "直接复制并填入 VS Code Copilot settings.json 自定义端点配置：",
      snippetSdk: "OpenAI SDK 调用格式 (CLIProxyAPI)",
      snippetDirect: "Magpie 本地直接接入信息",
      copyBtn: "复制",
      copiedBtn: "已复制!",
      savedMsg: "已保存配置 — CLIProxyAPI 正在应用新设置。",
      callsTile: "网关请求数",
      tokensTile: "总 Token 数",
      providerTile: "桥接服务状态",
      targetTile: "已识别模型数",
      updateBtn: "检查更新",
      updateChecking: "正在检查...",
      updateUpToDate: "已是最新版",
      updateAvailable: "更新至",
      updateRunning: "正在更新...",
      updateSuccess: "已成功更新至",
      updateFail: "检查更新失败",
      clientsTitle: "已接入的客户端与调用软件",
      clientActive: "活跃连接",
      clientEndpoint: "自定义端点直连 (端口 3425)",
      clientProxy: "CLIProxyAPI 代理连接 (端口 8080)",
      tabJs: "Node.js",
      tabPython: "Python",
      tabCurl: "cURL",
    },
  };

  function text(lang) {
    return String(lang || "").startsWith("zh") ? TEXT.zh : TEXT.en;
  }

  function fmtNum(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
    return String(num);
  }

  function buildSnippets(opts, modelsList = []) {
    const host = opts.host || "127.0.0.1";
    const port = Number(opts.port) || 8080;
    const cpaUrl = `http://${host}:${port}`;
    const cpaV1 = `${cpaUrl}/v1`;
    const cpaChatUrl = `${cpaV1}/chat/completions`;
    const magpieV1Url = (opts.magpieBaseUrl || "http://127.0.0.1:3425/v1").replace(/\/+$/, "");
    const magpieChatUrl = `${magpieV1Url}/chat/completions`;
    const key = (opts.clientApiKeys && opts.clientApiKeys[0]) || opts.magpieApiKey || "magpie";
    const defaultModel = opts.defaultModel || "group/gpt-6.1-sol";

    // Deduplicate effective models from modelsList + opts.extraModels + defaultModel
    const seen = new Set();
    const effectiveModels = [];

    const addModel = (rawId, rawName) => {
      const id = String(rawId || "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      const name = rawName || id;
      effectiveModels.push({
        id,
        name: name.includes("Magpie") ? name : `${name} (Magpie)`,
      });
    };

    // 1. Add detected live models from Magpie
    if (Array.isArray(modelsList) && modelsList.length > 0) {
      for (const m of modelsList) {
        const id = m.id || m.apiId;
        const name = m.display_name || m.name || id;
        addModel(id, name);
      }
    }

    // 2. Add manually configured extraModels
    const extraList = Array.isArray(opts.extraModels)
      ? opts.extraModels
      : typeof opts.extraModels === "string"
        ? opts.extraModels.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean)
        : [];
    for (const extra of extraList) {
      const id = typeof extra === "string" ? extra : extra?.id;
      const name = typeof extra === "object" ? (extra.display_name || extra.name) : id;
      addModel(id, name);
    }

    // 3. Fallback to default models if none found
    if (effectiveModels.length === 0) {
      addModel("group/gpt-6.1-sol", "group/gpt-6.1-sol");
      addModel("group/free-model-magpie", "group/free-model-magpie");
    }

    // VS Code Copilot Custom Endpoint array format (matching @[code_block] exactly)
    const customEndpointArray = [
      {
        name: "Magpie",
        vendor: "customendpoint",
        apiType: "chat-completions",
        models: effectiveModels.map((m) => ({
          id: m.id,
          name: m.name.endsWith("(Magpie)") ? m.name : `${m.id} (Magpie)`,
          url: magpieChatUrl,
          toolCalling: true,
          vision: true,
          maxInputTokens: 1000000,
          maxPromptTokens: 1000000,
          maxContextWindowTokens: 1000000,
          maxOutputTokens: 128000,
        })),
      },
    ];

    const customEndpointJson = JSON.stringify(customEndpointArray, null, 2);

    const firstModelId = effectiveModels[0]?.id || defaultModel;

    // OpenAI SDK translations via CLIProxyAPI (:8080/v1)
    const sdkJs = [
      'import OpenAI from "openai";',
      "",
      "// Connect to CLIProxyAPI (bridges calls to Magpie Gateway)",
      `const client = new OpenAI({ baseURL: "${cpaV1}", apiKey: "${key}" });`,
      "",
      "const response = await client.chat.completions.create({",
      `  model: "${firstModelId}",`,
      '  messages: [{ role: "user", content: "Hello!" }],',
      "});",
      "",
      "console.log(response.choices[0].message.content);",
    ].join("\n");

    const sdkPython = [
      "from openai import OpenAI",
      "",
      "# Connect to CLIProxyAPI (bridges calls to Magpie Gateway)",
      "client = OpenAI(",
      `    base_url="${cpaV1}",`,
      `    api_key="${key}",`,
      ")",
      "",
      "response = client.chat.completions.create(",
      `    model="${firstModelId}",`,
      '    messages=[{"role": "user", "content": "Hello!"}],',
      ")",
      "",
      "print(response.choices[0].message.content)",
    ].join("\n");

    const sdkCurl = [
      `curl ${cpaChatUrl} \\`,
      '  -H "Content-Type: application/json" \\',
      `  -H "Authorization: Bearer ${key}" \\`,
      "  -d '{",
      `    "model": "${firstModelId}",`,
      '    "messages": [{"role": "user", "content": "Hello!"}]',
      "  }'",
    ].join("\n");

    const directInfo = [
      `CLIProxyAPI OpenAI Base: ${cpaV1}`,
      `CLIProxyAPI Chat URL:   ${cpaChatUrl}`,
      `Magpie Gateway Base:     ${magpieV1Url}`,
      `CLIProxyAPI Web UI:      ${cpaUrl}/`,
    ].join("\n");

    return {
      customEndpointJson,
      sdkJs,
      sdkPython,
      sdkCurl,
      directInfo,
      cpaV1,
      cpaChatUrl,
      magpieChatUrl,
      modelCount: effectiveModels.length,
      models: effectiveModels,
    };
  }

  return { PERIODS, text, fmtNum, buildSnippets };
})();
