const { pollUserStatus } = require('./pollUserStatus');
const IdleOpWatch        = require('../models/IdleOpWatch');
const { WebhookClient }  = require('discord.js');

// Webhook for idle-op notifications
const silentWebhook = new WebhookClient({ url: process.env.SILENT_WEBHOOK_URL });

/**
 * Polls each watched user and notifies only when status changes.
 * Compares against the DB-stored lastAction.
 * Mentions captains only when the status transitions to 'offline'.
 */
let isInitialRun = true;
async function checkIdleOpStatus() {
  try {
    const watches = await IdleOpWatch.find();
      // Seed DB on first run without sending notifications
      if (isInitialRun) {
        for (const watchInit of watches) {
          await IdleOpWatch.updateOne(
            { userId: watchInit.userId },
            { lastAction: watchInit.lastAction || {} }
          );
        }
        isInitialRun = false;
        return;
      }
    for (const watch of watches) {
      const userId = watch.userId;
      // fetch current status
      const { name, status: { last_action: curr } } = await pollUserStatus(userId);
      const currStatus = curr.status;
      const prevStatus = watch.lastAction?.status;

      // Only proceed if status has changed
      if (prevStatus !== currStatus) {
        // Update DB with new status and timestamp
        await IdleOpWatch.updateOne(
          { userId },
          { lastAction: curr }
        );

        // Mention captains when status is online or offline
        const mention = ['offline'].includes(currStatus)
          ? `<@&${process.env.CAPTAIN_ROLE_ID}> `
          : '';

        // Send notification
        await silentWebhook.send({
          username: 'D4 Intelligence',
          content: `${mention}👀 **${name}** is now **${currStatus}**
          (${new Date(curr.timestamp * 1000).toISOString()})`
        });
      }
      // else, no action
    }
  } catch (err) {
    console.error('IdleOp status worker error:', err);
  }
}

module.exports = { checkIdleOpStatus };
