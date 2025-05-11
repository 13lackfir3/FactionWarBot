// models/Cooldown.js
import mongoose from 'mongoose';

const cooldownSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  userName: String,
  factionId: String,
  cooldownEndsAt: Date,
  notified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Cooldown', cooldownSchema);
