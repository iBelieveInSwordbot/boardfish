// AI Director modal — Boardfish 4 new-in-AI flow.
// Paste a script → Ronan produces a shot list → preview it → "Create storyboard"
// spawns a new storyboard item with N panels (each pre-filled with an aiPrompt),
// then optionally auto-generates images for all of them via Nano Banana.

import { useEffect, useState } from 'react';
import type { Action, BoardfishState } from '../store';
import { resolveStoryboardSettings } from '../store';
import type { Panel } from '../types';
import { generatePanelImage, generateShotList, healthCheck, ratioToLabel } from '../ai/client';
import type { Shot, ShotList } from '../ai/types';

type Props = {
  state: BoardfishState;
  dispatch: React.Dispatch<Action>;
  onClose: () => void;
};

type Stage =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'proxy-down' }
  | { kind: 'thinking' } // Ronan is working
  | { kind: 'preview'; shotList: ShotList; sessionId: string | null }
  | { kind: 'generating'; done: number; total: number; label: string };

function cryptoRandomId(): string {
  return (crypto as unknown as { randomUUID?: () => string }).randomUUID?.()
    ?? Math.random().toString(36).slice(2);
}

function shotToPanel(shot: Shot): Panel {
  return {
    id: cryptoRandomId(),
    imageDataUrl: null,
    imageName: null,
    cornerNote: `S${String(shot.shotNumber).padStart(2, '0')}`,
    fields: [
      { id: cryptoRandomId(), label: 'Slug', value: shot.slug || '' },
      { id: cryptoRandomId(), label: 'Action', value: shot.action || '' },
      {
        id: cryptoRandomId(),
        label: 'Camera',
        value: [shot.shotType, shot.cameraMove, shot.angle].filter(Boolean).join(' · '),
      },
      { id: cryptoRandomId(), label: 'Director Note', value: shot.directorNote || '' },
    ],
    aiPrompt: shot.imagePrompt,
  };
}

