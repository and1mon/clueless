// Per-game TTS gating: credit-based semaphore that allows BUFFER_SIZE messages
// to be generated ahead before blocking.

const BUFFER_SIZE = 5;

const ttsEnabled = new Map<string, boolean>();
const credits = new Map<string, number>();
const waitQueues = new Map<string, Array<() => void>>();

// Logging helper
function logTtsGate(level: 'INFO' | 'WARN', message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  const log = level === 'WARN' ? console.warn : console.log;
  log(`[${timestamp}] [${level}] [ttsGate] ${message}${dataStr}`);
}

/** Set whether TTS gating is active for a game. */
export function setTtsMode(gameId: string, enabled: boolean): void {
  logTtsGate('INFO', `Setting TTS mode`, { gameId, enabled });
  ttsEnabled.set(gameId, enabled);
  if (!enabled) {
    // Drain all blocked waiters and reset credits
    const queue = waitQueues.get(gameId);
    if (queue && queue.length > 0) {
      logTtsGate('INFO', `Draining wait queue (TTS disabled)`, { gameId, queueLength: queue.length });
      for (const resolve of queue) resolve();
      queue.length = 0;
    }
    credits.set(gameId, BUFFER_SIZE);
  } else {
    // Start with full credits so the first BUFFER_SIZE calls resolve instantly
    credits.set(gameId, BUFFER_SIZE);
    waitQueues.set(gameId, []);
  }
}

/** Wait for TTS ack from client. Resolves immediately when TTS is off. */
export function waitForTtsAck(gameId: string): Promise<void> {
  if (!ttsEnabled.get(gameId)) {
    return Promise.resolve();
  }

  const current = credits.get(gameId) ?? 0;
  if (current > 0) {
    // Consume a credit and resolve immediately
    credits.set(gameId, current - 1);
    logTtsGate('INFO', `Consumed TTS credit (immediate)`, { gameId, remainingCredits: current - 1 });
    return Promise.resolve();
  }

  // No credits — block until ackTts wakes us (FIFO)
  const queueLen = (waitQueues.get(gameId) ?? []).length;
  logTtsGate('WARN', `No TTS credits, blocking`, { gameId, queuePosition: queueLen });
  
  return new Promise((resolve) => {
    let resolved = false;
    const wrappedResolve = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        logTtsGate('INFO', `TTS wait resolved (ack received)`, { gameId });
        resolve();
      }
    };

    // Safety net: 15-second timeout
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // Remove from queue
        const queue = waitQueues.get(gameId);
        if (queue) {
          const idx = queue.indexOf(wrappedResolve);
          if (idx >= 0) queue.splice(idx, 1);
        }
        logTtsGate('WARN', `TTS wait timed out (15s)`, { gameId });
        resolve();
      }
    }, 15_000);

    let queue = waitQueues.get(gameId);
    if (!queue) {
      queue = [];
      waitQueues.set(gameId, queue);
    }
    queue.push(wrappedResolve);
  });
}

/** Client signals TTS playback finished — wake oldest blocked waiter or bank a credit. */
export function ackTts(gameId: string): void {
  const queue = waitQueues.get(gameId);
  if (queue && queue.length > 0) {
    // Wake the oldest blocked waiter
    logTtsGate('INFO', `Received TTS ack, waking waiter`, { gameId, remainingWaiters: queue.length - 1 });
    const resolve = queue.shift()!;
    resolve();
  } else {
    // No one waiting — bank a credit (up to BUFFER_SIZE)
    const current = credits.get(gameId) ?? 0;
    if (current < BUFFER_SIZE) {
      credits.set(gameId, current + 1);
      logTtsGate('INFO', `Received TTS ack, banked credit`, { gameId, credits: current + 1 });
    } else {
      logTtsGate('INFO', `Received TTS ack, credits full`, { gameId, credits: current });
    }
  }
}
