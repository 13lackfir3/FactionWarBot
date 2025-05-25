// index.js
console.log('🚀 index.js loaded – edits are live');
require('dotenv').config();

const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');
const axios    = require('axios');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionFlagsBits,
  WebhookClient
} = require('discord.js');

// Environment variables
const MY_FACTION_ID       = parseInt(process.env.MY_FACTION_ID, 10);
const TORN_API_KEY        = process.env.TORN_API_KEY;
const TOKEN               = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID           = process.env.CLIENT_ID;
const GUILD_ID            = process.env.GUILD_ID;
const MONGO_URI           = process.env.MONGO_URI;
const HOSPITAL_INTERVAL   = 60 * 1000;       // 1 minute
const SNAPSHOT_INTERVAL   = 15 * 60 * 1000;  // 15 minutes
const HOSPITAL_WEBHOOK    = process.env.HOSPITAL_WEBHOOK_URL;
const FACTION_ROLE        = process.env.FACTION_ROLE_ID;
const SILENT_WEBHOOK_URL  = process.env.SILENT_WEBHOOK_URL;

// Models & services
const { pollFactionMembers }    = require('./services/pollFaction');
const { pollFactionHospital }   = require('./services/pollFactionHospital');
const pollUserStatus = require('./services/pollUserStatus');
const EnemyFaction              = require('./models/EnemyFaction');
const Faction                   = require('./models/Faction');
const { startStatusWorker }     = require('./services/statusWorker');

// Connect to Mongo
mongoose.connect(MONGO_URI)
  .then(() => console.log('🗄️ Connected to MongoDB'))
  .catch(console.error);

// Discord setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const hospitalWebhook = new WebhookClient({ url: HOSPITAL_WEBHOOK });
const silentWebhook   = new WebhookClient({ url: SILENT_WEBHOOK_URL });

// watchedFactions.json
let watchedFactions = [];
function loadWatched() {
  try {
    watchedFactions = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'watchedFactions.json'), 'utf8')
    );
  } catch {
    watchedFactions = [];
  }
}
function saveWatched() {
  fs.writeFileSync(
    path.resolve(__dirname, 'watchedFactions.json'),
    JSON.stringify(watchedFactions, null, 2)
  );
}

// idleopWatch.json
let idleopWatch = [];
function loadIdleop() {
  try {
    idleopWatch = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'idleopWatch.json'), 'utf8')
    );
  } catch {
    idleopWatch = [];
  }
}
function saveIdleop() {
  fs.writeFileSync(
    path.resolve(__dirname, 'idleopWatch.json'),
    JSON.stringify(idleopWatch, null, 2)
  );
}

// transform raw Torn data
function transformMembers(raw) {
  return raw.map(m => ({
    memberId: m.id,
    name: m.name,
    level: m.level,
    daysInFaction: m.days_in_faction,
    lastAction: {
      status:    m.last_action?.status || '',
      timestamp: m.last_action ? new Date(m.last_action.timestamp * 1000) : new Date(),
      relative:  m.last_action?.relative || ''
    },
    status: {
      description: m.status?.description || '',
      details:     m.status?.details || null,
      state:       m.status?.state || '',
      until:       m.status?.until ? new Date(m.status.until * 1000) : null
    },
    reviveSetting: m.revive_setting || '',
    position:      m.position,
    isRevivable:   m.is_revivable,
    isInOc:        m.is_in_oc
  }));
}

// snapshot your faction
async function upsertFactionSnapshot() {
  const raw     = await pollFactionMembers(MY_FACTION_ID);
  const members = transformMembers(raw);
  await Faction.findOneAndUpdate(
    { factionId: MY_FACTION_ID },
    { monitoredAt: new Date(), members },
    { upsert: true }
  );
}

// hospital timers
const hospitalCache  = new Map();
const hospitalTimers = new Map();
async function scheduleHospitalTimersFor(factionId) {
  const now          = Date.now();
  const raw          = await pollFactionHospital(factionId);
  const members      = transformMembers(raw);
  const hospitalized = members.filter(m => m.status.state === 'Hospital' && m.status.until);

  const prevSet = hospitalCache.get(factionId) || new Set();
  const curSet  = new Set(hospitalized.map(m => m.memberId));

  for (const m of hospitalized) {
    const releaseAt = m.status.until.getTime();
    const msToAlert = releaseAt - now - 30_000;
    if (msToAlert <= 0) continue;
    const existing = hospitalTimers.get(m.memberId);
    if (!existing || existing.releaseAt !== releaseAt) {
      if (existing) clearTimeout(existing.timer);
      console.log(`⏱️ Scheduling hospital alert for ${m.name} in ${msToAlert}ms`);
      const timer = setTimeout(async () => {
        try {
          await hospitalWebhook.send({
            username: 'Hospital Alert Bot',
            content: `<@&${FACTION_ROLE}> **${m.name}** leaving hospital in 30s! <https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${m.memberId}>`
          });
        } catch (e) {
          console.error('❌ Hospital webhook failed:', e);
        }
        hospitalTimers.delete(m.memberId);
      }, msToAlert);
      hospitalTimers.set(m.memberId, { timer, releaseAt });
    }
  }

  for (const memberId of prevSet) {
    if (!curSet.has(memberId) && hospitalTimers.has(memberId)) {
      clearTimeout(hospitalTimers.get(memberId).timer);
      hospitalTimers.delete(memberId);
    }
  }
  hospitalCache.set(factionId, curSet);
}

