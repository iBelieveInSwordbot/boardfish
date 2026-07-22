/**
 * Boardfish AI — Projects dashboard (full-screen landing view).
 *
 * Lists all projects on the server. Grid (thumbnail) view by default,
 * list view alternative. Actions per project: Open, Rename, Duplicate,
 * Delete, Export JSON. Global actions: New, Import JSON.
 *
 * Wired to /api/projects on the ai-proxy. Selecting a project calls
 * `onOpen(id)` — App resolves it and routes back to the editor.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ProjectSummary } from '../projects-api';
import {
  createProject,
  deleteProject,
  duplicateProject,
  fetchProject,
  listProjects,
  renameProject,
} from '../projects-api';
import { defaultSettings } from '../types';
import './ProjectsDashboard.css';

type Props = {
  onOpen: (id: string) => void;
};

type ViewMode = 'grid' | 'list';
type SortMode = 'modified' | 'created' | 'name';

function formatWhen(ms: number): string {
  if (!ms) return '';
  const now = Date.now();
  const delta = now - ms;
  const min = 60 * 1000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (delta < min) return 'just now';
  if (delta < hr) return `${Math.floor(delta / min)} min ago`;
  if (delta < day) return `${Math.floor(delta / hr)} hr ago`;
  if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function sortProjects(list: ProjectSummary[], mode: SortMode): ProjectSummary[] {
  const arr = list.slice();
  if (mode === 'modified') arr.sort((a, b) => b.modified - a.modified);
  else if (mode === 'created') arr.sort((a, b) => b.created - a.created);
  else arr.sort((a, b) => a.name.localeCompare(b.name));
  return arr;
}

export function ProjectsDashboard({ onOpen }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() => {
    try { return (localStorage.getItem('boardfish:projects:view') as ViewMode) || 'grid'; }
    catch { return 'grid'; }
  });
  const [sort, setSort] = useState<SortMode>(() => {
    try { return (localStorage.getItem('boardfish:projects:sort') as SortMode) || 'modified'; }
    catch { return 'modified'; }
  });
  const [query, setQuery] = useState('');

  useEffect(() => { try { localStorage.setItem('boardfish:projects:view', view); } catch { /* ignore */ } }, [view]);
  useEffect(() => { try { localStorage.setItem('boardfish:projects:sort', sort); } catch { /* ignore */ } }, [sort]);

  async function refresh() {
    try {
      const p = await listProjects();
      setProjects(p);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setProjects([]);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const list = projects || [];
    const q = query.trim().toLowerCase();
    const matched = q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
    return sortProjects(matched, sort);
  }, [projects, sort, query]);

  async function handleNew() {
    setBusy('new');
    try {
      const p = await createProject({
        name: 'Untitled Project',
        settings: defaultSettings(),
        items: [],
      });
      onOpen(p.id);
    } catch (err) {
      alert(`Create failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleRename(p: ProjectSummary) {
    const next = prompt('Rename project', p.name);
    if (!next || next.trim() === p.name) return;
    try {
      await renameProject(p.id, next.trim());
      await refresh();
    } catch (err) {
      alert(`Rename failed: ${(err as Error).message}`);
    }
  }

  async function handleDuplicate(p: ProjectSummary) {
    setBusy(p.id);
    try {
      await duplicateProject(p.id);
      await refresh();
    } catch (err) {
      alert(`Duplicate failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(p: ProjectSummary) {
    if (!confirm(`Delete "${p.name}"?  This can't be undone.`)) return;
    setBusy(p.id);
    try {
      await deleteProject(p.id);
      await refresh();
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleExport(p: ProjectSummary) {
    try {
      const proj = await fetchProject(p.id);
      const blob = new Blob([JSON.stringify(proj, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${p.name.replace(/[^\w.-]+/g, '_') || 'project'}.boardfish.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Export failed: ${(err as Error).message}`);
    }
  }

  async function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json,.boardfish';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const txt = await file.text();
        const parsed = JSON.parse(txt);
        if (!parsed?.settings || !Array.isArray(parsed?.items)) {
          alert('Not a Boardfish project file (missing settings/items).');
          return;
        }
        const name = (parsed?.meta?.name || file.name.replace(/\.(json|boardfish)$/i, '')) as string;
        const p = await createProject({
          name,
          settings: parsed.settings,
          items: parsed.items,
          thumbnailMediaUrl: parsed?.meta?.thumbnailMediaUrl ?? null,
        });
        await refresh();
        // Auto-open the imported project so the user immediately sees it.
        onOpen(p.id);
      } catch (err) {
        alert(`Import failed: ${(err as Error).message}`);
      }
    };
    input.click();
  }

  return (
    <div className="projects-dash">
      <div className="projects-dash-header">
        <div className="projects-dash-brand">
          <span className="projects-dash-title">Boardfish AI</span>
          <span className="projects-dash-subtitle">Projects</span>
        </div>
        <div className="projects-dash-actions">
          <input
            className="projects-dash-search"
            type="search"
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="projects-dash-view-toggle" role="tablist" aria-label="View mode">
            <button
              type="button"
              className={view === 'grid' ? 'active' : ''}
              onClick={() => setView('grid')}
              title="Grid view"
            >
              ▦
            </button>
            <button
              type="button"
              className={view === 'list' ? 'active' : ''}
              onClick={() => setView('list')}
              title="List view"
            >
              ☰
            </button>
          </div>
          <select
            className="projects-dash-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            title="Sort by"
          >
            <option value="modified">Last modified</option>
            <option value="created">Recently created</option>
            <option value="name">Name (A–Z)</option>
          </select>
          <button
            type="button"
            className="projects-dash-btn ghost"
            onClick={handleImport}
            title="Import project JSON"
          >
            Import…
          </button>
          <button
            type="button"
            className="projects-dash-btn primary"
            onClick={handleNew}
            disabled={busy === 'new'}
            title="New project"
          >
            + New Project
          </button>
        </div>
      </div>

      {error && (
        <div className="projects-dash-error">
          Couldn’t load projects: {error}
          <button type="button" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      {projects === null && !error && (
        <div className="projects-dash-empty">Loading…</div>
      )}

      {projects && filtered.length === 0 && !error && (
        <div className="projects-dash-empty">
          {query ? (
            <>No projects match “{query}”.</>
          ) : (
            <>
              No projects yet. Click <b>+ New Project</b> to start.
            </>
          )}
        </div>
      )}

      {view === 'grid' && filtered.length > 0 && (
        <div className="projects-dash-grid">
          {filtered.map((p) => (
            <ProjectTile
              key={p.id}
              project={p}
              busy={busy === p.id}
              onOpen={() => onOpen(p.id)}
              onRename={() => handleRename(p)}
              onDuplicate={() => handleDuplicate(p)}
              onDelete={() => handleDelete(p)}
              onExport={() => handleExport(p)}
            />
          ))}
        </div>
      )}

      {view === 'list' && filtered.length > 0 && (
        <div className="projects-dash-list">
          <div className="projects-dash-list-header">
            <span className="col-thumb" />
            <span className="col-name">Name</span>
            <span className="col-modified">Modified</span>
            <span className="col-size">Size</span>
            <span className="col-actions" />
          </div>
          {filtered.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              busy={busy === p.id}
              onOpen={() => onOpen(p.id)}
              onRename={() => handleRename(p)}
              onDuplicate={() => handleDuplicate(p)}
              onDelete={() => handleDelete(p)}
              onExport={() => handleExport(p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type TileProps = {
  project: ProjectSummary;
  busy: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExport: () => void;
};

function ProjectTile({ project, busy, onOpen, onRename, onDuplicate, onDelete, onExport }: TileProps) {
  return (
    <div className="project-tile" onDoubleClick={onOpen}>
      <button
        type="button"
        className="project-tile-thumb"
        onClick={onOpen}
        aria-label={`Open ${project.name}`}
      >
        {project.thumbnailMediaUrl ? (
          <img src={project.thumbnailMediaUrl} alt="" />
        ) : (
          <div className="project-tile-thumb-empty">
            <span>▨</span>
            <span className="hint">No panels yet</span>
          </div>
        )}
        {busy && <div className="project-tile-busy" aria-label="Working…" />}
      </button>
      <div className="project-tile-meta">
        <button
          type="button"
          className="project-tile-name"
          onClick={onOpen}
          title={project.name}
        >
          {project.name}
        </button>
        <div className="project-tile-sub">
          <span>{formatWhen(project.modified)}</span>
          <span className="dot">·</span>
          <span>{formatBytes(project.bytes)}</span>
        </div>
      </div>
      <div className="project-tile-actions">
        <button type="button" onClick={onOpen} title="Open">Open</button>
        <details className="project-tile-menu">
          <summary title="More">⋯</summary>
          <div className="project-tile-menu-body">
            <button type="button" onClick={onRename}>Rename…</button>
            <button type="button" onClick={onDuplicate}>Duplicate</button>
            <button type="button" onClick={onExport}>Export JSON…</button>
            <button type="button" className="danger" onClick={onDelete}>Delete…</button>
          </div>
        </details>
      </div>
    </div>
  );
}

function ProjectRow({ project, busy, onOpen, onRename, onDuplicate, onDelete, onExport }: TileProps) {
  return (
    <div className="projects-dash-row" onDoubleClick={onOpen}>
      <button
        type="button"
        className="col-thumb thumb-btn"
        onClick={onOpen}
        aria-label={`Open ${project.name}`}
      >
        {project.thumbnailMediaUrl ? (
          <img src={project.thumbnailMediaUrl} alt="" />
        ) : (
          <div className="thumb-empty">▨</div>
        )}
      </button>
      <button
        type="button"
        className="col-name name-btn"
        onClick={onOpen}
        title={project.name}
      >
        {project.name}
      </button>
      <span className="col-modified">{formatWhen(project.modified)}</span>
      <span className="col-size">{formatBytes(project.bytes)}</span>
      <span className="col-actions">
        <button type="button" onClick={onRename} disabled={busy}>Rename</button>
        <button type="button" onClick={onDuplicate} disabled={busy}>Duplicate</button>
        <button type="button" onClick={onExport} disabled={busy}>Export</button>
        <button type="button" className="danger" onClick={onDelete} disabled={busy}>Delete</button>
      </span>
    </div>
  );
}
