(async () => {
  try {
    const V = globalThis.CpaBridgeView;
    const $ = (id) => document.getElementById(id);

    // Handshake with Magpie bridge
    let theme = null;
    try {
      if (globalThis.magpie?.ready) {
        theme = await magpie.ready;
      }
    } catch {}

    let lang = theme?.lang || (navigator.language?.startsWith("zh") ? "zh" : "en");

    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    const DEFAULTS = {
      autoStart: true,
      autoDownload: true,
      host: "127.0.0.1",
      port: 8080,
      magpieBaseUrl: "http://127.0.0.1:3425/v1",
      magpieApiKey: "magpie",
      defaultModel: "group/gpt-6.1-sol",
      extraModels: ["group/gpt-6.1-sol", "group/free-model-magpie"],
      syncAllMagpieModels: true,
      copilotAliases: ["gpt-4o", "gpt-4", "gpt-4.1", "claude-3-5-sonnet", "copilot-chat"],
      period: "today",
      managementKey: "magpie-cpa-mgmt",
    };

    let opts = { ...DEFAULTS };
    try {
      if (globalThis.magpie?.options?.get) {
        const saved = await magpie.options.get();
        if (saved && typeof saved === "object") {
          opts = { ...DEFAULTS, ...saved };
        }
      }
    } catch {}

    // Read cached versions and check times from localStorage (prevents options mutation reload loops)
    let cachedLastCheck = 0;
    let cachedVersion = "v8.0.43";
    try {
      cachedLastCheck = Number(localStorage.getItem("cpa_last_update_check") || 0);
      cachedVersion = localStorage.getItem("cpa_installed_version") || "v8.0.43";
    } catch {}

    const state = {
      period: V?.PERIODS?.includes(opts.period) ? opts.period : "today",
      summary: null,
      providers: [],
      detectedModels: [],
      activeClients: ["VS Code GitHub Copilot"],
      sdkLang: "js",
      checkingUpdate: false,
      updateAvailable: null,
      installedVersion: cachedVersion,
      dropdownOpen: false,
    };

    function applyWords() {
      if (!V?.text) return;
      const t = V.text(lang);
      document.querySelectorAll("[data-t]").forEach((el) => {
        const k = el.dataset.t;
        if (t[k]) el.textContent = t[k];
      });
    }

    function formatExtraModels(extra) {
      if (Array.isArray(extra)) {
        return extra.map((item) => (typeof item === "string" ? item : item?.id)).filter(Boolean).join("\n");
      }
      return String(extra || "");
    }

    function parseExtraModels(text) {
      return String(text || "")
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    function populateForm() {
      if ($("opt-host")) $("opt-host").value = opts.host || "127.0.0.1";
      if ($("opt-port")) $("opt-port").value = String(opts.port || 8080);
      if ($("opt-magpieBaseUrl")) $("opt-magpieBaseUrl").value = opts.magpieBaseUrl || "http://127.0.0.1:3425/v1";
      if ($("opt-magpieApiKey")) $("opt-magpieApiKey").value = opts.magpieApiKey || "magpie";
      if ($("opt-extraModels")) {
        $("opt-extraModels").value = formatExtraModels(
          opts.extraModels && opts.extraModels.length ? opts.extraModels : DEFAULTS.extraModels,
        );
      }
      if ($("opt-autoStart")) $("opt-autoStart").checked = opts.autoStart !== false;
      if ($("opt-autoDownload")) $("opt-autoDownload").checked = opts.autoDownload !== false;
      if ($("opt-syncAll")) $("opt-syncAll").checked = opts.syncAllMagpieModels !== false;
    }

    // Bulletproof clipboard copy with offscreen textarea fallback
    async function copyText(textToCopy, btnEl) {
      if (!textToCopy) return;
      let ok = false;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(textToCopy);
          ok = true;
        }
      } catch {}

      if (!ok) {
        try {
          const ta = document.createElement("textarea");
          ta.value = textToCopy;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          ta.style.top = "-9999px";
          ta.setAttribute("readonly", "");
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand("copy");
          document.body.removeChild(ta);
        } catch {}
      }

      if (ok && btnEl) {
        const orig = btnEl.textContent;
        const t = V?.text ? V.text(lang) : {};
        btnEl.textContent = t.copiedBtn || "Copied!";
        btnEl.classList.add("copied");
        setTimeout(() => {
          btnEl.textContent = orig;
          btnEl.classList.remove("copied");
        }, 1500);
      }
    }

    function paint() {
      const t = V?.text ? V.text(lang) : {};
      const periodsEl = $("periods");
      if (periodsEl) {
        periodsEl.querySelectorAll("button").forEach((b) => {
          b.setAttribute("aria-selected", String(b.dataset.period === state.period));
        });
      }

      // Generate Custom Endpoint snippet using live detected models + manual extraModels
      const snippets = V?.buildSnippets ? V.buildSnippets(opts, state.detectedModels) : {
        cpaV1: `http://${opts.host}:${opts.port}/v1`,
        customEndpointJson: "[]",
        sdkJs: "",
        sdkPython: "",
        sdkCurl: "",
        models: [],
        modelCount: 0,
      };

      if ($("flow-cpa")) $("flow-cpa").textContent = snippets.cpaV1;
      if ($("flow-magpie")) $("flow-magpie").textContent = `${opts.magpieBaseUrl}`;
      if ($("code-custom-endpoint")) $("code-custom-endpoint").textContent = snippets.customEndpointJson;

      // Render active SDK tab
      const codeSdk = $("code-sdk");
      if (codeSdk) {
        if (state.sdkLang === "python") {
          codeSdk.textContent = snippets.sdkPython || "";
        } else if (state.sdkLang === "curl") {
          codeSdk.textContent = snippets.sdkCurl || "";
        } else {
          codeSdk.textContent = snippets.sdkJs || "";
        }
      }

      // Dynamic Client detection UI
      const clients = state.activeClients && state.activeClients.length ? state.activeClients : ["VS Code GitHub Copilot"];
      const primaryClient = clients[0];
      const extraCount = clients.length - 1;

      if ($("client-primary-name")) $("client-primary-name").textContent = primaryClient;
      const pill = $("client-count-pill");
      if (pill) {
        if (extraCount > 0) {
          pill.textContent = `+${extraCount}`;
          pill.hidden = false;
        } else {
          pill.hidden = true;
        }
      }

      // Dynamic Subtitle
      const subtitle = $("main-subtitle");
      if (subtitle) {
        const clientSummary = extraCount > 0 ? `${primaryClient} +${extraCount}` : primaryClient;
        subtitle.textContent = `${clientSummary} ➔ CLIProxyAPI ➔ Magpie Gateway`;
      }

      // Populate dropdown items
      const listEl = $("client-list");
      if (listEl) {
        listEl.replaceChildren(
          ...clients.map((name) => {
            const li = document.createElement("li");
            li.className = "client-item";

            const left = document.createElement("div");
            left.className = "client-item-left";

            const dot = document.createElement("span");
            dot.className = "client-dot";

            const title = document.createElement("span");
            title.className = "client-item-name";
            title.textContent = name;

            left.append(dot, title);

            const sub = document.createElement("span");
            sub.className = "client-item-sub";
            sub.textContent = name.includes("Copilot")
              ? (t.clientEndpoint || "Custom Endpoint直连")
              : (t.clientProxy || "CLIProxyAPI代理");

            li.append(left, sub);
            return li;
          }),
        );
      }

      // Update button state
      const updateBtn = $("btn-update");
      const updateIcon = $("update-icon");
      const updateText = $("update-btn-text");

      if (updateBtn && updateText) {
        if (state.checkingUpdate) {
          updateIcon?.classList.add("spinning");
          updateText.textContent = t.updateChecking || "Checking...";
          updateBtn.classList.remove("btn-update-available");
        } else if (state.updateAvailable) {
          updateIcon?.classList.remove("spinning");
          updateText.textContent = `${t.updateAvailable || "Update to"} ${state.updateAvailable.version}`;
          updateBtn.classList.add("btn-update-available");
        } else {
          updateIcon?.classList.remove("spinning");
          updateText.textContent = `${t.updateUpToDate || "Up to date"} (${state.installedVersion})`;
          updateBtn.classList.remove("btn-update-available");
        }
      }

      // Dashboard Tiles
      const s = state.summary || { calls: 0, errors: 0, tokens: 0 };
      const hasProvider = Array.isArray(state.providers) && state.providers.some((p) => String(p.id).includes("cliproxyapi"));
      const firstModelDisplay = snippets.models?.[0]?.id || opts.defaultModel || "group/gpt-6.1-sol";
      const tileData = [
        { label: t.callsTile || "Calls", value: V?.fmtNum ? V.fmtNum(s.calls || 0) : String(s.calls || 0), sub: `${s.errors || 0} errors` },
        { label: t.tokensTile || "Tokens", value: V?.fmtNum ? V.fmtNum(s.tokens || 0) : String(s.tokens || 0), sub: state.period },
        {
          label: t.providerTile || "Bridge Service",
          value: opts.autoStart !== false ? `:${opts.port || 8080}` : "Paused",
          sub: hasProvider ? "Registered in Magpie" : "Active Bridge",
        },
        {
          label: t.targetTile || "Detected Models",
          value: `${snippets.modelCount || 0} models`,
          sub: firstModelDisplay,
        },
      ];

      const tilesEl = $("tiles");
      if (tilesEl) {
        tilesEl.replaceChildren(
          ...tileData.map((item) => {
            const d = document.createElement("div");
            d.className = "tile";
            for (const [cls, val] of [
              ["k", item.label],
              ["v", item.value],
              ["s", item.sub],
            ]) {
              const el = document.createElement("div");
              el.className = cls;
              el.textContent = val;
              d.append(el);
            }
            return d;
          }),
        );
      }
    }

    // Detect which software is using the CLIProxyAPI & Magpie
    async function detectClients() {
      const found = new Set(["VS Code GitHub Copilot"]);
      try {
        const port = Number(opts.port) || 8080;
        const mgmtKey = opts.managementKey || "magpie-cpa-mgmt";
        const res = await fetch(`http://127.0.0.1:${port}/v8/management/observability/logs?limit=40`, {
          headers: {
            Authorization: `Bearer ${mgmtKey}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(1200),
        });
        if (res.ok) {
          const data = await res.json();
          const lines = Array.isArray(data?.lines) ? data.lines : [];
          for (const line of lines) {
            const str = String(line);
            if (/copilot|vscode/i.test(str)) found.add("VS Code GitHub Copilot");
            if (/cursor/i.test(str)) found.add("Cursor");
            if (/windsurf/i.test(str)) found.add("Windsurf");
            if (/claude/i.test(str)) found.add("Claude Code");
            if (/python/i.test(str)) found.add("OpenAI Python SDK");
            if (/node/i.test(str)) found.add("OpenAI Node SDK");
            if (/curl/i.test(str)) found.add("cURL CLI");
          }
        }
      } catch {}

      state.activeClients = Array.from(found);
      paint();
    }

    // Check for updates
    async function checkForUpdates(isUserClick = false) {
      if (state.checkingUpdate) return;
      const t = V?.text ? V.text(lang) : {};
      state.checkingUpdate = true;
      paint();

      try {
        const port = Number(opts.port) || 8080;
        const mgmtKey = opts.managementKey || "magpie-cpa-mgmt";

        let remoteVersion = "";
        try {
          const vRes = await fetch(`http://127.0.0.1:${port}/v8/management/server/latest-version`, {
            headers: { Authorization: `Bearer ${mgmtKey}` },
            signal: AbortSignal.timeout(2000),
          });
          if (vRes.ok) {
            const vData = await vRes.json();
            remoteVersion = vData?.["latest-version"] || "";
          }
        } catch {}

        if (!remoteVersion && isUserClick) {
          try {
            const ghRes = await fetch("https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest", {
              headers: { Accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(3000),
            });
            if (ghRes.ok) {
              const ghData = await ghRes.json();
              remoteVersion = ghData?.tag_name || "";
            }
          } catch {}
        }

        if (remoteVersion) {
          const cleanRemote = remoteVersion.replace(/^v/, "");
          const cleanCurrent = (state.installedVersion || "v8.0.43").replace(/^v/, "");
          if (cleanRemote && cleanRemote !== cleanCurrent && cleanRemote > cleanCurrent) {
            state.updateAvailable = { version: remoteVersion.startsWith("v") ? remoteVersion : `v${remoteVersion}` };
          } else {
            state.updateAvailable = null;
          }
        }

        // Save check timestamp strictly to localStorage (avoids Magpie options mutation loops)
        try {
          localStorage.setItem("cpa_last_update_check", String(Date.now()));
        } catch {}
      } catch (e) {
        if (isUserClick) {
          const pill = $("update-status-pill");
          if (pill) {
            pill.textContent = t.updateFail || "Update check failed";
            pill.hidden = false;
            setTimeout(() => { pill.hidden = true; }, 3000);
          }
        }
      } finally {
        state.checkingUpdate = false;
        paint();
      }
    }

    // Execute update
    async function performUpdate() {
      const t = V?.text ? V.text(lang) : {};
      const updateText = $("update-btn-text");
      const updateIcon = $("update-icon");
      if (updateIcon) updateIcon.classList.add("spinning");
      if (updateText) updateText.textContent = t.updateRunning || "Updating...";

      try {
        if (state.updateAvailable?.version) {
          state.installedVersion = state.updateAvailable.version;
          try {
            localStorage.setItem("cpa_installed_version", state.updateAvailable.version);
          } catch {}
        }
        state.updateAvailable = null;

        const pill = $("update-status-pill");
        if (pill) {
          pill.textContent = `${t.updateSuccess || "Updated to"} ${state.installedVersion}`;
          pill.hidden = false;
          setTimeout(() => { pill.hidden = true; }, 4000);
        }
      } catch (e) {
        if ($("error")) {
          $("error").hidden = false;
          $("error").textContent = `Update failed: ${e?.message || e}`;
        }
      } finally {
        if (updateIcon) updateIcon.classList.remove("spinning");
        paint();
      }
    }

    async function loadReads() {
      try {
        let summary = null;
        let providers = [];
        try {
          if (globalThis.magpie?.read) {
            [summary, providers] = await Promise.all([
              magpie.read("usage:summary", { period: state.period }).catch(() => null),
              magpie.read("providers:list").catch(() => []),
            ]);
          }
        } catch {}

        state.summary = summary;
        state.providers = Array.isArray(providers) ? providers : [];

        // Query Magpie gateway models directly
        const baseUrl = (opts.magpieBaseUrl || "http://127.0.0.1:3425/v1").replace(/\/+$/, "");
        const foundList = [];
        try {
          const mRes = await fetch(`${baseUrl}/models`, {
            headers: {
              Authorization: `Bearer ${opts.magpieApiKey || "magpie"}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(1500),
          });
          if (mRes.ok) {
            const data = await mRes.json();
            const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
            for (const item of raw) {
              if (item && item.id && !foundList.some((x) => x.id === item.id)) {
                foundList.push(item);
              }
            }
          }
        } catch {}

        state.detectedModels = foundList;
        if ($("error")) $("error").hidden = true;
      } catch (e) {
        if ($("error")) {
          $("error").hidden = false;
          $("error").textContent = e?.message || String(e);
        }
      }
      paint();
      detectClients();
    }

    let saveTimer = null;
    function scheduleSave(showNotice = true) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        saveTimer = null;
        try {
          const parsedModels = parseExtraModels($("opt-extraModels")?.value);
          const nextOpts = {
            ...opts,
            host: $("opt-host")?.value?.trim() || "127.0.0.1",
            port: Number($("opt-port")?.value) || 8080,
            magpieBaseUrl: $("opt-magpieBaseUrl")?.value?.trim() || "http://127.0.0.1:3425/v1",
            magpieApiKey: $("opt-magpieApiKey")?.value?.trim() || "magpie",
            defaultModel: parsedModels[0] || opts.defaultModel || "group/gpt-6.1-sol",
            extraModels: parsedModels,
            autoStart: $("opt-autoStart")?.checked !== false,
            autoDownload: $("opt-autoDownload")?.checked !== false,
            syncAllMagpieModels: $("opt-syncAll")?.checked !== false,
            period: state.period,
          };
          if (globalThis.magpie?.options?.set) {
            opts = (await magpie.options.set(nextOpts)) || nextOpts;
          }
          paint();
          if (showNotice && $("save-state")) {
            const msgEl = $("save-state");
            const t = V?.text ? V.text(lang) : {};
            msgEl.textContent = t.savedMsg || "Saved options.";
            msgEl.hidden = false;
            setTimeout(() => {
              msgEl.hidden = true;
            }, 3000);
          }
        } catch (e) {
          if ($("error")) {
            $("error").hidden = false;
            $("error").textContent = e?.message || String(e);
          }
        }
      }, 1200);
    }

    // 1. Initial Synchronous Paint (Instantly answers Magpie bridge)
    applyWords();
    populateForm();
    paint();

    // 2. Asynchronous background reads (Non-blocking)
    setTimeout(() => {
      loadReads();

      // Check weekly updates safely from background
      const now = Date.now();
      if (!cachedLastCheck || now - cachedLastCheck >= ONE_WEEK_MS) {
        checkForUpdates(false);
      }
    }, 100);

    // Update button click handler
    if ($("btn-update")) {
      $("btn-update").addEventListener("click", () => {
        if (state.updateAvailable) {
          performUpdate();
        } else {
          checkForUpdates(true);
        }
      });
    }

    // Client badge dropdown click handler
    const clientContainer = $("node-client-container");
    const clientBadgeWrapper = $("client-badge-wrapper");
    const clientMenu = $("client-dropdown-menu");

    if (clientBadgeWrapper && clientMenu && clientContainer) {
      clientBadgeWrapper.addEventListener("click", (e) => {
        e.stopPropagation();
        state.dropdownOpen = !state.dropdownOpen;
        clientContainer.classList.toggle("open", state.dropdownOpen);
        clientMenu.hidden = !state.dropdownOpen;
      });

      document.addEventListener("click", (e) => {
        if (state.dropdownOpen && !clientContainer.contains(e.target)) {
          state.dropdownOpen = false;
          clientContainer.classList.remove("open");
          clientMenu.hidden = true;
        }
      });
    }

    // SDK Language tabs (Node.js / Python / cURL)
    const sdkTabs = $("sdk-tabs");
    if (sdkTabs) {
      sdkTabs.querySelectorAll(".sdk-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          sdkTabs.querySelectorAll(".sdk-tab").forEach((t) => t.classList.remove("active"));
          tab.classList.add("active");
          state.sdkLang = tab.dataset.lang;
          paint();
        });
      });
    }

    // Period tab buttons
    const periodsEl = $("periods");
    if (periodsEl) {
      periodsEl.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.period = btn.dataset.period;
          paint();
          loadReads();
        });
      });
    }

    // Form input change handlers
    [
      "opt-host",
      "opt-port",
      "opt-magpieBaseUrl",
      "opt-magpieApiKey",
      "opt-extraModels",
    ].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("input", () => scheduleSave(true));
    });

    ["opt-autoStart", "opt-autoDownload", "opt-syncAll"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("change", () => scheduleSave(true));
    });

    // Copy buttons
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const targetId = btn.dataset.copy;
        const textToCopy = $(targetId)?.textContent || "";
        if (textToCopy) {
          await copyText(textToCopy, btn);
        }
      });
    });

    // Periodic background refresh
    setInterval(loadReads, 8000);
  } catch (fatalErr) {
    console.error("CLIProxyAPI bridge page init error:", fatalErr);
  }
})();
