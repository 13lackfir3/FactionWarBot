import dotenv from 'dotenv';
  dotenv.config();
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import axios from 'axios';

import EnemyMember from './models/EnemyMember.js';
import Cooldown from './models/Cooldown.js';



const {
  BOT_TOKEN, TORN_API_KEY, WAR_CHANNEL_ID, MY_FACTION_ID,
  OWNER_ID, GUILD_ID, ALLOWED_ROLES, MONGO_URI, LOG_VERBOSE
} = process.env;

const VERBOSE = LOG_VERBOSE === 'true';

if (!BOT_TOKEN || !TORN_API_KEY || !WAR_CHANNEL_ID || !MY_FACTION_ID || !OWNER_ID || !GUILD_ID || !MONGO_URI) {
  console.error('❌ Missing required environment variables.');
  process.exit(1);
}

console.log(`[env] Loaded TORN_API_KEY starts with: ${TORN_API_KEY.slice(0, 5)}...`);

await mongoose.connect(MONGO_URI);
console.log('✅ MongoDB connected');

const WATCH_FILE = path.resolve('.', 'watchedFactions.json');
let watched = new Set();
function loadWatched() {
  if (fs.existsSync(WATCH_FILE)) {
    try { watched = new Set(JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'))); } catch { watched = new Set(); }
  }
}
function saveWatched() {
  fs.writeFileSync(WATCH_FILE, JSON.stringify([...watched], null, 2));
}
loadWatched();

let lastStatus = {};
let myLastStatus = {};
let lastAttackCheck = Math.floor(Date.now() / 1000) - 60;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  const commands = [
    { name: 'warstart', description: 'Start monitoring current war opponent (Captain)' },
    { name: 'endwar', description: 'Stop all war monitoring (Captain)' },
    {
      name: 'factionid',
      description: 'Add a faction ID to monitor',
      options: [{ name: 'id', description: 'Faction ID', type: 3, required: true }]
    }
  ];
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands);
  console.log(`✅ Slash commands registered`);
  startPolling();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, member, options, user } = interaction;
  const isCaptain = member.roles.cache.some(r => r.name === 'Captain');
  if (!isCaptain && user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ Only Captains can use this.', ephemeral: true });
  }

  if (commandName === 'factionid') {
    const id = options.getString('id');
    watched.add(id); saveWatched(); lastStatus[id] = {};
    return interaction.reply({ content: `👍 Watching faction ${id}`, ephemeral: true });
  }

  if (commandName === 'warstart') {
    await interaction.deferReply();
    try {
      const url = `https://api.torn.com/v2/faction/${MY_FACTION_ID}?selections=rankedwarreport&key=${TORN_API_KEY}`;
      const res = await axios.get(url);
      const report = res.data?.ranked_war_report;
      const active = report?.status === 'active';
      if (!active) return interaction.editReply('❌ No active war.');
      const enemy = String(report?.opponent?.faction_id);
      watched.add(enemy); saveWatched(); lastStatus[enemy] = {};
      return interaction.editReply(`⚔️ Monitoring enemy faction ${enemy}`);
    } catch (e) {
      console.error(e);
      return interaction.editReply('⚠️ Could not start war.');
    }
  }

  if (commandName === 'endwar') {
    watched.clear(); saveWatched();
    return interaction.reply('🛑 Monitoring stopped.');
  }
});

function startPolling() {
  const cycleCalls = 2 + watched.size;
  const interval = Math.max(1000, Math.floor(60000 / cycleCalls));
  console.log(`📡 Polling every ${interval}ms for ${[...watched].join(', ')}`);
  checkFaction(MY_FACTION_ID, true);
  watched.forEach(id => checkFaction(id, false));
  setTimeout(startPolling, interval);
}

async function checkFaction(factionId, isMine) {
  try {
    const url = `https://api.torn.com/v2/faction/${factionId}/members?striptags=true&key=${TORN_API_KEY}`;
    const res = await axios.get(url);
    const members = res.data.members;
    const channel = await client.channels.fetch(WAR_CHANNEL_ID);
    const cache = isMine ? myLastStatus : (lastStatus[factionId] || {});
    const now = {};

    for (const [userId, m] of Object.entries(members)) {
      now[userId] = m.status.status;

      if (!isMine) {
        await EnemyMember.updateOne(
          { userId },
          {
            userId,
            name: m.name,
            level: m.level,
            rank: m.rank,
            position: m.position,
            daysInFaction: m.days_in_faction,
            factionPosition: m.faction_position,
            factionId,
            status: m.status,
            lastAction: m.last_action,
            lastSeen: new Date()
          },
          { upsert: true }
        );

        if (m.status.status === 'hospital') {
          const cooldown = m.status.details?.cooldown || 0;
          const endsAt = new Date(Date.now() + cooldown * 1000);
          await Cooldown.updateOne(
            { userId },
            {
              userId,
              userName: m.name,
              factionId,
              cooldownEndsAt: endsAt,
              notified: false
            },
            { upsert: true }
          );
          if (VERBOSE) console.log(`💀 Hospital: ${m.name} (${userId}) | ${cooldown}s → ${endsAt.toISOString()}`);
        }

        if (cache[userId] === 'hospital' && m.status.status === 'online') {
          await Cooldown.deleteOne({ userId });
          channel.send(`✅ Enemy ${m.name} (${userId}) left hospital.`);
        }
      }
    }

    if (isMine) myLastStatus = now;
    else lastStatus[factionId] = now;
  } catch (e) {
    console.error(e);
  }
}

setInterval(async () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 8000);

  const targets = await Cooldown.find({
    cooldownEndsAt: { $lte: soon },
    notified: false
  });

  for (const user of targets) {
    const attackURL = `https://www.torn.com/loader2.php?sid=getInAttack&user2ID=${user.userId}`;
    const channel = await client.channels.fetch(WAR_CHANNEL_ID);
    await channel.send(`🎯 <@&${ALLOWED_ROLES}> target ready: <${attackURL}>`);
    user.notified = true;
    await user.save();
  }
}, 5000);

client.login(BOT_TOKEN);
