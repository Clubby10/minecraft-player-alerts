require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const {
  ActionRowBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const DEFAULT_CONFIG = {
  minecraft: {
    host: 'localhost',
    port: 25565,
    username: 'AlertBot',
    auth: 'microsoft',
    version: '1.8.9',
    joinCommand: ''
  },
  discord: {
    alertChannelId: '',
    adminRoleIds: [],
    adminUserIds: []
  },
  alerts: {
    enabled: true,
    radius: 64,
    pollMs: 3000,
    repeatAlertMs: 60000
  },
  whitelist: []
};

let config = loadConfig();
let mcBot = null;
let alertTimer = null;
let lastAlertAt = new Map();
let reconnecting = false;

const discord = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function privateResponse(contentOrOptions) {
  const options = typeof contentOrOptions === 'string'
    ? { content: contentOrOptions }
    : contentOrOptions;
  return { ...options, flags: MessageFlags.Ephemeral };
}

function publicResponse(contentOrOptions) {
  return typeof contentOrOptions === 'string'
    ? { content: contentOrOptions }
    : contentOrOptions;
}

function embed(title, description, color = 0x2f80ed) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

function skinUrl(username) {
  return `https://mc-heads.net/avatar/${encodeURIComponent(username || 'Steve')}/128`;
}

function bodyUrl(username) {
  return `https://mc-heads.net/body/${encodeURIComponent(username || 'Steve')}/160`;
}

function maskAccount(value) {
  if (!value) return 'unknown';
  const [name, domain] = value.split('@');
  if (!domain) return `${name.slice(0, 2)}${'*'.repeat(Math.max(3, name.length - 2))}`;
  const visibleStart = name.slice(0, Math.min(2, name.length));
  const visibleEnd = name.length > 4 ? name.slice(-1) : '';
  return `${visibleStart}${'*'.repeat(Math.max(4, name.length - visibleStart.length - visibleEnd.length))}${visibleEnd}@${domain}`;
}

function worldName() {
  const dimension = mcBot?.game?.dimension;
  if (dimension === undefined || dimension === null) return 'Unknown';
  if (dimension === 0 || dimension === 'overworld') return 'Overworld';
  if (dimension === -1 || dimension === 'the_nether' || dimension === 'minecraft:the_nether') return 'Nether';
  if (dimension === 1 || dimension === 'the_end' || dimension === 'minecraft:the_end') return 'End';
  return String(dimension);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return structuredClone(DEFAULT_CONFIG);
  }

  const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return mergeDefaults(DEFAULT_CONFIG, loaded);
}

function mergeDefaults(defaults, loaded) {
  if (Array.isArray(defaults)) return Array.isArray(loaded) ? loaded : defaults;
  if (!defaults || typeof defaults !== 'object') return loaded ?? defaults;

  const merged = { ...defaults };
  for (const [key, value] of Object.entries(loaded || {})) {
    merged[key] = mergeDefaults(defaults[key], value);
  }
  return merged;
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function commands() {
  return [
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('Connect the Minecraft bot to the configured server.'),
    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('Disconnect the Minecraft bot.'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show Minecraft bot status.'),
    new SlashCommandBuilder()
      .setName('sudo')
      .setDescription('Send raw chat text as the Minecraft bot.')
      .addStringOption(option =>
        option
          .setName('command')
          .setDescription('Text to send in Minecraft chat. Include / for commands.')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('warp')
      .setDescription('Run /warp as the Minecraft bot.')
      .addStringOption(option =>
        option
          .setName('name')
          .setDescription('Warp name.')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('move')
      .setDescription('Move the Minecraft bot to coordinates using pathfinding.')
      .addNumberOption(option =>
        option.setName('x').setDescription('Target X coordinate.').setRequired(true)
      )
      .addNumberOption(option =>
        option.setName('y').setDescription('Target Y coordinate.').setRequired(true)
      )
      .addNumberOption(option =>
        option.setName('z').setDescription('Target Z coordinate.').setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName('range')
          .setDescription('How close the bot needs to get. Defaults to 1 block.')
          .setMinValue(0)
          .setMaxValue(10)
      ),
    new SlashCommandBuilder()
      .setName('whitelist')
      .setDescription('Manage players ignored by alerts.')
      .addSubcommand(subcommand =>
        subcommand
          .setName('add')
          .setDescription('Add a Minecraft username to the whitelist.')
          .addStringOption(option =>
            option.setName('player').setDescription('Minecraft username.').setRequired(true)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('remove')
          .setDescription('Remove a Minecraft username from the whitelist.')
          .addStringOption(option =>
            option.setName('player').setDescription('Minecraft username.').setRequired(true)
          )
      )
      .addSubcommand(subcommand =>
        subcommand.setName('list').setDescription('List whitelisted Minecraft usernames.')
      ),
    new SlashCommandBuilder()
      .setName('config')
      .setDescription('View or change bot config.'),
    new SlashCommandBuilder()
      .setName('admin')
      .setDescription('Manage verified bot admins.')
      .addSubcommand(subcommand =>
        subcommand
          .setName('add')
          .setDescription('Add a verified bot admin.')
          .addUserOption(option =>
            option.setName('user').setDescription('Discord user to make a verified bot admin.').setRequired(true)
          )
      )
      .addSubcommand(subcommand =>
        subcommand.setName('list').setDescription('List verified bot admins.')
      )
  ].map(command => command.toJSON());
}

async function registerCommands() {
  if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
    throw new Error('DISCORD_TOKEN and CLIENT_ID must be set in .env');
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands() }
    );
    return;
  }

  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands() });
}

