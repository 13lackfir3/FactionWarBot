// index.js
require('dotenv').config();

const mongoose = require('mongoose');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes
} = require('discord.js');

const { pollFactionHospital } = require('./services/pollFactionHospital');
const EnemyFaction            = require('./models/EnemyFaction');

const TOKEN             = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID         = process.env.CLIENT_ID;
const GUILD_ID          = process.env.GUILD_ID;
const MONGO_URI         = process.env.MONGO_URI;
const HOSPITAL_INTERVAL = (parseInt(process.env.HOSPITAL_INTERVAL, 10) || 300) * 1000;

mongoose.connect(MONGO_URI)
  .then(() => console.log('🗄️  Connected to MongoDB:', MONGO_URI))
  .catch(err => console.error('MongoDB connection error:', err));

const commands = [{
  name:        'factionid',
  description: 'Fetch and store faction members with hospital timers',
  options: [{
    name:        'id',
    type:        4, // INTEGER
    description: 'Faction ID',
    required:    true
  }]
}];

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
const hospitalTimers = new Map(); // memberId → { timer, releaseAt, channelId }

// the core scheduling logic for one faction
async function scheduleHospitalTimersFor(factionId, channelId) {
  console.log(`🔧 scheduleHospitalTimersFor called for faction ${factionId} in channel ${channelId}`);
  const now = Date.now();
  const members = await pollFactionHospital(factionId);
  const hospitalized = members.filter(m => m.status.state === 'Hospital');
  console.log(`   → Found ${hospitalized.length} hospitalized members`);

  const prevSet    = hospitalCache.get(factionId) || new Set();
  const currentSet = new Set(hospitalized.map(m => m.id));

  // schedule new timers immediately
  for (const m of hospitalized) {
    console.log(`   • Checking member ${m.name}(${m.id}) with until=${m.status.until}`);
    if (!m.status.until) continue;
    const releaseAt    = m.status.until * 1000;
    const msUntilAlert = releaseAt - now - 8000;
    const existing     = hospitalTimers.get(m.id);

    if (msUntilAlert > 0 && (!existing || existing.releaseAt !== releaseAt)) {
      if (existing) {
        clearTimeout(existing.timer);
        console.log(`🗑️  Cleared old timer for ${m.name}(${m.id})`);
      }
      console.log(`⏱ [Immediate] Scheduling ping for ${m.name}(${m.id}) in ${msUntilAlert}ms`);
      const timer = setTimeout(async () => {
        console.log(`📣 Timer fired for ${m.name}(${m.id}), pinging @everyone in channel ${channelId}`);
        try {
          const ch = await client.channels.fetch(channelId);
          await ch.send(
            `@everyone **${m.name}** is leaving the hospital in 8 seconds!\n` +
            `<https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${m.id}>`
          );
        } catch (err) {
          console.error(`❌ Failed to send hospital-alert for member ${m.id}:`, err);
        }
        hospitalTimers.delete(m.id);
      }, msUntilAlert);
      hospitalTimers.set(m.id, { timer, releaseAt, channelId });
    }
  }

  // cancel timers for members who've recovered
  for (const prevId of prevSet) {
    if (!currentSet.has(prevId) && hospitalTimers.has(prevId)) {
      const { timer } = hospitalTimers.get(prevId);
      clearTimeout(timer);
      hospitalTimers.delete(prevId);
      console.log(`🚫 Canceled alert timer for member ${prevId} (recovered)`);
    }
  }

  hospitalCache.set(factionId, currentSet);
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Load watched list
  const watchedFile = path.resolve(__dirname, 'watchedFactions.json');
  try {
    watchedFactions = JSON.parse(fs.readFileSync(watchedFile, 'utf-8'));
    console.log('🔍 Loaded watchedFactions:', watchedFactions);
  } catch {
    watchedFactions = [];
    console.warn('⚠️  watchedFactions.json missing or invalid');
  }

  // run all at startup immediately
  for (const { factionId, channelId } of watchedFactions) {
    console.log(`🔄 Initial scheduling for faction ${factionId}`);
    scheduleHospitalTimersFor(factionId, channelId).catch(err =>
      console.error(`Error scheduling at startup for ${factionId}:`, err)
    );
  }

  // schedule recurring checks
  setInterval(() => {
    for (const { factionId, channelId } of watchedFactions) {
      console.log(`🔄 Recurring scheduling for faction ${factionId}`);
      scheduleHospitalTimersFor(factionId, channelId).catch(err =>
        console.error(`Error in scheduled loop for ${factionId}:`, err)
      );
    }

    // Log active timers after each pass
    if (hospitalTimers.size > 0) {
      console.log('🔔 Active hospital timers:');
      for (const [memberId, { releaseAt }] of hospitalTimers.entries()) {
        const secondsLeft = Math.round((releaseAt - Date.now()) / 1000);
        console.log(`  • Member ${memberId}: alert in ${secondsLeft}s`);
      }
    } else {
      console.log('🔕 No active hospital timers at this check.');
    }
  }, HOSPITAL_INTERVAL);
});

client.on('interactionCreate', async interaction => {
  console.log('⚡ Received interaction:', interaction.commandName);
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'factionid') return;

  await interaction.deferReply({ flags: 64 }); // ephemeral
  const factionId = interaction.options.getInteger('id');
  const channelId = interaction.channelId;
  console.log(`⚡ Handling /factionid for faction ${factionId} in channel ${channelId}`);

  // Persist watch list
  const watchedFile = path.resolve(__dirname, 'watchedFactions.json');
  watchedFactions.push({ factionId, channelId });
  fs.writeFileSync(watchedFile, JSON.stringify(watchedFactions, null, 2));
  console.log(`📝 Added faction ${factionId} to watch in channel ${channelId}`);

  try {
    const members = await pollFactionHospital(factionId);
    await EnemyFaction.findOneAndUpdate(
      { factionId },
      { monitoredAt: new Date(), members },
      { upsert: true, new: true }
    );
    console.log(`💾 Upserted ${members.length} members for faction ${factionId}`);

    console.log(`🏁 Calling scheduleHospitalTimersFor immediately for new faction ${factionId}`);
    await scheduleHospitalTimersFor(factionId, channelId);

    await interaction.editReply(`✅ Now watching faction ${factionId} with immediate hospital alerts.`);
  } catch (err) {
    console.error(`❌ /factionid error for ${factionId}:`, err);
    await interaction.editReply(`❌ Error: ${err.message}`);
  }
});

client.login(TOKEN);