export function AIDrawer({ state, dispatch, onClose }: Props) {
  const [script, setScript] = useState('');
  const [constraints, setConstraints] = useState('');
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [error, setError] = useState<string | null>(null);

  // Effective default aspect for this project (uses currently-selected storyboard if any, else global).
  const effectiveAspect = (() => {
    const sel = state.items.find((it) => it.id === state.selectedItemId);
    const sb = sel && sel.kind === 'storyboard' ? sel : null;
    const ratio = sb ? resolveStoryboardSettings(state.settings, sb).panelAspectRatio : state.settings.panelAspectRatio;
    return ratioToLabel(ratio);
  })();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await healthCheck();
      if (cancelled) return;
      setStage(ok ? { kind: 'idle' } : { kind: 'proxy-down' });
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && stage.kind !== 'thinking' && stage.kind !== 'generating') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, stage.kind]);

  async function handleGenerateShotList() {
    setError(null);
    setStage({ kind: 'thinking' });
    try {
      const { shotList, sessionId } = await generateShotList({
        script: script.trim(),
        defaultAspect: effectiveAspect,
        constraints: constraints.trim() || undefined,
      });
      setStage({ kind: 'preview', shotList, sessionId });
    } catch (err) {
      setError(String((err as Error).message || err));
      setStage({ kind: 'idle' });
    }
  }

  async function handleCreateStoryboard(shotList: ShotList) {
    // Build panels with stable ids so we can drive per-panel image gen below.
    const panels: Panel[] = shotList.shots.map(shotToPanel);

    // Atomic: create new storyboard at the end + seed with these panels.
    dispatch({ type: 'SET_LAST_STORYBOARD_PANELS', panels, name: shotList.title || undefined });

    if (autoGenerate) {
      await generateAllImages(panels);
    } else {
      onClose();
    }
  }

  async function generateAllImages(panels: Panel[]) {
    const workable = panels.filter((p) => p.aiPrompt);
    let done = 0;
    setStage({ kind: 'generating', done: 0, total: workable.length, label: 'starting concurrent gen…' });

    // Concurrency cap: 5 in flight at once. High enough to feel snappy for
    // typical 10-20 panel boards, low enough to avoid provider 429s on longer
    // boards. Each task also records its result to history via APPLY_AI_IMAGE.
    const CONCURRENCY = 5;
    const failures: string[] = [];

    async function worker(p: Panel) {
      try {
        const img = await generatePanelImage({ prompt: p.aiPrompt!, aspectRatio: effectiveAspect });
        dispatch({
          type: 'APPLY_AI_IMAGE',
          panelId: p.id,
          dataUrl: img.dataUrl,
          imageName: `AI ${new Date().toISOString().slice(0,10)} ${p.id.slice(0,6)}.jpg`,
          prompt: p.aiPrompt!,
          generatedAt: Date.now(),
        });
      } catch (err) {
        console.warn('[ai] panel image gen failed', p.id, err);
        failures.push(p.id);
      } finally {
        done += 1;
        setStage({ kind: 'generating', done, total: workable.length, label: `${done} of ${workable.length} complete` });
      }
    }

    await runWithConcurrency(workable, CONCURRENCY, worker);

    const label = failures.length === 0
      ? 'done'
      : `done — ${failures.length} failed (retry individually)`;
    setStage({ kind: 'generating', done: workable.length, total: workable.length, label });
    // Close after a beat so the user sees "done".
    setTimeout(() => onClose(), failures.length ? 1600 : 700);
  }

  // Bounded-concurrency task runner. Simple, dependency-free.
  async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    const queue = items.slice();
    const workers: Promise<void>[] = [];
    const step = async (): Promise<void> => {
      while (queue.length > 0) {
        const next = queue.shift()!;
        await fn(next);
      }
    };
    for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(step());
    await Promise.all(workers);
  }

  return (
    <div className="ai-drawer-backdrop" onClick={(e) => { if (e.target === e.currentTarget && stage.kind !== 'thinking' && stage.kind !== 'generating') onClose(); }}>
      <div className="ai-drawer">
        <div className="ai-drawer-header">
          <h2>AI Director · Ronan</h2>
          <button className="ai-drawer-close" onClick={onClose} disabled={stage.kind === 'thinking' || stage.kind === 'generating'}>✕</button>
        </div>

        {stage.kind === 'checking' && (
          <div className="ai-drawer-body"><p className="ai-muted">Checking AI proxy…</p></div>
        )}

        {stage.kind === 'proxy-down' && (
          <div className="ai-drawer-body">
            <p className="ai-error">AI proxy isn't running.</p>
            <p className="ai-muted">Start it in a terminal:</p>
            <pre className="ai-code">cd ai-proxy && npm start</pre>
            <p className="ai-muted">Then reopen this dialog.</p>
          </div>
        )}

        {stage.kind === 'idle' && (
          <div className="ai-drawer-body">
            <label className="ai-label">Script</label>
            <textarea
              className="ai-textarea"
              rows={16}
              placeholder="Paste your script here. Ronan will read it like Scorsese, Tarantino, or Hitchcock and produce a shot list…"
              value={script}
              onChange={(e) => setScript(e.target.value)}
            />
            <label className="ai-label">Optional direction (e.g. “more Hitchcock,” “color, not b&w,” “handheld throughout”)</label>
            <input
              className="ai-input"
              type="text"
              placeholder="leave blank for Ronan's own call"
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
            />
            <div className="ai-row">
              <label className="ai-checkbox">
                <input type="checkbox" checked={autoGenerate} onChange={(e) => setAutoGenerate(e.target.checked)} />
                Auto-generate panel images (Nano Banana Pro) after shot list is approved
              </label>
              <span className="ai-muted small">Default panel aspect: {effectiveAspect}</span>
            </div>
            {error && <p className="ai-error">{error}</p>}
            <div className="ai-actions">
              <button className="ai-btn-secondary" onClick={onClose}>Cancel</button>
              <button className="ai-btn-primary" onClick={handleGenerateShotList} disabled={!script.trim()}>
                Generate shot list
              </button>
            </div>
          </div>
        )}

        {stage.kind === 'thinking' && (
          <div className="ai-drawer-body">
            <p>🎬 Ronan is reading the script and thinking through the coverage…</p>
            <p className="ai-muted small">(Usually 10-30 seconds. He's picking camera language, pacing beats, choosing which director's sensibility fits.)</p>
          </div>
        )}

        {stage.kind === 'preview' && (
          <div className="ai-drawer-body">
            <h3 className="ai-h3">{stage.shotList.title}</h3>
            <p className="ai-muted">{stage.shotList.directorNotes}</p>
            <div className="ai-shot-list">
              {stage.shotList.shots.map((s) => (
                <ShotRow
                  key={s.shotNumber}
                  shot={s}
                  onChange={(next) => {
                    setStage({
                      kind: 'preview',
                      sessionId: stage.sessionId,
                      shotList: {
                        ...stage.shotList,
                        shots: stage.shotList.shots.map((x) => x.shotNumber === next.shotNumber ? next : x),
                      },
                    });
                  }}
                />
              ))}
            </div>
            <div className="ai-actions">
              <button className="ai-btn-secondary" onClick={() => setStage({ kind: 'idle' })}>Back / new script</button>
              <button className="ai-btn-primary" onClick={() => handleCreateStoryboard(stage.shotList)}>
                {autoGenerate ? 'Create storyboard + generate images' : 'Create storyboard (no images)'}
              </button>
            </div>
          </div>
        )}

        {stage.kind === 'generating' && (
          <div className="ai-drawer-body">
            <p>🎨 Generating panel images with Nano Banana Pro…</p>
            <p className="ai-muted">{stage.label}</p>
            <div className="ai-progress-wrap">
              <div className="ai-progress" style={{ width: `${(stage.done / Math.max(1, stage.total)) * 100}%` }} />
            </div>
            <p className="ai-muted small">{stage.done} / {stage.total} panels</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ShotRow({ shot, onChange }: { shot: Shot; onChange: (next: Shot) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="ai-shot-row">
      <div className="ai-shot-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="ai-shot-num">{String(shot.shotNumber).padStart(2, '0')}</span>
        <span className="ai-shot-slug">{shot.slug}</span>
        <span className="ai-shot-tags">
          {shot.shotType && <span className="ai-tag">{shot.shotType}</span>}
          {shot.cameraMove && <span className="ai-tag">{shot.cameraMove}</span>}
          {shot.aspectRatio && <span className="ai-tag">{shot.aspectRatio}</span>}
        </span>
        <span className="ai-shot-toggle">{expanded ? '−' : '+'}</span>
      </div>
      <div className="ai-shot-action">{shot.action}</div>
      {expanded && (
        <div className="ai-shot-detail">
          <label className="ai-label">Image prompt (edit before create)</label>
          <textarea
            className="ai-textarea small"
            rows={3}
            value={shot.imagePrompt}
            onChange={(e) => onChange({ ...shot, imagePrompt: e.target.value })}
          />
          {shot.directorNote && <p className="ai-muted small">🎬 {shot.directorNote}</p>}
        </div>
      )}
    </div>
  );
}
