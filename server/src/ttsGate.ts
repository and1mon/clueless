// Per-game TTS gating: credit-based semaphore that allows BUFFER_SIZE messages
// to be generated ahead before blocking.

const BUFFER_SIZE = 5;

const ttsEnabled = new Map<string, boolean>();
const credits = new Map<string, number>();
const waitQueues = new Map<string, Array<() => void>>();

/** Set whether TTS gating is active for a game. */
export function setTtsMode(gameId: string, enabled: boolean): void {
  ttsEnabled.set(gameId, enabled);
  if (!enabled) {
    // Drain all blocked waiters and reset credits
    const queue = waitQueues.get(gameId);
    if (queue) {
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
    return Promise.resolve();
  }

  // No credits — block until ackTts wakes us (FIFO)
  return new Promise((resolve) => {
    let resolved = false;
    const wrappedResolve = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
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
    const resolve = queue.shift()!;
    resolve();
  } else {
    // No one waiting — bank a credit (up to BUFFER_SIZE)
    const current = credits.get(gameId) ?? 0;
    if (current < BUFFER_SIZE) {
      credits.set(gameId, current + 1);
    }
  }
}
