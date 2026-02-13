// Per-game TTS gating: deliberation waits for the client to ack after TTS playback.

const ttsEnabled = new Map<string, boolean>();
const gates = new Map<string, () => void>();

/** Set whether TTS gating is active for a game. */
export function setTtsMode(gameId: string, enabled: boolean): void {
  ttsEnabled.set(gameId, enabled);
}

/** Wait for TTS ack from client. Falls back to a short delay when TTS is off. */
export function waitForTtsAck(gameId: string): Promise<void> {
  if (!ttsEnabled.get(gameId)) {
    return new Promise((r) => setTimeout(r, 1500));
  }

  return new Promise((resolve) => {
    // Resolve any previous unresolved gate
    const prev = gates.get(gameId);
    if (prev) prev();

    const timer = setTimeout(() => {
      gates.delete(gameId);
      resolve();
    }, 15_000);

    gates.set(gameId, () => {
      clearTimeout(timer);
      gates.delete(gameId);
      resolve();
    });
  });
}

/** Client signals TTS playback finished. */
export function ackTts(gameId: string): void {
  const resolve = gates.get(gameId);
  if (resolve) resolve();
}
