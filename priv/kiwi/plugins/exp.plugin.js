/**
 * @name Deadlock Experimental Tracker
 * @author Kiwi
 * @description Tracks the live build version of Steam App 3488080 via the official Steam IGCVersion API. Shows daily build delta (midnight reset). WITH SOUND
 * @version 6.0.0
 */

module.exports = class SteamBuildTracker {
    constructor() {
        this.appId    = "3488080";
        this.apiUrl   = "https://api.steampowered.com/IGCVersion_3488080/GetClientVersion/v1";
        this.updateInterval = 30000;
        this.timer    = null;
        this.widget   = null;
        this.styleEl  = null;
        this.isDragging = false;

        // Runtime state
        this.lastVersion       = null;
        this.dayBaseVersion    = null;
        this.dayKey            = null;
        this.allTimeHighDelta  = 0;
        this.advancedMode      = false;
        this.pos               = { x: 40, y: 100 };
        this._lastMinVersion   = null;

        // Historical daily deltas: array of { date: "YYYY-MM-DD", delta: number }
        // One entry per calendar day, never reset — grows over time
        this.dailyHistory      = [];
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

    // ─── API ──────────────────────────────────────────────────────────────────

    async fetchData() {
        try {
            const response = await BdApi.Net.fetch(this.apiUrl, {
                method: "GET",
                headers: { "Accept": "application/json" }
            });

            if (!response.ok) {
                this.updateWidget({ status: "HTTP ERR", version: null, delta: null, minVersion: null, error: `Status ${response.status}` });
                return;
            }

            const json   = await response.json();
            const result = json?.result;

            if (result && result.success) {
                const version    = result.active_version       != null ? Number(result.active_version)       : null;
                const minVersion = result.min_allowed_version  != null ? Number(result.min_allowed_version)  : null;

                if (version !== null) {
                    const today = this.todayKey();

                    // New day — reset baseline
                    if (this.dayKey !== today) {
                        // Save yesterday's final delta into history before resetting
                        if (this.dayKey && this.dayBaseVersion !== null && this.lastVersion !== null) {
                            this._upsertDailyHistory(this.dayKey, this.lastVersion - this.dayBaseVersion);
                        }
                        this.dayKey         = today;
                        this.dayBaseVersion = version;
                        this.saveSettings();
                    }

                    if (this.dayBaseVersion === null) {
                        this.dayBaseVersion = version;
                        this.saveSettings();
                    }

                    const changed = this.lastVersion !== null && this.lastVersion !== version;
                    this.lastVersion = version;

                    if (changed) this.playAlert();

                    const delta = version - this.dayBaseVersion;

                    // Always upsert today's current delta into history
                    this._upsertDailyHistory(today, delta);

                    if (delta > this.allTimeHighDelta) {
                        this.allTimeHighDelta = delta;
                    }

                    this.saveSettings();
                    this.updateWidget({ status: "LIVE", version, delta, minVersion, changed, error: null });
                } else {
                    this.updateWidget({ status: "NO DATA", version: null, delta: null, minVersion: null, error: "active_version missing" });
                }
            } else {
                this.updateWidget({ status: "NO DATA", version: null, delta: null, minVersion: null, error: "API returned no result" });
            }

        } catch (err) {
            console.error("[SteamBuildTracker] Fetch error:", err);
            const msg   = err?.message ?? String(err);
            const isNet = /net|connect|failed/i.test(msg);
            this.updateWidget({
                status: isNet ? "NET ERR" : "FETCH ERR",
                version: null, delta: null, minVersion: null,
                error: msg.slice(0, 60)
            });
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

    // Insert or update the delta for a given date key
    _upsertDailyHistory(dateKey, delta) {
        const existing = this.dailyHistory.find(e => e.date === dateKey);
        if (existing) {
            existing.delta = delta;
        } else {
            this.dailyHistory.push({ date: dateKey, delta });
            // Keep sorted by date
            this.dailyHistory.sort((a, b) => a.date.localeCompare(b.date));
        }
    }

    renderGraph() {
        const canvas = this.widget && this.widget.querySelector("#sbt-graph");
        if (!canvas) return;

        const W = canvas.width  = canvas.offsetWidth  || 232;
        const H = canvas.height = canvas.offsetHeight || 90;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = "#080909";
        ctx.fillRect(0, 0, W, H);

        const history = this.dailyHistory;

        if (history.length === 0) {
            ctx.fillStyle = "#2a2d33";
            ctx.font = "9px Consolas, monospace";
            ctx.textAlign = "center";
            ctx.fillText("NO HISTORY YET", W / 2, H / 2);
            return;
        }

        // Show as many days as fit at min 14px bar width
        const maxBars = Math.floor(W / 14);
        const points  = history.slice(-maxBars);
        const n       = points.length;

        const padT  = 18; // room for delta label above bar
        const padB  = 14; // room for date label below
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

            const isATH = delta === this.allTimeHighDelta;

            if (delta === 0) {
                ctx.fillStyle = isATH ? "#f0b232" : "#1e2030"; // Neutral ATH is yellow, standard zero is dark grey
            } else {
                ctx.fillStyle = isATH ? "#038028" : "#ffffff"; // Positive ATH is live green, standard activity is white
            }

            ctx.fillRect(x, y, barW, bH);

            // Delta number above bar
            const label = delta === 0 ? "0" : (delta > 0 ? "+" + delta : String(delta));
            ctx.font      = "7px Consolas, monospace";
            ctx.textAlign = "center";

            if (delta === 0) {
                ctx.fillStyle = isATH ? "#f0b232" : "#2a2d33";
            } else {
                ctx.fillStyle = isATH ? "#038028" : "#9ba3b8";
            }

            ctx.fillText(label, x + barW / 2, Math.max(y - 2, padT - 2));

            // Date label below — day number, show M/D on 1st or first bar
            const [, mm, dd] = date.split("-");
            const dayNum   = parseInt(dd, 10);
            const dateLabel = (dayNum === 1 || i === 0) ? `${parseInt(mm)}/${dayNum}` : String(dayNum);
            ctx.fillStyle = "#3c3f45";
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
        padding: 10px 14px 8px;
        border-bottom: 1px solid #1a1c1f;
        background: #111214;
        }
        #sbt-title  { font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: #7114e3; text-transform: uppercase; }
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

        this.widget.innerHTML = `
        <div id="sbt-header">
        <span id="sbt-title">Experimental Tracker</span>
        <span id="sbt-appid">APP ${this.appId}</span>
        </div>
        <div id="sbt-status-row">
        <div id="sbt-dot" class="fetching"></div>
        <span id="sbt-status-text">POLLING…</span>
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
            this.fetchData();
        });

        this.widget.querySelector("#sbt-advanced-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            this.advancedMode = !this.advancedMode;
            this._applyAdvancedVisibility();
            this.saveSettings();
            this.refreshAdvancedFields();
            if (this.advancedMode) this.renderGraph();
        });

            this.setupDragging();
    }

    _applyAdvancedVisibility() {
        const advSection   = this.widget.querySelector("#sbt-advanced-section");
        const graphSection = this.widget.querySelector("#sbt-graph-section");
        const advBtn       = this.widget.querySelector("#sbt-advanced-btn");
        if (advSection)   advSection.style.display   = this.advancedMode ? "grid" : "none";
        if (graphSection) graphSection.style.display  = this.advancedMode ? "block" : "none";
        if (advBtn)       advBtn.classList.toggle("active", this.advancedMode);
    }

    setFetching() {
        const dot    = this.widget?.querySelector("#sbt-dot");
        const status = this.widget?.querySelector("#sbt-status-text");
        if (dot)    dot.className    = "fetching";
        if (status) { status.textContent = "POLLING…"; status.className = ""; }
    }

    refreshAdvancedFields() {
        if (!this.widget) return;
        const athEl    = this.widget.querySelector("#sbt-ath");
        const minVerEl = this.widget.querySelector("#sbt-minver");
        if (athEl) {
            athEl.textContent = this.allTimeHighDelta > 0
            ? this.formatDelta(this.allTimeHighDelta)
            : "±0";
        }
        if (minVerEl && this._lastMinVersion != null) {
            minVerEl.textContent = String(this._lastMinVersion);
            minVerEl.className   = "sbt-value small";
        }
    }

    updateWidget({ status, version, delta, minVersion, changed = false, error }) {
        if (!this.widget) return;
        const isLive = status === "LIVE";

        if (minVersion != null) this._lastMinVersion = minVersion;

        // Status dot + label
        const dot      = this.widget.querySelector("#sbt-dot");
        const statusEl = this.widget.querySelector("#sbt-status-text");
        dot.className        = isLive ? "live" : "error";
        statusEl.textContent = status;
        statusEl.className   = isLive ? "live" : "error";

        // Version
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

        // Daily delta
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

        // Error
        const errEl = this.widget.querySelector("#sbt-error-msg");
        if (error && !isLive) {
            errEl.textContent   = error;
            errEl.style.display = "block";
        } else {
            errEl.style.display = "none";
        }

        // Timestamp
        const timeEl = this.widget.querySelector("#sbt-time");
        if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();

        // Advanced panel
        if (this.advancedMode) {
            const athEl    = this.widget.querySelector("#sbt-ath");
            const minVerEl = this.widget.querySelector("#sbt-minver");

            if (athEl) {
                athEl.textContent = this.allTimeHighDelta > 0
                ? this.formatDelta(this.allTimeHighDelta)
                : "±0";
            }
            if (minVerEl) {
                if (isLive && minVersion != null) {
                    minVerEl.textContent = String(minVersion);
                    minVerEl.className   = "sbt-value small";
                } else if (minVersion == null) {
                    minVerEl.textContent = "N/A";
                    minVerEl.className   = "sbt-value small placeholder";
                }
            }

            // Redraw graph on every update when advanced is open
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
        this.fetchData();
        this.timer = setInterval(() => {
            this.setFetching();
            this.fetchData();
        }, this.updateInterval);
    }

    stopTracking() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    // ─── Persistence ──────────────────────────────────────────────────────────

    loadSettings() {
        try {
            const saved = BdApi.Data.load("SteamBuildTracker", "settings");
            if (saved) {
                if (saved.pos)                          this.pos              = saved.pos;
                if (saved.dayKey)                       this.dayKey           = saved.dayKey;
                if (saved.dayBaseVersion != null)       this.dayBaseVersion   = saved.dayBaseVersion;
                if (saved.allTimeHighDelta != null)     this.allTimeHighDelta = saved.allTimeHighDelta;
                if (saved.advancedMode != null)         this.advancedMode     = saved.advancedMode;
                if (Array.isArray(saved.dailyHistory))  this.dailyHistory     = saved.dailyHistory;
            }
        } catch (e) { console.log("[SteamBuildTracker] Using default settings."); }

        // Seed historical data from known records if history is empty

    }

    saveSettings() {
        try {
            BdApi.Data.save("SteamBuildTracker", "settings", {
                pos:              this.pos,
                dayKey:           this.dayKey,
                dayBaseVersion:   this.dayBaseVersion,
                allTimeHighDelta: this.allTimeHighDelta,
                advancedMode:     this.advancedMode,
                dailyHistory:     this.dailyHistory
            });
        } catch (e) { console.error("[SteamBuildTracker] Failed to save settings:", e); }
    }
};
