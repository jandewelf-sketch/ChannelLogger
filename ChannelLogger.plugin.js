/**
 * @name ChannelLogger
 * @author jandewelf-sketch
 * @description Logs new, edited and deleted messages from chosen server channels to one or more log channels in your own server, using your own Discord bot.
 * @version 1.3.0
 */

const { Data, UI, ContextMenu, Webpack } = BdApi;

const COLORS = { create: 0x57f287, edit: 0xfee75c, delete: 0xed4245, info: 0x5865f2 };
const CACHE_LIMIT = 2000;
const QUEUE_LIMIT = 1000;
const API = "https://discord.com/api/v10";
const UA = "DiscordBot (ChannelLogger, 1.3.0)";
const TOKEN_RE = /^[\w-]{18,}\.[\w-]{5,}\.[\w-]{20,}$/;
const ID_RE = /^\d{17,20}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const embedSize = (e) =>
    (e.title?.length || 0) +
    (e.description?.length || 0) +
    (e.author?.name?.length || 0) +
    (e.footer?.text?.length || 0) +
    (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
// Images that can be shown inside an embed. Spoilers and SVGs stay plain links.
const isEmbeddableImage = (a) => {
    const name = (a.filename || "").split("?")[0];
    if (/^SPOILER_/i.test(name) || /svg/i.test(a.content_type || "") || /\.svg$/i.test(name)) return false;
    return /^image\//i.test(a.content_type || "") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
};
const MAX_GALLERY = 4; // Discord merges up to 4 embeds with the same url into one image grid
const newKey = () => "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "style") el.style.cssText = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
};

const tryFind = (...fns) => {
    for (const fn of fns) {
        try {
            const r = fn();
            if (r) return r;
        } catch (_) {}
    }
    return null;
};

const byKeys = (...keys) => (Webpack.getByKeys || Webpack.getByProps).call(Webpack, ...keys);

const getStore = (name, ...keys) =>
    tryFind(
        () => Webpack.getStore?.(name),
        () => Webpack.getModule((m) => m?._dispatchToken && m?.getName?.() === name),
        () => Webpack.getModule((m) => m?._dispatchToken && m?.getName?.() === name, { searchExports: true }),
        () => byKeys(...keys)
    );

const findDispatcher = () => {
    const loose = (m) => m && typeof m.subscribe === "function" && typeof m.dispatch === "function" && typeof m.unsubscribe === "function";
    const strict = (m) => loose(m) && (m._subscriptions || m._actionHandlers || typeof m.isDispatching === "function");
    return tryFind(
        () => Webpack.getModule(strict),
        () => Webpack.getModule(strict, { searchExports: true }),
        () => byKeys("dispatch", "subscribe", "unsubscribe"),
        () => Webpack.getModule(loose, { searchExports: true }),
        () => Webpack.getModule(loose)
    );
};

// Requests go through BetterDiscord's own network layer, not the client's browser fetch.
const netFetch = (url, opts = {}) => {
    if (!BdApi.Net || typeof BdApi.Net.fetch !== "function") {
        throw new Error("BdApi.Net.fetch is missing. Update BetterDiscord.");
    }
    return BdApi.Net.fetch(url, opts);
};