// slash commands
const commands = [
  { name: 'start',      description: 'Start monitoring a faction', options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'stop',       description: 'Stop monitoring a faction',  options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'starthosp',  description: 'Enable hospital alerts',      options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'stophosp',   description: 'Disable hospital alerts',     options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'revives',    description: 'List revivable members' },
  { name: 'warrevives', description: 'List enemy revivable members', options: [{ name: 'id', type: 4, description: 'Faction ID', required: false }] },
  { name: 'oc',         description: 'List members not in OC' },
  { name: 'cleanup',    description: 'Bulk delete messages',        options: [{ name: 'count', type: 4, description: 'Number to remove', required: false }], defaultMemberPermissions: PermissionFlagsBits.ManageMessages.toString() },
  { name: 'prewar',     description: 'Snapshot your faction data'  },
  { name: 'idleop',     description: 'Watch a user’s online status', options: [{ name: 'id', type: 4, description: 'User ID to watch', required: true }] }
];

// register
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    console.log('🔄 Registering slash commands…');
    const target = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);
    await rest.put(target, { body: commands });
    console.log('✅ Commands registered');
  } catch (error) {
    console.error('Slash registration error:', error);
  }
})();

// ready
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  loadWatched();
  loadIdleop();
  // kick off hospital polls
  watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId));
  setInterval(() => watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId)), HOSPITAL_INTERVAL);
  // snapshot
  upsertFactionSnapshot();
  setInterval(upsertFactionSnapshot, SNAPSHOT_INTERVAL);
  // start status worker
  setTimeout(() => startStatusWorker(client, idleopWatch, silentWebhook), 10_000);
});

// interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;
  await interaction.deferReply({ ephemeral: commandName === 'cleanup' });

  try {
    let raw, list;
    switch (commandName) {
      case 'start': {
        const id = options.getInteger('id');
        if (!watchedFactions.some(w => w.factionId === id)) {
          watchedFactions.push({ factionId: id, channelId: interaction.channelId });
          saveWatched();
          raw = await pollFactionMembers(id);
          await EnemyFaction.findOneAndUpdate(
            { factionId: id },
            { monitoredAt: new Date(), members: raw },
            { upsert: true }
          );
          await interaction.editReply(`✅ Monitoring faction ${id}.`);
        } else {
          await interaction.editReply(`⚠️ Already monitoring ${id}.`);
        }
        break;
      }
      case 'stop': {
        const id = options.getInteger('id');
        watchedFactions = watchedFactions.filter(w => w.factionId !== id);
        saveWatched();
        await interaction.editReply(`✅ Stopped monitoring ${id}.`);
        break;
      }
      case 'starthosp': {
        const id = options.getInteger('id');
        if (!watchedFactions.some(w => w.factionId === id)) {
          watchedFactions.push({ factionId: id, channelId: interaction.channelId });
          saveWatched();
        }
        scheduleHospitalTimersFor(id);
        await interaction.editReply(`✅ Hospital alerts started for faction ${id}.`);
        break;
      }
      case 'stophosp': {
        const id = options.getInteger('id');
        watchedFactions = watchedFactions.filter(w => w.factionId !== id);
        saveWatched();
        const prev = hospitalCache.get(id) || new Set();
        for (const mid of prev) {
          const info = hospitalTimers.get(mid);
          if (info) clearTimeout(info.timer), hospitalTimers.delete(mid);
        }
        hospitalCache.delete(id);
        await interaction.editReply(`✅ Hospital alerts stopped for faction ${id}.`);
        break;
      }
      case 'revives': {
        raw = await pollFactionMembers(MY_FACTION_ID);
        list = transformMembers(raw).filter(m => m.isRevivable)
          .map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Revivable members:**\n${list}`);
        break;
      }
      case 'warrevives': {
        const watchedIds = watchedFactions.map(w => w.factionId);
        const id = options.getInteger('id') || watchedIds[0];
        raw = await pollFactionMembers(id);
        list = transformMembers(raw).filter(m => m.isRevivable)
          .map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Enemy faction ${id} revives:**\n${list}`);
        break;
      }
      case 'oc': {
        raw = await pollFactionMembers(MY_FACTION_ID);
        list = transformMembers(raw).filter(m => !m.isInOc)
          .map(m => `• ${m.name} (ID: ${m.memberId})`).join('\n') || '_None_';
        await interaction.editReply(`**Not in OC:**\n${list}`);
        break;
      }
      case 'cleanup': {
        const count = options.getInteger('count') || 10;
        const msgs  = await interaction.channel.messages.fetch({ limit: count });
        await interaction.channel.bulkDelete(msgs, true);
        await interaction.editReply(`✅ Deleted ${count} messages.`);
        break;
      }
      case 'prewar': {
        await upsertFactionSnapshot();
        await interaction.editReply('✅ Snapshot saved.');
        break;
      }
      case 'idleop': {
        const userId = options.getInteger('id');
        // initial status fetch & DB update
        const status = await pollUserStatus(userId);
        await EnemyFaction.findOneAndUpdate(
          { factionId: userId },
          { monitoredAt: new Date(), 'members': [ status ] },
          { upsert: true }
        );
        // add to watch list
        if (!idleopWatch.includes(userId)) {
          idleopWatch.push(userId);
          saveIdleop();
        }
        await interaction.editReply(`✅ Now watching user ${userId}. Current status: **${status.status}**`);
        break;
      }
      default:
        await interaction.editReply('⚠️ Unknown command.');
    }
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    await interaction.editReply(`❌ ${err.message}`);
  }
});

client.login(TOKEN);
