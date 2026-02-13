// TTS service — calls server-side kokoro TTS via API.

const VOICE_POOL = [
  'af_heart', 'af_bella', 'af_aoede', 'af_kore', 'af_sarah', 'af_sky',
  'am_fenrir', 'am_michael', 'am_puck', 'am_adam', 'am_eric',
  'bf_emma', 'bf_isabella', 'bf_alice',
  'bm_george', 'bm_fable', 'bm_daniel', 'bm_lewis',
];

function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .trim();
}

/** Check if the TTS server is reachable. */
export async function preloadTTS(): Promise<boolean> {
  try {
    const res = await fetch('/api/tts/health');
    return res.ok;
  } catch {
    return false;
  }
}

/** Generate TTS audio via server. Returns a blob URL or null. */
export async function generateTTS(text: string, voice: string): Promise<string | null> {
  const clean = cleanForSpeech(text);
  if (!clean) return null;
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, voice }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export function disposeTTS(): void { }

export function pickVoice(index: number): string {
  return VOICE_POOL[index % VOICE_POOL.length];
}

export function setStatusCallback(): void { }
export function setProgressCallback(): void { }
export function isTTSReady(): boolean { return true; }
export function isTTSLoading(): boolean { return false; }
export function getTTSError(): string | null { return null; }
