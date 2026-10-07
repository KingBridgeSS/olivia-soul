// Pending upstream PCM: 16 kHz, mono, signed 16-bit samples.
export const UPSTREAM_AUDIO_BUFFER_SECONDS = 30;
export const MAX_UPSTREAM_AUDIO_BYTES = 16000 * 2 * UPSTREAM_AUDIO_BUFFER_SECONDS;

// Pending, unplayed audio: consumed samples free space in the playback ring.
// Keep one minute of headroom below the deployed GPU input buffer (600 seconds).
export const REPLY_AUDIO_BUFFER_SECONDS = 540;
export const MAX_REPLY_AUDIO_SAMPLES = 24000 * REPLY_AUDIO_BUFFER_SECONDS;
