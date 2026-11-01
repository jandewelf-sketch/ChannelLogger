/**
 * @name ChannelLogger
 * @author jandewelf-sketch
 * @description Logs new, edited, and deleted messages from selected server channels to a log channel in your own server, using your own Discord bot.
 * @version 1.1.0
 */

const { Data, UI, ContextMenu, Webpack } = BdApi;

const COLORS = { create: 0x57f287, edit: 0xfee75c, delete: 0xed4245, info: 0x5865f2 };
const CACHE_LIMIT = 2000;
const QUEUE_LIMIT = 1000;
const API = "https://discord.com/api/v10";
const UA = "DiscordBot (ChannelLogger, 1.1.0)";
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

// Requests are routed through BetterDiscord's own network layer, rather than the client's browser fetch.
const netFetch = (url, opts = {}) => {
    if (!BdApi.Net || typeof BdApi.Net.fetch !== "function") {
        throw new Error("BdApi.Net.fetch ontbreekt. Update BetterDiscord.");
    }
    return BdApi.Net.fetch(url, opts);
};

module.exports = class ChannelLogger {
    constructor(meta) {
        this.meta = meta;
        this.name = meta?.name || "ChannelLogger";
        this.defaults = {
            botToken: "",
            logChannelId: "",
            ignoreBots: false,
            ignoreSelf: false,
            logEdits: true,
            logDeletes: true,
            keywords: "",
            channels: {}, // id -> { label, guildName }
            guilds: {}, // id -> { label }
        };
        this.cache = new Map();
        this.queue = [];
        this.pumping = false;
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
            console.error("[ChannelLogger] Niet gevonden:", missing);
            UI.showToast(`ChannelLogger: kon niet vinden: ${missing.join(", ")}`, { type: "error" });
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
    }

    safe(fn) {
        try { fn(); } catch (err) { console.error("[ChannelLogger]", err); }
    }

    /* ---------- settings ---------- */

    loadSettings() {
        const saved = Data.load(this.name, "settings") || {};
        this.settings = Object.assign({}, this.defaults, saved);
        this.settings.channels = this.settings.channels || {};
        this.settings.guilds = this.settings.guilds || {};
        this.refreshBotId();
    }

    save() {
        Data.save(this.name, "settings", this.settings);
        this.refreshBotId();
    }

    cleanToken(t) {
        return (t || "").trim().replace(/^Bot\s+/i, "");
    }

    // The first part of a bot token is the Base64-encoded bot ID.
    refreshBotId() {
        this.botUserId = null;
        try {
            const part = this.cleanToken(this.settings.botToken).split(".")[0];
            const id = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
            if (/^\d+$/.test(id)) this.botUserId = id;
        } catch (_) {}
    }

    isConfigured() {
        return TOKEN_RE.test(this.cleanToken(this.settings.botToken)) && ID_RE.test((this.settings.logChannelId || "").trim());
    }

    /* ---------- filters ---------- */

    isMonitored(channelId) {
        if (channelId === (this.settings.logChannelId || "").trim()) return false; // nooit het logkanaal zelf
        const channel = this.ChannelStore.getChannel(channelId);
        if (!channel || !channel.guild_id) return false; // geen DM's
        const { channels, guilds } = this.settings;
        if (channels[channelId] || guilds[channel.guild_id]) return true;
        if (channel.parent_id) {
            if (channels[channel.parent_id]) return true; // kanaal of categorie als ouder
            const parent = this.ChannelStore.getChannel(channel.parent_id);
            if (parent?.parent_id && channels[parent.parent_id]) return true; // thread in kanaal in categorie
        }
        return false;
    }

    passesAuthorFilters(author) {
        if (!author) return true;
        if (this.botUserId && author.id === this.botUserId) return false; // voorkom loops
        if (this.settings.ignoreBots && author.bot) return false;
        if (this.settings.ignoreSelf && author.id === this.UserStore.getCurrentUser()?.id) return false;
        return true;
    }

    matchesKeywords(text) {
        const kws = this.settings.keywords
            .split(",")
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean);
        if (!kws.length) return true;
        const t = (text || "").toLowerCase();
        return kws.some((k) => t.includes(k));
    }

    /* ---------- event handlers ---------- */

    handleCreate(e) {
        if (e.optimistic || e.isPushNotification) return;
        const msg = e.message;
        if (!msg) return;
        const channelId = e.channelId || msg.channel_id;
        if (!this.isMonitored(channelId)) return;
        if (!this.passesAuthorFilters(msg.author)) return;

        this.remember(msg, channelId);
        if (!this.matchesKeywords(msg.content)) return;
        this.enqueue(this.buildEmbed("create", { msg, channelId, content: msg.content || "", attachments: msg.attachments, stickers: msg.sticker_items }));
    }

    handleUpdate(e) {
        if (!this.settings.logEdits) return;
        const msg = e.message;
        if (!msg || typeof msg.content !== "string") return;
        const channelId = msg.channel_id || e.channelId;
        if (!this.isMonitored(channelId)) return;

        const cached = this.cache.get(msg.id);
        const author = msg.author || cached?.author;
        if (!this.passesAuthorFilters(author)) return;

        if (cached) {
            if (cached.content === msg.content) return; // geen echte bewerking
        } else if (!msg.edited_timestamp) {
            return; // embed-update zonder bewerking
        }

        const old = cached ? cached.content : null;
        this.cache.set(msg.id, { ...(cached || { timestamp: msg.timestamp, attachments: [] }), channelId, content: msg.content, author });

        if (!this.matchesKeywords(msg.content) && !this.matchesKeywords(old)) return;
        this.enqueue(this.buildEmbed("edit", { msg: { ...msg, author }, channelId, content: msg.content, old, attachments: msg.attachments || cached?.attachments }));
    }

    handleDelete(e) {
        this.logDelete(e.id, e.channelId);
    }

    handleBulkDelete(e) {
        for (const id of e.ids || []) this.logDelete(id, e.channelId);
    }

    logDelete(id, channelId) {
        if (!this.settings.logDeletes) return;
        if (!this.isMonitored(channelId)) return;
        const cached = this.cache.get(id);
        this.cache.delete(id);

        if (cached) {
            if (!this.passesAuthorFilters(cached.author)) return;
            if (!this.matchesKeywords(cached.content)) return;
        } else if (this.settings.keywords.trim()) {
            return; // zonder cache kunnen we niet op trefwoorden filteren
        }

        this.enqueue(
            this.buildEmbed("delete", {
                msg: { id, author: cached?.author, timestamp: cached?.timestamp },
                channelId,
                content: cached ? cached.content : null,
                attachments: cached?.attachments,
            })
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
        const authorName = author ? author.global_name || author.username : "Onbekende gebruiker";

        const stickerText = (stickers || []).map((s) => `*(sticker: ${s.name})*`).join(" ");
        const placeholder = "*(geen tekst — embed, bijlage of sticker)*";
        let description;

        if (kind === "edit") {
            const oldText = old === null ? "*(onbekend — stond niet in cache)*" : cut(old || "*(leeg)*", 1800);
            description = `**Nieuw**\n${cut(content || placeholder, 1800)}\n\n**Oud**\n${oldText}`;
        } else if (kind === "delete") {
            description = content === null ? "*(inhoud onbekend — bericht stond niet in cache)*" : cut(content || placeholder, 3800);
        } else {
            description = cut([content, stickerText].filter(Boolean).join("\n") || placeholder, 3800);
        }

        const embed = {
            title: { create: "Nieuw bericht", edit: "Bericht bewerkt", delete: "Bericht verwijderd" }[kind],
            description,
            color: COLORS[kind],
            author: { name: cut(authorName, 200), icon_url: this.avatarUrl(author) },
            footer: {
                text: cut(`${guild?.name ?? "Onbekende server"} • #${channel?.name ?? channelId}${author?.id ? ` • ID ${author.id}` : ""}`, 500),
            },
            timestamp: kind === "delete" ? new Date().toISOString() : msg.edited_timestamp || msg.timestamp || new Date().toISOString(),
        };

        if (kind !== "delete" && channel?.guild_id && msg.id) {
            embed.url = `https://discord.com/channels/${channel.guild_id}/${channelId}/${msg.id}`;
        }

        if (attachments?.length) {
            const lines = attachments.map((a) => `[${a.filename || "bijlage"}](${a.url})`).join("\n");
            embed.fields = [{ name: "Bijlagen", value: cut(lines, 1000) }];
            const img = attachments.find((a) => a.content_type?.startsWith("image/"));
            if (img) embed.image = { url: img.url };
        }

        return embed;
    }

    /* ---------- verzenden via de bot ---------- */

    botHeaders() {
        return {
            Authorization: `Bot ${this.cleanToken(this.settings.botToken)}`,
            "Content-Type": "application/json",
            "User-Agent": UA,
        };
    }

    enqueue(embed) {
        if (!this.isConfigured()) {
            if (!this.warnedNotConfigured) {
                this.warnedNotConfigured = true;
                UI.showToast("ChannelLogger: stel eerst een geldige bot-token en kanaal-ID in.", { type: "warning" });
            }
            return;
        }
        this.warnedNotConfigured = false;
        this.queue.push(embed);
        if (this.queue.length > QUEUE_LIMIT) this.queue.shift();
        this.pump();
    }

    hint(status) {
        if (status === 401) return "Bot-token ongeldig of ingetrokken.";
        if (status === 403) return "De bot heeft geen toegang of rechten in het logkanaal (Kanaal bekijken, Berichten sturen, Embeds insluiten).";
        if (status === 404) return "Logkanaal niet gevonden. Klopt het kanaal-ID?";
        return "";
    }

    async pump() {
        if (this.pumping) return;
        this.pumping = true;
        let failures = 0;
        try {
            while (this.running && this.queue.length) {
                const batch = [];
                let size = 0;
                while (this.queue.length && batch.length < 10) {
                    const s = embedSize(this.queue[0]);
                    if (batch.length && size + s > 5500) break;
                    size += s;
                    batch.push(this.queue.shift());
                }

                const res = await this.send(batch);
                if (res.ok) {
                    failures = 0;
                } else if (res.retryAfter) {
                    this.queue.unshift(...batch);
                    await sleep(res.retryAfter * 1000 + 100);
                    continue;
                } else {
                    failures++;
                    if (failures >= 3 || res.fatal) {
                        const extra = this.hint(res.status);
                        UI.showToast(
                            `ChannelLogger: versturen mislukt${res.status ? ` (HTTP ${res.status})` : ""}${res.detail ? `: ${res.detail}` : ""}${extra ? ` — ${extra}` : ""}`,
                            { type: "error", timeout: 10000 }
                        );
                        failures = 0; // batch laten vallen
                    } else {
                        this.queue.unshift(...batch);
                        await sleep(3000);
                        continue;
                    }
                }
                await sleep(1000);
            }
        } finally {
            this.pumping = false;
        }
    }

    async send(embeds) {
        try {
            const res = await netFetch(`${API}/channels/${this.settings.logChannelId.trim()}/messages`, {
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
                console.error("[ChannelLogger] Verzenden mislukt", res.status, raw.slice(0, 500));
                return { ok: false, status: res.status, detail, fatal: res.status >= 400 && res.status < 500 };
            }
            return { ok: true };
        } catch (err) {
            console.error("[ChannelLogger] netwerkfout", err);
            return { ok: false, fatal: true, detail: String(err?.message || err) };
        }
    }

    /* ---------- context menus ---------- */

    patchChannelMenu(tree, props) {
        const channel = props?.channel;
        const children = tree?.props?.children;
        if (!channel?.guild_id || !Array.isArray(children)) return;
        children.push(
            ContextMenu.buildItem({ type: "separator" }),
            ContextMenu.buildItem({
                type: "toggle",
                label: channel.type === 4 ? "Log deze categorie" : "Log dit kanaal",
                checked: !!this.settings.channels[channel.id],
                action: () => this.toggleChannel(channel),
            })
        );
    }

    patchGuildMenu(tree, props) {
        const guild = props?.guild;
        const children = tree?.props?.children;
        if (!guild || !Array.isArray(children)) return;
        children.push(
            ContextMenu.buildItem({ type: "separator" }),
            ContextMenu.buildItem({
                type: "toggle",
                label: "Log hele server",
                checked: !!this.settings.guilds[guild.id],
                action: () => this.toggleGuild(guild),
            })
        );
    }

    toggleChannel(channel) {
        const label = `${channel.type === 4 ? "📁 " : "#"}${channel.name}`;
        if (this.settings.channels[channel.id]) {
            delete this.settings.channels[channel.id];
            UI.showToast(`Logging gestopt: ${label}`, { type: "info" });
        } else {
            const guild = this.GuildStore.getGuild(channel.guild_id);
            this.settings.channels[channel.id] = { label, guildName: guild?.name || "?" };
            UI.showToast(`Logging gestart: ${label}`, { type: "success" });
            if (!this.isConfigured()) UI.showToast("Let op: bot-token of kanaal-ID is nog niet ingesteld.", { type: "warning" });
        }
        this.save();
    }

    toggleGuild(guild) {
        if (this.settings.guilds[guild.id]) {
            delete this.settings.guilds[guild.id];
            UI.showToast(`Logging gestopt: ${guild.name}`, { type: "info" });
        } else {
            this.settings.guilds[guild.id] = { label: guild.name };
            UI.showToast(`Logging gestart voor hele server: ${guild.name}`, { type: "success" });
            if (!this.isConfigured()) UI.showToast("Let op: bot-token of kanaal-ID is nog niet ingesteld.", { type: "warning" });
        }
        this.save();
    }

    /* ---------- settings panel ---------- */

    getSettingsPanel() {
        if (!this.settings) this.loadSettings();
        const root = h("div", { style: "color:var(--text-normal);padding:8px 0" });
        const inputStyle =
            "width:100%;padding:8px;border-radius:4px;border:none;box-sizing:border-box;background:var(--background-tertiary,#1e1f22);color:var(--text-normal)";
        const btnStyle = "padding:6px 12px;border-radius:4px;border:none;cursor:pointer;background:var(--brand-experiment,#5865f2);color:#fff;margin-left:8px";
        const headStyle = "font-weight:600;margin:16px 0 6px;color:var(--header-primary)";
        const noteStyle = "font-size:12px;opacity:.7;margin-top:4px";

        const render = () => {
            root.innerHTML = "";

            // Bot-token (verborgen invoer)
            const tokenInput = h("input", { type: "password", value: this.settings.botToken, placeholder: "Bot-token", style: inputStyle, autocomplete: "off" });
            tokenInput.addEventListener("change", () => {
                this.settings.botToken = this.cleanToken(tokenInput.value);
                tokenInput.value = this.settings.botToken;
                this.save();
                if (this.settings.botToken && !TOKEN_RE.test(this.settings.botToken)) UI.showToast("Dit lijkt geen geldige bot-token.", { type: "error" });
            });

            // Kanaal-ID
            const chanInput = h("input", { type: "text", value: this.settings.logChannelId, placeholder: "ID van je logkanaal", style: inputStyle });
            chanInput.addEventListener("change", () => {
                this.settings.logChannelId = chanInput.value.trim();
                chanInput.value = this.settings.logChannelId;
                this.save();
                if (this.settings.logChannelId && !ID_RE.test(this.settings.logChannelId)) UI.showToast("Dit lijkt geen geldig kanaal-ID.", { type: "error" });
            });

            const testBtn = h("button", { style: btnStyle, onclick: () => this.sendTest() }, "Stuur test");
            const diagBtn = h(
                "button",
                {
                    style: btnStyle,
                    onclick: async (ev) => {
                        ev.target.disabled = true;
                        ev.target.textContent = "Bezig…";
                        await this.runDiagnose();
                        render();
                    },
                },
                "Diagnose"
            );

            root.append(
                h("div", { style: headStyle }, "Bot-token"),
                tokenInput,
                h("div", { style: noteStyle }, "Staat leesbaar in de plugin-data op je computer. Deel hem met niemand en reset hem in het Developer Portal als hij lekt."),
                h("div", { style: headStyle }, "Kanaal-ID van je logkanaal"),
                h("div", { style: "display:flex;align-items:center" }, chanInput, testBtn, diagBtn),
                h("div", { style: noteStyle }, "Zet Ontwikkelaarsmodus aan, rechtsklik op het logkanaal en kies 'Kanaal-ID kopiëren'."),
                this.diagText
                    ? h("pre", { style: "white-space:pre-wrap;user-select:text;margin-top:8px;padding:8px;border-radius:4px;font-size:12px;background:var(--background-tertiary,#1e1f22)" }, this.diagText)
                    : ""
            );

            const toggle = (key, label) => {
                const cb = h("input", { type: "checkbox", checked: !!this.settings[key] });
                cb.addEventListener("change", () => {
                    this.settings[key] = cb.checked;
                    this.save();
                });
                return h("label", { style: "display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer" }, cb, label);
            };
            root.append(
                h("div", { style: headStyle }, "Opties"),
                toggle("logEdits", "Bewerkte berichten loggen"),
                toggle("logDeletes", "Verwijderde berichten loggen"),
                toggle("ignoreBots", "Berichten van bots negeren"),
                toggle("ignoreSelf", "Mijn eigen berichten negeren")
            );

            const kw = h("input", { type: "text", value: this.settings.keywords, placeholder: "bv. giveaway, update (leeg = alles loggen)", style: inputStyle });
            kw.addEventListener("change", () => {
                this.settings.keywords = kw.value;
                this.save();
            });
            root.append(h("div", { style: headStyle }, "Trefwoorden (komma-gescheiden)"), kw);

            const list = (title, obj, labelFn, key) => {
                const ids = Object.keys(obj);
                const items = ids.length
                    ? ids.map((id) =>
                          h(
                              "div",
                              { style: "display:flex;justify-content:space-between;align-items:center;padding:4px 0" },
                              h("span", {}, labelFn(obj[id])),
                              h("button", { style: btnStyle, onclick: () => { delete this.settings[key][id]; this.save(); render(); } }, "Verwijder")
                          )
                      )
                    : [h("div", { style: "opacity:.7" }, "Nog niets. Rechtsklik op een kanaal of server.")];
                root.append(h("div", { style: headStyle }, title), ...items);
            };
            list("Gelogde kanalen / categorieën", this.settings.channels, (c) => `${c.guildName} › ${c.label}`, "channels");
            list("Volledig gelogde servers", this.settings.guilds, (g) => g.label, "guilds");
        };

        render();
        return root;
    }

    /* ---------- test & diagnose ---------- */

    sendTest() {
        if (!this.running) return UI.showToast("Plugin is niet actief.", { type: "error" });
        this.enqueue({
            title: "ChannelLogger test",
            description: "Als je dit ziet, werkt de bot.",
            color: COLORS.info,
            timestamp: new Date().toISOString(),
        });
    }

    async runDiagnose() {
        const lines = [];
        const add = (t) => lines.push(t);
        add(`Plugin: ${this.meta?.version || "?"} | BetterDiscord: ${BdApi.version ?? "onbekend"} | Net.fetch: ${typeof BdApi.Net?.fetch}`);
        add(`Token geldig van vorm: ${TOKEN_RE.test(this.cleanToken(this.settings.botToken))} | Kanaal-ID geldig van vorm: ${ID_RE.test((this.settings.logChannelId || "").trim())}`);

        const oneLine = (t) => String(t).replace(/\s+/g, " ").slice(0, 150);
        const attempt = async (label, fn, fmt) => {
            try {
                const r = await fn();
                let t = "";
                try { t = await r.text(); } catch (_) {}
                add(`${label}: HTTP ${r.status} ${fmt ? fmt(t) : oneLine(t)}`);
            } catch (e) {
                add(`${label}: FOUT ${e?.name || ""}: ${e?.message || e}`);
            }
        };
        const json = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };

        if (typeof BdApi.Net?.fetch === "function") {
            if (this.isConfigured()) {
                const id = this.settings.logChannelId.trim();
                await attempt("A. Wie is de bot (GET /users/@me)", () => netFetch(`${API}/users/@me`, { headers: this.botHeaders() }), (t) => {
                    const j = json(t);
                    return j?.username ? `bot=${j.username}` : oneLine(t);
                });
                await attempt("B. Logkanaal opzoeken (GET /channels/{id})", () => netFetch(`${API}/channels/${id}`, { headers: this.botHeaders() }), (t) => {
                    const j = json(t);
                    return j?.name ? `kanaal=#${j.name} type=${j.type}` : oneLine(t);
                });
                await attempt(
                    "C. Testbericht plaatsen (POST /channels/{id}/messages)",
                    () =>
                        netFetch(`${API}/channels/${id}/messages`, {
                            method: "POST",
                            headers: this.botHeaders(),
                            body: JSON.stringify({ embeds: [{ title: "ChannelLogger diagnose", description: "Dit verzoek kwam door.", color: COLORS.info }] }),
                        }),
                    (t) => (json(t)?.id ? "bericht geplaatst" : oneLine(t))
                );
            } else {
                add("Vul eerst een geldige bot-token en kanaal-ID in.");
            }
        }

        this.diagText = lines.join("\n");
        console.log("[ChannelLogger] Diagnose\n" + this.diagText);
    }
};
