/**
 * @name SteamBuildTracker
 * @author AI Collaborator
 * @description Tracks the live build version of Steam App 3488080 via the official Steam IGCVersion API. Shows daily build delta (midnight reset). WITH SOUND
 * @version 4.0.0
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
        this.lastVersion    = null;  // last seen version (number)
        this.dayBaseVersion = null;  // version at start of today (number)
        this.dayKey         = null;  // "YYYY-MM-DD" of when dayBaseVersion was recorded
        this.pos            = { x: 40, y: 100 };
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

    // Returns "+N", "-N", or "±0"
    formatDelta(delta) {
        if (delta === 0)  return "±0";
        if (delta > 0)    return `+${delta}`;
        return String(delta);
    }

    // ─── API ──────────────────────────────────────────────────────────────────

    async fetchData() {
        try {
            const response = await BdApi.Net.fetch(this.apiUrl, {
                method: "GET",
                headers: { "Accept": "application/json" }
            });

            if (!response.ok) {
                this.updateWidget({ status: "HTTP ERR", version: null, delta: null, error: `Status ${response.status}` });
                return;
            }

            const json   = await response.json();
            const result = json?.result;

            if (result && result.success) {
                const version = result.active_version != null ? Number(result.active_version) : null;

                if (version !== null) {
                    const today = this.todayKey();

                    // New day — reset baseline to whatever version was at first poll today
                    if (this.dayKey !== today) {
                        this.dayKey         = today;
                        this.dayBaseVersion = version;
                        this.saveSettings();
                    }

                    // If baseline somehow never got saved (first ever run mid-day), set it now
                    if (this.dayBaseVersion === null) {
                        this.dayBaseVersion = version;
                        this.saveSettings();
                    }

                    const changed = this.lastVersion !== null && this.lastVersion !== version;
                    this.lastVersion = version;

                    if (changed) this.playAlert();

                    const delta = version - this.dayBaseVersion;
                    this.updateWidget({ status: "LIVE", version, delta, changed, error: null });
                } else {
                    this.updateWidget({ status: "NO DATA", version: null, delta: null, error: "active_version missing" });
                }
            } else {
                this.updateWidget({ status: "NO DATA", version: null, delta: null, error: "API returned no result" });
            }

        } catch (err) {
            console.error("[SteamBuildTracker] Fetch error:", err);
            const msg   = err?.message ?? String(err);
            const isNet = /net|connect|failed/i.test(msg);
            this.updateWidget({
                status: isNet ? "NET ERR" : "FETCH ERR",
                version: null,
                delta: null,
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
            #sbt-title  { font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: #5865f2; text-transform: uppercase; }
            #sbt-appid  { font-size: 9px; color: #3c3f45; letter-spacing: 0.5px; }
            #sbt-status-row {
                display: flex; align-items: center; gap: 6px;
                padding: 8px 14px; border-bottom: 1px solid #1a1c1f;
            }
            #sbt-dot {
                width: 7px; height: 7px; border-radius: 50%;
                background: #23a55a; flex-shrink: 0; transition: background 0.3s ease;
            }
            #sbt-dot.error    { background: #f23f43; animation: none; }
            #sbt-dot.live     { background: #23a55a; animation: sbt-pulse 2s infinite; }
            #sbt-dot.fetching { background: #f0b232; animation: sbt-blink 0.8s infinite; }
            @keyframes sbt-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
            @keyframes sbt-blink { 0%,100%{opacity:1} 50%{opacity:0.2}  }
            #sbt-status-text { font-size: 10px; letter-spacing: 1px; color: #5c6068; font-weight: 600; }
            #sbt-status-text.live  { color: #23a55a; }
            #sbt-status-text.error { color: #f23f43; }

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
            .sbt-value.placeholder { font-size: 13px; color: #2a2d33; }
            .sbt-value.delta-zero { color: #5c6068; }
            .sbt-value.delta-pos  { color: #23a55a; }
            .sbt-value.delta-neg  { color: #f23f43; }

            #sbt-error-msg {
                font-size: 10px; color: #f23f43; margin-top: 4px;
                display: none; word-break: break-all;
                grid-column: 1 / -1;
            }
            #sbt-footer {
                padding: 6px 14px 8px;
                border-top: 1px solid #1a1c1f;
                display: flex; align-items: center; justify-content: space-between;
            }
            #sbt-time-label { font-size: 9px; color: #2a2d33; letter-spacing: 0.5px; }
            #sbt-time       { font-size: 9px; color: #3c3f45; }
            #sbt-refresh-btn {
                background: none; border: 1px solid #1a1c1f; border-radius: 4px;
                color: #3c3f45; font-size: 10px; padding: 2px 7px; cursor: pointer;
                font-family: inherit; letter-spacing: 0.5px; transition: all 0.15s ease;
            }
            #sbt-refresh-btn:hover { border-color: #5865f2; color: #5865f2; background: rgba(88,101,242,0.08); }
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
            <div id="sbt-footer">
                <div>
                    <span id="sbt-time-label">UPDATED </span>
                    <span id="sbt-time">—</span>
                </div>
                <button id="sbt-refresh-btn">↻ REFRESH</button>
            </div>
        `;

        document.body.appendChild(this.widget);

        this.widget.querySelector("#sbt-refresh-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            this.setFetching();
            this.fetchData();
        });

        this.setupDragging();
    }

    setFetching() {
        const dot    = this.widget?.querySelector("#sbt-dot");
        const status = this.widget?.querySelector("#sbt-status-text");
        if (dot)    dot.className    = "fetching";
        if (status) { status.textContent = "POLLING…"; status.className = ""; }
    }

    updateWidget({ status, version, delta, changed = false, error }) {
        if (!this.widget) return;
        const isLive = status === "LIVE";

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
            if (e.target.id === "sbt-refresh-btn") return;
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
                if (saved.pos)            this.pos            = saved.pos;
                if (saved.dayKey)         this.dayKey         = saved.dayKey;
                if (saved.dayBaseVersion != null) this.dayBaseVersion = saved.dayBaseVersion;
            }
        } catch (e) { console.log("[SteamBuildTracker] Using default settings."); }
    }

    saveSettings() {
        try {
            BdApi.Data.save("SteamBuildTracker", "settings", {
                pos:            this.pos,
                dayKey:         this.dayKey,
                dayBaseVersion: this.dayBaseVersion
            });
        } catch (e) { console.error("[SteamBuildTracker] Failed to save settings:", e); }
    }
};
