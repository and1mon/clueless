import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
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
  { name: 'The Analyst', description: 'You are cautious and analytical. You think through risks carefully before committing to a guess.' },
  { name: 'The Commander', description: 'You are bold and decisive. You trust your instincts and push the team to act quickly.' },
  { name: 'The Cheerleader', description: 'You are supportive and collaborative. You build on others\' ideas and look for consensus.' },
  { name: 'The Skeptic', description: 'You are skeptical and detail-oriented. You challenge assumptions and spot flaws in reasoning.' },
  { name: 'The Wildcard', description: 'You are creative and lateral-thinking. You find unexpected connections between words.' },
  { name: 'The Strategist', description: 'You are competitive and strategic. You always consider what the enemy team might do next.' },
  { name: 'The Professor', description: 'You are patient and methodical. You prefer to eliminate wrong answers before guessing.' },
  { name: 'The Hype Man', description: 'You are enthusiastic and optimistic. You encourage the team and celebrate good guesses.' },
  { name: 'The Observer', description: 'You are quiet and observant. You speak only when you have something important to add.' },
  { name: 'The Captain', description: 'You are a natural leader. You take charge of discussions and keep the team focused.' },
  { name: 'The Contrarian', description: 'You are a devil\'s advocate. You argue the opposite position to stress-test ideas.' },
  { name: 'The Realist', description: 'You are pragmatic and results-oriented. You prefer safe single-word guesses over risky multi-word plays.' },
  { name: 'The Gambler', description: 'You are a risk-taker. You love going for ambitious multi-word connections.' },
  { name: 'The Diplomat', description: 'You are empathetic and diplomatic. You mediate disagreements and find middle ground.' },
  { name: 'The Encyclopedia', description: 'You are nerdy and encyclopedic. You draw on obscure knowledge to find word connections.' },
  { name: 'The Joker', description: 'You are funny and lighthearted. You keep morale up with humor while still playing seriously.' },
  { name: 'The Sweater', description: 'You are intense and focused. You treat every guess like it could win or lose the game.' },
  { name: 'The Thinker', description: 'You are philosophical. You overthink word meanings and consider multiple interpretations.' },
  { name: 'The Speedster', description: 'You are impatient and action-oriented. You hate long discussions and want to guess already.' },
  { name: 'The Poet', description: 'You are a wordsmith. You love puns, etymology, and clever word associations.' },
];