function isAllowed(interaction) {
  const userId = interaction.user.id;
  if (config.discord.adminUserIds.includes(userId)) return true;

  if (!interaction.inGuild()) return false;
  if (hasDiscordAdminPermission(interaction)) return true;

  const roleIds = new Set(config.discord.adminRoleIds);
  const roles = interaction.member?.roles;
  if (roles?.cache) return roles.cache.some(role => roleIds.has(role.id));
  if (Array.isArray(roles)) return roles.some(roleId => roleIds.has(roleId));
  return false;
}

function hasDiscordAdminPermission(interaction) {
  return Boolean(interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function isVerifiedAdmin(interaction) {
  return config.discord.adminUserIds.includes(interaction.user.id);
}

function canManageVerifiedAdmins(interaction) {
  return isVerifiedAdmin(interaction)
    || (config.discord.adminUserIds.length === 0 && hasDiscordAdminPermission(interaction));
}

function requireAllowed(interaction) {
  if (isAllowed(interaction)) return true;
  interaction.reply(privateResponse({
    embeds: [embed('Permission Denied', 'You do not have permission to use this bot.', 0xe74c3c)]
  }));
  return false;
}

function requireVerifiedAdmin(interaction) {
  if (isVerifiedAdmin(interaction)) return true;
  interaction.reply(privateResponse({
    embeds: [embed('Permission Denied', 'Only verified admins listed in config can use this command.', 0xe74c3c)]
  }));
  return false;
}

function requireAdminManager(interaction) {
  if (canManageVerifiedAdmins(interaction)) return true;
  interaction.reply(privateResponse({
    embeds: [embed('Permission Denied', 'Only verified admins listed in config can manage verified admins.', 0xe74c3c)]
  }));
  return false;
}

async function getAlertChannel() {
  if (!config.discord.alertChannelId) return null;
  const channel = await discord.channels.fetch(config.discord.alertChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

async function sendAlert(messageOrOptions) {
  const channel = await getAlertChannel();
  const payload = typeof messageOrOptions === 'string'
    ? { content: messageOrOptions }
    : messageOrOptions;

  if (!channel) {
    console.log(`[alert skipped: no alert channel] ${JSON.stringify(payload)}`);
    return;
  }

  await channel.send(payload).catch(error => {
    console.error('Failed to send Discord alert:', error);
  });
}

function startMinecraftBot() {
  if (mcBot) {
    return { ok: false, message: 'Minecraft bot is already running.' };
  }

  const options = {
    host: config.minecraft.host,
    port: Number(config.minecraft.port),
    username: config.minecraft.username,
    auth: config.minecraft.auth || 'microsoft'
  };

  if (config.minecraft.version) options.version = config.minecraft.version;

  mcBot = mineflayer.createBot(options);
  mcBot.loadPlugin(pathfinder);
  lastAlertAt = new Map();

  mcBot.once('spawn', () => {
    console.log(`Minecraft bot spawned on ${config.minecraft.host}:${config.minecraft.port}`);
    const loginEmbed = embed('Minecraft Bot Online', 'The account joined the configured server.', 0x27ae60)
      .setThumbnail(skinUrl(mcBot.username))
      .addFields(
        { name: 'Username', value: mcBot.username, inline: true },
        { name: 'Server', value: `${config.minecraft.host}:${config.minecraft.port}`, inline: true },
        { name: 'Version', value: String(config.minecraft.version || 'auto'), inline: true },
        { name: 'World', value: worldName(), inline: true }
    );
    sendAlert({ embeds: [loginEmbed] });
    if (config.alerts.enabled) startAlertLoop();

    const command = normalizeMinecraftCommand(config.minecraft.joinCommand);
    if (command) {
      setTimeout(() => {
        if (!mcBot) return;
        mcBot.chat(command);
        sendAlert({
          embeds: [
            embed('Join Command Sent', 'The configured post-join command was sent.', 0x2f80ed)
              .addFields({ name: 'Command', value: command, inline: false })
          ]
        });
      }, 2500);
    }
  });

  mcBot.once('login', () => {
    console.log(`Minecraft bot logged in using protocol version ${mcBot.version}.`);
  });

  mcBot.on('kicked', reason => {
    sendAlert({
      embeds: [
        embed('Minecraft Bot Kicked', formatReason(reason), 0xe74c3c)
          .setThumbnail(skinUrl(mcBot?.username || config.minecraft.username))
      ]
    });
  });

  mcBot.on('error', error => {
    console.error('Mineflayer error:', error);
    sendAlert({
      embeds: [
        embed('Minecraft Bot Error', error.message || 'Unknown Mineflayer error.', 0xe67e22)
          .setThumbnail(skinUrl(mcBot?.username || config.minecraft.username))
      ]
    });
  });

  mcBot.on('end', () => {
    stopAlertLoop();
    mcBot = null;
    if (!reconnecting) {
      sendAlert({
        embeds: [embed('Minecraft Bot Disconnected', 'The Minecraft bot is no longer connected.', 0x95a5a6)]
      });
    }
    reconnecting = false;
  });

  return {
    ok: true,
    embed: embed('Logging In', 'Starting the Minecraft connection.', 0x3498db)
      .setThumbnail(skinUrl('Steve'))
      .addFields(
        { name: 'Username', value: 'Pending login', inline: false },
        { name: 'Server', value: `${options.host}:${options.port}`, inline: true },
        { name: 'Version', value: String(options.version || 'auto'), inline: true }
      )
  };
}

function stopMinecraftBot() {
  if (!mcBot) return false;
  stopAlertLoop();
  mcBot.quit('Discord leave command');
  mcBot = null;
  return true;
}

function startAlertLoop() {
  stopAlertLoop();
  if (!config.alerts.enabled) return;
  alertTimer = setInterval(checkNearbyPlayers, Number(config.alerts.pollMs) || 3000);
}

function stopAlertLoop() {
  if (alertTimer) clearInterval(alertTimer);
  alertTimer = null;
}

function checkNearbyPlayers() {
  if (!mcBot?.entity || !config.alerts.enabled) return;

  const now = Date.now();
  const radius = Number(config.alerts.radius) || 64;
  const repeatMs = Number(config.alerts.repeatAlertMs) || 60000;
  const whitelist = new Set(config.whitelist.map(name => name.toLowerCase()));

  for (const [name, player] of Object.entries(mcBot.players)) {
    if (!player.entity || name === mcBot.username || whitelist.has(name.toLowerCase())) continue;

    const distance = mcBot.entity.position.distanceTo(player.entity.position);
    if (distance > radius) continue;

    const last = lastAlertAt.get(name) || 0;
    if (now - last < repeatMs) continue;

    lastAlertAt.set(name, now);
    const position = player.entity.position;
    sendAlert({
      embeds: [
        embed('Nearby Player Detected', `${name} is within the alert radius.`, 0xf1c40f)
          .setThumbnail(skinUrl(name))
          .addFields(
            { name: 'Player', value: name, inline: true },
            { name: 'Distance', value: `${distance.toFixed(1)} blocks`, inline: true },
            { name: 'World', value: worldName(), inline: true },
            {
              name: 'Coordinates',
              value: `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`,
              inline: false
            }
          )
      ]
    });
  }
}

function formatReason(reason) {
  if (typeof reason === 'string') {
    try {
      return textFromChatComponent(JSON.parse(reason)).slice(0, 900);
    } catch {
      return reason.slice(0, 900);
    }
  }

  return textFromChatComponent(reason).slice(0, 900);
}

function textFromChatComponent(component) {
  if (!component) return 'Unknown reason';
  if (typeof component === 'string') return component;

  const value = component.value && typeof component.value === 'object'
    ? Object.fromEntries(Object.entries(component.value).map(([key, item]) => [key, item?.value ?? item]))
    : component;

  const parts = [];
  if (value.text) parts.push(String(value.text));
  if (value.translate) parts.push(String(value.translate));
  if (Array.isArray(value.extra)) parts.push(...value.extra.map(textFromChatComponent));

  const text = parts.join('').trim();
  return text || JSON.stringify(component);
}

function normalizeMinecraftCommand(command) {
  const value = String(command || '').trim();
  if (!value) return '';
  return value.startsWith('/') ? value : `/${value}`;
}

function botStatus() {
  const connection = mcBot
    ? `online as \`${mcBot.username}\``
    : 'offline';

  return [
    `Minecraft bot is ${connection}.`,
    `Server: \`${config.minecraft.host}:${config.minecraft.port}\``,
    `Alerts: \`${config.alerts.enabled ? 'enabled' : 'disabled'}\`, radius \`${config.alerts.radius}\``,
    `Alert channel: ${config.discord.alertChannelId ? `<#${config.discord.alertChannelId}>` : '`not set`'}`
  ].join('\n');
}

function botStatusEmbed() {
  const status = mcBot ? 'Online' : 'Offline';
  const name = mcBot?.username || config.minecraft.username;
  return embed('Bot Status', `Minecraft bot is ${status.toLowerCase()}.`, mcBot ? 0x27ae60 : 0x95a5a6)
    .setThumbnail(skinUrl(name))
    .addFields(
      { name: 'Status', value: status, inline: true },
      { name: 'Account', value: `${maskAccount(config.minecraft.username)} (${mcBot?.username || 'not connected'})`, inline: true },
      { name: 'Server', value: `${config.minecraft.host}:${config.minecraft.port}`, inline: true },
      { name: 'Version', value: String(config.minecraft.version || 'auto'), inline: true },
      { name: 'Join Command', value: config.minecraft.joinCommand || 'Not set', inline: true },
      { name: 'World', value: worldName(), inline: true },
      { name: 'Alerts', value: `${config.alerts.enabled ? 'Enabled' : 'Disabled'} (${config.alerts.radius} blocks)`, inline: true },
      { name: 'Alert Channel', value: config.discord.alertChannelId ? `<#${config.discord.alertChannelId}>` : 'Not set', inline: false }
    );
}

function configSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config:select')
      .setPlaceholder('Choose a config setting')
      .addOptions(
        { label: 'Show Config', value: 'show', description: 'View the current bot config.' },
        { label: 'Server IP + Port', value: 'server', description: 'Set the Minecraft server address.' },
        { label: 'Server IP', value: 'host', description: 'Set only the Minecraft server IP or hostname.' },
        { label: 'Server Port', value: 'port', description: 'Set only the Minecraft server port.' },
        { label: 'Username', value: 'username', description: 'Set the Minecraft account username or email.' },
        { label: 'Auth Mode', value: 'auth', description: 'Set microsoft, offline, or mojang auth.' },
        { label: 'Version', value: 'version', description: 'Set the Minecraft protocol version.' },
        { label: 'Join Command', value: 'join_command', description: 'Set the command sent after joining.' },
        { label: 'Alert Channel', value: 'alert_channel', description: 'Set the Discord channel for alerts.' },
        { label: 'Alert Radius', value: 'alert_radius', description: 'Set the nearby-player alert radius.' },
        { label: 'Alerts On', value: 'alerts_enabled', description: 'Turn nearby-player alerts true or false.' }
      )
  );
}

function textInput(id, label, value, options = {}) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(options.style || TextInputStyle.Short)
    .setRequired(options.required ?? true);

  if (value !== undefined && value !== null) input.setValue(String(value));
  if (options.placeholder) input.setPlaceholder(options.placeholder);
  if (options.minLength) input.setMinLength(options.minLength);
  if (options.maxLength) input.setMaxLength(options.maxLength);

  return new ActionRowBuilder().addComponents(input);
}

function configModal(field) {
  const modal = new ModalBuilder()
    .setCustomId(`config:modal:${field}`)
    .setTitle('Update Config');

  switch (field) {
    case 'server':
      return modal
        .setTitle('Set Server')
        .addComponents(
          textInput('ip', 'Server IP or hostname', config.minecraft.host, { maxLength: 100 }),
          textInput('port', 'Server port', config.minecraft.port, { placeholder: '25565', maxLength: 5 })
        );
    case 'host':
      return modal
        .setTitle('Set Server IP')
        .addComponents(textInput('ip', 'Server IP or hostname', config.minecraft.host, { maxLength: 100 }));
    case 'port':
      return modal
        .setTitle('Set Server Port')
        .addComponents(textInput('port', 'Server port', config.minecraft.port, { placeholder: '25565', maxLength: 5 }));
    case 'username':
      return modal
        .setTitle('Set Username')
        .addComponents(textInput('username', 'Minecraft username or email', config.minecraft.username, { maxLength: 100 }));
    case 'auth':
      return modal
        .setTitle('Set Auth Mode')
        .addComponents(textInput('mode', 'Auth mode', config.minecraft.auth, { placeholder: 'microsoft, offline, or mojang', maxLength: 20 }));
    case 'version':
      return modal
        .setTitle('Set Version')
        .addComponents(textInput('version', 'Minecraft version, false, or auto', config.minecraft.version || 'auto', { maxLength: 30 }));
    case 'join_command':
      return modal
        .setTitle('Set Join Command')
        .addComponents(textInput('command', 'Command sent after joining', config.minecraft.joinCommand || '', { placeholder: '/server factions', maxLength: 200 }));
    case 'alert_channel':
      return modal
        .setTitle('Set Alert Channel')
        .addComponents(textInput('channel', 'Discord channel mention or ID', config.discord.alertChannelId, { placeholder: '#alerts or 123456789012345678', maxLength: 100 }));
    case 'alert_radius':
      return modal
        .setTitle('Set Alert Radius')
        .addComponents(textInput('radius', 'Alert radius in blocks', config.alerts.radius, { placeholder: '64', maxLength: 5 }));
    case 'alerts_enabled':
      return modal
        .setTitle('Set Alerts On')
        .addComponents(textInput('enabled', 'true or false', String(config.alerts.enabled), { placeholder: 'true', maxLength: 5 }));
    default:
      return null;
  }
}

function parsePort(value) {
  const port = Number(String(value || '').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function parseAlertRadius(value) {
  const radius = Number(String(value || '').trim());
  if (!Number.isFinite(radius) || radius < 1 || radius > 512) return null;
  return radius;
}

function parseBoolean(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['true', 'yes', '1', 'on', 'enabled', 'resume'].includes(normalized)) return true;
  if (['false', 'no', '0', 'off', 'disabled', 'pause'].includes(normalized)) return false;
  return null;
}

async function handleConfig(interaction) {
  await interaction.reply(privateResponse({
    embeds: [embed('Config', 'Choose the setting to view or change.', 0x2f80ed)],
    components: [configSelectRow()]
  }));
}

async function handleConfigSelect(interaction) {
  const field = interaction.values[0];
  if (field === 'show') {
    await interaction.update({
      embeds: [botStatusEmbed()],
      components: [configSelectRow()]
    });
    return;
  }

  const modal = configModal(field);
  if (!modal) {
    await interaction.reply(privateResponse({ embeds: [embed('Unsupported Config Field', 'That config field is not supported.', 0xe74c3c)] }));
    return;
  }

  await interaction.showModal(modal);
}

async function handleConfigModal(interaction) {
  const field = interaction.customId.slice('config:modal:'.length);

  switch (field) {
    case 'server': {
      const host = interaction.fields.getTextInputValue('ip').trim();
      const port = parsePort(interaction.fields.getTextInputValue('port'));
      if (!host) {
        await interaction.reply(privateResponse({ embeds: [embed('Invalid Config Value', 'Server IP or hostname cannot be empty.', 0xe74c3c)] }));
        return;
      }
      if (!port) {
        await interaction.reply(privateResponse({ embeds: [embed('Invalid Config Value', 'Server port must be a number from 1 to 65535.', 0xe74c3c)] }));
        return;
      }
      config.minecraft.host = host;
      config.minecraft.port = port;
      break;
    }
    case 'host': {
      const host = interaction.fields.getTextInputValue('ip').trim();
      if (!host) {
        await interaction.reply(privateResponse({ embeds: [embed('Invalid Config Value', 'Server IP or hostname cannot be empty.', 0xe74c3c)] }));
        return;
      }
      config.minecraft.host = host;
      break;
    }
    case 'port': {
      const port = parsePort(interaction.fields.getTextInputValue('port'));
      if (!port) {
        await interaction.reply(privateResponse({ embeds: [embed('Invalid Config Value', 'Server port must be a number from 1 to 65535.', 0xe74c3c)] }));
        return;
      }
      config.minecraft.port = port;
      break;
    }
    case 'username':
      config.minecraft.username = interaction.fields.getTextInputValue('username').trim();
      break;
    case 'auth': {
      const mode = interaction.fields.getTextInputValue('mode').trim().toLowerCase();
      if (!['offline', 'microsoft', 'mojang'].includes(mode)) {
        await interaction.reply(privateResponse({ embeds: [embed('Invalid Config Value', 'Auth must be `offline`, `microsoft`, or `mojang`.', 0xe74c3c)] }));
        return;
      }
      config.minecraft.auth = mode;
      break;
    }
    case 'version': {
      const op1 = interaction.fields.getTextInputValue('version').trim();
      config.minecraft.version = ['false', 'auto', ''].includes(op1.toLowerCase()) ? false : op1;
      break;
    }
    case 'join_command': {
      const op1 = interaction.fields.getTextInputValue('command').trim();
      config.minecraft.joinCommand = ['false', 'none', 'clear', ''].includes(op1.toLowerCase())
        ? ''
        : normalizeMinecraftCommand(op1);
      break;
    }
    case 'alert_channel': {
      const channel = interaction.fields.getTextInputValue('channel').trim().replace(/[<#>]/g, '');
      if (!/^\d{17,20}$/.test(channel)) {
        await interaction.reply(privateResponse({ embeds: [embed('Invalid Config Value', 'Alert channel must be a channel mention or channel ID.', 0xe74c3c)] }));
        return;
      }
      config.discord.alertChannelId = channel;
      break;
    }
    case 'alert_radius': {
      const radius = parseAlertRadius(interaction.fields.getTextInputValue('radius'));
      if (!radius) {
        await interaction.reply(privateResponse({ embeds: [embed('Invalid Config Value', 'Alert radius must be a number from 1 to 512.', 0xe74c3c)] }));
        return;
      }
      config.alerts.radius = radius;
      break;
    }
    case 'alerts_enabled': {
      const enabled = parseBoolean(interaction.fields.getTextInputValue('enabled'));
      if (enabled === null) {
        await interaction.reply(privateResponse({ embeds: [embed('Invalid Config Value', 'Alerts on must be `true` or `false`.', 0xe74c3c)] }));
        return;
      }
      config.alerts.enabled = enabled;
      if (config.alerts.enabled && mcBot?.entity) startAlertLoop();
      if (!config.alerts.enabled) stopAlertLoop();
      break;
    }
    default:
      await interaction.reply(privateResponse({ embeds: [embed('Unsupported Config Field', 'That config field is not supported.', 0xe74c3c)] }));
      return;
  }

  saveConfig();
  await interaction.reply(privateResponse({
    embeds: [
      embed('Config Updated', `Updated \`${field}\`.\nRestart or run /leave then /join for server/account changes.`, 0x27ae60)
    ]
  }));
}

async function handleAdmin(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'list') {
    const admins = config.discord.adminUserIds.length
      ? config.discord.adminUserIds.map(id => `<@${id}>`).join('\n')
      : 'No verified admins are configured.';
    await interaction.reply(privateResponse({
      embeds: [embed('Verified Admins', admins, 0x2f80ed)]
    }));
    return;
  }

  if (subcommand === 'add') {
    const user = interaction.options.getUser('user', true);
    if (!config.discord.adminUserIds.includes(user.id)) {
      config.discord.adminUserIds.push(user.id);
      saveConfig();
    }

    await interaction.reply(privateResponse({
      embeds: [
        embed('Verified Admin Added', `${user} can now use /config and manage verified admins.`, 0x27ae60)
      ]
    }));
  }
}

async function handleWhitelist(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'list') {
    const players = config.whitelist.length ? config.whitelist.join('\n') : 'No whitelisted players.';
    await interaction.reply(publicResponse({
      embeds: [
        embed('Whitelisted Players', players, 0x9b59b6)
          .setFooter({ text: `${config.whitelist.length} player(s)` })
      ]
    }));
    return;
  }

  const player = interaction.options.getString('player', true).trim();
  const existing = config.whitelist.find(name => name.toLowerCase() === player.toLowerCase());

  if (subcommand === 'add') {
    if (!existing) config.whitelist.push(player);
    saveConfig();
    await interaction.reply(publicResponse({
      embeds: [
        embed('Player Whitelisted', `${player} will be ignored by nearby-player alerts.`, 0x27ae60)
          .setThumbnail(skinUrl(player))
      ]
    }));
    return;
  }

  if (subcommand === 'remove') {
    config.whitelist = config.whitelist.filter(name => name.toLowerCase() !== player.toLowerCase());
    saveConfig();
    await interaction.reply(publicResponse({
      embeds: [
        embed('Player Removed', `${player} will trigger nearby-player alerts again.`, 0xe67e22)
          .setThumbnail(skinUrl(player))
      ]
    }));
  }
}

async function handleAlerts(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'pause') {
    config.alerts.enabled = false;
    saveConfig();
    stopAlertLoop();
    lastAlertAt = new Map();
    await interaction.reply(publicResponse({
      embeds: [
        embed('Alerts Paused', 'Nearby-player alerts are now paused.', 0xe67e22)
          .addFields(
            { name: 'Radius', value: `${config.alerts.radius} blocks`, inline: true },
            { name: 'World', value: worldName(), inline: true }
          )
      ]
    }));
    return;
  }

  if (subcommand === 'resume') {
    config.alerts.enabled = true;
    saveConfig();
    if (mcBot?.entity) startAlertLoop();
    await interaction.reply(publicResponse({
      embeds: [
        embed('Alerts Resumed', 'Nearby-player alerts are now active.', 0x27ae60)
          .addFields(
            { name: 'Radius', value: `${config.alerts.radius} blocks`, inline: true },
            { name: 'World', value: worldName(), inline: true }
          )
      ]
    }));
    return;
  }

  await interaction.reply(publicResponse({
    embeds: [
      embed(
        'Alert Status',
        `Nearby-player alerts are ${config.alerts.enabled ? 'active' : 'paused'}.`,
        config.alerts.enabled ? 0x27ae60 : 0xe67e22
      ).addFields(
        { name: 'Radius', value: `${config.alerts.radius} blocks`, inline: true },
        { name: 'Poll Rate', value: `${config.alerts.pollMs} ms`, inline: true },
        { name: 'World', value: worldName(), inline: true }
      )
    ]
  }));
}

async function ensureMinecraftReady(interaction, options = {}) {
  if (mcBot) return true;
  const response = {
    embeds: [embed('Minecraft Bot Offline', 'Use `/join` before running this command.', 0xe74c3c)]
  };
  await interaction.reply(options.public ? publicResponse(response) : privateResponse(response));
  return false;
}

async function handleMove(interaction) {
  if (!mcBot) {
    await interaction.reply(privateResponse({
      embeds: [embed('Minecraft Bot Offline', 'Use `/join` before moving the bot.', 0xe74c3c)]
    }));
    return;
  }

  const x = interaction.options.getNumber('x', true);
  const y = interaction.options.getNumber('y', true);
  const z = interaction.options.getNumber('z', true);
  const range = interaction.options.getInteger('range') ?? 1;

  await interaction.deferReply();

  const movements = new Movements(mcBot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.canOpenDoors = true;
  mcBot.pathfinder.setMovements(movements);

  const start = mcBot.entity.position;
  await interaction.editReply({
    embeds: [
      embed('Moving Bot', `Pathfinding to ${x}, ${y}, ${z}.`, 0x3498db)
        .addFields(
          { name: 'From', value: `${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)}`, inline: true },
          { name: 'Target', value: `${x}, ${y}, ${z}`, inline: true },
          { name: 'World', value: worldName(), inline: true }
        )
    ]
  });

  try {
    await mcBot.pathfinder.goto(new goals.GoalNear(x, y, z, range));
    const end = mcBot.entity.position;
    await interaction.editReply({
      embeds: [
        embed('Move Complete', 'The bot reached the target area.', 0x27ae60)
          .addFields(
            { name: 'Position', value: `${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}`, inline: true },
            { name: 'Range', value: `${range} block(s)`, inline: true },
            { name: 'World', value: worldName(), inline: true }
          )
      ]
    });
  } catch (error) {
    await interaction.editReply({
      embeds: [
        embed('Move Failed', error.message || 'Pathfinder could not reach that target.', 0xe74c3c)
          .addFields(
            { name: 'Target', value: `${x}, ${y}, ${z}`, inline: true },
            { name: 'World', value: worldName(), inline: true }
          )
      ]
    });
  }
}

discord.on('interactionCreate', async interaction => {
  if (!requireAllowed(interaction)) return;

  try {
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'config:select') {
        if (!requireVerifiedAdmin(interaction)) return;
        await handleConfigSelect(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('config:modal:')) {
        if (!requireVerifiedAdmin(interaction)) return;
        await handleConfigModal(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case 'join': {
        const result = startMinecraftBot();
        await interaction.reply(privateResponse(result.embed ? { embeds: [result.embed] } : {
          embeds: [embed('Minecraft Bot', result.message, result.ok ? 0x3498db : 0xe67e22)]
        }));
        break;
      }
      case 'leave': {
        const stopped = stopMinecraftBot();
        await interaction.reply(privateResponse({
          embeds: [
            embed(
              stopped ? 'Disconnecting' : 'Minecraft Bot Offline',
              stopped ? 'Minecraft bot is disconnecting.' : 'Minecraft bot is not connected.',
              stopped ? 0xe67e22 : 0x95a5a6
            )
          ]
        }));
        break;
      }
      case 'status':
        await interaction.reply(privateResponse({ embeds: [botStatusEmbed()] }));
        break;
      case 'sudo': {
        if (!(await ensureMinecraftReady(interaction, { public: true }))) return;
        const command = interaction.options.getString('command', true);
        await interaction.deferReply();
        await interaction.editReply({
          embeds: [
            embed('Sending Command', 'The Minecraft bot is sending chat text.', 0x3498db)
              .addFields({ name: 'Text', value: command.slice(0, 1000), inline: false })
          ]
        });
        mcBot.chat(command);
        await interaction.editReply({
          embeds: [
            embed('Command Complete', 'The Minecraft bot sent the chat text.', 0x27ae60)
              .addFields({ name: 'Text', value: command.slice(0, 1000), inline: false })
          ]
        });
        break;
      }
      case 'warp': {
        if (!(await ensureMinecraftReady(interaction))) return;
        const name = interaction.options.getString('name', true).trim();
        const command = `/warp ${name}`;
        mcBot.chat(command);
        await interaction.reply(privateResponse({
          embeds: [
            embed('Warp Sent', `The bot is warping to ${name}.`, 0x2f80ed)
              .addFields({ name: 'Command', value: command, inline: false })
          ]
        }));
        break;
      }
      case 'move': {
        await handleMove(interaction);
        break;
      }
      case 'whitelist':
        await handleWhitelist(interaction);
        break;
      case 'config':
        if (!requireVerifiedAdmin(interaction)) return;
        await handleConfig(interaction);
        break;
      case 'admin':
        if (!requireAdminManager(interaction)) return;
        await handleAdmin(interaction);
        break;
      default:
        await interaction.reply(privateResponse({
          embeds: [embed('Unknown Command', 'That command is not registered in this bot.', 0xe74c3c)]
        }));
    }
  } catch (error) {
    console.error('Command failed:', error);
    const response = {
      embeds: [embed('Command Failed', error.message || 'Unknown command error.', 0xe74c3c)]
    };
    if (interaction.deferred) await interaction.editReply(response);
    else if (interaction.replied) await interaction.followUp(privateResponse(response));
    else await interaction.reply(privateResponse(response));
  }
});

discord.once('clientReady', () => {
  console.log(`Discord bot logged in as ${discord.user.tag}`);
});

async function main() {
  await registerCommands();
  await discord.login(process.env.DISCORD_TOKEN);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
