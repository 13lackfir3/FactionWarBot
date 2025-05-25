// workers/statusWorker.js
// Polls watched operators every 30 seconds and alerts on status changes

const fs = require('fs');
const path = require('path');
const { PollUserStatusError, pollUserStatus } = require('../services/pollUserStatus');
const { SILENT_WEBHOOK_URL } = process.env;
const { WebhookClient } = require('discord.js');

// Path to watched idle operations file
const WATCH_FILE = path.resolve(__dirname, '../idleopWatch.json');
let watchedOps = [];

function loadWatchedOps() {
  try {
    watchedOps = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf-8'));
  } catch {
    watchedOps = [];
  }
}

function saveWatchedOps() {
  fs.writeFileSync(WATCH_FILE, JSON.stringify(watchedOps, null, 2));
}

// Initialize webhook for silent alerts
const silentWebhook = new WebhookClient({ url: SILENT_WEBHOOK_URL });

/**
 * Check each watched user for status changes
 */
async function checkIdleOps() {
  for (let entry of watchedOps) {
    try {
      const newStatus = await pollUserStatus(entry.userId);
      if (newStatus.status !== entry.lastStatus) {
        // Status changed → send alert
        await silentWebhook.send({
          username: 'IdleOp Alert',
          content: `<@${entry.userId}> status changed: **${entry.lastStatus}** → **${newStatus.status}**`
        });
        // Update stored status
        entry.lastStatus = newStatus.status;
      }
    } catch (err) {
      console.error(`Error polling status for ${entry.userId}:`, err);
    }
  }
  saveWatchedOps();
}

/**
 * Start the 30-second polling loop
 */
function startStatusWorker() {
  loadWatchedOps();
  // initial check
  setTimeout(checkIdleOps, 10000);
  // recurring every 30s
  setInterval(checkIdleOps, 30 * 1000);
}

module.exports = { startStatusWorker };
