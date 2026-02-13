import type { KokoroTTS } from 'kokoro-js';

let ttsInstance: KokoroTTS | null = null;
let loading = false;

export async function initTTS(): Promise<void> {
  if (ttsInstance || loading) return;
  loading = true;
  try {
    const { KokoroTTS: Cls } = await import('kokoro-js');
    console.log('[TTS] Loading Kokoro model (CPU)...');
    ttsInstance = await Cls.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'cpu',
    });
    console.log('[TTS] Model loaded, ready to serve.');
  } catch (err) {
    console.error('[TTS] Failed to load model:', err);
  } finally {
    loading = false;
  }
}

export async function generateAudio(text: string, voice: string): Promise<Buffer | null> {
  if (!ttsInstance) return null;
  try {
    const audio = await ttsInstance.generate(text, { voice: voice as any });
    const blob = audio.toBlob();
    const arrayBuffer = await blob.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('[TTS] Generation error:', err);
    return null;
  }
}

export function isTTSReady(): boolean {
  return ttsInstance !== null;
}