export function App(): JSX.Element {
  const [game, setGame] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [guessWord, setGuessWord] = useState('');
  const [hintWord, setHintWord] = useState('');
  const [hintCount, setHintCount] = useState('2');
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);

  const [setup, setSetup] = useState({
    humanName: 'You',
    humanTeam: 'red' as TeamColor,
    humanRole: 'operative' as PlayerRole | 'spectator',
    redCount: 2,
    blueCount: 3,
    baseUrl: '',
    model: '',
    apiKey: '',
    redPlayers: defaultLlmPlayers('red', 2),
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

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game?.chatLog]);

  // Stale detection state (must be before any early returns)
  const [staleRetries, setStaleRetries] = useState(0);
  const [showRetryPrompt, setShowRetryPrompt] = useState(false);
  const lastMsgCount = useRef(0);
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null);

  // Detect LLM config errors and go back to setup
  useEffect(() => {
    if (game?.llmError) {
      setError(`⚠️ ${game.llmError}. Check your LLM configuration and try again.`);
      setGame(null);
    }
  }, [game?.llmError]);

  // Stale detection: auto-nudge LLM if no new messages after 60s
  const isThinking = game ? (game.deliberating.red || game.deliberating.blue) : false;
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
    setError('');
  };

  const updateLlmCount = (team: TeamColor, count: number): void => {
    const clamped = Math.max(0, Math.min(6, count));
    const key = team === 'red' ? 'redPlayers' : 'bluePlayers';
    const countKey = team === 'red' ? 'redCount' : 'blueCount';
    setSetup((s) => {
      const current = s[key];
      let next: LlmPlayerSetup[];
      if (clamped > current.length) {
        const prefix = team === 'red' ? 'Red' : 'Blue';
        next = [...current, ...Array.from({ length: clamped - current.length }, (_, i) => ({
          name: `${prefix}-${current.length + i + 1}`,
          model: '',
          personality: '',
        }))];
      } else {
        next = current.slice(0, clamped);
      }
      return { ...s, [countKey]: clamped, [key]: next };
    });
  };

  const updateLlmPlayer = (team: TeamColor, index: number, field: keyof LlmPlayerSetup, value: string): void => {
    const key = team === 'red' ? 'redPlayers' : 'bluePlayers';
    setSetup((s) => {
      const players = [...s[key]];
      players[index] = { ...players[index], [field]: value };
      return { ...s, [key]: players };
    });
  };

  const assignRandomPersonalities = (): void => {
    const shuffled = [...PERSONALITY_POOL].sort(() => Math.random() - 0.5);
    let idx = 0;
    setSetup((s) => ({
      ...s,
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
          llmPlayers: { red: setup.redCount, blue: setup.blueCount },
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

  // --- SETUP ---
  if (!game) {
    const renderPlayerList = (team: TeamColor) => {
      const players = team === 'red' ? setup.redPlayers : setup.bluePlayers;
      const count = team === 'red' ? setup.redCount : setup.blueCount;
      return (
        <div className="team-setup">
          <div className="team-setup-header">
            <span className={`team-label ${team}`}>{team === 'red' ? '🔴 Red Team' : '🔵 Blue Team'}</span>
            <div className="llm-count-ctrl">
              <button type="button" onClick={() => updateLlmCount(team, count - 1)}>−</button>
              <span>{count}</span>
              <button type="button" onClick={() => updateLlmCount(team, count + 1)}>+</button>
            </div>
          </div>
          {players.map((p, i) => {
            const key = `${team}-${i}`;
            const isExpanded = expandedPlayer === key;
            return (
              <div key={key} className="llm-player-row">
                <div className="llm-player-summary">
                  <input
                    value={p.name}
                    onChange={(e) => updateLlmPlayer(team, i, 'name', e.target.value)}
                    placeholder={`${team === 'red' ? 'Red' : 'Blue'}-${i + 1}`}
                    className="player-name-input"
                  />
                  <button type="button" className="expand-btn" onClick={() => setExpandedPlayer(isExpanded ? null : key)}>
                    {isExpanded ? '▾' : '▸'} Settings
                  </button>
                </div>
                {isExpanded ? (
                  <div className="llm-player-details">
                    <label>Model override <input value={p.model} onChange={(e) => updateLlmPlayer(team, i, 'model', e.target.value)} placeholder="Use default" /></label>
                    <label>Personality
                      <textarea
                        value={p.personality}
                        onChange={(e) => updateLlmPlayer(team, i, 'personality', e.target.value)}
                        placeholder="e.g. You are bold and decisive. You trust your instincts."
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
          <h1>🕵️ Clueless</h1>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">{theme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
        <p className="subtitle">Codenames with LLM teammates</p>
        <form onSubmit={createGame} className="setup-form">
          <fieldset className="setup-fieldset">
            <legend>You</legend>
            <label>Name <input value={setup.humanName} onChange={(e) => setSetup((s) => ({ ...s, humanName: e.target.value }))} /></label>
            <div className="setup-row">
              <label>Team
                <select value={setup.humanTeam} onChange={(e) => setSetup((s) => ({ ...s, humanTeam: e.target.value as TeamColor }))}>
                  <option value="red">Red</option><option value="blue">Blue</option>
                </select>
              </label>
              <label>Role
                <select value={setup.humanRole} onChange={(e) => setSetup((s) => ({ ...s, humanRole: e.target.value as PlayerRole | 'spectator' }))}>
                  <option value="operative">Operative</option>
                  <option value="spymaster">Spymaster</option>
                  <option value="spectator">Spectator</option>
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset className="setup-fieldset">
            <legend>LLM Players</legend>
            <div className="personality-actions">
              <button type="button" onClick={assignRandomPersonalities}>🎲 Random personalities</button>
              <button type="button" onClick={clearAllPersonalities} className="secondary">Clear all</button>
            </div>
            {renderPlayerList('red')}
            {renderPlayerList('blue')}
          </fieldset>

          <fieldset className="setup-fieldset">
            <legend>LLM Connection</legend>
            <label>Endpoint <input value={setup.baseUrl} onChange={(e) => setSetup((s) => ({ ...s, baseUrl: e.target.value }))} placeholder="from .env" /></label>
            <label>Default model <input value={setup.model} onChange={(e) => setSetup((s) => ({ ...s, model: e.target.value }))} placeholder="from .env" /></label>
            <label>API key <input value={setup.apiKey} onChange={(e) => setSetup((s) => ({ ...s, apiKey: e.target.value }))} placeholder="from .env" type="password" /></label>
          </fieldset>

          <button disabled={loading} type="submit">{loading ? 'Starting…' : 'Start Game'}</button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </main>
    );
  }

  // --- GAME ---
  const turn = game.turn;
  const pendingProposals = isSpectator ? [] : game.proposals[myTeam].filter((p) => p.status === 'pending');
  const redLeft = game.cards.filter((c) => c.owner === 'red' && !c.revealed).length;
  const blueLeft = game.cards.filter((c) => c.owner === 'blue' && !c.revealed).length;
  const isHumanSpymaster = humanPlayer?.role === 'spymaster';
  const showSpyView = isSpectator || isHumanSpymaster;
  const canAct = !isSpectator;
  const hasPendingProposal = pendingProposals.length > 0;

  return (
    <main className="game-screen">
      <header className="topbar">
        <h1>Clueless</h1>
        {isSpectator ? <span className="spectator-badge">👁 Spectating</span> : null}
        <div className="topbar-right">
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
            {game.winner ? (
              <div className="game-status winner-banner">🏆 {game.winner} wins!</div>
            ) : turn.phase === 'guess' && turn.hintWord ? (
              <div className="game-status">
                <span className={`badge ${turn.activeTeam}`}>{turn.activeTeam}'s turn</span>
                <span className="hint-word">"{turn.hintWord}"</span>
                <span className="hint-count">{turn.hintCount}</span>
                <span className="hint-progress">{turn.guessesMade} / {turn.maxGuesses} guesses</span>
              </div>
            ) : (
              <div className="game-status">
                <span className={`badge ${turn.activeTeam}`}>{turn.activeTeam}'s turn</span>
                <span className="phase">Waiting for hint…</span>
              </div>
            )}
          </div>
          <div className="board-grid">
            {game.cards.map((card) => {
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
                <div className="action-row">
                  <input placeholder="Hint word" value={hintWord} onChange={(e) => setHintWord(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendHint(); }} />
                  <input type="number" min={1} value={hintCount} onChange={(e) => setHintCount(e.target.value)} className="count-input" />
                  <button onClick={sendHint}>Give Hint</button>
                </div>
              ) : null}

              {isMyTurn && turn.phase === 'guess' && !isHumanSpymaster && !hasPendingProposal ? (
                <div className="action-row">
                  <input placeholder="Guess a word (or click the board)" value={guessWord} onChange={(e) => setGuessWord(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') proposeGuess(); }} />
                  <button onClick={() => proposeGuess()}>Propose</button>
                  <button onClick={proposeEndTurn} className="secondary">End Turn</button>
                </div>
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
            {game.chatLog.map((msg) => {
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
                  <div key={msg.id} className="bubble-row system-row">
                    <div className={`vote-msg ${isVoteAccept ? 'vote-accept' : 'vote-reject'}`}>
                      <span className="vote-icon">{isVoteAccept ? '✓' : '✗'}</span>
                      <span>{msg.content}</span>
                    </div>
                  </div>
                );
              }

              if (isProposal) {
                return (
                  <div key={msg.id} className="bubble-row system-row">
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
                    <div className="bubble-row system-row">
                      <div className={`action-msg team-${msgTeam}`}>{msg.content}</div>
                    </div>
                  </div>
                );
              }

              return (
                <div key={msg.id} className={`bubble-row ${isSystem ? 'system-row' : isHuman ? 'mine' : 'theirs'}`}>
                  {isSystem ? (
                    <div className={`${isAction ? 'action-msg' : 'system-msg'} team-${msgTeam}`}>{msg.content}</div>
                  ) : (
                    <div className={`bubble ${isHuman ? 'bubble-mine' : 'bubble-theirs'} bubble-team-${msgTeam}`}>
                      <span className="bubble-name">{msg.playerName}</span>
                      <span className="bubble-text">{msg.content}</span>
                    </div>
                  )}
                </div>
              );
            })}
            {isThinking ? (
              <div className="bubble-row theirs">
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
            <div className="chat-input">
              <input
                placeholder="Talk to your team…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }}
              />
              <button onClick={sendChat}>Send</button>
              <button onClick={nudgeLlm} className="secondary" title="Ask LLMs to respond">🤖</button>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
