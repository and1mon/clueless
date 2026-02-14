import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { apiRequest } from './api';
import { type GameState, type Player, type PlayerRole, type TeamColor } from './types';

type Theme = 'light' | 'dark';
function getInitialTheme(): Theme {
  const saved = localStorage.getItem('clueless-theme') as Theme | null;
  if (saved) return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

interface LlmPlayerSetup {
  name: string;
  model: string;
  personality: string;
}

function defaultLlmPlayers(team: TeamColor, count: number): LlmPlayerSetup[] {
  const prefix = team === 'red' ? 'Red' : 'Blue';
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${i + 1}`,
    model: '',
    personality: '',
  }));
}

const PERSONALITY_POOL: { name: string; description: string }[] = [
  { name: 'The Overthinker', description: 'You overthink everything and second-guess yourself constantly. Every choice stresses you out and you keep imagining what could go wrong.' },
  { name: 'The Hothead', description: 'You\'re impatient and get fired up easily. You want to guess NOW and hate when people deliberate forever. Not rude, just intense.' },
  { name: 'The Schemer', description: 'You\'re always thinking three moves ahead. You care about what the other team is doing almost as much as your own plays. Sneaky energy.' },
  { name: 'The Hype Beast', description: 'You get WAY too excited about everything. Every good guess makes you explode with joy and every bad one devastates you. Pure emotional energy.' },
  { name: 'The Chill One', description: 'You\'re super relaxed and laid-back. Nothing phases you. You go with the flow and keep things mellow. Easy agreement, low stress.' },
  { name: 'The Trash Talker', description: 'You love talking shit — to the other team AND your own teammates (lovingly). Competitive banter is your love language.' },
  { name: 'The Nerd', description: 'You get excited about obscure word connections and etymology. Kind of a know-it-all but in a charming way. You drop random facts.' },
  { name: 'The Skeptic', description: 'You don\'t trust anyone\'s first instinct, including your own. You poke holes in every suggestion and question everything.' },
  { name: 'The Cheerleader', description: 'You\'re endlessly positive and supportive. You hype up every teammate\'s idea. Even bad guesses get encouragement from you.' },
  { name: 'The Boss', description: 'You naturally take charge of discussions. You like to organize the team and keep things on track. Can come across as a bit bossy but mean well.' },
  { name: 'The Comedian', description: 'You can\'t help making jokes and puns about everything. You take the game seriously but you take being funny MORE seriously.' },
  { name: 'The Worry Wart', description: 'You\'re always thinking about worst-case scenarios. You\'re cautious to a fault and imagine everything that could go wrong.' },
  { name: 'The Gambler', description: 'You love risky plays and big swings. You believe in bold moves and get bored with safe, obvious guesses.' },
  { name: 'The Peacemaker', description: 'You hate conflict and always try to find middle ground. When teammates disagree you try to hear everyone out and find compromise.' },
  { name: 'The Rival', description: 'You are OBSESSED with beating the other team. Everything is about the competition. You take their successes personally and celebrate their failures.' },
  { name: 'The Contrarian', description: 'If everyone agrees, you suddenly get suspicious. You play devil\'s advocate on purpose and argue the opposite just to test ideas.' },
  { name: 'The Vibes Player', description: 'You go purely on gut feeling and vibes. Your reasoning is often just intuition which drives analytical teammates crazy.' },
  { name: 'The Professor', description: 'You approach the game methodically and like to reason through things step by step. A bit dry but usually right. You eliminate wrong answers before guessing.' },
  { name: 'The Drama Queen', description: 'Everything is the end of the world or the best thing ever. You have BIG reactions to everything. There is no middle ground in your emotional range.' },
  { name: 'The Silent Type', description: 'You don\'t talk much, but when you do, it\'s usually something sharp or funny. You observe more than you speak. Quality over quantity.' },
];

// Configure marked for inline rendering
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true, // GitHub Flavored Markdown
});

// Helper to parse markdown inline (no block elements)
function parseMarkdown(text: string): string {
  return marked.parseInline(text) as string;
}

// Convert system message display text into natural speech for TTS
function systemTextToSpeech(text: string): string {
  const revealed = text.match(/^Revealed "(.+?)" → (.+)$/);
  if (revealed) return `${revealed[1]} was revealed. It belongs to ${revealed[2]}.`;
  const hint = text.match(/^Spymaster says: "(.+?)" \((\d+)\)$/);
  if (hint) return `The spymaster's hint is ${hint[1]}, for ${hint[2]}.`;
  const gameOver = text.match(/^Game over — (\w+) wins! \((.+)\)$/);
  if (gameOver) return `Game over! ${gameOver[1]} team wins. ${gameOver[2]}.`;
  const turnSwitch = text.match(/^It's now (\w+)'s turn\.$/);
  if (turnSwitch) return `It's now ${turnSwitch[1]} team's turn.`;
  const proposeGuess = text.match(/^(.+) proposes guessing "(.+)"$/);
  if (proposeGuess) return `${proposeGuess[1]} proposes guessing ${proposeGuess[2]}.`;
  const alsoGuess = text.match(/^(.+) also wants to guess "(.+)"$/);
  if (alsoGuess) return `${alsoGuess[1]} also wants to guess ${alsoGuess[2]}.`;
  const voted = text.match(/^(.+) voted (accept|reject)$/);
  if (voted) return `${voted[1]} voted to ${voted[2]}.`;
  return text.replace(/"/g, '');
}

export function App(): JSX.Element {
  const [game, setGameRaw] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [guessWord, setGuessWord] = useState('');
  const [hintWord, setHintWord] = useState('');
  const [hintCount, setHintCount] = useState('2');
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameState | null>(null);
  const [displayVersion, setDisplayVersion] = useState(0);
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);

  // TTS board sync: store game snapshots keyed by chatLog length
  const gameSnapshots = useRef<Map<number, GameState>>(new Map());
  const setGame = useCallback((g: GameState | null) => {
    if (g) {
      gameSnapshots.current.set(g.chatLog.length, g);
      // Keep only recent snapshots to avoid memory leak
      if (gameSnapshots.current.size > 50) {
        const keys = Array.from(gameSnapshots.current.keys()).sort((a, b) => a - b);
        for (let i = 0; i < keys.length - 50; i++) gameSnapshots.current.delete(keys[i]);
      }
    }
    setGameRaw(g);
  }, []);
  gameRef.current = game;

  const [setup, setSetup] = useState({
    humanName: 'You',
    humanTeam: 'red' as TeamColor,
    humanRole: 'spectator' as PlayerRole | 'spectator',
    teamSize: 3,
    baseUrl: '',
    model: '',
    redModel: '',
    blueModel: '',
    neutralLlmMode: true,
    apiKey: '',
    redPlayers: defaultLlmPlayers('red', 3),
    bluePlayers: defaultLlmPlayers('blue', 3),
  });

  const isSpectator = setup.humanRole === 'spectator';

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('clueless-theme', theme);
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  const humanPlayer = useMemo(
    () => game ? Object.values(game.players).find((p) => p.type === 'human') : undefined,
    [game],
  );
  const myTeam = humanPlayer?.team ?? 'red';

  const playerNames = useMemo(() => {
    if (!game) return {} as Record<string, string>;
    return Object.fromEntries(Object.values(game.players).map((p) => [p.id, p.name]));
  }, [game]);

  const isMyTurn = game && !isSpectator ? game.turn.activeTeam === myTeam && !game.winner : false;

  // Auto-refresh
  useEffect(() => {
    if (!game) return;
    const timer = setInterval(async () => {
      try {
        const latest = await apiRequest<GameState>(`/api/games/${game.id}`);
        setGame(latest);
      } catch { /* ignore */ }
    }, 1500);
    return () => clearInterval(timer);
  }, [game?.id]);

  // Auto-scroll chat (also triggers when display-gated messages are revealed)
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game?.chatLog, displayVersion]);

  // Stale detection state (must be before any early returns)
  const [staleRetries, setStaleRetries] = useState(0);
  const [showRetryPrompt, setShowRetryPrompt] = useState(false);
  const lastMsgCount = useRef(0);
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingBubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [thinkingBubbleGrace, setThinkingBubbleGrace] = useState(false);
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null);

  // TTS state
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ttsStartIdx = useRef(-1);
  const ttsCache = useRef<Map<string, string>>(new Map());
  const ttsGenerating = useRef<Set<string>>(new Set());
  const ttsFailed = useRef<Set<string>>(new Set());
  const displayUpTo = useRef(0);
  // A3: State counter to re-trigger tryAdvanceDisplay when TTS generation completes
  const [ttsReady, setTtsReady] = useState(0);
  // A4: Track concurrent generation count to limit parallel requests
  const ttsActiveGenerations = useRef(0);
  const TTS_MAX_CONCURRENT = 2;
  // A4: Queue of pending TTS generation requests
  const ttsQueue = useRef<Array<{ msgId: string; content: string; voice: string }>>([]);

  // A4: Process TTS generation queue — starts next item if under concurrency limit
  const processTtsQueue = useCallback(() => {
    while (ttsActiveGenerations.current < TTS_MAX_CONCURRENT && ttsQueue.current.length > 0) {
      const item = ttsQueue.current.shift()!;
      if (ttsCache.current.has(item.msgId) || ttsFailed.current.has(item.msgId)) continue;
      ttsActiveGenerations.current++;
      import('./ttsService').then(({ generateTTS }) => {
        generateTTS(item.content, item.voice).then((blobUrl) => {
          ttsActiveGenerations.current--;
          ttsGenerating.current.delete(item.msgId);
          if (blobUrl) {
            ttsCache.current.set(item.msgId, blobUrl);
          } else {
            ttsFailed.current.add(item.msgId);
          }
          // A3: Bump ttsReady to re-trigger the advance effect
          setTtsReady((v) => v + 1);
          // A4: Process next in queue
          processTtsQueue();
        });
      });
    }
  }, []);

  // A1: playAudio now sends tts-ack AFTER playback finishes (not after generation)
  const playAudio = useCallback((blobUrl: string, msgId: string, onEnd?: () => void) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const audio = new Audio(blobUrl);
    audioRef.current = audio;
    setPlayingMsgId(msgId);

    const handleEnd = () => {
      setPlayingMsgId(null);
      audioRef.current = null;
      // A1: Ack the server after the user actually heard the message
      const g = gameRef.current;
      if (g) {
        apiRequest(`/api/games/${g.id}/tts-ack`, { method: 'POST', body: '{}' }).catch(() => {});
      }
      onEnd?.();
    };

    audio.onended = handleEnd;
    audio.onerror = handleEnd;
    audio.play().catch(() => {
      setPlayingMsgId(null);
      handleEnd();
    });
  }, []);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPlayingMsgId(null);
  }, []);

  const cleanupTts = useCallback(() => {
    for (const url of ttsCache.current.values()) {
      URL.revokeObjectURL(url);
    }
    ttsCache.current.clear();
    ttsGenerating.current.clear();
    ttsFailed.current.clear();
    ttsQueue.current = [];
    ttsActiveGenerations.current = 0;
    ttsStartIdx.current = -1;
    import('./ttsService').then(({ disposeTTS }) => disposeTTS());
  }, []);

  const resetTts = useCallback(() => {
    setTtsEnabled(false);
    setTtsLoading(false);
    stopAudio();
    cleanupTts();
  }, [stopAudio, cleanupTts]);

  // Clean up TTS blob URLs and worker on unmount
  useEffect(() => {
    return () => cleanupTts();
  }, [cleanupTts]);

  // tryAdvanceDisplay: reveal messages one at a time, gated by audio playback.
  const tryAdvanceDisplay = useCallback(() => {
    const g = gameRef.current;
    if (!g || !ttsEnabled) return;
    if (audioRef.current) return; // audio still playing

    const log = g.chatLog;

    while (displayUpTo.current < log.length) {
      const msg = log[displayUpTo.current];
      if (msg.content === '...') {
        displayUpTo.current++;
        setDisplayVersion((v) => v + 1);
        continue;
      }

      const blobUrl = ttsCache.current.get(msg.id);
      const failed = ttsFailed.current.has(msg.id);

      if (blobUrl) {
        displayUpTo.current++;
        setDisplayVersion((v) => v + 1);
        playAudio(blobUrl, msg.id, () => {
          tryAdvanceDisplay();
        });
        return;
      } else if (failed) {
        displayUpTo.current++;
        setDisplayVersion((v) => v + 1);
        // A1: Ack for failed TTS too so server doesn't stall
        const gg = gameRef.current;
        if (gg) {
          apiRequest(`/api/games/${gg.id}/tts-ack`, { method: 'POST', body: '{}' }).catch(() => {});
        }
        continue;
      } else {
        // Audio not ready — A3: will be re-triggered by ttsReady state change
        break;
      }
    }
  }, [ttsEnabled, playAudio]);

  // A3: Re-trigger tryAdvanceDisplay when TTS generation completes
  useEffect(() => {
    if (ttsReady > 0) tryAdvanceDisplay();
  }, [ttsReady, tryAdvanceDisplay]);

  // End-game catch-up: keep trying to reveal/play any buffered final messages in TTS mode.
  useEffect(() => {
    if (!ttsEnabled || !game?.winner) return;
    const timer = setInterval(() => {
      processTtsQueue();
      tryAdvanceDisplay();
    }, 300);
    return () => clearInterval(timer);
  }, [ttsEnabled, game?.winner, game?.chatLog.length, processTtsQueue, tryAdvanceDisplay]);

  // Generate TTS for new chat messages with A4: concurrency-limited queue
  useEffect(() => {
    if (!game || !ttsEnabled || ttsLoading) return;
    const log = game.chatLog;
    if (ttsStartIdx.current < 0) {
      ttsStartIdx.current = log.length;
      displayUpTo.current = log.length;
      setDisplayVersion((v) => v + 1);
      return;
    }
    for (let i = ttsStartIdx.current; i < log.length; i++) {
      const msg = log[i];
      if (msg.content === '...') {
        ttsStartIdx.current = i + 1;
        continue;
      }
      if (ttsCache.current.has(msg.id) || ttsGenerating.current.has(msg.id) || ttsFailed.current.has(msg.id)) {
        ttsStartIdx.current = i + 1;
        continue;
      }
      const player = game.players[msg.playerId];
      const isAction = msg.kind !== 'chat';
      const voice = isAction ? 'bf_emma' : (player?.voice || 'af_heart');
      const content = isAction ? systemTextToSpeech(msg.content) : msg.content;
      ttsGenerating.current.add(msg.id);
      // A4: Enqueue instead of firing all in parallel
      ttsQueue.current.push({ msgId: msg.id, content, voice });
      ttsStartIdx.current = i + 1;
    }
    // A4: Kick the queue processor
    processTtsQueue();
    // Also try to advance in case new system messages appeared
    tryAdvanceDisplay();
  }, [game?.chatLog.length, ttsEnabled, ttsLoading, tryAdvanceDisplay, processTtsQueue]);

  // Detect LLM config errors and go back to setup
  useEffect(() => {
    if (game?.llmError) {
      setError(`⚠️ ${game.llmError}. Check your LLM configuration and try again.`);
      setGame(null);
      resetTts();
    }
  }, [game?.llmError, resetTts]);

  // Stale detection: auto-nudge LLM if no new messages after 60s
  const isThinking = game ? (game.deliberating.red || game.deliberating.blue) : false;

  // A5: Show thinking bubble when server is deliberating OR when TTS has buffered unrevealed messages
  const hasTtsBuffer = ttsEnabled && game ? displayUpTo.current < game.chatLog.length : false;
  const showThinkingRaw = isThinking || hasTtsBuffer;
  const showThinking = showThinkingRaw || thinkingBubbleGrace;

  // Keep thinking bubble visible briefly to bridge polling gaps between LLM messages.
  useEffect(() => {
    if (thinkingBubbleTimer.current) {
      clearTimeout(thinkingBubbleTimer.current);
      thinkingBubbleTimer.current = null;
    }
    if (game?.winner) {
      setThinkingBubbleGrace(false);
      return;
    }
    if (showThinkingRaw) {
      setThinkingBubbleGrace(true);
      return;
    }
    thinkingBubbleTimer.current = setTimeout(() => {
      setThinkingBubbleGrace(false);
      thinkingBubbleTimer.current = null;
    }, 1800);
    return () => {
      if (thinkingBubbleTimer.current) {
        clearTimeout(thinkingBubbleTimer.current);
        thinkingBubbleTimer.current = null;
      }
    };
  }, [showThinkingRaw, game?.winner]);

  // When TTS is enabled, show thinking bubble for the team of the next unrevealed message
  const thinkingTeam = useMemo(() => {
    if (!game) return 'red';

    if (ttsEnabled && displayUpTo.current < game.chatLog.length) {
      for (let i = displayUpTo.current; i < game.chatLog.length; i++) {
        const msg = game.chatLog[i];
        if (msg.kind === 'chat' && msg.content !== '...') {
          return msg.team;
        }
      }
    }

    return game.deliberating.red ? 'red' : game.deliberating.blue ? 'blue' : game.turn.activeTeam;
  }, [game, ttsEnabled, displayVersion]);
  useEffect(() => {
    if (!game || game.winner) return;
    const msgCount = game.chatLog.length;
    if (msgCount !== lastMsgCount.current) {
      lastMsgCount.current = msgCount;
      setStaleRetries(0);
      setShowRetryPrompt(false);
    }
    if (staleTimer.current) clearTimeout(staleTimer.current);
    if (!isThinking) return;

    staleTimer.current = setTimeout(() => {
      if (staleRetries >= 2) {
        setShowRetryPrompt(true);
      } else {
        setStaleRetries((r) => r + 1);
        nudgeLlm();
      }
    }, 60_000);
    return () => { if (staleTimer.current) clearTimeout(staleTimer.current); };
  }, [game?.chatLog.length, isThinking, staleRetries]);

  const handleRetry = (): void => {
    setShowRetryPrompt(false);
    setStaleRetries(0);
    nudgeLlm();
  };

  // Player lookup for team roster
  const teamRoster = useMemo(() => {
    if (!game) return { red: [] as Player[], blue: [] as Player[] };
    return {
      red: game.teams.red.players.map((id) => game.players[id]).filter(Boolean),
      blue: game.teams.blue.players.map((id) => game.players[id]).filter(Boolean),
    };
  }, [game]);

  const apply = (next: GameState): void => {
    setGame(next);
    setError('');
  };

  const newGame = (): void => {
    setGame(null);
    gameSnapshots.current.clear();
    setError('');
    resetTts();
  };

  // Compute LLM counts from teamSize + human placement
  const llmCount = (team: TeamColor): number => {
    if (setup.humanRole === 'spectator') return setup.teamSize;
    return team === setup.humanTeam ? setup.teamSize - 1 : setup.teamSize;
  };

  const syncPlayers = (s: typeof setup, newSize: number, newTeam: TeamColor, newRole: string): typeof setup => {
    const redLlm = newRole === 'spectator' ? newSize : (newTeam === 'red' ? newSize - 1 : newSize);
    const blueLlm = newRole === 'spectator' ? newSize : (newTeam === 'blue' ? newSize - 1 : newSize);
    const resize = (arr: LlmPlayerSetup[], team: TeamColor, target: number): LlmPlayerSetup[] => {
      if (target <= arr.length) return arr.slice(0, target);
      const prefix = team === 'red' ? 'Red' : 'Blue';
      return [...arr, ...Array.from({ length: target - arr.length }, (_, i) => ({
        name: `${prefix}-${arr.length + i + 1}`, model: '', personality: '',
      }))];
    };
    return { ...s, teamSize: newSize, humanTeam: newTeam, humanRole: newRole as PlayerRole | 'spectator',
      redPlayers: resize(s.redPlayers, 'red', redLlm),
      bluePlayers: resize(s.bluePlayers, 'blue', blueLlm),
    };
  };

  const changeTeamSize = (size: number): void => {
    const clamped = Math.max(2, Math.min(6, size));
    setSetup((s) => syncPlayers(s, clamped, s.humanTeam, s.humanRole));
  };

  const joinTeam = (team: TeamColor): void => {
    if (setup.humanRole === 'spectator') return;
    setSetup((s) => syncPlayers(s, s.teamSize, team, s.humanRole));
  };

  const setRole = (role: string): void => {
    setSetup((s) => syncPlayers(s, s.teamSize, s.humanTeam, role));
  };

  const updateLlmPlayer = (team: TeamColor, index: number, field: keyof LlmPlayerSetup, value: string): void => {
    const key = team === 'red' ? 'redPlayers' : 'bluePlayers';
    setSetup((s) => {
      const players = [...s[key]];
      players[index] = { ...players[index], [field]: value };
      const shouldDisableNeutral = field === 'personality' && value.trim().length > 0;
      return { ...s, [key]: players, neutralLlmMode: shouldDisableNeutral ? false : s.neutralLlmMode };
    });
  };

  const assignRandomPersonalities = (): void => {
    const shuffled = [...PERSONALITY_POOL].sort(() => Math.random() - 0.5);
    let idx = 0;
    setSetup((s) => ({
      ...s,
      neutralLlmMode: false,
      redPlayers: s.redPlayers.map((p) => {
        const pick = shuffled[idx++ % shuffled.length];
        return { ...p, name: pick.name, personality: pick.description };
      }),
      bluePlayers: s.bluePlayers.map((p) => {
        const pick = shuffled[idx++ % shuffled.length];
        return { ...p, name: pick.name, personality: pick.description };
      }),
    }));
  };

  const clearAllPersonalities = (): void => {
    setSetup((s) => ({
      ...s,
      neutralLlmMode: true,
      redPlayers: s.redPlayers.map((p, i) => ({ ...p, name: `Red-${i + 1}`, personality: '' })),
      bluePlayers: s.bluePlayers.map((p, i) => ({ ...p, name: `Blue-${i + 1}`, personality: '' })),
    }));
  };

  const createGame = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const created = await apiRequest<GameState>('/api/games', {
        method: 'POST',
        body: JSON.stringify({
          humanName: setup.humanName,
          humanTeam: setup.humanTeam,
          humanRole: setup.humanRole,
          llmPlayers: { red: llmCount('red'), blue: llmCount('blue') },
          llmPlayerConfigs: {
            red: setup.redPlayers.map((p) => ({
              name: p.name || undefined,
              model: p.model || undefined,
              personality: p.personality || undefined,
            })),
            blue: setup.bluePlayers.map((p) => ({
              name: p.name || undefined,
              model: p.model || undefined,
              personality: p.personality || undefined,
            })),
          },
          llmTeamModels: {
            red: setup.redModel || undefined,
            blue: setup.blueModel || undefined,
          },
          llmNeutralMode: setup.neutralLlmMode,
          llm: { baseUrl: setup.baseUrl, model: setup.model, apiKey: setup.apiKey },
        }),
      });
      apply(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const sendChat = async (): Promise<void> => {
    if (!game || !humanPlayer || !message.trim()) return;
    try {
      const next = await apiRequest<GameState>(`/api/games/${game.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({ team: myTeam, playerId: humanPlayer.id, content: message }),
      });
      apply(next);
      setMessage('');
    } catch (err) { setError((err as Error).message); }
  };

  const sendHint = async (): Promise<void> => {
    if (!game || !humanPlayer || !hintWord.trim()) return;
    try {
      const next = await apiRequest<GameState>(`/api/games/${game.id}/hint`, {
        method: 'POST',
        body: JSON.stringify({ team: myTeam, playerId: humanPlayer.id, word: hintWord, count: Number(hintCount) }),
      });
      apply(next);
      setHintWord('');
    } catch (err) { setError((err as Error).message); }
  };

  const proposeGuess = async (word?: string): Promise<void> => {
    if (!game || !humanPlayer) return;
    const w = word ?? guessWord;
    if (!w.trim()) return;
    try {
      // Send chat message first if provided
      if (message.trim()) {
        const chatNext = await apiRequest<GameState>(`/api/games/${game.id}/chat`, {
          method: 'POST',
          body: JSON.stringify({ team: myTeam, playerId: humanPlayer.id, content: message }),
        });
        apply(chatNext);
        setMessage('');
      }
      const next = await apiRequest<GameState>(`/api/games/${game.id}/proposals`, {
        method: 'POST',
        body: JSON.stringify({ team: myTeam, playerId: humanPlayer.id, kind: 'guess', payload: { word: w } }),
      });
      apply(next);
      setGuessWord('');
    } catch (err) { setError((err as Error).message); }
  };

  const proposeEndTurn = async (): Promise<void> => {
    if (!game || !humanPlayer) return;
    try {
      // Send chat message first if provided
      if (message.trim()) {
        const chatNext = await apiRequest<GameState>(`/api/games/${game.id}/chat`, {
          method: 'POST',
          body: JSON.stringify({ team: myTeam, playerId: humanPlayer.id, content: message }),
        });
        apply(chatNext);
        setMessage('');
      }
      const next = await apiRequest<GameState>(`/api/games/${game.id}/proposals`, {
        method: 'POST',
        body: JSON.stringify({ team: myTeam, playerId: humanPlayer.id, kind: 'end_turn', payload: {} }),
      });
      apply(next);
    } catch (err) { setError((err as Error).message); }
  };

  const vote = async (proposalId: string, decision: 'accept' | 'reject'): Promise<void> => {
    if (!game || !humanPlayer) return;
    try {
      const next = await apiRequest<GameState>(`/api/games/${game.id}/proposals/${proposalId}/vote`, {
        method: 'POST',
        body: JSON.stringify({ team: myTeam, playerId: humanPlayer.id, decision }),
      });
      apply(next);
    } catch (err) { setError((err as Error).message); }
  };

  const nudgeLlm = async (): Promise<void> => {
    if (!game) return;
    try {
      await apiRequest(`/api/games/${game.id}/teams/${myTeam}/llm-deliberate`, { method: 'POST', body: '{}' });
    } catch { /* ignore */ }
  };

  const pauseLlm = async (): Promise<void> => {
    if (!game) return;
    try {
      const next = await apiRequest<GameState>(`/api/games/${game.id}/teams/${myTeam}/pause`, { method: 'POST', body: '{}' });
      apply(next);
    } catch { /* ignore */ }
  };

  const resumeLlm = async (): Promise<void> => {
    if (!game) return;
    try {
      await apiRequest(`/api/games/${game.id}/teams/${myTeam}/resume`, { method: 'POST', body: '{}' });
    } catch { /* ignore */ }
  };

  // In TTS mode, derive a "display" game state that matches what the user has seen so far
  const displayGame = useMemo(() => {
    if (!game || !ttsEnabled) return game;
    const target = displayUpTo.current;
    let best: GameState | null = null;
    let bestLen = -1;
    for (const [len, snap] of gameSnapshots.current) {
      if (len <= target && len > bestLen) {
        best = snap;
        bestLen = len;
      }
    }
    return best ?? game;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, ttsEnabled, displayVersion]);

  // --- SETUP ---
  if (!game) {
    const renderPlayerList = (team: TeamColor) => {
      const players = team === 'red' ? setup.redPlayers : setup.bluePlayers;
      const isHumanTeam = team === setup.humanTeam && setup.humanRole !== 'spectator';
      const isJoined = isHumanTeam;
      return (
        <div
          className={`team-card ${team}${isJoined ? ' joined' : ''}`}
          onClick={() => joinTeam(team)}
          role="button"
          tabIndex={0}
        >
          <div className="team-card-header">
            <span className={`team-label ${team}`}>{team === 'red' ? 'Red Team' : 'Blue Team'}</span>
            <span className="team-size">{setup.teamSize} players</span>
          </div>
          {isJoined ? (
            <div className="team-human-slot">
              <span className="human-badge">You ({setup.humanRole})</span>
            </div>
          ) : null}
          {players.map((p, i) => {
            const key = `${team}-${i}`;
            const isExpanded = expandedPlayer === key;
            return (
              <div key={key} className="llm-player-row" onClick={(e) => e.stopPropagation()}>
                <div className="llm-player-summary">
                  <input
                    value={p.name}
                    onChange={(e) => updateLlmPlayer(team, i, 'name', e.target.value)}
                    placeholder={`${team === 'red' ? 'Red' : 'Blue'}-${i + 1}`}
                    className="player-name-input"
                  />
                  <button type="button" className="expand-btn" onClick={() => setExpandedPlayer(isExpanded ? null : key)}>
                    {isExpanded ? '▾' : '▸'}
                  </button>
                </div>
                {isExpanded ? (
                  <div className="llm-player-details">
                    <label>Model <input value={p.model} onChange={(e) => updateLlmPlayer(team, i, 'model', e.target.value)} placeholder="Use default" /></label>
                    <label>Personality
                      <textarea
                        value={p.personality}
                        onChange={(e) => updateLlmPlayer(team, i, 'personality', e.target.value)}
                        placeholder="e.g. You are bold and decisive."
                        rows={2}
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      );
    };

    return (
      <main className="setup-screen">
        <div className="setup-header">
          <div>
            <h1>Clueless</h1>
            <p className="subtitle">Word spy game with LLM teammates</p>
          </div>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">{theme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
        <form onSubmit={createGame} className="setup-form">
          <div className="setup-top-bar">
            <div className="setup-top-group">
              <label>Your name
                <input value={setup.humanName} onChange={(e) => setSetup((s) => ({ ...s, humanName: e.target.value }))} />
              </label>
              <label>Role
                <select value={setup.humanRole} onChange={(e) => setRole(e.target.value)}>
                  <option value="operative">Operative</option>
                  <option value="spymaster">Spymaster</option>
                  <option value="spectator">Spectator</option>
                </select>
              </label>
              <label>Team size
                <div className="team-size-ctrl">
                  <button type="button" onClick={() => changeTeamSize(setup.teamSize - 1)}>−</button>
                  <span>{setup.teamSize}</span>
                  <button type="button" onClick={() => changeTeamSize(setup.teamSize + 1)}>+</button>
                </div>
              </label>
            </div>
            <div className="personality-actions">
              <button type="button" onClick={assignRandomPersonalities}>Randomize</button>
              <button type="button" onClick={clearAllPersonalities} className="secondary">Clear all (neutral)</button>
            </div>
          </div>

          <div className="teams-columns">
            {renderPlayerList('red')}
            {renderPlayerList('blue')}
          </div>

          <details className="connection-details">
            <summary>Connection settings</summary>
            <div className="connection-fields">
              <label>Endpoint <input value={setup.baseUrl} onChange={(e) => setSetup((s) => ({ ...s, baseUrl: e.target.value }))} placeholder="from .env" /></label>
              <div className="model-group">
                <label>Global default model <input value={setup.model} onChange={(e) => setSetup((s) => ({ ...s, model: e.target.value }))} placeholder="from .env" /></label>
                <div className="team-models">
                  <label>Red team model <input value={setup.redModel} onChange={(e) => setSetup((s) => ({ ...s, redModel: e.target.value }))} placeholder="optional override" /></label>
                  <label>Blue team model <input value={setup.blueModel} onChange={(e) => setSetup((s) => ({ ...s, blueModel: e.target.value }))} placeholder="optional override" /></label>
                </div>
              </div>
              <label>API key <input value={setup.apiKey} onChange={(e) => setSetup((s) => ({ ...s, apiKey: e.target.value }))} placeholder="from .env" type="password" /></label>
            </div>
          </details>

          <button disabled={loading} type="submit">{loading ? 'Starting…' : 'Start Game'}</button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </main>
    );
  }

  // --- GAME ---
  const boardGame = displayGame ?? game;
  const turn = boardGame.turn;
  const pendingProposals = isSpectator ? [] : game.proposals[myTeam].filter((p) => p.status === 'pending');
  const redLeft = boardGame.cards.filter((c) => c.owner === 'red' && !c.revealed).length;
  const blueLeft = boardGame.cards.filter((c) => c.owner === 'blue' && !c.revealed).length;
  const isHumanSpymaster = humanPlayer?.role === 'spymaster';
  const showSpyView = isSpectator || isHumanSpymaster;
  const canAct = !isSpectator;
  const hasPendingProposal = pendingProposals.length > 0;

  // Chat availability
  const isBanter = turn.phase === 'banter';
  const isEnemyTurn = !isSpectator && turn.activeTeam !== myTeam && !isBanter && !game.winner;
  const isPaused = !isSpectator && !!game.humanPaused[myTeam];
  const chatDisabled = isEnemyTurn || (isHumanSpymaster && turn.activeTeam === myTeam && turn.phase === 'guess');
  const chatPlaceholder = isEnemyTurn
    ? `${turn.activeTeam}'s turn — wait for yours…`
    : (isHumanSpymaster && turn.phase === 'guess')
      ? 'Spymasters stay quiet during guessing…'
      : 'Talk to your team…';

  return (
    <main className="game-screen">
      <header className="topbar">
        <h1>Clueless</h1>
        {isSpectator ? <span className="spectator-badge">👁 Spectating</span> : null}
        <div className="topbar-right">
          <button
            className={`tts-toggle ${ttsEnabled ? 'active' : ''}`}
            onClick={() => {
              if (!ttsEnabled) {
                setTtsEnabled(true);
                setTtsLoading(true);
                import('./ttsService').then(({ preloadTTS }) => {
                  preloadTTS().then((ok) => {
                    setTtsLoading(false);
                    if (!ok) setTtsEnabled(false);
                    else if (game) {
                      // Everything already shown stays visible; future messages will be gated
                      displayUpTo.current = game.chatLog.length;
                      setDisplayVersion((v) => v + 1);
                      apiRequest(`/api/games/${game.id}/tts-mode`, { method: 'POST', body: JSON.stringify({ enabled: true }) }).catch(() => {});
                    }
                  });
                });
              } else {
                setTtsEnabled(false);
                stopAudio();
                // Flush all buffered messages to visible
                if (game) {
                  displayUpTo.current = game.chatLog.length;
                  setDisplayVersion((v) => v + 1);
                  // Send ack to unblock any stuck server waiter
                  apiRequest(`/api/games/${game.id}/tts-ack`, { method: 'POST', body: '{}' }).catch(() => {});
                  apiRequest(`/api/games/${game.id}/tts-mode`, { method: 'POST', body: JSON.stringify({ enabled: false }) }).catch(() => {});
                }
                cleanupTts();
              }
            }}
            title={ttsEnabled ? 'Disable TTS' : 'Enable TTS (requires TTS server)'}
          >
            {ttsLoading ? '⏳' : ttsEnabled ? '🔊' : '🔇'}
          </button>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">{theme === 'dark' ? '☀️' : '🌙'}</button>
          <button className="new-game-btn" onClick={newGame}>New Game</button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <div className="game-layout">
        {/* LEFT: Board */}
        <section className="board-section">
          <div className="board-info">
            <div className="score-bar">
              <span className="team-score red-score">{redLeft} <small>red</small></span>
              <span className="sep">—</span>
              <span className="team-score blue-score">{blueLeft} <small>blue</small></span>
            </div>
            {boardGame.winner ? (
              <div className="game-status winner-banner">{boardGame.winner} wins!</div>
            ) : turn.phase === 'banter' ? (
              <div className="game-status">
                <span className="phase">Between turns...</span>
              </div>
            ) : turn.phase === 'guess' && turn.hintWord ? (
              <div className="game-status">
                <span className={`badge ${turn.activeTeam}`}>{turn.activeTeam}'s turn</span>
                <span className="hint-word">"{turn.hintWord}"</span>
                <span className="hint-count">{turn.hintCount}</span>
                <span className="hint-progress">{turn.guessesMade} / {turn.maxGuesses} guesses</span>
                {showSpyView && turn.hintTargets?.length ? (
                  <span className="hint-targets">targeting: {turn.hintTargets.join(', ')}</span>
                ) : null}
                {showSpyView && turn.hintReasoning ? (
                  <span className="hint-reasoning">reasoning: {turn.hintReasoning}</span>
                ) : null}
              </div>
            ) : (
              <div className="game-status">
                <span className={`badge ${turn.activeTeam}`}>{turn.activeTeam}'s turn</span>
                <span className="phase">Waiting for hint…</span>
              </div>
            )}
          </div>
          <div className="board-grid">
            {boardGame.cards.map((card) => {
              const showOwner = showSpyView && card.owner !== 'neutral' && !card.revealed;
              return (
                <button
                  key={card.word}
                  type="button"
                  className={`card ${card.revealed ? `revealed ${card.owner}` : 'hidden'} ${showOwner ? `spy-${card.owner}` : ''}`}
                  disabled={!isMyTurn || turn.phase !== 'guess' || card.revealed || isHumanSpymaster || hasPendingProposal}
                  onClick={() => proposeGuess(card.word)}
                  title={showOwner ? card.owner : undefined}
                >
                  {card.word}
                </button>
              );
            })}
          </div>

          {/* Team roster */}
          <div className="team-roster">
            {(['red', 'blue'] as const).map((t) => (
              <div key={t} className={`roster-column roster-${t}`}>
                <h3 className="roster-header">{t.toUpperCase()}</h3>
                <div className="roster-players">
                  {teamRoster[t].map((p) => (
                    <div
                      key={p.id}
                      className={`roster-player ${p.id === humanPlayer?.id ? 'roster-you' : ''}`}
                      onMouseEnter={() => setHoveredPlayer(p.id)}
                      onMouseLeave={() => setHoveredPlayer(null)}
                    >
                      <span className="roster-icon">{p.role === 'spymaster' ? '🕵️' : '🔍'}</span>
                      <span className="roster-name">{p.name}</span>
                      {hoveredPlayer === p.id && p.type === 'llm' && (
                        <div className="player-card">
                          <div className="player-card-row"><strong>Model:</strong> {p.model || game.llmConfig.model}</div>
                          <div className="player-card-row"><strong>Personality:</strong> {p.personality || '—'}</div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* RIGHT: Unified Chat */}
        <section className="chat-section">
          {/* Actions — only when playing */}
          {canAct ? (
            <div className="actions">
              {isMyTurn && turn.phase === 'hint' && isHumanSpymaster ? (
                <>
                  <div className="action-prompt">🎯 Your turn — give your team a hint!</div>
                  <div className="action-row">
                    <input placeholder="Hint word" value={hintWord} onChange={(e) => setHintWord(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendHint(); }} />
                    <input type="number" min={1} value={hintCount} onChange={(e) => setHintCount(e.target.value)} className="count-input" />
                    <button onClick={sendHint}>Give Hint</button>
                  </div>
                </>
              ) : null}

              {isMyTurn && turn.phase === 'guess' && !isHumanSpymaster && !hasPendingProposal ? (
                <div className="action-prompt">🎯 Your turn — pick a word or end the turn!</div>
              ) : null}

              {isMyTurn && turn.phase === 'guess' && !isHumanSpymaster && hasPendingProposal ? (
                <div className="action-prompt">🗳️ Vote on the proposal below!</div>
              ) : null}

              {pendingProposals.map((p) => {
                const isOwnProposal = p.createdBy === humanPlayer?.id;
                return (
                  <div key={p.id} className="proposal-card">
                    <span className="proposal-label">{p.kind === 'guess' ? `Guess "${p.payload.word}"` : 'End turn'} — {playerNames[p.createdBy]}</span>
                    {!isOwnProposal ? (
                      <div className="vote-buttons">
                        <button onClick={() => vote(p.id, 'accept')} className="accept">✓ Accept</button>
                        <button onClick={() => vote(p.id, 'reject')} className="reject">✗ Reject</button>
                      </div>
                    ) : (
                      <span className="waiting-votes">Waiting for votes…</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* Unified chat log */}
          <div className="chat-log">
            {game.chatLog.slice(0, ttsEnabled ? displayUpTo.current : game.chatLog.length).map((msg) => {
              const isHuman = msg.playerId === humanPlayer?.id;
              const isSystem = msg.kind === 'system' || msg.kind === 'proposal';
              const msgTeam = msg.team;

              // Classify system/proposal messages
              const isVoteAccept = isSystem && msg.content.includes('voted accept');
              const isVoteReject = isSystem && msg.content.includes('voted reject');
              const isProposal = isSystem && msg.content.includes('proposes');
              const isReveal = isSystem && msg.content.includes('Revealed');
              const isTurnSwitch = isSystem && msg.content.includes("It's now");
              const isAction = isSystem && (isVoteAccept || isVoteReject || isProposal || isReveal ||
                msg.content.includes('Spymaster') ||
                msg.content.includes('end their turn') ||
                msg.content.includes('rejected') ||
                msg.content.includes('Game over')
              );

              if (isVoteAccept || isVoteReject) {
                return (
                  <div key={msg.id} className={`bubble-row system-row ${msgTeam ? `team-${msgTeam}` : ''}`}>
                    <div className={`vote-msg ${isVoteAccept ? 'vote-accept' : 'vote-reject'}`}>
                      <span className="vote-icon">{isVoteAccept ? '✓' : '✗'}</span>
                      <span>{msg.content}</span>
                    </div>
                  </div>
                );
              }

              if (isProposal) {
                return (
                  <div key={msg.id} className={`bubble-row system-row ${msgTeam ? `team-${msgTeam}` : ''}`}>
                    <div className={`proposal-msg team-${msgTeam}`}>
                      <span className="proposal-icon">📋</span>
                      <span>{msg.content}</span>
                    </div>
                  </div>
                );
              }

              if (isTurnSwitch) {
                return (
                  <div key={msg.id}>
                    <hr className="turn-divider" />
                    <div className={`bubble-row system-row ${msgTeam ? `team-${msgTeam}` : ''}`}>
                      <div className={`action-msg team-${msgTeam}`}>{msg.content}</div>
                    </div>
                  </div>
                );
              }

              return (
                <div key={msg.id} className={`bubble-row ${isSystem ? 'system-row' : isHuman ? 'mine' : 'theirs'} ${msgTeam ? `team-${msgTeam}` : ''}`}>
                  {isSystem ? (
                    <div className={`${isAction ? 'action-msg' : 'system-msg'} team-${msgTeam}`}>{msg.content}</div>
                  ) : (
                    <div className={`bubble ${isHuman ? 'bubble-mine' : 'bubble-theirs'} bubble-team-${msgTeam}`}>
                      <span className="bubble-name">{msg.playerName}</span>
                      <span className="bubble-text" dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.content) }} />
                      {ttsEnabled && ttsCache.current.has(msg.id) ? (
                        <button
                          className={`tts-btn ${playingMsgId === msg.id ? 'playing' : ''}`}
                          onClick={() => playingMsgId === msg.id ? stopAudio() : playAudio(ttsCache.current.get(msg.id)!, msg.id)}
                          title={playingMsgId === msg.id ? 'Stop' : 'Play'}
                        >
                          {playingMsgId === msg.id ? '⏹' : '🔊'}
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
            {showThinking ? (
              <div className={`bubble-row theirs team-${thinkingTeam}`}>
                <div className="bubble bubble-theirs thinking-bubble">
                  <span className="dots">●●●</span>
                </div>
              </div>
            ) : null}
            {showRetryPrompt ? (
              <div className="bubble-row system-row">
                <div className="retry-prompt">
                  <span>LLMs seem stuck. Want to try again?</span>
                  <button onClick={handleRetry} className="retry-btn">🔄 Retry</button>
                </div>
              </div>
            ) : null}
            <div ref={chatEndRef} />
          </div>

          {/* Chat input — only when playing */}
          {!isSpectator ? (
            <div className={`chat-input${isPaused ? ' paused' : ''}${isMyTurn && !isHumanSpymaster && turn.phase === 'guess' && !hasPendingProposal ? ' with-guess' : ''}`}>
              <input
                placeholder={chatPlaceholder}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !chatDisabled) sendChat(); }}
                disabled={chatDisabled}
              />
              {isMyTurn && !isHumanSpymaster && turn.phase === 'guess' && !hasPendingProposal ? (
                <>
                  <input
                    className="guess-input"
                    placeholder="Guess word (or click board)"
                    value={guessWord}
                    onChange={(e) => setGuessWord(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') proposeGuess(); }}
                  />
                  <button onClick={() => proposeGuess()} title="Propose guess">Propose</button>
                  <button onClick={proposeEndTurn} className="secondary" title="End your turn">End Turn</button>
                </>
              ) : (
                <button onClick={sendChat} disabled={chatDisabled}>Send</button>
              )}
              {isMyTurn && !isHumanSpymaster && turn.phase === 'guess' ? (
                isPaused
                  ? <button onClick={resumeLlm} className="secondary" title="Let LLMs continue discussing">▶️</button>
                  : <button onClick={pauseLlm} className="secondary" title="Ask LLMs to hold on">✋</button>
              ) : (
                <button onClick={nudgeLlm} className="secondary" title="Ask LLMs to respond">🤖</button>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
