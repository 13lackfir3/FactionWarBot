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
const MY_FACTION_ID      = parseInt(process.env.MY_FACTION_ID, 10);
const TORN_API_KEY       = process.env.TORN_API_KEY;
const TOKEN              = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID          = process.env.CLIENT_ID;
const GUILD_ID           = process.env.GUILD_ID;
const MONGO_URI          = process.env.MONGO_URI;
const HOSPITAL_INTERVAL  = 60 * 1000;       // 1 minute poll
const SNAPSHOT_INTERVAL  = 15 * 60 * 1000;  // 15 minutes snapshot
const HOSPITAL_WEBHOOK   = process.env.HOSPITAL_WEBHOOK_URL;
const FACTION_ROLE       = process.env.FACTION_ROLE_ID; // role ID for @Faction Member

// Models & services
const { pollFactionMembers }   = require('./services/pollFaction');
const { pollFactionHospital }  = require('./services/pollFactionHospital');
const EnemyFaction             = require('./models/EnemyFaction');
const Faction                  = require('./models/Faction');

// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('🗄️ Connected to MongoDB'))
  .catch(console.error);

// Discord client & webhook
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const hospitalWebhook = new WebhookClient({ url: HOSPITAL_WEBHOOK });

// In-memory watched factions
let watchedFactions = [];
function loadWatched() {
  try {
    watchedFactions = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'watchedFactions.json'), 'utf8'));
  } catch {
    watchedFactions = [];
  }
}
function saveWatched() {
  fs.writeFileSync(path.resolve(__dirname, 'watchedFactions.json'), JSON.stringify(watchedFactions, null, 2));
}

// Transform raw API members into our schema
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

// Snapshot own faction to DB
async function upsertFactionSnapshot() {
  const raw     = await pollFactionMembers(MY_FACTION_ID);
  const members = transformMembers(raw);
  await Faction.findOneAndUpdate(
    { factionId: MY_FACTION_ID },
    { monitoredAt: new Date(), members },
    { upsert: true }
  );
}

// Hospital alert scheduler state
const hospitalCache  = new Map(); // factionId -> Set<memberId>
const hospitalTimers = new Map(); // memberId -> { timer, releaseAt }

async function scheduleHospitalTimersFor(factionId) {
  const now          = Date.now();
  const raw          = await pollFactionHospital(factionId);
  const members      = transformMembers(raw);
  const hospitalized = members.filter(m => m.status.state === 'Hospital' && m.status.until);

  console.log(`⏲️ [${new Date().toISOString()}] Faction ${factionId}: ${hospitalized.length} in hospital`);

  const prevSet = hospitalCache.get(factionId) || new Set();
  const curSet  = new Set(hospitalized.map(m => m.memberId));

  for (const m of hospitalized) {
    const releaseAt = m.status.until.getTime();
    const msToAlert = releaseAt - now - 30000;  // 30s before
    if (msToAlert <= 0) continue;
    const existing = hospitalTimers.get(m.memberId);
    if (!existing || existing.releaseAt !== releaseAt) {
      if (existing) clearTimeout(existing.timer);
      console.log(`⏱️ Scheduling alert for ${m.name} (ID:${m.memberId}) in ${msToAlert}ms`);
      const timer = setTimeout(async () => {
        try {
          await hospitalWebhook.send({
            username: 'Hospital Alert Bot',
            content: `<@&${FACTION_ROLE}> **${m.name}** leaving hospital in 30s! <https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${m.memberId}>`
          });
        } catch (e) {
          console.error('❌ Failed webhook alert:', e);
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
      console.log(`🚫 Canceled timer for member ${memberId}`);
    }
  }
  hospitalCache.set(factionId, curSet);
}

// Slash commands definition
const commands = [
  { name: 'start',      description: 'Start monitoring a faction',        options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'stop',       description: 'Stop monitoring a faction',         options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'starthosp',  description: 'Enable hospital alerts',           options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'stophosp',   description: 'Disable hospital alerts',          options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }] },
  { name: 'revives',    description: 'List revivable members' },
  { name: 'warrevives', description: 'List enemy revivable members',     options: [{ name: 'id', type: 4, description: 'Faction ID', required: false }] },
  { name: 'oc',         description: 'List members not in OC' },
  { name: 'cleanup',    description: 'Bulk delete messages',             options: [{ name: 'count', type: 4, description: 'Number to remove', required: false }], defaultMemberPermissions: PermissionFlagsBits.ManageMessages.toString() },
  { name: 'prewar',     description: 'Snapshot your faction data' },
  { name: 'status',     description: 'Show current faction status' }
];

// Register slash commands
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

// Ready handler
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  loadWatched();
  watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId));
  upsertFactionSnapshot();
  setInterval(() => watchedFactions.forEach(w => scheduleHospitalTimersFor(w.factionId)), HOSPITAL_INTERVAL);
  setInterval(upsertFactionSnapshot, SNAPSHOT_INTERVAL);
});

// Interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;
  await interaction.deferReply({ ephemeral: commandName === 'cleanup' || commandName === 'status' });

  try {
    switch (commandName) {
      case 'start': {/* unchanged */} break;
      case 'stop': {/* unchanged */} break;
      case 'starthosp': {/* unchanged */} break;
      case 'stophosp': {/* unchanged */} break;
      case 'revives': {/* unchanged */} break;
      case 'warrevives': {/* unchanged */} break;
      case 'oc': {/* unchanged */} break;
      case 'cleanup': {
        const count = options.getInteger('count') || 10;
        const channel = interaction.channel;
        const messages = await channel.messages.fetch({ limit: count });
        await channel.bulkDelete(messages, true);
        await interaction.editReply(`✅ Deleted ${messages.size} messages.`);
      } break;
      case 'prewar': {/* unchanged */} break;
      case 'status': {
        // now showing online/idle/offline instead of hospital state
        const rawApi = await pollFactionMembers(MY_FACTION_ID);
        const list = rawApi
          .map(m => `• ${m.name} (ID: ${m.id}): ${m.last_action.status}`)
          .join('\n') || '_None_';
        await interaction.editReply(`**Current status:**\n${list}`);
      } break;
      default:
        await interaction.editReply('⚠️ Unknown command.');
    }
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    await interaction.editReply(`❌ ${err.message}`);
  }
});

client.login(TOKEN);
