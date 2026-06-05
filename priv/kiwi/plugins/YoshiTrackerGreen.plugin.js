/**
 * @name YoshiTracker
 * @version 5.1.0
 * @description Tracks messages, typing, presence, and voice for a specific user. Persistent resizable widget.
 * @author You
 */

// ============================================
// CONFIGURATION — Edit these to match your needs
// ============================================
const TARGET_USER_ID  = "1229609738828906517";
const TARGET_GUILD_ID = "1231286446472691825";
const DISPLAY_NAME    = "Yoshi";

// Channels Yoshi primarily uses — used for the guild presence subscription
const TARGET_CHANNEL_IDS = [
    "1231311070786752579",  // announcements
    "1231286447131328544",  // deadlock-chat
];

const MESSAGE_SOUND_URL = "https://actions.google.com/sounds/v1/alarms/beep_short.ogg";
const TYPING_SOUND_URL  = "https://actions.google.com/sounds/v1/cartoon/slide_whistle.ogg";
const VOICE_SOUND_URL   = "https://actions.google.com/sounds/v1/cartoon/clang_and_wobble.ogg";
// Presence changes have NO sound — notification only.
// ============================================

const DEFAULT_SETTINGS = {
    enableTypingAlert:   true,
    enableMessageAlert:  true,
    enablePresenceAlert: true,
    enableVoiceAlert:    true,
    enableSound:         true,
    typingCooldown:      2,
    messageCooldown:     6,
    showDebugPanel:      false,
    showWidget:          true,
    widgetCollapsed:     false,
    widgetX:             20,
    widgetY:             20,
    widgetWidth:         260,
    widgetHeight:        130,
};

// ─── Status meta ──────────────────────────────────────────────────────────────
const STATUS_META = {
    online:    { emoji: "🟢", label: "Online",          color: "#23a55a", toastBg: "#0d2219" },
    idle:      { emoji: "🌙", label: "Idle",            color: "#f0b232", toastBg: "#2a2008" },
    dnd:       { emoji: "⛔", label: "Do Not Disturb",  color: "#f23f43", toastBg: "#2a0808" },
    offline:   { emoji: "⚫", label: "Offline",         color: "#80848e", toastBg: "#141414" },
    invisible: { emoji: "⚫", label: "Offline",         color: "#80848e", toastBg: "#141414" },
};
const statusMeta = (s) =>
    STATUS_META[s] ?? { emoji: "❓", label: s ?? "Unknown", color: "#aaa", toastBg: "#1a1a1a" };
// ─────────────────────────────────────────────────────────────────────────────

