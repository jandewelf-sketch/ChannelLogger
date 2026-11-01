# ChannelLogger

A [BetterDiscord](https://betterdiscord.app) plugin that logs new, edited and deleted messages from channels you choose and posts them as embeds in a log channel in **your own server**, through **your own Discord bot**.

Reading happens in your Discord client (the plugin only sees what your client already receives), so channels in servers your bot is *not* a member of can be logged too. The bot only needs to write to your log channel.

## Features

- Right-click a channel, category or server to start or stop logging it
- Logs new messages, edits (old and new text) and deletions
- Attachments as links, a link back to the original message, author, server and channel
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
7. Open the plugin settings, paste the bot token and the channel ID, and press **Diagnose**. Steps A, B and C should succeed.

## Usage

Right-click a channel, category or server and toggle **Log this channel** / **Log this category** / **Log whole server**. Everything that is being logged is listed in the plugin settings.

## Limitations

- Edited or deleted messages only show their old content if the message was posted while the plugin was running (in-memory cache of the last 2000 messages).
- Messages longer than ~3800 characters are truncated; the link to the original is included.
- Attachment links expire after a while, so images in old logs may stop loading.

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
