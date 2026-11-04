# ChannelLogger

A [BetterDiscord](https://betterdiscord.app) plugin that logs new, edited and deleted messages from channels you choose and posts them as embeds in a log channel in **your own server**, through **your own Discord bot**.

Reading happens in your Discord client (the plugin only sees what your client already receives), so channels in servers your bot is *not* a member of can be logged too. The bot only needs to write to your log channel.

## Features

- Right-click a channel, category or server to start or stop logging it, and pick **which log channel** it goes to
- **Multiple log channels** with routing rules: per source, per event (edits / deletes) and per keyword
- Logs new messages, edits (old and new text) and deletions
- Images are shown directly inside the log embed (as an image grid, up to 4 per grid); other attachments are listed as links
- A link back to the original message, plus author, server and channel
- Filters: ignore bots, ignore your own messages, keyword filter
- Send queue with rate-limit handling, mentions in logs never ping anyone
- Built-in **Diagnose** button to check bot, channel and permissions
- Server channels only; DMs are never logged

## Requirements

- BetterDiscord 1.9.7 or newer (the plugin was tested on 1.14.4)
- A Discord bot in your own server (see below)

## Install

1. Download `ChannelLogger.plugin.js`.
2. Put it in your BetterDiscord plugins folder (Settings → Plugins → *Open Plugins Folder*).
3. Enable the plugin.

## Set up the bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a **New Application**.
2. Open the **Bot** tab, click **Reset Token** and copy the token. No privileged intents are needed.
3. Under **OAuth2 → URL Generator** choose the scope `bot` and the permissions **View Channels**, **Send Messages** and **Embed Links**. Use *Guild Install*.
4. Open the generated link and invite the bot to **your own** server.
5. Make sure the bot can write in your log channel.
6. Turn on Developer Mode in Discord (Settings → Advanced), right-click the log channel and choose *Copy Channel ID*.
7. Open the plugin settings, paste the bot token, press **Add log channel**, give it a name and paste the channel ID. Press **Diagnose**: the bot check and, for every log channel, the lookup and the test post should succeed.

## Usage

Right-click a channel, category or server and choose where to log it. With a single log channel this is one toggle; with several it is a submenu (**Log to default**, **Log to "Name"**, **Stop logging**). Everything that is being logged is listed in the plugin settings, where you can also change the log channel per entry.

## Multiple log channels and routing

Add as many log channels as you like (each is a channel in your own server that your bot can write to) and mark one as the **default**. For every message the log channel is chosen in this order, first match wins:

1. **Keyword routes**: if the message contains one of the route's keywords (comma-separated, case-insensitive), it goes to that route's log channel.
2. **Event override**: edited and deleted messages can be sent to their own log channel, for example a dedicated "deletes" channel.
3. **The log channel chosen for the logged channel, category or server** (right-click menu or the list in the settings).
4. **The default log channel.**

Example: log a whole server to "General", send everything containing `giveaway` or `nitro` to "Giveaways", and send all deleted messages to "Deletes".

Settings from version 1.1.x are migrated automatically: the old single log channel becomes your default log channel.

## Limitations

- Edited or deleted messages only show their old content if the message was posted while the plugin was running (in-memory cache of the last 2000 messages).
- Messages longer than ~3800 characters are truncated; the link to the original is included.
- Images are displayed from the original Discord attachment links. Those links can expire, so images in old logs may stop loading at some point.
- Videos and other files cannot be shown inside an embed and are listed as links. Attachments marked as spoiler are also kept as links, so they stay hidden.
- More than 4 images in one message are shown as several image grids below each other (Discord allows at most 10 attachments per message).

## Security and privacy

- The bot token is stored unencrypted in BetterDiscord's plugin data on your computer, like any BetterDiscord plugin setting. Treat it like a password, keep the bot private ("Public Bot" off) and in your own server only, and reset the token if it may have leaked. **Never commit a token to a repository.**
- You are collecting messages written by other people. Keep the log channel private, respect the rules of the servers you are in, and be aware of privacy laws such as the GDPR if you store or share logs.
- BetterDiscord is a client modification and is not allowed by Discord's Terms of Service. Use this plugin at your own risk.

## Troubleshooting

Press **Diagnose** in the plugin settings and look at the output:

- `HTTP 401`: bot token invalid or reset
- `HTTP 403` / *Missing Access*: the bot lacks permissions in the log channel
- `HTTP 404`: wrong channel ID

## License

MIT, see [LICENSE](LICENSE).
