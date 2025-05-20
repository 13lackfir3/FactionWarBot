// index.js
require('dotenv').config();

const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  WebhookClient,
  PermissionFlagsBits
} = require('discord.js');

const { pollFactionMembers } = require('./services/pollFaction');
const EnemyFaction            = require('./models/EnemyFaction');

const TOKEN                  = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID              = process.env.CLIENT_ID;
const GUILD_ID               = process.env.GUILD_ID;
const MONGO_URI              = process.env.MONGO_URI;
const HOSPITAL_INTERVAL      = (parseInt(process.env.HOSPITAL_INTERVAL, 10) || 300) * 1000;
const HOSPITAL_WEBHOOK_URL   = process.env.HOSPITAL_WEBHOOK_URL; // Webhook URL from .env

// Initialize webhook client
const hospitalWebhook = new WebhookClient({ url: HOSPITAL_WEBHOOK_URL });

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('🗄️ Connected to MongoDB:', MONGO_URI))
  .catch(err => console.error('MongoDB connection error:', err));

// Define slash commands
const commands = [
  {
    name: 'factionid',
    description: 'Fetch & store faction members with hospital timers',
    options: [{ name: 'id', type: 4, description: 'Torn faction ID', required: true }]
  },
  {
    name: 'revives',
    description: 'List all watched factions members with revives enabled'
  },
  {
    name: 'warrevives',
    description: 'List revivable members in a specific faction',
    options: [{ name: 'id', type: 4, description: 'Faction ID', required: true }]
  },
  {
    name: 'cleanup',
    description: 'Bulk delete recent messages in this channel',
    defaultMemberPermissions: PermissionFlagsBits.ManageMessages.toString()
  }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    console.log('🔄 Registering slash commands…');
    const target = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);
    await rest.put(target, { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Slash registration error:', err);
  }
})();

const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages ]
});

let watchedFactions = [];
const hospitalCache  = new Map(); // factionId → Set of memberIds
const hospitalTimers = new Map(); // memberId → timeout handle

// schedule a timer to fire exactly when hospital timer hits zero, then send via webhook
async function scheduleHospitalTimersFor(factionId) {
  const nowMs = Date.now();
  const members = await pollFactionMembers(factionId);
  const hospitalized = members.filter(m => m.status.state === 'Hospital');

  const prevSet    = hospitalCache.get(factionId) || new Set();
  const currentSet = new Set(hospitalized.map(m => m.id));

  for (const m of hospitalized) {
    if (!m.status.until) continue;
    const releaseAtMs = m.status.until * 1000;
    const msUntilZero = releaseAtMs - nowMs;

    if (msUntilZero >= 0 && !hospitalTimers.has(m.id)) {
      console.log(`⏱ scheduling webhook timer for ${m.name}(${m.id}) in ${msUntilZero}ms`);
      const timer = setTimeout(async () => {
        console.log(`✅ Timer hit zero for ${m.name} (${m.id})`);
        try {
          await hospitalWebhook.send({
            username: 'Hospital Alert Bot',
            content:
              `@everyone **${m.name}** is now out of the hospital!\n` +
              `https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${m.id}`,
            allowedMentions: { parse: ['everyone'] }
          });
        } catch (err) {
          console.error(`❌ Webhook send failed for ${m.id}:`, err);
        }
        hospitalTimers.delete(m.id);
      }, msUntilZero);
      hospitalTimers.set(m.id, timer);
    }
  }

  // cancel timers for those who've recovered
  for (const prevId of prevSet) {
    if (!currentSet.has(prevId) && hospitalTimers.has(prevId)) {
      clearTimeout(hospitalTimers.get(prevId));
      hospitalTimers.delete(prevId);
      console.log(`🚫 canceled timer for recovered ${prevId}`);
    }
  }

  hospitalCache.set(factionId, currentSet);
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // load watched list
  try {
    watchedFactions = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'watchedFactions.json')));
  } catch {
    watchedFactions = [];
  }

  // run scheduling immediately and on interval for each faction
  for (const wf of watchedFactions) {
    scheduleHospitalTimersFor(wf.factionId).catch(console.error);
  }
  setInterval(() => {
    for (const wf of watchedFactions) {
      scheduleHospitalTimersFor(wf.factionId).catch(console.error);
    }
  }, HOSPITAL_INTERVAL);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, channelId } = interaction;

  if (commandName === 'factionid') {
    await interaction.deferReply({ ephemeral: true });
    const factionId = options.getInteger('id');

    watchedFactions.push({ factionId, channelId });
    fs.writeFileSync(
      path.resolve(__dirname, 'watchedFactions.json'),
      JSON.stringify(watchedFactions, null, 2)
    );

    try {
      const rawMembers = await pollFactionMembers(factionId);
      const members = rawMembers.map(m => ({
        memberId:      m.id,
        name:          m.name,
        level:         m.level,
        position:      m.position,
        reviveSetting: m.revive_setting,
        isRevivable:   m.is_revivable,
        status:        m.status,
        lastAction:    m.last_action,
        scheduledAlertAt: null,
        travel:           {}
      }));

      await EnemyFaction.findOneAndUpdate(
        { factionId },
        { monitoredAt: new Date(), members },
        { upsert: true, new: true }
      );

      await scheduleHospitalTimersFor(factionId);
      await interaction.editReply(`✅ Now watching faction ${factionId}. Stored ${members.length} members.`);
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Error: ${err.message}`);
    }
  }

  else if (commandName === 'revives') {
    let response = '';
    for (const { factionId } of watchedFactions) {
      const doc = await EnemyFaction.findOne({ factionId }).lean();
      if (!doc) continue;
      const list = doc.members
        .filter(m => m.isRevivable)
        .map(m => `• ${m.name} (ID: ${m.memberId})`)
        .join('\n') || '• _None_';
      response += `**Faction ${factionId} revives:**\n${list}\n\n`;
    }
    await interaction.reply({ content: response || 'No data available.', ephemeral: false });
  }

  else if (commandName === 'warrevives') {
    await interaction.deferReply({ ephemeral: true });
    const factionId = options.getInteger('id');
    const doc = await EnemyFaction.findOne({ factionId }).lean();
    if (!doc) {
      return interaction.editReply(`❌ No data found for faction ${factionId}.`);
    }
    const list = doc.members
      .filter(m => m.isRevivable)
      .map(m => `• ${m.name} (ID: ${m.memberId})`)
      .join('\n') || '*None*';
    await interaction.editReply({
      content: `**Faction ${factionId} revives:**\n${list}`
    });
  }

  else if (commandName === 'cleanup') {
    await interaction.reply({ content: 'Cleaning up…', ephemeral: true });
    const msgs = await interaction.channel.messages.fetch({ limit: 100 });
    await interaction.channel.bulkDelete(msgs, true);
  }
});

client.login(TOKEN);
