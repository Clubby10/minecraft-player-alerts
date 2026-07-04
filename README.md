# Minecraft Discord Alerts

Mineflayer Discord bot for joining a Minecraft server, sending commands, and alerting when non-whitelisted players are nearby.

## Setup

1. Install Node.js 18+.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in Discord values.
4. Copy `config.example.json` to `config.json` and edit bot settings.
5. Run `npm start`.

Set `GUILD_ID` in `.env` for faster slash command updates during testing.

## Commands

- `/join`, `/leave`, `/status`
- `/config` - private settings menu for server, account, alerts, and channel config
- `/whitelist add player`, `/whitelist remove player`, `/whitelist list`
- `/sudo command`, `/warp name`, `/move x y z range`
- `/admin add user`, `/admin list`

## Permissions

Most commands allow Discord `Administrator`, `discord.adminUserIds`, or `discord.adminRoleIds`.

`/config` requires `discord.adminUserIds`. `/admin` also requires `discord.adminUserIds`, except Discord `Administrator` users can add the first verified admin when the list is empty.
