import { config } from './config.js';

// Counts attempts per key in fixed time windows. Held in memory, which is
// enough for a single server process.
class AttemptLimiter {
  #entries = new Map(); // key -> { count, resetAt }

  // Seconds until `key` may try again, or 0 if it has made fewer than `max`
  // attempts in the current window.
  retryAfter(key, max) {
    const entry = this.#entries.get(key);
    const now = Date.now();
    if (!entry || entry.resetAt <= now || entry.count < max) return 0;
    return Math.ceil((entry.resetAt - now) / 1000);
  }

  record(key) {
    const now = Date.now();
    let entry = this.#entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#prune(now);
      entry = { count: 0, resetAt: now + config.limits.windowMs };
      this.#entries.set(key, entry);
    }
    entry.count += 1;
  }

  #prune(now) {
    if (this.#entries.size < 10_000) return;
    for (const [key, entry] of this.#entries) if (entry.resetAt <= now) this.#entries.delete(key);
  }
}

// Requests for codes that do not exist, per client address. A code is only
// six digits, so guessing has to be slowed down.
export const lookupMisses = new AttemptLimiter();

// Wrong passwords, per share (not per client, so spreading guesses across
// many addresses does not help).
export const unlockFailures = new AttemptLimiter();
