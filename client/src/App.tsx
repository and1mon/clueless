import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from './api';
import { type GameState, type PlayerRole, type TeamColor } from './types';

export function App(): JSX.Element {
  const [game, setGame] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [guessWord, setGuessWord] = useState('');
  const [hintWord, setHintWord] = useState('');
  const [hintCount, setHintCount] = useState('2');
  const [chatTab, setChatTab] = useState<'red' | 'blue'>('red');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [setup, setSetup] = useState({
    humanName: 'You',
    humanTeam: 'red' as TeamColor,
    humanRole: 'operative' as PlayerRole | 'spectator',
    redLlm: '2',
    blueLlm: '3',
    baseUrl: '',
    model: '',
    apiKey: '',
  });

  const isSpectator = setup.humanRole === 'spectator';
  const humanPlayer = useMemo(
    () => game ? Object.values(game.players).find((p) => p.type === 'human') : undefined,
    [game],
  );
  const myTeam = humanPlayer?.team ?? 'red';
  const enemyTeam: TeamColor = myTeam === 'red' ? 'blue' : 'red';

  const playerNames = useMemo(() => {
    if (!game) return {} as Record<string, string>;
    return Object.fromEntries(Object.values(game.players).map((p) => [p.id, p.name]));
  }, [game]);

  const isMyTurn = game && !isSpectator ? game.turn.activeTeam === myTeam && !game.winner : false;

  // Auto-switch chat tab to the active team
  useEffect(() => {
    if (!game || game.winner) return;
    setChatTab(game.turn.activeTeam);
  }, [game?.turn.activeTeam, game?.winner]);

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
  }, [game?.chats, chatTab]);

  const apply = (next: GameState): void => {
    setGame(next);
    setError('');
  };

  const newGame = (): void => {
    setGame(null);
    setError('');
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
          llmPlayers: { red: Number(setup.redLlm), blue: Number(setup.blueLlm) },
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
    return (
      <main className="setup-screen">
        <h1>��️ Clueless</h1>
        <p className="subtitle">Codenames with local LLM teammates</p>
        <form onSubmit={createGame} className="setup-form">
          <label>Name <input value={setup.humanName} onChange={(e) => setSetup((s) => ({ ...s, humanName: e.target.value }))} /></label>
          <div className="setup-row">
            <label>Team
              <select value={setup.humanTeam} onChange={(e) => setSetup((s) => ({ ...s, humanTeam: e.target.value as TeamColor }))}>
                <option value="red">Red</option><option value="blue">Blue</option>
              </select>
            </label>
            <label>Role
              <select value={setup.humanRole} onChange={(e) => setSetup((s) => ({ ...s, humanRole: e.target.value as PlayerRole | 'spectator' }))}>
                <option value="operative">Operative (guesser)</option>
                <option value="spymaster">Spymaster (hint-giver)</option>
                <option value="spectator">Spectator (watch AI play)</option>
              </select>
            </label>
          </div>
          <div className="setup-row">
            <label>Red LLMs <input type="number" min={0} value={setup.redLlm} onChange={(e) => setSetup((s) => ({ ...s, redLlm: e.target.value }))} /></label>
            <label>Blue LLMs <input type="number" min={0} value={setup.blueLlm} onChange={(e) => setSetup((s) => ({ ...s, blueLlm: e.target.value }))} /></label>
          </div>
          <label>LLM endpoint <input value={setup.baseUrl} onChange={(e) => setSetup((s) => ({ ...s, baseUrl: e.target.value }))} placeholder="from .env" /></label>
          <label>Model <input value={setup.model} onChange={(e) => setSetup((s) => ({ ...s, model: e.target.value }))} placeholder="from .env" /></label>
          <label>API key <input value={setup.apiKey} onChange={(e) => setSetup((s) => ({ ...s, apiKey: e.target.value }))} placeholder="from .env" /></label>
          <button disabled={loading} type="submit">{loading ? 'Starting…' : 'Start Game'}</button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </main>
    );
  }

  // --- GAME ---
  const turn = game.turn;
  const activeChat = game.chats[chatTab];
  const pendingProposals = isSpectator ? [] : game.proposals[myTeam].filter((p) => p.status === 'pending');
  const redLeft = game.cards.filter((c) => c.owner === 'red' && !c.revealed).length;
  const blueLeft = game.cards.filter((c) => c.owner === 'blue' && !c.revealed).length;
  const isThinking = game.deliberating[chatTab];
  const isHumanSpymaster = humanPlayer?.role === 'spymaster';
  const showSpyView = isSpectator || isHumanSpymaster;
  const canAct = !isSpectator && chatTab === myTeam;

  return (
    <main className="game-screen">
      <header className="topbar">
        <h1>Clueless</h1>
        <div className="score">
          <span className="red-score">{redLeft}</span>
          <span className="sep">–</span>
          <span className="blue-score">{blueLeft}</span>
        </div>
        <div className="turn-info">
          {game.winner ? (
            <span className="winner">🏆 {game.winner} wins!</span>
          ) : (
            <>
              <span className={`badge ${turn.activeTeam}`}>{turn.activeTeam}'s turn</span>
              {turn.phase === 'hint' ? (
                <span className="phase">Waiting for hint…</span>
              ) : (
                <span className="hint-display">🔎 "{turn.hintWord}" ({turn.hintCount}) — guesses {turn.guessesMade}/{turn.maxGuesses}</span>
              )}
            </>
          )}
        </div>
        {isSpectator ? <span className="spectator-badge">👁 Spectating</span> : null}
        <button className="new-game-btn" onClick={newGame}>New Game</button>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <div className="game-layout">
        {/* LEFT: Board */}
        <section className="board-section">
          <div className="board-grid">
            {game.cards.map((card) => {
              const showOwner = showSpyView && card.owner !== 'neutral' && !card.revealed;
              return (
                <button
                  key={card.word}
                  type="button"
                  className={`card ${card.revealed ? `revealed ${card.owner}` : 'hidden'} ${showOwner ? `spy-${card.owner}` : ''}`}
                  disabled={!isMyTurn || turn.phase !== 'guess' || card.revealed || isHumanSpymaster}
                  onClick={() => proposeGuess(card.word)}
                  title={showOwner ? card.owner : undefined}
                >
                  {card.word}
                </button>
              );
            })}
          </div>
        </section>

        {/* RIGHT: Chat */}
        <section className="chat-section">
          {/* Tab switcher */}
          <div className="chat-tabs">
            <button className={chatTab === 'red' ? 'tab active red-tab' : 'tab'} onClick={() => setChatTab('red')}>
              Red Team
            </button>
            <button className={chatTab === 'blue' ? 'tab active blue-tab' : 'tab'} onClick={() => setChatTab('blue')}>
              Blue Team
            </button>
          </div>

          {/* Actions — only when playing (not spectating) and viewing own team */}
          {canAct ? (
            <div className="actions">
              {isMyTurn && turn.phase === 'hint' && isHumanSpymaster ? (
                <div className="action-row">
                  <input placeholder="Hint word" value={hintWord} onChange={(e) => setHintWord(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendHint(); }} />
                  <input type="number" min={1} value={hintCount} onChange={(e) => setHintCount(e.target.value)} className="count-input" />
                  <button onClick={sendHint}>Give Hint</button>
                </div>
              ) : null}

              {isMyTurn && turn.phase === 'guess' && !isHumanSpymaster ? (
                <div className="action-row">
                  <input placeholder="Guess a word (or click the board)" value={guessWord} onChange={(e) => setGuessWord(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') proposeGuess(); }} />
                  <button onClick={() => proposeGuess()}>Propose</button>
                  <button onClick={proposeEndTurn} className="secondary">End Turn</button>
                </div>
              ) : null}

              {pendingProposals.length > 0 ? (
                <div className="proposals">
                  {pendingProposals.map((p) => (
                    <div key={p.id} className="proposal-card">
                      <span>{p.kind === 'guess' ? `Guess "${p.payload.word}"` : 'End turn'} — {playerNames[p.createdBy]}</span>
                      <div className="vote-buttons">
                        <button onClick={() => vote(p.id, 'accept')} className="accept">✓ Yes</button>
                        <button onClick={() => vote(p.id, 'reject')} className="reject">✗ No</button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Chat log */}
          <div className="chat-log">
            {activeChat.map((msg) => {
              const isHuman = msg.playerId === humanPlayer?.id;
              const isSystem = msg.kind === 'system' || msg.kind === 'proposal';
              return (
                <div key={msg.id} className={`bubble-row ${isSystem ? 'system-row' : isHuman ? 'mine' : 'theirs'}`}>
                  {isSystem ? (
                    <div className="system-msg">{msg.content}</div>
                  ) : (
                    <div className={`bubble ${isHuman ? 'bubble-mine' : 'bubble-theirs'}`}>
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
            <div ref={chatEndRef} />
          </div>

          {/* Chat input — only when playing */}
          {!isSpectator && chatTab === myTeam ? (
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
