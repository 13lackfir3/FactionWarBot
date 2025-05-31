const mongoose = require('mongoose');
const { Schema } = mongoose;

// Schema for idle-op watch entries
const IdleOpWatchSchema = new Schema({
  userId: { type: String, required: true, unique: true, index: true },
  name:   { type: String, required: true },
  lastAction: {
    status:    { type: String, required: true },
    timestamp: { type: Date,   required: true }
  },
  channelId: { type: String, required: true }
});

module.exports = mongoose.model('IdleOpWatch', IdleOpWatchSchema);