module.exports = class ChannelLogger {
    constructor(meta) {
        this.meta = meta;
        this.name = meta?.name || "ChannelLogger";
        this.defaults = {
            botToken: "",
            destinations: {}, // key -> { name, channelId }
            defaultDest: "",
            eventRoutes: { edit: "", delete: "" }, // event -> destination key ("" = no override)
            keywordRoutes: [], // [{ keywords, dest }]
            ignoreBots: false,
            ignoreSelf: false,
            logEdits: true,
            logDeletes: true,
            keywords: "",
            channels: {}, // id -> { label, guildName, dest }
            guilds: {}, // id -> { label, dest }
        };
        this.cache = new Map();
        this.queues = new Map(); // log channel id -> { name, items: [] }
        this.pumping = new Set();
        this.running = false;
        this.unpatches = [];
        this.warnedNotConfigured = false;
    }

    /* ---------- lifecycle ---------- */

    start() {
        this.loadSettings();
        this.running = true;

        this.Dispatcher = findDispatcher();
        this.ChannelStore = getStore("ChannelStore", "getChannel", "getMutableGuildChannelsForGuild");
        this.GuildStore = getStore("GuildStore", "getGuild", "getGuilds");
        this.UserStore = getStore("UserStore", "getCurrentUser", "getUser");

        const missing = [
            ["Dispatcher", this.Dispatcher],
            ["ChannelStore", this.ChannelStore],
            ["GuildStore", this.GuildStore],
            ["UserStore", this.UserStore],
        ]
            .filter(([, v]) => !v)
            .map(([n]) => n);

        if (missing.length) {
            console.error("[ChannelLogger] Not found:", missing);
            UI.showToast(`ChannelLogger: could not find: ${missing.join(", ")}`, { type: "error" });
            this.running = false;
            return;
        }

        this.onCreate = (e) => this.safe(() => this.handleCreate(e));
        this.onUpdate = (e) => this.safe(() => this.handleUpdate(e));
        this.onDelete = (e) => this.safe(() => this.handleDelete(e));
        this.onBulkDelete = (e) => this.safe(() => this.handleBulkDelete(e));

        this.Dispatcher.subscribe("MESSAGE_CREATE", this.onCreate);
        this.Dispatcher.subscribe("MESSAGE_UPDATE", this.onUpdate);
        this.Dispatcher.subscribe("MESSAGE_DELETE", this.onDelete);
        this.Dispatcher.subscribe("MESSAGE_DELETE_BULK", this.onBulkDelete);

        this.unpatches.push(ContextMenu.patch("channel-context", (tree, props) => this.patchChannelMenu(tree, props)));
        this.unpatches.push(ContextMenu.patch("guild-context", (tree, props) => this.patchGuildMenu(tree, props)));
    }

    stop() {
        this.running = false;
        if (this.Dispatcher) {
            this.Dispatcher.unsubscribe("MESSAGE_CREATE", this.onCreate);
            this.Dispatcher.unsubscribe("MESSAGE_UPDATE", this.onUpdate);
            this.Dispatcher.unsubscribe("MESSAGE_DELETE", this.onDelete);
            this.Dispatcher.unsubscribe("MESSAGE_DELETE_BULK", this.onBulkDelete);
        }
        for (const un of this.unpatches) {
            try { un?.(); } catch (_) {}
        }
        this.unpatches = [];
        this.cache.clear();
        this.queues.clear();
    }

    safe(fn) {
        try { fn(); } catch (err) { console.error("[ChannelLogger]", err); }
    }

    /* ---------- settings ---------- */

    loadSettings() {
        const saved = Data.load(this.name, "settings") || {};
        const s = Object.assign({}, this.defaults, saved);
        s.channels = s.channels || {};
        s.guilds = s.guilds || {};
        s.destinations = s.destinations || {};
        s.keywordRoutes = Array.isArray(s.keywordRoutes) ? s.keywordRoutes : [];
        s.eventRoutes = Object.assign({ edit: "", delete: "" }, s.eventRoutes || {});

        // Migrate from the single log channel of version 1.1.x.
        if (saved.logChannelId && !Object.keys(s.destinations).length) {
            s.destinations.main = { name: "Main", channelId: String(saved.logChannelId).trim() };
            s.defaultDest = "main";
        }
        delete s.logChannelId;

        this.settings = s;
        this.normalize();
        this.refreshDerived();
    }

    save() {
        this.normalize();
        Data.save(this.name, "settings", this.settings);
        this.refreshDerived();
    }

    // Keep references to destinations consistent.
    normalize() {
        const s = this.settings;
        const keys = Object.keys(s.destinations);
        if (!s.destinations[s.defaultDest]) s.defaultDest = keys[0] || "";
        for (const ev of ["edit", "delete"]) if (s.eventRoutes[ev] && !s.destinations[s.eventRoutes[ev]]) s.eventRoutes[ev] = "";
        s.keywordRoutes = s.keywordRoutes.filter((r) => s.destinations[r.dest]);
        for (const e of [...Object.values(s.channels), ...Object.values(s.guilds)]) {
            if (e.dest && !s.destinations[e.dest]) e.dest = "";
        }
    }

    cleanToken(t) {
        return (t || "").trim().replace(/^Bot\s+/i, "");
    }

    refreshDerived() {
        // The first part of a bot token is the base64-encoded bot ID.
        this.botUserId = null;
        try {
            const part = this.cleanToken(this.settings.botToken).split(".")[0];
            const id = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
            if (/^\d+$/.test(id)) this.botUserId = id;
        } catch (_) {}

        this.destIds = new Set(
            Object.values(this.settings.destinations)
                .map((d) => (d.channelId || "").trim())
                .filter(Boolean)
        );
    }

    isConfigured() {
        return (
            TOKEN_RE.test(this.cleanToken(this.settings.botToken)) &&
            Object.values(this.settings.destinations).some((d) => ID_RE.test((d.channelId || "").trim()))
        );
    }

    destName(key) {
        return this.settings.destinations[key]?.name || "?";
    }

    /* ---------- filters and routing ---------- */

    // Returns the settings entry of the most specific logged source (channel, category or server), or null.
    getSource(channelId) {
        if (this.destIds.has(channelId)) return null; // never log the log channels themselves
        const channel = this.ChannelStore.getChannel(channelId);
        if (!channel || !channel.guild_id) return null; // no DMs
        const { channels, guilds } = this.settings;
        if (channels[channelId]) return channels[channelId];
        if (channel.parent_id) {
            if (channels[channel.parent_id]) return channels[channel.parent_id]; // channel or category as parent
            const parent = this.ChannelStore.getChannel(channel.parent_id);
            if (parent?.parent_id && channels[parent.parent_id]) return channels[parent.parent_id]; // thread in a channel in a category
        }
        return guilds[channel.guild_id] || null;
    }

    passesAuthorFilters(author) {
        if (!author) return true;
        if (this.botUserId && author.id === this.botUserId) return false; // prevent loops
        if (this.settings.ignoreBots && author.bot) return false;
        if (this.settings.ignoreSelf && author.id === this.UserStore.getCurrentUser()?.id) return false;
        return true;
    }

    kwList(str) {
        return (str || "")
            .split(",")
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean);
    }

    // Global filter: with no keywords everything passes.
    matchesKeywords(text) {
        const kws = this.kwList(this.settings.keywords);
        if (!kws.length) return true;
        const t = (text || "").toLowerCase();
        return kws.some((k) => t.includes(k));
    }

    // Priority: keyword routes, then event override (edit/delete), then the source's destination, then the default.
    resolveDest(source, kind, ...texts) {
        const { destinations, keywordRoutes, eventRoutes, defaultDest } = this.settings;
        const hay = texts.filter((t) => typeof t === "string").join("\n").toLowerCase();
        if (hay) {
            for (const r of keywordRoutes) {
                const kws = this.kwList(r.keywords);
                if (destinations[r.dest] && kws.length && kws.some((k) => hay.includes(k))) return r.dest;
            }
        }
        if (kind !== "create") {
            const k = eventRoutes[kind];
            if (k && destinations[k]) return k;
        }
        if (source?.dest && destinations[source.dest]) return source.dest;
        return destinations[defaultDest] ? defaultDest : Object.keys(destinations)[0] || null;
    }

    /* ---------- event handlers ---------- */

    handleCreate(e) {
        if (e.optimistic || e.isPushNotification) return;
        const msg = e.message;
        if (!msg) return;
        const channelId = e.channelId || msg.channel_id;
        const source = this.getSource(channelId);
        if (!source) return;
        if (!this.passesAuthorFilters(msg.author)) return;

        this.remember(msg, channelId);
        if (!this.matchesKeywords(msg.content)) return;
        this.enqueue(
            this.buildEmbed("create", { msg, channelId, content: msg.content || "", attachments: msg.attachments, stickers: msg.sticker_items }),
            this.resolveDest(source, "create", msg.content)
        );
    }

    handleUpdate(e) {
        if (!this.settings.logEdits) return;
        const msg = e.message;
        if (!msg || typeof msg.content !== "string") return;
        const channelId = msg.channel_id || e.channelId;
        const source = this.getSource(channelId);
        if (!source) return;

        const cached = this.cache.get(msg.id);
        const author = msg.author || cached?.author;
        if (!this.passesAuthorFilters(author)) return;

        if (cached) {
            if (cached.content === msg.content) return; // not a real edit
        } else if (!msg.edited_timestamp) {
            return; // embed update without an edit
        }

        const old = cached ? cached.content : null;
        this.cache.set(msg.id, { ...(cached || { timestamp: msg.timestamp, attachments: [] }), channelId, content: msg.content, author });

        if (!this.matchesKeywords(msg.content) && !this.matchesKeywords(old)) return;
        this.enqueue(
            this.buildEmbed("edit", { msg: { ...msg, author }, channelId, content: msg.content, old, attachments: msg.attachments || cached?.attachments }),
            this.resolveDest(source, "edit", msg.content, old)
        );
    }

    handleDelete(e) {
        this.logDelete(e.id, e.channelId);
    }

    handleBulkDelete(e) {
        for (const id of e.ids || []) this.logDelete(id, e.channelId);
    }

    logDelete(id, channelId) {
        if (!this.settings.logDeletes) return;
        const source = this.getSource(channelId);
        if (!source) return;
        const cached = this.cache.get(id);
        this.cache.delete(id);

        if (cached) {
            if (!this.passesAuthorFilters(cached.author)) return;
            if (!this.matchesKeywords(cached.content)) return;
        } else if (this.settings.keywords.trim()) {
            return; // without a cache we cannot filter on keywords
        }

        this.enqueue(
            this.buildEmbed("delete", {
                msg: { id, author: cached?.author, timestamp: cached?.timestamp },
                channelId,
                content: cached ? cached.content : null,
                attachments: cached?.attachments,
            }),
            this.resolveDest(source, "delete", cached?.content)
        );
    }

    remember(msg, channelId) {
        this.cache.set(msg.id, {
            content: msg.content || "",
            author: msg.author,
            channelId,
            timestamp: msg.timestamp,
            attachments: (msg.attachments || []).map((a) => ({ url: a.url, filename: a.filename, content_type: a.content_type })),
        });
        if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    }

    /* ---------- embeds ---------- */

    avatarUrl(author) {
        if (!author?.id) return undefined;
        if (author.avatar) return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png`;
        try {
            return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(author.id) >> 22n) % 6n)}.png`;
        } catch (_) {
            return undefined;
        }
    }

    buildEmbed(kind, { msg, channelId, content, old, attachments, stickers }) {
        const channel = this.ChannelStore.getChannel(channelId);
        const guild = channel?.guild_id ? this.GuildStore.getGuild(channel.guild_id) : null;
        const author = msg.author;
        const authorName = author ? author.global_name || author.username : "Unknown user";

        const stickerText = (stickers || []).map((s) => `*(sticker: ${s.name})*`).join(" ");
        const placeholder = "*(no text — embed, attachment or sticker)*";
        const hasAttachments = !!attachments?.length;
        let description;

        if (kind === "edit") {
            const oldText = old === null ? "*(unknown — not in cache)*" : cut(old || "*(empty)*", 1800);
            description = `**New**\n${cut(content || (hasAttachments ? "*(no text)*" : placeholder), 1800)}\n\n**Old**\n${oldText}`;
        } else if (kind === "delete") {
            const body = content === null ? "*(content unknown — message was not in cache)*" : content || (hasAttachments ? "" : placeholder);
            description = body ? cut(body, 3800) : undefined;
        } else {
            const body = [content, stickerText].filter(Boolean).join("\n") || (hasAttachments ? "" : placeholder);
            description = body ? cut(body, 3800) : undefined;
        }

        const embed = {
            title: { create: "New message", edit: "Message edited", delete: "Message deleted" }[kind],
            description,
            color: COLORS[kind],
            author: { name: cut(authorName, 200), icon_url: this.avatarUrl(author) },
            footer: {
                text: cut(`${guild?.name ?? "Unknown server"} • #${channel?.name ?? channelId}${author?.id ? ` • ID ${author.id}` : ""}`, 500),
            },
            timestamp: kind === "delete" ? new Date().toISOString() : msg.edited_timestamp || msg.timestamp || new Date().toISOString(),
        };

        if (kind !== "delete" && channel?.guild_id && msg.id) {
            embed.url = `https://discord.com/channels/${channel.guild_id}/${channelId}/${msg.id}`;
        }

        // Images are shown inside the embed. Discord merges embeds that share the same url into one
        // image grid (up to 4 per grid), so every image gets its own embed with the same url.
        const images = [];
        const files = [];
        for (const a of attachments || []) (isEmbeddableImage(a) && images.length < 10 ? images : files).push(a);

        if (files.length) {
            const lines = files.map((a) => `[${a.filename || "attachment"}](${a.url})`).join("\n");
            embed.fields = [{ name: "Attachments", value: cut(lines, 1000) }];
        }

        const group = [embed];
        if (images.length) {
            embed.image = { url: images[0].url };
            if (images.length > 1) {
                if (!embed.url) embed.url = channel?.guild_id ? `https://discord.com/channels/${channel.guild_id}/${channelId}` : "https://discord.com/channels/@me";
                for (let i = 1; i < images.length; i++) {
                    const part = Math.floor(i / MAX_GALLERY);
                    const url = part === 0 ? embed.url : `${embed.url}${embed.url.includes("?") ? "&" : "?"}part=${part}`;
                    group.push({ url, image: { url: images[i].url }, color: embed.color });
                }
            }
        }

        return group;
    }

    /* ---------- sending via the bot ---------- */

    botHeaders() {
        return {
            Authorization: `Bot ${this.cleanToken(this.settings.botToken)}`,
            "Content-Type": "application/json",
            "User-Agent": UA,
        };
    }

    // Each log channel has its own queue, because Discord rate limits per channel.
    enqueue(embedOrGroup, destKey) {
        const group = Array.isArray(embedOrGroup) ? embedOrGroup : [embedOrGroup];
        const dest = this.settings.destinations[destKey];
        const channelId = (dest?.channelId || "").trim();
        if (!TOKEN_RE.test(this.cleanToken(this.settings.botToken)) || !ID_RE.test(channelId)) {
            if (!this.warnedNotConfigured) {
                this.warnedNotConfigured = true;
                UI.showToast(`ChannelLogger: set a valid bot token and channel ID${dest ? ` for "${dest.name}"` : ""} first.`, { type: "warning" });
            }
            return;
        }
        this.warnedNotConfigured = false;
        let q = this.queues.get(channelId);
        if (!q) {
            q = { name: dest.name, items: [] };
            this.queues.set(channelId, q);
        }
        q.name = dest.name;
        q.items.push(group); // a group is never split over two messages, or the image grid would break
        if (q.items.length > QUEUE_LIMIT) q.items.shift();
        this.pump(channelId);
    }

    hint(status) {
        if (status === 401) return "Bot token invalid or revoked.";
        if (status === 403) return "The bot has no access or permissions in the log channel (View Channels, Send Messages, Embed Links).";
        if (status === 404) return "Log channel not found. Is the channel ID correct?";
        return "";
    }

    async pump(channelId) {
        if (this.pumping.has(channelId)) return;
        const q = this.queues.get(channelId);
        if (!q) return;
        this.pumping.add(channelId);
        let failures = 0;
        try {
            while (this.running && q.items.length) {
                const groups = [];
                let size = 0;
                let count = 0;
                while (q.items.length) {
                    const g = q.items[0];
                    const gs = g.reduce((n, e) => n + embedSize(e), 0);
                    if (count > 0 && (count + g.length > 10 || size + gs > 5500)) break;
                    size += gs;
                    count += g.length;
                    groups.push(q.items.shift());
                }

                const res = await this.send(channelId, groups.flat());
                if (res.ok) {
                    failures = 0;
                } else if (res.retryAfter) {
                    q.items.unshift(...groups);
                    await sleep(res.retryAfter * 1000 + 100);
                    continue;
                } else {
                    failures++;
                    if (failures >= 3 || res.fatal) {
                        const extra = this.hint(res.status);
                        UI.showToast(
                            `ChannelLogger: sending to "${q.name}" failed${res.status ? ` (HTTP ${res.status})` : ""}${res.detail ? `: ${res.detail}` : ""}${extra ? ` — ${extra}` : ""}`,
                            { type: "error", timeout: 10000 }
                        );
                        failures = 0; // drop the batch
                    } else {
                        q.items.unshift(...groups);
                        await sleep(3000);
                        continue;
                    }
                }
                await sleep(1000);
            }
        } finally {
            this.pumping.delete(channelId);
        }
    }

    async send(channelId, embeds) {
        try {
            const res = await netFetch(`${API}/channels/${channelId}/messages`, {
                method: "POST",
                headers: this.botHeaders(),
                body: JSON.stringify({ allowed_mentions: { parse: [] }, embeds }),
            });
            const raw = await res.text();
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (_) {}

            if (res.status === 429) {
                return { ok: false, retryAfter: parsed?.retry_after || 1 };
            }
            if (!res.ok) {
                let detail = parsed?.message || (raw || "").replace(/\s+/g, " ").slice(0, 150);
                if (parsed?.code) detail += ` (code ${parsed.code})`;
                if (parsed?.errors) detail += " " + JSON.stringify(parsed.errors).slice(0, 200);
                console.error("[ChannelLogger] Sending failed", res.status, raw.slice(0, 500));
                return { ok: false, status: res.status, detail, fatal: res.status >= 400 && res.status < 500 };
            }
            return { ok: true };
        } catch (err) {
            console.error("[ChannelLogger] network error", err);
            return { ok: false, fatal: true, detail: String(err?.message || err) };
        }
    }

    /* ---------- context menus ---------- */

    patchChannelMenu(tree, props) {
        const channel = props?.channel;
        const children = tree?.props?.children;
        if (!channel?.guild_id || !Array.isArray(children)) return;
        const isCategory = channel.type === 4;
        const makeEntry = () => ({
            label: `${isCategory ? "📁 " : "#"}${channel.name}`,
            guildName: this.GuildStore.getGuild(channel.guild_id)?.name || "?",
            dest: "",
        });
        children.push(ContextMenu.buildItem({ type: "separator" }), this.sourceMenuItem("channels", channel.id, isCategory ? "this category" : "this channel", makeEntry));
    }

    patchGuildMenu(tree, props) {
        const guild = props?.guild;
        const children = tree?.props?.children;
        if (!guild || !Array.isArray(children)) return;
        children.push(
            ContextMenu.buildItem({ type: "separator" }),
            this.sourceMenuItem("guilds", guild.id, "whole server", () => ({ label: guild.name, dest: "" }))
        );
    }

    // One toggle when there is a single log channel, a submenu to pick the destination when there are several.
    sourceMenuItem(store, id, noun, makeEntry) {
        const current = this.settings[store][id];
        const dests = Object.entries(this.settings.destinations);

        if (dests.length <= 1) {
            return ContextMenu.buildItem({
                type: "toggle",
                label: `Log ${noun}`,
                checked: !!current,
                action: () => this.setSource(store, id, makeEntry, ""),
            });
        }

        const items = [
            {
                type: "toggle",
                label: `Log to default ("${this.destName(this.settings.defaultDest)}")`,
                checked: !!current && !current.dest,
                action: () => this.setSource(store, id, makeEntry, ""),
            },
            ...dests.map(([key, d]) => ({
                type: "toggle",
                label: `Log to "${d.name}"`,
                checked: current?.dest === key,
                action: () => this.setSource(store, id, makeEntry, key),
            })),
        ];
        if (current) {
            items.push({ type: "separator" }, { type: "text", label: "Stop logging", danger: true, action: () => this.removeSource(store, id) });
        }
        return ContextMenu.buildItem({ type: "submenu", label: `ChannelLogger: ${noun}`, items });
    }

    // Choosing the destination that is already active switches logging off again.
    setSource(store, id, makeEntry, destKey) {
        const current = this.settings[store][id];
        if (current && (current.dest || "") === destKey) {
            this.removeSource(store, id);
            return;
        }
        const entry = { ...(current || makeEntry()), dest: destKey };
        this.settings[store][id] = entry;
        const target = this.destName(destKey || this.settings.defaultDest);
        UI.showToast(`Logging started: ${entry.label} → ${target}`, { type: "success" });
        if (!this.isConfigured()) UI.showToast("Note: bot token or channel ID is not set yet.", { type: "warning" });
        this.save();
    }

    removeSource(store, id) {
        const entry = this.settings[store][id];
        delete this.settings[store][id];
        UI.showToast(`Logging stopped: ${entry?.label || id}`, { type: "info" });
        this.save();
    }

    /* ---------- settings panel ---------- */

    getSettingsPanel() {
        if (!this.settings) this.loadSettings();
        const root = h("div", { style: "color:var(--text-normal);padding:8px 0" });
        const fieldStyle = "padding:8px;border-radius:4px;border:none;box-sizing:border-box;background:var(--background-tertiary,#1e1f22);color:var(--text-normal)";
        const inputStyle = `width:100%;${fieldStyle}`;
        const btnStyle = "padding:6px 12px;border-radius:4px;border:none;cursor:pointer;background:var(--brand-experiment,#5865f2);color:#fff;margin-left:8px;white-space:nowrap";
        const dangerStyle = btnStyle.replace("var(--brand-experiment,#5865f2)", "#da373c");
        const headStyle = "font-weight:600;margin:18px 0 6px;color:var(--header-primary)";
        const noteStyle = "font-size:12px;opacity:.7;margin-top:4px";
        const rowStyle = "display:flex;align-items:center;gap:8px;margin:6px 0";

        const select = (options, value, onChange, style = "") => {
            const sel = h("select", { style: `${fieldStyle};${style}` });
            for (const [v, l] of options) sel.append(h("option", { value: v }, l));
            sel.value = value;
            sel.addEventListener("change", () => onChange(sel.value));
            return sel;
        };
        const destOptions = (noneLabel) => [
            ...(noneLabel ? [["", noneLabel]] : []),
            ...Object.entries(this.settings.destinations).map(([k, d]) => [k, d.name || "(unnamed)"]),
        ];
        const toggle = (key, label) => {
            const cb = h("input", { type: "checkbox", checked: !!this.settings[key] });
            cb.addEventListener("change", () => {
                this.settings[key] = cb.checked;
                this.save();
            });
            return h("label", { style: "display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer" }, cb, label);
        };

        const render = () => {
            root.innerHTML = "";
            const s = this.settings;

            /* Bot token */
            const tokenInput = h("input", { type: "password", value: s.botToken, placeholder: "Bot token", style: inputStyle, autocomplete: "off" });
            tokenInput.addEventListener("change", () => {
                s.botToken = this.cleanToken(tokenInput.value);
                tokenInput.value = s.botToken;
                this.save();
                if (s.botToken && !TOKEN_RE.test(s.botToken)) UI.showToast("This does not look like a valid bot token.", { type: "error" });
            });
            root.append(
                h("div", { style: headStyle }, "Bot token"),
                tokenInput,
                h("div", { style: noteStyle }, "Stored unencrypted in the plugin data on your computer. Share it with no one and reset it in the Developer Portal if it leaks.")
            );

            /* Log channels */
            root.append(h("div", { style: headStyle }, "Log channels"));
            const destEntries = Object.entries(s.destinations);
            if (!destEntries.length) root.append(h("div", { style: "opacity:.7" }, "No log channel yet. Add one below."));
            for (const [key, d] of destEntries) {
                const nameInput = h("input", { type: "text", value: d.name, placeholder: "Name (e.g. Giveaways)", style: `${fieldStyle};width:30%` });
                nameInput.addEventListener("change", () => {
                    d.name = nameInput.value.trim() || "Unnamed";
                    this.save();
                    render();
                });
                const idInput = h("input", { type: "text", value: d.channelId, placeholder: "Channel ID", style: `${fieldStyle};flex:1;min-width:0` });
                idInput.addEventListener("change", () => {
                    d.channelId = idInput.value.trim();
                    idInput.value = d.channelId;
                    this.save();
                    if (d.channelId && !ID_RE.test(d.channelId)) UI.showToast("This does not look like a valid channel ID.", { type: "error" });
                });
                const radio = h("input", { type: "radio", name: "channellogger-default", checked: s.defaultDest === key });
                radio.addEventListener("change", () => {
                    s.defaultDest = key;
                    this.save();
                    render();
                });
                root.append(
                    h(
                        "div",
                        { style: rowStyle },
                        nameInput,
                        idInput,
                        h("label", { style: "display:flex;align-items:center;gap:4px;white-space:nowrap;cursor:pointer" }, radio, "Default"),
                        h("button", { style: btnStyle, onclick: () => this.sendTest(key) }, "Test"),
                        h("button", { style: dangerStyle, onclick: () => { delete s.destinations[key]; this.save(); render(); } }, "Remove")
                    )
                );
            }
            root.append(
                h(
                    "div",
                    { style: "display:flex;align-items:center;margin-top:8px" },
                    h(
                        "button",
                        {
                            style: btnStyle.replace("margin-left:8px;", ""),
                            onclick: () => {
                                const key = newKey();
                                s.destinations[key] = { name: `Log ${Object.keys(s.destinations).length + 1}`, channelId: "" };
                                if (!s.defaultDest) s.defaultDest = key;
                                this.save();
                                render();
                            },
                        },
                        "Add log channel"
                    ),
                    h(
                        "button",
                        {
                            style: btnStyle,
                            onclick: async (ev) => {
                                ev.target.disabled = true;
                                ev.target.textContent = "Working…";
                                await this.runDiagnose();
                                render();
                            },
                        },
                        "Diagnose"
                    )
                ),
                h("div", { style: noteStyle }, "Turn on Developer Mode, right-click a log channel and choose 'Copy Channel ID'. The default log channel is used when nothing below says otherwise."),
                this.diagText
                    ? h("pre", { style: "white-space:pre-wrap;user-select:text;margin-top:8px;padding:8px;border-radius:4px;font-size:12px;background:var(--background-tertiary,#1e1f22)" }, this.diagText)
                    : ""
            );

            /* Routing */
            root.append(
                h("div", { style: headStyle }, "Routing"),
                h("div", { style: noteStyle }, "Priority: keyword routes, then the edited/deleted overrides, then the log channel chosen for the logged channel, category or server, then the default.")
            );
            const noDests = !Object.keys(s.destinations).length;
            for (const [ev, label] of [["edit", "Edited messages go to"], ["delete", "Deleted messages go to"]]) {
                root.append(
                    h(
                        "div",
                        { style: rowStyle },
                        h("span", { style: "min-width:190px" }, label),
                        select(destOptions("Same as the channel's log channel"), s.eventRoutes[ev] || "", (v) => { s.eventRoutes[ev] = v; this.save(); }, "flex:1")
                    )
                );
            }
            root.append(h("div", { style: "font-weight:600;margin:12px 0 4px" }, "Keyword routes"));
            if (!s.keywordRoutes.length) root.append(h("div", { style: "opacity:.7" }, "None. Messages containing these keywords are sent to the chosen log channel instead."));
            s.keywordRoutes.forEach((r, i) => {
                const kw = h("input", { type: "text", value: r.keywords, placeholder: "e.g. giveaway, nitro", style: `${fieldStyle};flex:1;min-width:0` });
                kw.addEventListener("change", () => {
                    r.keywords = kw.value;
                    this.save();
                });
                root.append(
                    h(
                        "div",
                        { style: rowStyle },
                        kw,
                        h("span", {}, "→"),
                        select(destOptions(""), r.dest, (v) => { r.dest = v; this.save(); }, "width:35%"),
                        h("button", { style: dangerStyle, onclick: () => { s.keywordRoutes.splice(i, 1); this.save(); render(); } }, "Remove")
                    )
                );
            });
            root.append(
                h(
                    "button",
                    {
                        style: btnStyle.replace("margin-left:8px;", "") + ";margin-top:6px",
                        disabled: noDests,
                        onclick: () => {
                            s.keywordRoutes.push({ keywords: "", dest: s.defaultDest || Object.keys(s.destinations)[0] });
                            this.save();
                            render();
                        },
                    },
                    "Add keyword route"
                )
            );

            /* Options */
            root.append(
                h("div", { style: headStyle }, "Options"),
                toggle("logEdits", "Log edited messages"),
                toggle("logDeletes", "Log deleted messages"),
                toggle("ignoreBots", "Ignore messages from bots"),
                toggle("ignoreSelf", "Ignore my own messages")
            );
            const kwFilter = h("input", { type: "text", value: s.keywords, placeholder: "e.g. giveaway, update (empty = log everything)", style: inputStyle });
            kwFilter.addEventListener("change", () => {
                s.keywords = kwFilter.value;
                this.save();
            });
            root.append(h("div", { style: headStyle }, "Only log messages containing (comma-separated)"), kwFilter);

            /* Logged sources */
            const list = (title, store, labelFn) => {
                const ids = Object.keys(s[store]);
                const rows = ids.length
                    ? ids.map((id) => {
                          const entry = s[store][id];
                          return h(
                              "div",
                              { style: rowStyle },
                              h("span", { style: "flex:1" }, labelFn(entry)),
                              select(destOptions(`Default ("${this.destName(s.defaultDest)}")`), entry.dest || "", (v) => { entry.dest = v; this.save(); }, "width:38%"),
                              h("button", { style: dangerStyle, onclick: () => { delete s[store][id]; this.save(); render(); } }, "Remove")
                          );
                      })
                    : [h("div", { style: "opacity:.7" }, "Nothing yet. Right-click a channel or server.")];
                root.append(h("div", { style: headStyle }, title), ...rows);
            };
            list("Logged channels / categories", "channels", (c) => `${c.guildName} › ${c.label}`);
            list("Fully logged servers", "guilds", (g) => g.label);
        };

        render();
        return root;
    }

    /* ---------- test & diagnose ---------- */

    sendTest(destKey) {
        if (!this.running) return UI.showToast("Plugin is not running.", { type: "error" });
        this.enqueue(
            {
                title: "ChannelLogger test",
                description: `If you see this, the bot works. Log channel: ${this.destName(destKey)}`,
                color: COLORS.info,
                timestamp: new Date().toISOString(),
            },
            destKey
        );
    }

    async runDiagnose() {
        const lines = [];
        const add = (t) => lines.push(t);
        add(`Plugin: ${this.meta?.version || "?"} | BetterDiscord: ${BdApi.version ?? "unknown"} | Net.fetch: ${typeof BdApi.Net?.fetch}`);
        add(`Token format valid: ${TOKEN_RE.test(this.cleanToken(this.settings.botToken))}`);

        const oneLine = (t) => String(t).replace(/\s+/g, " ").slice(0, 150);
        const attempt = async (label, fn, fmt) => {
            try {
                const r = await fn();
                let t = "";
                try { t = await r.text(); } catch (_) {}
                add(`${label}: HTTP ${r.status} ${fmt ? fmt(t) : oneLine(t)}`);
            } catch (e) {
                add(`${label}: ERROR ${e?.name || ""}: ${e?.message || e}`);
            }
        };
        const json = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };

        if (typeof BdApi.Net?.fetch === "function" && TOKEN_RE.test(this.cleanToken(this.settings.botToken))) {
            await attempt("A. Who is the bot (GET /users/@me)", () => netFetch(`${API}/users/@me`, { headers: this.botHeaders() }), (t) => {
                const j = json(t);
                return j?.username ? `bot=${j.username}` : oneLine(t);
            });
            const dests = Object.values(this.settings.destinations);
            if (!dests.length) add("No log channels configured.");
            for (const d of dests) {
                const id = (d.channelId || "").trim();
                if (!ID_RE.test(id)) {
                    add(`"${d.name}": channel ID format is not valid`);
                    continue;
                }
                await attempt(`"${d.name}" look up (GET /channels/{id})`, () => netFetch(`${API}/channels/${id}`, { headers: this.botHeaders() }), (t) => {
                    const j = json(t);
                    return j?.name ? `channel=#${j.name} type=${j.type}` : oneLine(t);
                });
                await attempt(
                    `"${d.name}" post test (POST /channels/{id}/messages)`,
                    () =>
                        netFetch(`${API}/channels/${id}/messages`, {
                            method: "POST",
                            headers: this.botHeaders(),
                            body: JSON.stringify({ embeds: [{ title: "ChannelLogger diagnose", description: `This request went through (${d.name}).`, color: COLORS.info }] }),
                        }),
                    (t) => (json(t)?.id ? "message posted" : oneLine(t))
                );
            }
        } else {
            add("Fill in a valid bot token first.");
        }

        this.diagText = lines.join("\n");
        console.log("[ChannelLogger] Diagnose\n" + this.diagText);
    }
};