module.exports = class YoshiTracker {
    constructor() {
        this.settings         = { ...DEFAULT_SETTINGS };
        this.lastTypingAlert  = 0;
        this.lastMessageAlert = 0;
        this.lastStatus       = null;
        this.isTyping         = false;
        this.typingTimeout    = null;
        this.debugPanel       = null;
        this.widget           = null;
        this.notifContainer   = null;
        this.debugLogs        = [];
        this.eventCount       = { typing: 0, message: 0, targetTyping: 0, targetMessage: 0, presence: 0, voice: 0 };
        this.channelGuildMap  = {};

        // Jump targets — updated live as events arrive
        this.lastTypingChannelId  = null;
        this.lastMessageChannelId = null;
        this.lastMessageId        = null;
        this.voiceChannelId       = null;
        this.voiceChannelName     = null;

        // Bound event handler refs — stored so unsubscribe works correctly
        this._onTyping    = this._handleTyping.bind(this);
        this._onMessage   = this._handleMessage.bind(this);
        this._onPresence  = this._handlePresence.bind(this);
        this._onPresence1 = this._handlePresenceSingular.bind(this);
        this._onVoice     = this._handleVoice.bind(this);

        // Timer IDs
        this._presencePollId = null;

        // Drag/resize cleanup refs
        this._docMouseMove = null;
        this._docMouseUp   = null;

        // Cached module references — resolved once at startup
        this._flux             = null;
        this._presenceStore    = null;
        this._channelStore     = null;
        this._voiceStore       = null;
        this._router           = null;
        this._guildSubscribe   = null; // Discord's internal guild subscription API
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    start() {
        const saved = BdApi.Data.load("YoshiTracker", "settings");
        if (saved) this.settings = { ...DEFAULT_SETTINGS, ...saved };

        this._log("🚀 Plugin starting...", "green");
        this._log(`👤 Tracking: ${DISPLAY_NAME} (${TARGET_USER_ID})`, "blue");
        this._log(`🏠 Server:   ${TARGET_GUILD_ID}`, "blue");

        // Cache all module refs first — everything else depends on these
        this._cacheStores();

        // Seed initial state using cached refs
        this._seedChannelMap();
        this._seedLastStatus();
        this._seedVoiceState();

        // Subscribe to Flux events
        this._flux = this._findFluxDispatcher();
        if (this._flux) {
            this._flux.subscribe("TYPING_START",              this._onTyping);
            this._flux.subscribe("MESSAGE_CREATE",            this._onMessage);
            this._flux.subscribe("PRESENCE_UPDATES",          this._onPresence);
            this._flux.subscribe("PRESENCE_UPDATE",           this._onPresence1);
            this._flux.subscribe("VOICE_STATE_UPDATE",        this._onVoice);
            this._log("✅ Subscribed to Flux events", "green");
        } else {
            this._log("❌ FluxDispatcher not found — real-time events disabled", "red");
            this._log("💡 Only the 60s poller will run. Check the debug panel for strategy failures.", "orange");
        }

        // Subscribe to guild presence using Discord's internal API (safe — no raw WebSocket)
        this._subscribeGuildPresence();

        // Poller is a last-resort safety net only — no alerts, widget display only
        this._startPresencePoller();

        // Build UI
        this._createNotifContainer();
        if (this.settings.showWidget)     this._createWidget();
        if (this.settings.showDebugPanel) this._createDebugPanel();

        BdApi.UI.showToast(`YoshiTracker v5 — tracking ${DISPLAY_NAME}`, { type: "success", timeout: 3000 });
    }

    stop() {
        this._log("🛑 Stopping...", "red");

        if (this._flux) {
            this._flux.unsubscribe("TYPING_START",       this._onTyping);
            this._flux.unsubscribe("MESSAGE_CREATE",     this._onMessage);
            this._flux.unsubscribe("PRESENCE_UPDATES",   this._onPresence);
            this._flux.unsubscribe("PRESENCE_UPDATE",    this._onPresence1);
            this._flux.unsubscribe("VOICE_STATE_UPDATE", this._onVoice);
        }

        BdApi.Patcher.unpatchAll("YoshiTracker");
        clearTimeout(this.typingTimeout);
        clearInterval(this._presencePollId);

        if (this._docMouseMove) document.removeEventListener("mousemove", this._docMouseMove);
        if (this._docMouseUp)   document.removeEventListener("mouseup",   this._docMouseUp);

        this.debugPanel?.remove();
        this.widget?.remove();
        this.notifContainer?.remove();
        document.getElementById("yt-keyframes")?.remove();

        BdApi.UI.showToast("YoshiTracker stopped.", { type: "info" });
    }

    // ─── Module / store resolution ────────────────────────────────────────────

    /**
     * Resolve and cache all Discord module references once at startup.
     * Uses BdApi.Webpack.getStore() (BD 2.x preferred API) with
     * getByKeys() as fallback for each store.
     */
    _cacheStores() {
        // PresenceStore
        try {
            this._presenceStore =
                BdApi.Webpack.getStore?.("PresenceStore") ??
                BdApi.Webpack.getByKeys?.("getStatus", "getActivities", "getState") ??
                BdApi.Webpack.getModule(m => typeof m.getStatus === "function" && typeof m.getActivities === "function");
            this._log(this._presenceStore ? "✅ PresenceStore" : "⚠️ PresenceStore not found", this._presenceStore ? "green" : "orange");
        } catch (e) { this._log("⚠️ PresenceStore: " + e.message, "orange"); }

        // ChannelStore
        try {
            this._channelStore =
                BdApi.Webpack.getStore?.("ChannelStore") ??
                BdApi.Webpack.getByKeys?.("getChannel", "hasChannel", "getDMFromUserId") ??
                BdApi.Webpack.getModule(m => typeof m.getChannel === "function" && typeof m.hasChannel === "function");
            this._log(this._channelStore ? "✅ ChannelStore" : "⚠️ ChannelStore not found", this._channelStore ? "green" : "orange");
        } catch (e) { this._log("⚠️ ChannelStore: " + e.message, "orange"); }

        // VoiceStateStore
        try {
            this._voiceStore =
                BdApi.Webpack.getStore?.("VoiceStateStore") ??
                BdApi.Webpack.getByKeys?.("getVoiceStateForUser", "getVoiceStatesForChannel") ??
                BdApi.Webpack.getModule(m => typeof m.getVoiceStateForUser === "function");
            this._log(this._voiceStore ? "✅ VoiceStateStore" : "⚠️ VoiceStateStore not found", this._voiceStore ? "green" : "orange");
        } catch (e) { this._log("⚠️ VoiceStateStore: " + e.message, "orange"); }

        // Router (for jump buttons)
        try {
            this._router =
                BdApi.Webpack.getByKeys?.("transitionTo", "replaceWith", "back") ??
                BdApi.Webpack.getModule(m => typeof m.transitionTo === "function" && typeof m.back === "function");
            this._log(this._router ? "✅ Router" : "⚠️ Router not found (jump buttons won't work)", this._router ? "green" : "orange");
        } catch (e) { this._log("⚠️ Router: " + e.message, "orange"); }

        // Guild subscription API (safe internal Discord API — no raw WebSocket)
        try {
            this._guildSubscribe =
                BdApi.Webpack.getByKeys?.("subscribeToGuild", "unsubscribeFromGuild") ??
                BdApi.Webpack.getModule(m =>
                    typeof m.subscribeToGuild   === "function" &&
                    typeof m.unsubscribeFromGuild === "function"
                );
            this._log(this._guildSubscribe
                ? "✅ GuildSubscriptions API"
                : "⚠️ GuildSubscriptions not found — presence may lag", this._guildSubscribe ? "green" : "orange");
        } catch (e) { this._log("⚠️ GuildSubscriptions: " + e.message, "orange"); }
    }

    /**
     * Try multiple known shapes for the gateway WebSocket send function.
     * Discord periodically restructures this module, so we walk several patterns.
     */
    _resolveGatewaySend() {
        const strategies = [
            // Modern BD 2.x — GatewayConnectionStore or similar
            () => {
                const m = BdApi.Webpack.getStore?.("GatewayConnectionStore");
                const socket = m?.getSocket?.() ?? m?._socket;
                return socket?.send?.bind(socket) ?? null;
            },
            // Socket nested on a module
            () => {
                const m = BdApi.Webpack.getModule(m => m.socket?.readyState === 1 && typeof m.socket.send === "function");
                return m ? m.socket.send.bind(m.socket) : null;
            },
            // Direct send + close + _events shape
            () => {
                const m = BdApi.Webpack.getModule(m =>
                    typeof m.send === "function" &&
                    typeof m.close === "function" &&
                    m._events != null &&
                    m.readyState === 1
                );
                return m ? m.send.bind(m) : null;
            },
            // socketSend method on a gateway manager
            () => {
                const m = BdApi.Webpack.getByKeys?.("socketSend", "connect", "disconnect");
                return m ? (data) => m.socketSend(data) : null;
            },
            // _send on a connection object
            () => {
                const m = BdApi.Webpack.getModule(m => typeof m._send === "function" && typeof m.connect === "function");
                return m ? (data) => m._send(data) : null;
            },
        ];

        for (let i = 0; i < strategies.length; i++) {
            try {
                const fn = strategies[i]();
                if (fn) { this._log(`✅ Gateway send found (strategy ${i + 1})`, "green"); return fn; }
            } catch (_) {}
        }
        return null;
    }

    /**
     * Find FluxDispatcher using BD 2.x preferred APIs first, then fallbacks.
     */
    _findFluxDispatcher() {
        const candidates = [
            // BD 2.x — getByKeys is the preferred modern approach
            () => BdApi.Webpack.getByKeys?.("dispatch", "subscribe", "register", "waitFor"),
            () => BdApi.Webpack.getByKeys?.("dispatch", "subscribe", "register"),
            // Filter-based fallbacks for older/patched BD versions
            () => BdApi.Webpack.getModule(m => m.dispatch && m.subscribe && m.waitFor),
            () => BdApi.Webpack.getModule(m => m.dispatch && m.subscribe && m.register),
            () => BdApi.Webpack.getModule(m =>
                typeof m.dispatch  === "function" &&
                typeof m.subscribe === "function" &&
                !m.findDOMNode
            ),
            // Dispatcher nested inside a wrapper module
            () => {
                const m = BdApi.Webpack.getModule(m => m._dispatcher?.dispatch && m._dispatcher?.subscribe);
                return m?._dispatcher ?? null;
            },
        ];

        for (let i = 0; i < candidates.length; i++) {
            try {
                const result = candidates[i]();
                if (result?.dispatch && result?.subscribe) {
                    this._log(`✅ FluxDispatcher (strategy ${i + 1})`, "green");
                    return result;
                }
            } catch (e) {
                this._log(`⚠️ Flux strategy ${i + 1}: ${e.message}`, "orange");
            }
        }

        this._log("❌ All FluxDispatcher strategies failed", "red");
        return null;
    }

    // ─── Channel / Guild helpers ──────────────────────────────────────────────

    _seedChannelMap() {
        try {
            const GuildChannelStore =
                BdApi.Webpack.getStore?.("GuildChannelStore") ??
                BdApi.Webpack.getByKeys?.("getChannels", "getDefaultChannel") ??
                BdApi.Webpack.getModule(m => typeof m.getChannels === "function" && typeof m.getDefaultChannel === "function");

            const channels = GuildChannelStore?.getChannels(TARGET_GUILD_ID);
            if (!channels) return;

            let n = 0;
            for (const group of Object.values(channels)) {
                if (!Array.isArray(group)) continue;
                for (const entry of group) {
                    const ch = entry.channel ?? entry;
                    if (ch?.id) { this.channelGuildMap[ch.id] = TARGET_GUILD_ID; n++; }
                }
            }
            this._log(`📋 Seeded ${n} channels from guild`, "blue");
        } catch (e) {
            this._log("⚠️ Channel seed failed: " + e.message, "orange");
        }
    }

    _resolveGuildId(channelId) {
        if (!channelId) return null;
        if (this.channelGuildMap[channelId]) return this.channelGuildMap[channelId];
        try {
            const ch = this._channelStore?.getChannel(channelId);
            if (ch?.guild_id) {
                this.channelGuildMap[channelId] = ch.guild_id;
                return ch.guild_id;
            }
        } catch (_) {}
        return null;
    }

    _getChannelName(channelId) {
        if (!channelId) return "unknown";
        try {
            return this._channelStore?.getChannel(channelId)?.name ?? channelId;
        } catch (_) { return channelId; }
    }

    // ─── Navigation ───────────────────────────────────────────────────────────

    _jumpTo(channelId, messageId = null) {
        if (!channelId) return;
        try {
            const path = messageId
                ? `/channels/${TARGET_GUILD_ID}/${channelId}/${messageId}`
                : `/channels/${TARGET_GUILD_ID}/${channelId}`;

            if (this._router?.transitionTo) {
                this._router.transitionTo(path);
                return;
            }
            // Re-attempt router lookup in case it loaded late
            const router = BdApi.Webpack.getByKeys?.("transitionTo", "back");
            if (router?.transitionTo) {
                this._router = router;
                router.transitionTo(path);
                return;
            }
            // Last resort: discord:// deep link
            window.open(`discord:/${path}`);
        } catch (e) {
            this._log("❌ Jump failed: " + e.message, "red");
        }
    }

    // ─── State seeding ────────────────────────────────────────────────────────

    _seedLastStatus() {
        try {
            if (!this._presenceStore) return;
            this.lastStatus = this._presenceStore.getStatus(TARGET_USER_ID) ?? "offline";
            this._log(`📡 Initial status: ${this.lastStatus}`, "blue");
        } catch (e) { this._log("⚠️ Status seed failed: " + e.message, "orange"); }
    }

    _seedVoiceState() {
        try {
            if (!this._voiceStore) return;
            const state = this._voiceStore.getVoiceStateForUser?.(TARGET_USER_ID);
            if (state?.channelId) {
                this.voiceChannelId   = state.channelId;
                this.voiceChannelName = this._getChannelName(state.channelId);
                this._log(`🎙️ Initial voice: #${this.voiceChannelName}`, "blue");
            }
        } catch (e) { this._log("⚠️ Voice seed failed: " + e.message, "orange"); }
    }

    // ─── Guild presence subscription ─────────────────────────────────────────

    /**
     * Subscribe to presence events for the target guild using Discord's own
     * internal GuildSubscriptions API. This is safe — it goes through Discord's
     * normal code path rather than writing raw bytes to the WebSocket directly,
     * which was causing random reconnects/reloads.
     *
     * If the internal API isn't available we fall back to relying solely on
     * Flux events (which fire when the server is in view) + the 60s poller.
     */
    _subscribeGuildPresence() {
        if (!this._guildSubscribe) {
            this._log("⚠️ GuildSubscriptions unavailable — relying on Flux events + poller", "orange");
            return;
        }
        try {
            this._guildSubscribe.subscribeToGuild(TARGET_GUILD_ID, {
                typing:     true,
                activities: true,
                threads:    false,
            });
            this._log("✅ Subscribed to guild presence (internal API)", "green");
        } catch (e) {
            this._log("⚠️ Guild presence sub failed: " + e.message, "orange");
        }
    }

    // ─── Presence poller (safety net only) ───────────────────────────────────

    /**
     * Reads PresenceStore every 60s as a last resort.
     * Only updates the widget display — never fires alerts,
     * because PresenceStore can hold stale data when the guild isn't subscribed.
     */
    _startPresencePoller() {
        clearInterval(this._presencePollId);
        this._presencePollId = setInterval(() => {
            try {
                if (!this._presenceStore) return;
                const current = this._presenceStore.getStatus(TARGET_USER_ID);
                if (!current || current === this.lastStatus) return;
                this._log(`🔄 Poller: ${this.lastStatus} → ${current} (widget only)`, "orange");
                this._applyStatusChange(current, true);
            } catch (e) {
                this._log("⚠️ Poller error: " + e.message, "orange");
            }
        }, 60000);
        this._log("⏱️ Presence poller started (60s safety net, widget-only)", "blue");
    }

    // ─── Event handlers ───────────────────────────────────────────────────────

    _handlePresence(event) {
        // PRESENCE_UPDATES — batched internal event (array of updates)
        for (const update of (event.updates ?? [])) {
            if (update.user?.id !== TARGET_USER_ID) continue;
            this._applyStatusChange(update.status, false);
        }
    }

    _handlePresenceSingular(event) {
        // PRESENCE_UPDATE — raw gateway event (single object)
        if (event.user?.id !== TARGET_USER_ID) return;
        const status = event.status ?? event.presence?.status;
        if (status) this._applyStatusChange(status, false);
    }

    /**
     * Central status change handler.
     * @param {string}  newStatus   The incoming status string
     * @param {boolean} fromPoller  When true: widget update only, no alert.
     *                              PresenceStore can be stale so poller never alerts.
     */
    _applyStatusChange(newStatus, fromPoller = false) {
        // Guard: don't count or act if nothing changed
        if (newStatus === this.lastStatus) return;

        this.eventCount.presence++;
        const prev = this.lastStatus;
        this.lastStatus = newStatus;
        this._updateWidget();
        this._log(`📡 Presence${fromPoller ? " [poll]" : " [event]"}: ${prev} → ${newStatus}`, "cyan");

        if (fromPoller) return; // widget updated silently — done
        if (!this.settings.enablePresenceAlert) return;
        this._showPresenceNotif(statusMeta(newStatus), prev);
    }

    _handleVoice(event) {
        // VOICE_STATE_UPDATE can arrive in two shapes depending on Discord version:
        // flat:   { userId, channelId, guildId, ... }
        // nested: { voiceState: { userId, channelId, guildId } }
        const vs = event.voiceState ?? event;
        const userId    = vs.userId    ?? vs.user?.id;
        const channelId = vs.channelId ?? null;
        const guildId   = vs.guildId   ?? this._resolveGuildId(channelId);

        if (userId !== TARGET_USER_ID) return;
        if (guildId && guildId !== TARGET_GUILD_ID) return;

        this.eventCount.voice++;
        const newChannelId = channelId; // null = left voice entirely
        const oldChannelId = this.voiceChannelId;

        if (newChannelId === oldChannelId) return;

        this.voiceChannelId   = newChannelId;
        this.voiceChannelName = newChannelId ? this._getChannelName(newChannelId) : null;
        this._updateWidget();

        if (!this.settings.enableVoiceAlert) return;

        if (!newChannelId) {
            this._log(`🔇 ${DISPLAY_NAME} left voice`, "cyan");
            this._showCustomNotif(`🔇 ${DISPLAY_NAME} left voice`, "#1a1414", "#f23f43", 4000);
        } else if (!oldChannelId) {
            this._log(`🎙️ ${DISPLAY_NAME} joined #${this.voiceChannelName}`, "cyan");
            this._showCustomNotif(
                `🎙️ ${DISPLAY_NAME} joined voice\n#${this.voiceChannelName}`,
                "#0d2219", "#23a55a", 4500
            );
            this._playSound(VOICE_SOUND_URL, 0.35);
        } else {
            const oldName = this._getChannelName(oldChannelId);
            this._log(`🔀 ${DISPLAY_NAME} moved: #${oldName} → #${this.voiceChannelName}`, "cyan");
            this._showCustomNotif(
                `🔀 ${DISPLAY_NAME} moved voice\n#${oldName} → #${this.voiceChannelName}`,
                "#0d1a3a", "#5865f2", 4500
            );
        }
    }

    _handleTyping(event) {
        this.eventCount.typing++;
        if (event.channelId && event.guildId) {
            this.channelGuildMap[event.channelId] = event.guildId;
        }
        const guildId = event.guildId || this._resolveGuildId(event.channelId);

        if (event.userId === TARGET_USER_ID) {
            this.lastTypingChannelId = event.channelId;
            this.isTyping = true;
            clearTimeout(this.typingTimeout);
            // Discord's typing indicator window is ~10s; clear automatically
            this.typingTimeout = setTimeout(() => {
                this.isTyping = false;
                this._updateWidget();
            }, 10000);
            this._updateWidget();
        }

        this._log(`⌨️ Typing — user: ${event.userId} | guild: ${guildId ?? "?"}`, "yellow");

        if (!this.settings.enableTypingAlert)        return;
        if (event.userId !== TARGET_USER_ID)         return;
        if (guildId      !== TARGET_GUILD_ID)        { this._log("↩️ Wrong guild", "gray"); return; }

        this.eventCount.targetTyping++;
        this._log("🎯 TARGET IS TYPING!", "magenta");

        const now = Date.now() / 1000;
        if (now - this.lastTypingAlert < this.settings.typingCooldown) {
            this._log("⏳ Cooldown", "orange"); return;
        }
        this.lastTypingAlert = now;

        const channelName = this._getChannelName(event.channelId);
        this._showCustomNotif(`✏️ ${DISPLAY_NAME} is typing in #${channelName}...`, "#0d1a3a", "#5865f2");
        this._playSound(TYPING_SOUND_URL, 0.4);
        this._log(`📢 Typing in #${channelName}`, "lime");
    }

    _handleMessage(event) {
        const msg = event.message ?? event;
        this.eventCount.message++;
        if (!msg?.author) return;

        if (msg.channel_id && msg.guild_id) {
            this.channelGuildMap[msg.channel_id] = msg.guild_id;
        }

        // Message sent = typing definitely stopped
        if (msg.author.id === TARGET_USER_ID) {
            this.lastMessageChannelId = msg.channel_id;
            this.lastMessageId        = msg.id;
            this.isTyping = false;
            clearTimeout(this.typingTimeout);
            this._updateWidget();
        }

        const guildId = msg.guild_id || this._resolveGuildId(msg.channel_id);
        this._log(`💬 Message — user: ${msg.author.id} | guild: ${guildId ?? "?"}`, "cyan");

        if (!this.settings.enableMessageAlert)       return;
        if (msg.author.id !== TARGET_USER_ID)        return;
        if (guildId       !== TARGET_GUILD_ID)       { this._log("↩️ Wrong guild", "gray"); return; }

        this.eventCount.targetMessage++;
        this._log("🎯 TARGET SENT MESSAGE!", "magenta");

        const now = Date.now() / 1000;
        if (now - this.lastMessageAlert < this.settings.messageCooldown) {
            this._log("⏳ Cooldown", "orange"); return;
        }
        this.lastMessageAlert = now;

        const channelName = this._getChannelName(msg.channel_id);
        const preview = msg.content
            ? `"${msg.content.slice(0, 80)}${msg.content.length > 80 ? "…" : ""}"`
            : "(attachment / embed)";

        this._showCustomNotif(`💬 ${DISPLAY_NAME} → #${channelName}\n${preview}`, "#0d2219", "#23a55a");
        this._playSound(MESSAGE_SOUND_URL, 0.5);
        this._log(`📢 Message in #${channelName}`, "lime");
    }

    // ─── Custom slide-in notification ─────────────────────────────────────────

    _createNotifContainer() {
        this.notifContainer?.remove();
        const el = document.createElement("div");
        el.id = "yt-notif-container";
        el.style.cssText = `
            position:fixed; top:16px; left:16px;
            z-index:100001;
            display:flex; flex-direction:column; gap:8px;
            pointer-events:none; max-width:340px;
        `;
        document.body.appendChild(el);
        this.notifContainer = el;
    }

    _showCustomNotif(text, bgColor = "#141414", borderColor = "#5865f2", duration = 4500) {
        if (!this.notifContainer) this._createNotifContainer();

        const notif = document.createElement("div");
        notif.style.cssText = `
            background:${bgColor};
            border:1.5px solid ${borderColor};
            border-radius:8px; padding:10px 14px;
            color:#fff;
            font-family:'Whitney','Helvetica Neue',Arial,sans-serif;
            font-size:13px; line-height:1.5;
            white-space:pre-wrap; word-break:break-word;
            pointer-events:auto;
            box-shadow:0 4px 20px rgba(0,0,0,0.6);
            transform:translateX(-110%); opacity:0;
            transition:transform 0.28s cubic-bezier(0.34,1.4,0.64,1), opacity 0.2s ease;
            cursor:pointer;
        `;
        notif.title = "Click to dismiss";
        notif.textContent = text;
        notif.onclick = () => this._dismissNotif(notif);
        this.notifContainer.appendChild(notif);

        requestAnimationFrame(() => requestAnimationFrame(() => {
            notif.style.transform = "translateX(0)";
            notif.style.opacity   = "1";
        }));
        notif._dismissTimer = setTimeout(() => this._dismissNotif(notif), duration);
    }

    _dismissNotif(notif) {
        clearTimeout(notif._dismissTimer);
        notif.style.transform = "translateX(-110%)";
        notif.style.opacity   = "0";
        setTimeout(() => notif.remove(), 300);
    }

    _showPresenceNotif(meta, prevStatus) {
        const prev = statusMeta(prevStatus);
        this._showCustomNotif(
            `${meta.emoji} ${DISPLAY_NAME} is now ${meta.label}\n(was ${prev.label})`,
            meta.toastBg, meta.color, 5500
        );
    }

    // ─── Persistent status widget ─────────────────────────────────────────────

    /** Derive font size from widget dimensions so content always fits. */
    _calcFontSize(w, h) {
        // Header is ~28px. Divide remaining height across ~3 rows to fill the widget.
        const available = Math.max(40, h - 28);
        const rowFs = Math.floor(available / 3.5);
        const widthFs = Math.floor(w / 9);
        return Math.max(12, Math.min(rowFs, widthFs, 36));
    }

    _injectKeyframes() {
        if (document.getElementById("yt-keyframes")) return;
        const s = document.createElement("style");
        s.id = "yt-keyframes";
        s.textContent = `
            @keyframes ytdot {
                0%,60%,100% { transform:translateY(0); opacity:0.4; }
                30% { transform:translateY(-4px); opacity:1; }
            }
            @keyframes ytpulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
            #yt-widget { transition: border-color 0.4s ease; }
        `;
        document.head.appendChild(s);
    }

    _createWidget() {
        this.widget?.remove();
        this._injectKeyframes();

        const el = document.createElement("div");
        el.id = "yt-widget";
        el.style.cssText = `
            position:fixed;
            left:${this.settings.widgetX}px;
            top:${this.settings.widgetY}px;
            width:${this.settings.widgetWidth}px;
            height:${this.settings.widgetCollapsed ? "auto" : this.settings.widgetHeight + "px"};
            min-width:140px; min-height:40px;
            background:rgba(8,8,14,0.93);
            border:1.5px solid rgba(88,101,242,0.55);
            border-radius:10px; color:white;
            font-family:'Whitney','Helvetica Neue',Arial,sans-serif;
            z-index:99998;
            box-shadow:0 8px 28px rgba(0,0,0,0.55);
            user-select:none; overflow:hidden;
            backdrop-filter:blur(8px);
            display:flex; flex-direction:column;
        `;

   el.innerHTML = `
            <div id="yt-widget-header" style="
                background: rgba(16, 44, 25, 0.85); padding:5px 8px;
                font-size:10px; color:rgba(255,255,255,0.45);
                display:flex; justify-content:space-between; align-items:center;
                cursor:grab; flex-shrink:0;
                border-bottom:1px solid rgba(35, 165, 90, 0.3);
                text-transform:uppercase; letter-spacing:0.06em; gap:6px;
            ">
                <span style="flex:1;">YoshiTracker</span>
                <button id="yt-widget-toggle" title="Collapse / Expand" style="
                    background:none; border:none; color:rgba(255,255,255,0.5);
                    cursor:pointer; font-size:13px; padding:0 2px; line-height:1;
                ">${this.settings.widgetCollapsed ? "▲" : "▼"}</button>
            </div>
            <div id="yt-widget-body" style="
                flex:1; overflow:hidden;
                display:${this.settings.widgetCollapsed ? "none" : "flex"};
                flex-direction:column; padding:6px 10px 8px; gap:0; justify-content:space-between;
            "></div>
            <div id="yt-widget-resizer" title="Drag to resize" style="
                position:absolute; bottom:0; right:0;
                width:18px; height:18px; cursor:nwse-resize;
                background:linear-gradient(135deg, transparent 50%, rgba(35, 165, 90, 0.6) 50%);
                border-radius:0 0 10px 0;
                display:${this.settings.widgetCollapsed ? "none" : "block"};
            "></div>
        `;

        document.body.appendChild(el);
        this.widget = el;

        // Collapse / expand toggle
        el.querySelector("#yt-widget-toggle").onclick = () => {
            this.settings.widgetCollapsed = !this.settings.widgetCollapsed;
            this._save();
            const body    = el.querySelector("#yt-widget-body");
            const resizer = el.querySelector("#yt-widget-resizer");
            const btn     = el.querySelector("#yt-widget-toggle");
            if (this.settings.widgetCollapsed) {
                body.style.display    = "none";
                resizer.style.display = "none";
                el.style.height       = "auto";
                btn.textContent       = "▲";
            } else {
                body.style.display    = "flex";
                resizer.style.display = "block";
                el.style.height       = this.settings.widgetHeight + "px";
                btn.textContent       = "▼";
            }
        };

        // Drag to move
        let dragging = false, dSX, dSY, dOX, dOY;
        const header = el.querySelector("#yt-widget-header");

        // Resize via corner drag
        let resizing = false, rSX, rSY, rOW, rOH;
        const resizer = el.querySelector("#yt-widget-resizer");

        const onMove = (e) => {
            if (dragging) {
                this.settings.widgetX = Math.max(0, dOX + (e.clientX - dSX));
                this.settings.widgetY = Math.max(0, dOY + (e.clientY - dSY));
                el.style.left = this.settings.widgetX + "px";
                el.style.top  = this.settings.widgetY + "px";
            }
            if (resizing) {
                this.settings.widgetWidth  = Math.max(140, rOW + (e.clientX - rSX));
                this.settings.widgetHeight = Math.max(80,  rOH + (e.clientY - rSY));
                el.style.width  = this.settings.widgetWidth  + "px";
                el.style.height = this.settings.widgetHeight + "px";
                this._updateWidget();
            }
        };
        const onUp = () => {
            if (dragging) { dragging = false; header.style.cursor = "grab"; this._save(); }
            if (resizing) { resizing = false; this._save(); }
        };

        header.addEventListener("mousedown", (e) => {
            if (e.target.id === "yt-widget-toggle") return;
            dragging = true;
            dSX = e.clientX; dSY = e.clientY;
            dOX = this.settings.widgetX; dOY = this.settings.widgetY;
            header.style.cursor = "grabbing";
            e.preventDefault();
        });

        resizer.addEventListener("mousedown", (e) => {
            resizing = true;
            rSX = e.clientX; rSY = e.clientY;
            rOW = this.settings.widgetWidth; rOH = this.settings.widgetHeight;
            e.preventDefault(); e.stopPropagation();
        });

        // Remove old listeners before adding new ones
        if (this._docMouseMove) document.removeEventListener("mousemove", this._docMouseMove);
        if (this._docMouseUp)   document.removeEventListener("mouseup",   this._docMouseUp);
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
        this._docMouseMove = onMove;
        this._docMouseUp   = onUp;

        this._updateWidget();
    }

    _updateWidget() {
        if (!this.widget) return;
        const body = this.widget.querySelector("#yt-widget-body");
        if (!body || this.settings.widgetCollapsed) return;

        const fs   = this._calcFontSize(this.settings.widgetWidth, this.settings.widgetHeight);
        const meta = statusMeta(this.lastStatus);

        const dotSize = Math.max(4, Math.floor(fs * 0.38));
        const dots = [0, 0.2, 0.4].map(d =>
            `<span style="width:${dotSize}px;height:${dotSize}px;background:#99b4ff;border-radius:50%;display:inline-block;animation:ytdot 1.2s infinite ${d}s;"></span>`
        ).join("");

        const jumpBtn = (label, channelId, messageId = null, color = "#5865f2") => {
            if (!channelId) return "";
            return `<button class="yt-jump-btn"
                data-channel="${channelId}"
                data-message="${messageId ?? ""}"
                style="background:${color}33;border:1px solid ${color}66;color:${color};
                       border-radius:4px;padding:2px 7px;font-size:${fs - 2}px;
                       cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;">
                ↗ ${label}
            </button>`;
        };

        const voiceLine = this.voiceChannelId ? `
            <div style="display:flex;align-items:center;gap:5px;font-size:${fs - 1}px;color:#a0c4ff;flex:1;">
                <span>🎙️</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">#${this.voiceChannelName ?? this.voiceChannelId}</span>
                ${jumpBtn("Join", this.voiceChannelId, null, "#a0c4ff")}
            </div>` : "";

        // typingLine is rendered inline in body.innerHTML below

        const msgLine = this.lastMessageChannelId ? `
            <div style="display:flex;align-items:center;gap:5px;font-size:${fs - 2}px;color:rgba(255,255,255,0.28);flex:1;">
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                    Last msg: #${this._getChannelName(this.lastMessageChannelId)}
                </span>
                ${jumpBtn("→", this.lastMessageChannelId, this.lastMessageId, "#23a55a")}
            </div>` : "";

        body.style.fontSize = fs + "px";
        body.innerHTML = `
            <div style="font-size:${fs + 4}px;font-weight:700;letter-spacing:0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;display:flex;align-items:center;">
                ${DISPLAY_NAME}
            </div>
            <div style="display:flex;align-items:center;gap:6px;font-size:${fs}px;flex:1;">
                <span style="
                    width:${Math.max(8, Math.floor(fs * 0.75))}px;
                    height:${Math.max(8, Math.floor(fs * 0.75))}px;
                    border-radius:50%; flex-shrink:0;
                    background:${meta.color}; box-shadow:0 0 6px ${meta.color}aa;
                    ${this.lastStatus === "online" ? "animation:ytpulse 2.5s infinite;" : ""}
                "></span>
                <span style="color:${meta.color};font-weight:600;">${meta.label}</span>
            </div>
            <div style="display:flex;align-items:center;gap:5px;font-size:${fs}px;color:${this.isTyping ? "#aac4ff" : "rgba(255,255,255,0.35)"};flex:1;">
                ${this.isTyping
                    ? `<span style="animation:ytpulse 1s infinite;flex-shrink:0;">✏️</span>
                       <span style="flex:1;">Typing</span>
                       <span style="display:inline-flex;gap:2px;margin-left:4px;vertical-align:middle;">${dots}</span>
                       ${jumpBtn("Go", this.lastTypingChannelId, null, "#5865f2")}`
                    : `<span style="flex:1;">Not typing</span>`
                }
            </div>
            ${voiceLine}
            ${msgLine}
        `;

        // Wire up jump buttons after innerHTML is set
        body.querySelectorAll(".yt-jump-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                this._jumpTo(btn.dataset.channel, btn.dataset.message || null);
            });
        });

        this.widget.style.borderColor = meta.color + "88";
    }

    // ─── Sound ────────────────────────────────────────────────────────────────

    _playSound(url, volume = 0.5) {
        if (!this.settings.enableSound) return;
        const a = new Audio(url);
        a.volume = volume;
        a.play().catch(e => this._log("❌ Sound failed: " + e.message, "red"));
    }

    _save() { BdApi.Data.save("YoshiTracker", "settings", this.settings); }

    // ─── Debug panel ──────────────────────────────────────────────────────────

    _log(message, color = "white") {
        const ts = new Date().toLocaleTimeString();
        this.debugLogs.push({ time: ts, msg: message, color });
        if (this.debugLogs.length > 100) this.debugLogs.shift();
        this._updateDebugPanel();
    }

    _createDebugPanel() {
        this.debugPanel?.remove();
        const el = document.createElement("div");
        el.id = "yt-debug";
        el.style.cssText = `
            position:fixed; bottom:20px; right:20px; width:440px; max-height:460px;
            background:rgba(10,10,15,0.97); border:2px solid #5865f2; border-radius:10px;
            color:white; font-family:'Consolas',monospace; font-size:12px; z-index:99999;
            overflow:hidden; box-shadow:0 12px 32px rgba(0,0,0,0.6);
            display:flex; flex-direction:column;
        `;
        el.innerHTML = `
            <div style="background:#5865f2;padding:10px 14px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
                <span>🔍 YoshiTracker Debug</span>
                <button id="yt-debug-close" style="background:none;border:none;color:white;cursor:pointer;font-size:18px;line-height:1;">×</button>
            </div>
            <div id="yt-debug-stats" style="padding:7px 14px;background:rgba(88,101,242,0.15);border-bottom:1px solid rgba(88,101,242,0.3);font-size:11px;flex-shrink:0;line-height:1.8;"></div>
            <div id="yt-debug-logs"  style="padding:10px 14px;overflow-y:auto;flex:1;line-height:1.7;"></div>
        `;
        document.body.appendChild(el);
        this.debugPanel = el;

        el.querySelector("#yt-debug-close").onclick = () => {
            this.settings.showDebugPanel = false;
            this._save();
            el.remove();
            this.debugPanel = null;
        };
        this._updateDebugPanel();
    }

    _updateDebugPanel() {
        if (!this.debugPanel) return;
        const stats = this.debugPanel.querySelector("#yt-debug-stats");
        if (stats) {
            const { typing, message, targetTyping, targetMessage, presence, voice } = this.eventCount;
            const m = statusMeta(this.lastStatus);
            stats.innerHTML =
                `All — ⌨️${typing} 💬${message} 📡${presence} 🎙️${voice}<br>` +
                `Target — ⌨️${targetTyping} 💬${targetMessage} &nbsp;|&nbsp; ` +
                `Status: <span style="color:${m.color}">${m.emoji} ${m.label}</span>`;
        }
        const logs = this.debugPanel.querySelector("#yt-debug-logs");
        if (logs) {
            logs.innerHTML = this.debugLogs
                .map(l => `<div style="color:${l.color}">[${l.time}] ${l.msg}</div>`)
                .join("");
            logs.scrollTop = logs.scrollHeight;
        }
    }

    // ─── Settings panel ───────────────────────────────────────────────────────

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.cssText = "padding:16px;color:var(--text-normal);max-width:520px;";

        const heading = (text) => {
            const h = document.createElement("h3");
            h.textContent = text;
            h.style.cssText = "margin:18px 0 10px;color:var(--header-primary);font-size:12px;text-transform:uppercase;letter-spacing:0.07em;border-bottom:1px solid var(--background-modifier-accent);padding-bottom:6px;";
            panel.appendChild(h);
        };

        const addToggle = (label, key, desc, onChange) => {
            const wrap = document.createElement("div");
            wrap.style.cssText = "margin-bottom:10px;";
            const row = document.createElement("label");
            row.style.cssText = "display:flex;align-items:center;cursor:pointer;gap:8px;font-weight:500;font-size:13px;";
            const cb = document.createElement("input");
            cb.type = "checkbox"; cb.checked = this.settings[key];
            cb.onchange = () => { this.settings[key] = cb.checked; this._save(); onChange?.(cb.checked); };
            row.appendChild(cb);
            row.appendChild(document.createTextNode(label));
            wrap.appendChild(row);
            if (desc) {
                const d = document.createElement("div"); d.textContent = desc;
                d.style.cssText = "font-size:11px;color:var(--text-muted);margin:2px 0 0 22px;";
                wrap.appendChild(d);
            }
            panel.appendChild(wrap);
        };

        const addNumber = (label, key, desc, min = 0, onUpdate) => {
            const wrap = document.createElement("div");
            wrap.style.cssText = "margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
            const lbl = document.createElement("span"); lbl.textContent = label;
            lbl.style.cssText = "font-weight:500;font-size:13px;flex:1;min-width:160px;";
            const inp = document.createElement("input");
            inp.type = "number"; inp.min = min; inp.value = this.settings[key];
            inp.style.cssText = "width:72px;padding:4px 8px;background:var(--input-background);color:var(--text-normal);border:1px solid var(--background-modifier-accent);border-radius:4px;font-size:13px;";
            inp.onchange = () => { this.settings[key] = Number(inp.value); this._save(); onUpdate?.(); };
            wrap.appendChild(lbl); wrap.appendChild(inp);
            if (desc) {
                const d = document.createElement("div"); d.textContent = desc;
                d.style.cssText = "width:100%;font-size:11px;color:var(--text-muted);"; wrap.appendChild(d);
            }
            panel.appendChild(wrap);
        };

        // Info card
        const info = document.createElement("div");
        info.style.cssText = "padding:11px 13px;background:var(--background-secondary);border-radius:6px;border-left:3px solid #5865f2;font-size:12px;line-height:1.9;margin-bottom:4px;";
        info.innerHTML = `
            <strong style="color:var(--header-primary)">🎯 Currently tracking</strong><br>
            👤 <code>${TARGET_USER_ID}</code> — ${DISPLAY_NAME}<br>
            🏠 Guild: <code>${TARGET_GUILD_ID}</code><br>
            <span style="color:var(--text-muted);font-size:11px;">Edit the constants at the top of the plugin file to change these.</span>
        `;
        panel.appendChild(info);

        heading("🔔 Alerts");
        addToggle("Typing Alerts",   "enableTypingAlert",   "Notification + sound when target starts typing");
        addToggle("Message Alerts",  "enableMessageAlert",  "Notification + sound when target sends a message");
        addToggle("Presence Alerts", "enablePresenceAlert", "Notification (no sound) when status changes");
        addToggle("Voice Alerts",    "enableVoiceAlert",    "Notification when target joins/leaves/moves voice");
        addToggle("Enable Sounds",   "enableSound",         "Sounds for typing, message, and voice join alerts");

        heading("⏱ Cooldowns");
        addNumber("Typing cooldown (s)",  "typingCooldown",  "Min seconds between typing notifications",  0);
        addNumber("Message cooldown (s)", "messageCooldown", "Min seconds between message notifications", 0);

        heading("📌 Widget");
        addToggle("Show Widget", "showWidget", "Always-on-screen status and typing widget",
            (val) => { val ? this._createWidget() : (this.widget?.remove(), this.widget = null); }
        );

        const posGrid = document.createElement("div");
        posGrid.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:10px;";

        const mkPosInput = (label, key, min = 0) => {
            const g = document.createElement("div");
            g.style.cssText = "display:flex;flex-direction:column;gap:4px;";
            const l = document.createElement("label"); l.textContent = label;
            l.style.cssText = "font-size:11px;color:var(--text-muted);";
            const inp = document.createElement("input");
            inp.type = "number"; inp.value = this.settings[key]; inp.min = min;
            inp.style.cssText = "padding:5px 6px;background:var(--input-background);color:var(--text-normal);border:1px solid var(--background-modifier-accent);border-radius:4px;font-size:12px;width:100%;box-sizing:border-box;";
            inp.onchange = () => {
                this.settings[key] = Number(inp.value); this._save();
                if (this.widget) {
                    if (key === "widgetX")      this.widget.style.left   = inp.value + "px";
                    if (key === "widgetY")      this.widget.style.top    = inp.value + "px";
                    if (key === "widgetWidth")  { this.widget.style.width  = inp.value + "px"; this._updateWidget(); }
                    if (key === "widgetHeight") { this.widget.style.height = inp.value + "px"; this._updateWidget(); }
                }
            };
            g.appendChild(l); g.appendChild(inp); posGrid.appendChild(g);
        };

        mkPosInput("X (left)",  "widgetX");
        mkPosInput("Y (top)",   "widgetY");
        mkPosInput("Width",     "widgetWidth",  140);
        mkPosInput("Height",    "widgetHeight",  80);
        panel.appendChild(posGrid);

        const posNote = document.createElement("div");
        posNote.textContent = "💡 Drag the widget header to move it. Drag the bottom-right corner to resize. Font scales automatically.";
        posNote.style.cssText = "font-size:11px;color:var(--text-muted);margin-bottom:4px;";
        panel.appendChild(posNote);

        heading("🛠 Debug");
        addToggle("Show Debug Panel", "showDebugPanel", "Floating event log in bottom-right",
            (val) => { val ? this._createDebugPanel() : (this.debugPanel?.remove(), this.debugPanel = null); }
        );

        heading("🧪 Test");
        const btnGrid = document.createElement("div");
        btnGrid.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";

        const mkBtn = (label, fn) => {
            const b = document.createElement("button"); b.textContent = label;
            b.style.cssText = "padding:7px 12px;background:var(--brand-experiment);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:500;";
            b.onclick = fn; btnGrid.appendChild(b);
        };

        mkBtn("💬 Message",     () => { this._showCustomNotif(`💬 ${DISPLAY_NAME} → #general\n"hey what's up"`, "#0d2219", "#23a55a"); this._playSound(MESSAGE_SOUND_URL); });
        mkBtn("✏️ Typing",      () => { this._showCustomNotif(`✏️ ${DISPLAY_NAME} is typing in #general...`, "#0d1a3a", "#5865f2"); this._playSound(TYPING_SOUND_URL, 0.4); });
        mkBtn("🟢 Online",      () => this._showPresenceNotif(statusMeta("online"),  "offline"));
        mkBtn("🌙 Idle",        () => this._showPresenceNotif(statusMeta("idle"),    "online"));
        mkBtn("⚫ Offline",     () => this._showPresenceNotif(statusMeta("offline"), "online"));
        mkBtn("🎙️ Voice join",  () => { this._showCustomNotif(`🎙️ ${DISPLAY_NAME} joined voice\n#general`, "#0d2219", "#23a55a"); this._playSound(VOICE_SOUND_URL, 0.35); });
        mkBtn("✏️ Widget typing", () => {
            this.isTyping = true;
            this.lastTypingChannelId = TARGET_CHANNEL_IDS[1];
            this._updateWidget();
            clearTimeout(this.typingTimeout);
            this.typingTimeout = setTimeout(() => { this.isTyping = false; this._updateWidget(); }, 5000);
        });
        mkBtn("🔄 Re-subscribe", () => {
            this._subscribeGuildPresence();
            BdApi.UI.showToast("Guild presence re-subscribed", { type: "success", timeout: 2000 });
        });

        panel.appendChild(btnGrid);
        return panel;
    }
};
