/**
 * @name Deadlock API Tracker
 * @author Kiwi
 * @description Tracks the live build version of multiple Steam Apps via the official Steam IGCVersion API. Switch apps with the dropdown. Shows daily build delta (midnight reset). WITH SOUND
 * @version 7.0.0
 */

const APP_DEFS = [
    { id: "1422450", name: "Deadlock Main",                 url: "https://api.steampowered.com/IGCVersion_1422450/GetClientVersion/v1" },
{ id: "3488080", name: "Deadlock (Experimental)", url: "https://api.steampowered.com/IGCVersion_3488080/GetClientVersion/v1" },
{ id: "3781850", name: "Deadlock Canary",            url: "https://api.steampowered.com/IGCVersion_3781850/GetClientVersion/v1" },
{ id: "3125160", name: "Deadlock NDA", url: "https://api.steampowered.com/IGCVersion_3125160/GetServerVersion/v1" },
];

module.exports = class SteamBuildTracker {
    constructor() {
        this.apps     = APP_DEFS;
        this.currentAppId  = APP_DEFS[0].id;
        this.updateInterval = 30000;
        this.timer    = null;
        this.widget   = null;
        this.styleEl  = null;
        this.isDragging = false;

        this.advancedMode = false;
        this.pos           = { x: 40, y: 100 };

        // Per-app state, keyed by appId
        this.appState = {};
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    start() {
        this.loadSettings();
        this.injectStyles();
        this.createWidget();
        this.startTracking();
    }

    stop() {
        this.stopTracking();
        if (this._onDocClick) { document.removeEventListener("mousedown", this._onDocClick); this._onDocClick = null; }
        if (this.widget)  { this.widget.remove();  this.widget  = null; }
        if (this.styleEl) { this.styleEl.remove(); this.styleEl = null; }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    }

    formatDelta(delta) {
        if (delta === 0) return "±0";
        if (delta > 0)   return `+${delta}`;
        return String(delta);
    }

    nowHHMM() {
        return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    }

    getCurrentAppDef() {
        return this.apps.find(a => a.id === this.currentAppId) || this.apps[0];
    }

    getState(appId = this.currentAppId) {
        return this.appState[appId];
    }

    // ─── API ──────────────────────────────────────────────────────────────────

    async fetchData(appId) {
        const def = this.apps.find(a => a.id === appId);
        if (!def) return;
        const state = this.appState[appId];
        if (!state) return;

        try {
            const response = await BdApi.Net.fetch(def.url, {
                method: "GET",
                headers: { "Accept": "application/json" }
            });

            if (!response.ok) {
                if (appId === this.currentAppId) {
                    this.updateWidget({ status: "HTTP ERR", version: null, delta: null, minVersion: null, error: `Status ${response.status}` });
                }
                return;
            }

            const json   = await response.json();
            const result = json?.result;

            if (result && result.success) {
                const version    = result.active_version      != null ? Number(result.active_version)      : null;
                const minVersion = result.min_allowed_version != null ? Number(result.min_allowed_version) : null;

                if (version !== null) {
                    const today = this.todayKey();

                    // New day — save yesterday's delta then reset baseline
                    if (state.dayKey !== today) {
                        if (state.dayKey && state.dayBaseVersion !== null && state.lastVersion !== null) {
                            this._upsertDailyHistory(state, state.dayKey, state.lastVersion - state.dayBaseVersion);
                        }
                        state.dayKey         = today;
                        state.dayBaseVersion = version;
                        this.saveSettings();
                    }

                    if (state.dayBaseVersion === null) {
                        state.dayBaseVersion = version;
                        this.saveSettings();
                    }

                    const changed = state.lastVersion !== null && state.lastVersion !== version;
                    state.lastVersion = version;

                    if (changed && appId === this.currentAppId) this.playAlert();

                    const delta = version - state.dayBaseVersion;

                    this._upsertDailyHistory(state, today, delta);

                    // Update ATH if this delta beats the record
                    if (delta > state.allTimeHighDelta) {
                        state.allTimeHighDelta = delta;
                    }

                    if (minVersion != null) state._lastMinVersion = minVersion;

                    this.saveSettings();

                    if (appId === this.currentAppId) {
                        this.updateWidget({ status: "LIVE", version, delta, minVersion, changed, error: null });
                    }
                } else if (appId === this.currentAppId) {
                    this.updateWidget({ status: "NO DATA", version: null, delta: null, minVersion: null, error: "active_version missing" });
                }
            } else if (appId === this.currentAppId) {
                this.updateWidget({ status: "NO DATA", version: null, delta: null, minVersion: null, error: "API returned no result" });
            }

        } catch (err) {
            console.error("[SteamBuildTracker] Fetch error:", err);
            const msg   = err?.message ?? String(err);
            const isNet = /net|connect|failed/i.test(msg);
            if (appId === this.currentAppId) {
                this.updateWidget({
                    status: isNet ? "NET ERR" : "FETCH ERR",
                    version: null, delta: null, minVersion: null,
                    error: msg.slice(0, 60)
                });
            }
        }
    }

    // ─── Alert Sound ──────────────────────────────────────────────────────────

    playAlert() {
        try {
            const audio = new Audio("https://actions.google.com/sounds/v1/alarms/beep_short.ogg");
            audio.volume = 0.5;
            audio.play().catch(e => console.warn("[SteamBuildTracker] Audio play failed:", e));
        } catch (e) {
            console.warn("[SteamBuildTracker] Audio error:", e);
        }
    }

    // ─── Daily History ────────────────────────────────────────────────────────

    _upsertDailyHistory(state, dateKey, delta) {
        const existing = state.dailyHistory.find(e => e.date === dateKey);
        if (existing) {
            existing.delta = delta;
        } else {
            state.dailyHistory.push({ date: dateKey, delta });
            state.dailyHistory.sort((a, b) => a.date.localeCompare(b.date));
        }
    }

    // ─── Graph ────────────────────────────────────────────────────────────────

    renderGraph() {
        const canvas = this.widget && this.widget.querySelector("#sbt-graph");
        if (!canvas) return;

        const state = this.getState();
        if (!state) return;

        const W = canvas.width  = canvas.offsetWidth  || 232;
        const H = canvas.height = canvas.offsetHeight || 90;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = "#080909";
        ctx.fillRect(0, 0, W, H);

        const history = state.dailyHistory;

        if (history.length === 0) {
            ctx.fillStyle = "#2a2d33";
            ctx.font = "9px Consolas, monospace";
            ctx.textAlign = "center";
            ctx.fillText("NO HISTORY YET", W / 2, H / 2);
            return;
        }

        const maxBars = 10;
        const points  = history.slice(-maxBars);
        const n       = points.length;

        const padT  = 18;
        const padB  = 14;
        const padLR = 4;
        const innerW = W - padLR * 2;
        const innerH = H - padT - padB;

        const gap    = 2;
        const barW   = Math.floor((innerW - gap * (n - 1)) / n);
        const totalW = barW * n + gap * (n - 1);
        const startX = padLR + Math.floor((innerW - totalW) / 2);

        const deltas = points.map(p => p.delta);
        const maxD   = Math.max(...deltas, 1);

        for (let i = 0; i < n; i++) {
            const { date, delta } = points[i];
            const x = startX + i * (barW + gap);

            const bH = delta > 0 ? Math.max(2, Math.round((delta / maxD) * innerH)) : 2;
            const y  = padT + innerH - bH;

            // ATH bar is gold, active bars white, zero bars near-invisible
            const isATH = delta > 0 && delta === state.allTimeHighDelta;
            ctx.fillStyle = isATH ? "#f0b232" : (delta === 0 ? "#1e2030" : "#ffffff");
            ctx.fillRect(x, y, barW, bH);

            // Delta label above bar
            const label = delta === 0 ? "0" : (delta > 0 ? "+" + delta : String(delta));
            ctx.font      = "7px Consolas, monospace";
            ctx.textAlign = "center";
            ctx.fillStyle = isATH ? "#f0b232" : (delta === 0 ? "#2a2d33" : "#9ba3b8");
            ctx.fillText(label, x + barW / 2, Math.max(y - 2, padT - 2));

            // Date label below
            const [, mm, dd] = date.split("-");
            const dayNum    = parseInt(dd, 10);
            const dateLabel = (dayNum === 1 || i === 0) ? `${parseInt(mm)}/${dayNum}` : String(dayNum);
            ctx.fillStyle = "#ffffff";
            ctx.font      = "7px Consolas, monospace";
            ctx.fillText(dateLabel, x + barW / 2, H - 2);
        }
    }

    // ─── Styles ───────────────────────────────────────────────────────────────

    injectStyles() {
        this.styleEl = document.createElement("style");
        this.styleEl.id = "steam-build-tracker-styles";
        this.styleEl.textContent = `
        #sbt-widget {
        position: fixed;
        width: 260px;
        background: #0d0e10;
        border: 1px solid #1a1c1f;
        border-radius: 10px;
        z-index: 99999;
        color: #c9cdd3;
        font-family: 'Consolas', 'Menlo', 'Courier New', monospace;
        font-size: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04);
        overflow: hidden;
        cursor: grab;
        user-select: none;
        transition: box-shadow 0.15s ease;
        }
        #sbt-widget:hover {
        box-shadow: 0 16px 48px rgba(0,0,0,0.8), 0 0 0 1px rgba(88,101,242,0.3);
        }
        #sbt-widget.dragging {
        cursor: grabbing;
        box-shadow: 0 24px 60px rgba(0,0,0,0.9), 0 0 0 1px rgba(88,101,242,0.5);
        }
        #sbt-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 14px 8px;
        border-bottom: 1px solid #1a1c1f;
        background: #111214;
        }
        #sbt-title  { font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: #7114e3; text-transform: uppercase; flex-shrink: 0; }
        #sbt-app-dropdown {
        position: relative;
        flex-shrink: 0;
        margin-left: auto;
        }
        #sbt-app-dropdown-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        background: #0a0b0d;
        color: #c9cdd3;
        border: 1px solid #1a1c1f;
        border-radius: 4px;
        font-family: inherit;
        font-size: 9px;
        letter-spacing: 0.3px;
        padding: 4px 6px;
        max-width: 132px;
        cursor: pointer;
        outline: none;
        transition: all 0.15s ease;
        }
        #sbt-app-dropdown-btn:hover,
        #sbt-app-dropdown-btn.open { border-color: #0212c2; color: #0212c2; }
        #sbt-app-dropdown-label {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        #sbt-app-dropdown-caret { font-size: 8px; flex-shrink: 0; color: #3c3f45; }
        #sbt-app-dropdown-list {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        min-width: 168px;
        background: #111214;
        border: 1px solid #1a1c1f;
        border-radius: 6px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.8);
        z-index: 100000;
        overflow: hidden;
        display: none;
        }
        #sbt-app-dropdown-list.open { display: block; }
        .sbt-app-option {
            padding: 7px 10px;
            font-size: 10px;
            color: #c9cdd3;
            cursor: pointer;
            letter-spacing: 0.3px;
            white-space: nowrap;
        }
        .sbt-app-option:hover   { background: rgba(2,18,194,0.15); color: #ffffff; }
        .sbt-app-option.active  { color: #7114e3; font-weight: 700; }
        #sbt-appid  { font-size: 9px; color: #3c3f45; letter-spacing: 0.5px; }
        #sbt-status-row {
        display: flex; align-items: center; gap: 6px;
        padding: 8px 14px; border-bottom: 1px solid #1a1c1f;
        }
        #sbt-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #038028; flex-shrink: 0; transition: background 0.3s ease;
        }
        #sbt-dot.error    { background: #b80206; animation: none; }
        #sbt-dot.live     { background: #038028; animation: sbt-pulse 2s infinite; }
        #sbt-dot.fetching { background: #f0b232; animation: sbt-blink 0.8s infinite; }
        @keyframes sbt-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes sbt-blink { 0%,100%{opacity:1} 50%{opacity:0.2}  }
        #sbt-status-text { font-size: 10px; letter-spacing: 1px; color: #5c6068; font-weight: 600; }
        #sbt-status-text.live  { color: #038028; }
        #sbt-status-text.error { color: #b80206; }
        #sbt-body {
        padding: 10px 14px 12px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px 12px;
        }
        .sbt-field { }
        .sbt-label {
            font-size: 9px; letter-spacing: 1.2px; color: #3c3f45;
            font-weight: 700; text-transform: uppercase; margin-bottom: 3px;
        }
        .sbt-value {
            font-size: 20px; font-weight: 700; color: #ffffff;
            line-height: 1; letter-spacing: -0.5px;
        }
        .sbt-value.changed { animation: sbt-flash 2s ease forwards; }
        @keyframes sbt-flash {
            0%   { color: #f0b232; text-shadow: 0 0 14px rgba(240,178,50,0.7); }
            100% { color: #ffffff; text-shadow: none; }
        }
        .sbt-value.placeholder { color: #2a2d33; }
        .sbt-value.delta-zero  { color: #5c6068; }
        .sbt-value.delta-pos   { color: #23a55a; }
        .sbt-value.delta-neg   { color: #b50206; }
        .sbt-value.delta-ath   { color: #f0b232; }
        .sbt-value.small       { font-size: 14px; }
        #sbt-advanced-section {
        border-top: 1px solid #1a1c1f;
        padding: 10px 14px 12px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px 12px;
        background: #0a0b0d;
        }
        #sbt-graph-section {
        border-top: 1px solid #1a1c1f;
        padding: 10px 14px 10px;
        background: #080909;
        }
        #sbt-graph-label {
        font-size: 9px; letter-spacing: 1.2px; color: #3c3f45;
        font-weight: 700; text-transform: uppercase; margin-bottom: 6px;
        }
        #sbt-graph {
        display: block;
        width: 100%;
        height: 90px;
        border-radius: 4px;
        }
        #sbt-error-msg {
        font-size: 10px; color: #f23f43; margin-top: 4px;
        display: none; word-break: break-all;
        grid-column: 1 / -1;
        }
        #sbt-footer {
        padding: 6px 14px 8px;
        border-top: 1px solid #1a1c1f;
        display: flex; align-items: center; justify-content: space-between;
        gap: 6px;
        }
        #sbt-time-label { font-size: 9px; color: #2a2d33; letter-spacing: 0.5px; }
        #sbt-time       { font-size: 9px; color: #3c3f45; }
        .sbt-btn {
            background: none; border: 1px solid #1a1c1f; border-radius: 4px;
            color: #3c3f45; font-size: 10px; padding: 2px 7px; cursor: pointer;
            font-family: inherit; letter-spacing: 0.5px; transition: all 0.15s ease;
            flex-shrink: 0;
        }
        .sbt-btn:hover  { border-color: #0212c2; color: #0212c2; background: rgba(2,18,194,0.08); }
        .sbt-btn.active { border-color: #038028; color: #038028; background: rgba(3,128,40,0.08); }
        `;
        document.head.appendChild(this.styleEl);
    }

    // ─── Widget ───────────────────────────────────────────────────────────────

    createWidget() {
        this.widget = document.createElement("div");
        this.widget.id = "sbt-widget";
        this.widget.style.top  = `${this.pos.y}px`;
        this.widget.style.left = `${this.pos.x}px`;

        const currentDef = this.getCurrentAppDef();
        const optionsHtml = this.apps.map(a =>
        `<div class="sbt-app-option${a.id === this.currentAppId ? " active" : ""}" data-app-id="${a.id}">${a.name}</div>`
        ).join("");

        this.widget.innerHTML = `
        <div id="sbt-header">
        <span id="sbt-title">Deadlock API Tracker</span>
        <span id="sbt-appid">APP ${this.currentAppId}</span>
        </div>
        <div id="sbt-status-row">
        <div id="sbt-dot" class="fetching"></div>
        <span id="sbt-status-text">POLLING…</span>
        <div id="sbt-app-dropdown">
        <button type="button" id="sbt-app-dropdown-btn">
        <span id="sbt-app-dropdown-label">${currentDef.name}</span>
        <span id="sbt-app-dropdown-caret">▾</span>
        </button>
        <div id="sbt-app-dropdown-list">${optionsHtml}</div>
        </div>
        </div>
        <div id="sbt-body">
        <div class="sbt-field">
        <div class="sbt-label">Active Version</div>
        <div class="sbt-value placeholder" id="sbt-version">—</div>
        </div>
        <div class="sbt-field">
        <div class="sbt-label">Today's Delta</div>
        <div class="sbt-value placeholder" id="sbt-delta">—</div>
        </div>
        <div id="sbt-error-msg"></div>
        </div>
        <div id="sbt-advanced-section" style="display:none">
        <div class="sbt-field">
        <div class="sbt-label">ATH Delta</div>
        <div class="sbt-value delta-ath" id="sbt-ath">—</div>
        </div>
        <div class="sbt-field">
        <div class="sbt-label">Min Allowed Ver</div>
        <div class="sbt-value small placeholder" id="sbt-minver">—</div>
        </div>
        </div>
        <div id="sbt-graph-section" style="display:none">
        <div id="sbt-graph-label">Daily Version Jumps</div>
        <canvas id="sbt-graph"></canvas>
        </div>
        <div id="sbt-footer">
        <div>
        <span id="sbt-time-label">UPDATED </span>
        <span id="sbt-time">—</span>
        </div>
        <button id="sbt-advanced-btn" class="sbt-btn">ADVANCED</button>
        <button id="sbt-refresh-btn" class="sbt-btn">↻ REFRESH</button>
        </div>
        `;

        document.body.appendChild(this.widget);

        this.widget.querySelector("#sbt-refresh-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            this.setFetching();
            this.fetchData(this.currentAppId);
        });

        this.widget.querySelector("#sbt-advanced-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            this.advancedMode = !this.advancedMode;
            this._applyAdvancedVisibility();
            this.saveSettings();
            this.refreshAdvancedFields();
            if (this.advancedMode) this.renderGraph();
        });

            const dropdownBtn  = this.widget.querySelector("#sbt-app-dropdown-btn");
            const dropdownList = this.widget.querySelector("#sbt-app-dropdown-list");

            dropdownBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            dropdownList.addEventListener("mousedown", (e) => e.stopPropagation());

            dropdownBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.toggleAppDropdown();
            });

            dropdownList.addEventListener("click", (e) => {
                e.stopPropagation();
                const option = e.target.closest(".sbt-app-option");
                if (!option) return;
                this.closeAppDropdown();
                this.switchApp(option.dataset.appId);
            });

            // Close the dropdown when clicking anywhere outside of it
            this._onDocClick = (e) => {
                if (!this.widget) return;
                if (!this.widget.querySelector("#sbt-app-dropdown").contains(e.target)) {
                    this.closeAppDropdown();
                }
            };
            document.addEventListener("mousedown", this._onDocClick);

            this._applyAdvancedVisibility();
            this.setupDragging();
    }

    toggleAppDropdown() {
        const btn  = this.widget.querySelector("#sbt-app-dropdown-btn");
        const list = this.widget.querySelector("#sbt-app-dropdown-list");
        const isOpen = list.classList.contains("open");
        if (isOpen) {
            list.classList.remove("open");
            btn.classList.remove("open");
        } else {
            list.classList.add("open");
            btn.classList.add("open");
        }
    }

    closeAppDropdown() {
        if (!this.widget) return;
        const btn  = this.widget.querySelector("#sbt-app-dropdown-btn");
        const list = this.widget.querySelector("#sbt-app-dropdown-list");
        if (list) list.classList.remove("open");
        if (btn)  btn.classList.remove("open");
    }

    switchApp(appId) {
        if (!this.appState[appId] || appId === this.currentAppId) return;

        this.currentAppId = appId;
        this.saveSettings();

        // Update the dropdown button label + highlighted option
        if (this.widget) {
            const def = this.getCurrentAppDef();
            const labelEl = this.widget.querySelector("#sbt-app-dropdown-label");
            if (labelEl) labelEl.textContent = def.name;

            this.widget.querySelectorAll(".sbt-app-option").forEach(opt => {
                opt.classList.toggle("active", opt.dataset.appId === appId);
            });
        }

        // Show cached data for this app immediately, then refresh live
        this.restoreCachedView();
        this.setFetching();
        this.fetchData(appId);
    }

    restoreCachedView() {
        if (!this.widget) return;
        const state = this.getState();

        const appIdEl = this.widget.querySelector("#sbt-appid");
        if (appIdEl) appIdEl.textContent = `APP ${this.currentAppId}`;

        if (state && state.lastVersion != null && state.dayBaseVersion != null) {
            const delta = state.lastVersion - state.dayBaseVersion;
            this.updateWidget({ status: "LIVE", version: state.lastVersion, delta, minVersion: state._lastMinVersion, changed: false, error: null });
        } else {
            this.updateWidget({ status: "NO DATA", version: null, delta: null, minVersion: null, error: null });
        }
    }

    _applyAdvancedVisibility() {
        const advSection   = this.widget.querySelector("#sbt-advanced-section");
        const graphSection = this.widget.querySelector("#sbt-graph-section");
        const advBtn       = this.widget.querySelector("#sbt-advanced-btn");
        if (advSection)   advSection.style.display  = this.advancedMode ? "grid"  : "none";
        if (graphSection) graphSection.style.display = this.advancedMode ? "block" : "none";
        if (advBtn)       advBtn.classList.toggle("active", this.advancedMode);
    }

    setFetching() {
        const dot    = this.widget?.querySelector("#sbt-dot");
        const status = this.widget?.querySelector("#sbt-status-text");
        if (dot)    dot.className = "fetching";
        if (status) { status.textContent = "POLLING…"; status.className = ""; }
    }

    refreshAdvancedFields() {
        if (!this.widget) return;
        const state = this.getState();
        if (!state) return;
        const athEl    = this.widget.querySelector("#sbt-ath");
        const minVerEl = this.widget.querySelector("#sbt-minver");
        if (athEl) {
            athEl.textContent = this.formatDelta(state.allTimeHighDelta);
        }
        if (minVerEl && state._lastMinVersion != null) {
            minVerEl.textContent = String(state._lastMinVersion);
            minVerEl.className   = "sbt-value small";
        }
    }

    updateWidget({ status, version, delta, minVersion, changed = false, error }) {
        if (!this.widget) return;
        const isLive = status === "LIVE";
        const state  = this.getState();

        if (minVersion != null && state) state._lastMinVersion = minVersion;

        const appIdEl = this.widget.querySelector("#sbt-appid");
        if (appIdEl) appIdEl.textContent = `APP ${this.currentAppId}`;

        const dot      = this.widget.querySelector("#sbt-dot");
        const statusEl = this.widget.querySelector("#sbt-status-text");
        dot.className        = isLive ? "live" : "error";
        statusEl.textContent = status;
        statusEl.className   = isLive ? "live" : "error";

        const verEl = this.widget.querySelector("#sbt-version");
        if (isLive && version !== null) {
            verEl.textContent = String(version);
            verEl.className   = "sbt-value";
            if (changed) {
                void verEl.offsetWidth;
                verEl.className = "sbt-value changed";
            }
        } else {
            verEl.textContent = "—";
            verEl.className   = "sbt-value placeholder";
        }

        const deltaEl = this.widget.querySelector("#sbt-delta");
        if (isLive && delta !== null) {
            deltaEl.textContent = this.formatDelta(delta);
            deltaEl.className   = delta > 0 ? "sbt-value delta-pos"
            : delta < 0 ? "sbt-value delta-neg"
            :             "sbt-value delta-zero";
        } else {
            deltaEl.textContent = "—";
            deltaEl.className   = "sbt-value placeholder";
        }

        const errEl = this.widget.querySelector("#sbt-error-msg");
        if (error && !isLive) {
            errEl.textContent   = error;
            errEl.style.display = "block";
        } else {
            errEl.style.display = "none";
        }

        const timeEl = this.widget.querySelector("#sbt-time");
        if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();

        if (this.advancedMode) {
            const athEl    = this.widget.querySelector("#sbt-ath");
            const minVerEl = this.widget.querySelector("#sbt-minver");

            if (athEl && state) athEl.textContent = this.formatDelta(state.allTimeHighDelta);

            if (minVerEl) {
                if (isLive && minVersion != null) {
                    minVerEl.textContent = String(minVersion);
                    minVerEl.className   = "sbt-value small";
                } else if (minVersion == null && state && state._lastMinVersion != null) {
                    minVerEl.textContent = String(state._lastMinVersion);
                    minVerEl.className   = "sbt-value small";
                } else if (minVersion == null) {
                    minVerEl.textContent = "N/A";
                    minVerEl.className   = "sbt-value small placeholder";
                }
            }

            this.renderGraph();
        }

        this._applyAdvancedVisibility();
    }

    // ─── Dragging ─────────────────────────────────────────────────────────────

    setupDragging() {
        let ox = 0, oy = 0;

        const onMove = (e) => {
            if (!this.isDragging) return;
            this.pos.x = e.clientX - ox;
            this.pos.y = e.clientY - oy;
            this.widget.style.left = `${this.pos.x}px`;
            this.widget.style.top  = `${this.pos.y}px`;
        };

        const onUp = () => {
            if (!this.isDragging) return;
            this.isDragging = false;
            this.widget.classList.remove("dragging");
            this.saveSettings();
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup",   onUp);
        };

        this.widget.addEventListener("mousedown", (e) => {
            if (e.target.classList.contains("sbt-btn")) return;
            if (e.target.closest("#sbt-app-dropdown")) return;
            this.isDragging = true;
            this.widget.classList.add("dragging");
            const rect = this.widget.getBoundingClientRect();
            ox = e.clientX - rect.left;
            oy = e.clientY - rect.top;
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup",   onUp);
        });
    }

    // ─── Polling ──────────────────────────────────────────────────────────────

    startTracking() {
        this.setFetching();
        this.fetchData(this.currentAppId);
        this.timer = setInterval(() => {
            this.setFetching();
            this.fetchData(this.currentAppId);
        }, this.updateInterval);
    }

    stopTracking() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    // ─── Persistence ──────────────────────────────────────────────────────────

    _defaultState(appId) {
        // Only the original tracked app (3488080) has a known ATH record; every other app starts at 0.
        const seededATH = appId === "3488080" ? 36 : 0;
        return {
            lastVersion:       null,
            dayBaseVersion:    null,
            dayKey:            null,
            allTimeHighDelta:  seededATH,
            dailyHistory:      [],
            _lastMinVersion:   null
        };
    }

    loadSettings() {
        // Seed default state for every known app
        for (const def of this.apps) {
            this.appState[def.id] = this._defaultState(def.id);
        }

        try {
            const saved = BdApi.Data.load("SteamBuildTracker", "settings");
            if (saved) {
                if (saved.pos)                  this.pos          = saved.pos;
                if (saved.advancedMode != null) this.advancedMode = saved.advancedMode;
                if (saved.currentAppId && this.apps.some(a => a.id === saved.currentAppId)) {
                    this.currentAppId = saved.currentAppId;
                }

                if (saved.appState) {
                    // New multi-app format
                    for (const id of Object.keys(saved.appState)) {
                        if (this.appState[id]) {
                            this.appState[id] = { ...this.appState[id], ...saved.appState[id] };
                        }
                    }
                } else if (saved.dayKey !== undefined || saved.allTimeHighDelta !== undefined) {
                    // Migrate old single-app (v6.x) settings into the original app slot
                    const legacy = this.appState["3488080"];
                    if (saved.dayKey)                      legacy.dayKey           = saved.dayKey;
                    if (saved.dayBaseVersion != null)      legacy.dayBaseVersion   = saved.dayBaseVersion;
                    if (saved.allTimeHighDelta != null)    legacy.allTimeHighDelta = saved.allTimeHighDelta;
                    if (Array.isArray(saved.dailyHistory)) legacy.dailyHistory     = saved.dailyHistory;
                }
            }
        } catch (e) { console.log("[SteamBuildTracker] Using default settings."); }

        // Ensure every app has a dayKey seeded so the first fetch establishes a baseline
        for (const id of Object.keys(this.appState)) {
            const st = this.appState[id];
            if (st.dayBaseVersion === null && !st.dayKey) {
                st.dayKey = this.todayKey();
            }
            const floor = id === "3488080" ? 36 : 0;
            if (st.allTimeHighDelta < floor) {
                st.allTimeHighDelta = floor;
            }
        }
    }

    saveSettings() {
        try {
            BdApi.Data.save("SteamBuildTracker", "settings", {
                pos:           this.pos,
                currentAppId:  this.currentAppId,
                advancedMode:  this.advancedMode,
                appState:      this.appState
            });
        } catch (e) { console.error("[SteamBuildTracker] Failed to save settings:", e); }
    }
};
