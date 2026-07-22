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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectSummary } from '../projects-api';
import {
  addProjectToFolder,
  createFolder,
  createProject,
  deleteFolder,
  deleteProject,
  duplicateProject,
  fetchProject,
  listFolders,
  listProjects,
  removeProjectFromFolder,
  renameFolder,
  renameProject,
  setProjectFolders,
} from '../projects-api';
import type { FolderRecord } from '../projects-api';
import { defaultSettings, newStoryboardItem } from '../types';
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

  // Folder filter. null = All Projects, otherwise a user folder name.
  // Persisted so a page reload keeps the current view.
  const [folderFilter, setFolderFilter] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem('boardfish:projects:folder');
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      // Legacy '' (Uncategorized) is coerced to null (All Projects).
      if (parsed === null || parsed === '' ) return null;
      if (typeof parsed === 'string') return parsed;
    } catch { /* ignore */ }
    return null;
  });
  useEffect(() => {
    try { localStorage.setItem('boardfish:projects:folder', JSON.stringify(folderFilter)); } catch { /* ignore */ }
  }, [folderFilter]);

  // "All Projects" twirldown state (for future hierarchical subfolders).
  const [allProjectsExpanded, setAllProjectsExpanded] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('boardfish:projects:allExpanded');
      if (raw === '0' || raw === 'false') return false;
    } catch { /* ignore */ }
    return true;
  });
  useEffect(() => {
    try { localStorage.setItem('boardfish:projects:allExpanded', allProjectsExpanded ? '1' : '0'); } catch { /* ignore */ }
  }, [allProjectsExpanded]);

  // Move-to-folder dialog state.
  const [moveDialog, setMoveDialog] = useState<ProjectSummary | null>(null);

  // Folder state — sourced from /api/folders (which unions in any legacy
  // folder names referenced only by project meta). Empty folders live
  // exclusively in folders.json.
  const [folders, setFolders] = useState<FolderRecord[]>([]);

  async function refresh() {
    try {
      const [p, fs] = await Promise.all([listProjects(), listFolders()]);
      setProjects(p);
      setFolders(fs);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setProjects([]);
      setFolders([]);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const list = projects || [];
    const q = query.trim().toLowerCase();
    const byQuery = q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
    // null = All Projects (show every project). Otherwise show projects
    // whose folders[] contains this User folder name.
    const byFolder = folderFilter === null
      ? byQuery
      : byQuery.filter((p) => (p.folders || (p.folder ? [p.folder] : [])).includes(folderFilter));
    return sortProjects(byFolder, sort);
  }, [projects, sort, query, folderFilter]);

  // Names list for the New Project / Move-to dialogs. Alphabetical.
  const folderList = useMemo(
    () => [...folders].sort((a, b) => a.name.localeCompare(b.name)).map((f) => f.name),
    [folders],
  );

  // "All Projects" count: every project (a project can also live in
  // multiple User folders; those User folders keep their own counts).
  const allCount = (projects || []).length;

  /**
   * Set the project's User-folder memberships to exactly this list.
   * `null` (from the legacy "Uncategorized" choice) clears the list.
   * If the folder is new (typed in), the server auto-creates a legacy
   * record that folders/list will merge in on next refresh.
   */
  async function handleSetFolders(p: ProjectSummary, folders: string[]) {
    setBusy(p.id);
    try {
      await setProjectFolders(p.id, folders);
      setMoveDialog(null);
      await refresh();
    } catch (err) {
      alert(`Update failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  // Create an empty folder immediately. No dialog — the sidebar shows it
  // with a default name ("New Folder", or "New Folder (2)", …) and starts
  // in inline-rename mode so the user can name it right away.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  async function openNewFolderDialog() {
    try {
      const created = await createFolder('New Folder');
      await refresh();
      setFolderFilter(created.name);
      setRenamingFolderId(created.id);
    } catch (err) {
      alert(`Create folder failed: ${(err as Error).message}`);
    }
  }

  async function handleRenameFolder(id: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed) {
      setRenamingFolderId(null);
      return;
    }
    const existing = folders.find((f) => f.id === id);
    if (!existing) {
      setRenamingFolderId(null);
      return;
    }
    if (existing.name === trimmed) {
      setRenamingFolderId(null);
      return;
    }
    try {
      await renameFolder(id, trimmed);
      // Update the current sidebar filter if it pointed at the old name.
      if (folderFilter === existing.name) setFolderFilter(trimmed);
      if (defaultNewFolder === existing.name) setDefaultNewFolder(trimmed);
      setRenamingFolderId(null);
      await refresh();
    } catch (err) {
      alert(`Rename failed: ${(err as Error).message}`);
    }
  }

  async function handleDeleteFolder(id: string) {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    const msg = f.count > 0
      ? `Delete User folder “${f.name}”? Its ${f.count} project alias${f.count === 1 ? '' : 'es'} will be removed. Projects themselves are unaffected.`
      : `Delete User folder “${f.name}”?`;
    if (!confirm(msg)) return;
    try {
      await deleteFolder(id);
      if (folderFilter === f.name) setFolderFilter(null);
      if (defaultNewFolder === f.name) setDefaultNewFolder(null);
      await refresh();
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    }
  }

  /**
   * Drag-and-drop onto a User folder ADDS the project to that folder
   * (multi-membership). Dropping on "All Projects" clears all user
   * folder memberships (project keeps existing, is a no-op if none).
   */
  async function handleDropOnFolder(projectId: string, folderName: string | null) {
    const p = (projects || []).find((x) => x.id === projectId);
    if (!p) return;
    setBusy(projectId);
    try {
      if (folderName === null) {
        // Drop on "All Projects" is a no-op — the project is already
        // in the global list. We don't want to strip user-folder aliases
        // silently on a stray drag.
        return;
      }
      const cur = p.folders || (p.folder ? [p.folder] : []);
      if (cur.includes(folderName)) return;
      await addProjectToFolder(projectId, folderName);
      await refresh();
    } catch (err) {
      alert(`Add to folder failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveFromFolder(projectId: string, folderName: string) {
    setBusy(projectId);
    try {
      await removeProjectFromFolder(projectId, folderName);
      await refresh();
    } catch (err) {
      alert(`Remove failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  // Remembered default folder for the New Project dialog. Persisted in
  // localStorage so the next "+ New Project" opens with the last-used
  // folder pre-selected. null = Uncategorized.
  const [defaultNewFolder, setDefaultNewFolder] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem('boardfish:projects:new-default-folder');
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed === 'string') return parsed;
    } catch { /* ignore */ }
    return null;
  });
  useEffect(() => {
    try { localStorage.setItem('boardfish:projects:new-default-folder', JSON.stringify(defaultNewFolder)); } catch { /* ignore */ }
  }, [defaultNewFolder]);

  // Name-prompt dialog state. `kind` selects the flow that runs after the
  // user confirms; `project` is set for rename. `defaultValue` seeds the
  // input; `busyKey` gates the confirm button while the async op runs.
  const [nameDialog, setNameDialog] = useState<
    | { kind: 'new'; defaultValue: string; defaultFolder: string | null }
    | { kind: 'rename'; project: ProjectSummary; defaultValue: string }
    | null
  >(null);

  function openNewDialog() {
    // Seed the folder picker with either the currently-selected sidebar
    // folder (if the user is browsing a folder) or the remembered default.
    // Passing `null` when sidebar shows All Projects / Uncategorized keeps
    // the remembered choice.
    const seedFolder = folderFilter && folderFilter !== ''
      ? folderFilter
      : defaultNewFolder;
    setNameDialog({
      kind: 'new',
      defaultValue: 'Untitled Project',
      defaultFolder: seedFolder,
    });
  }

  async function submitNameDialog(name: string, folder?: string | null) {
    if (!nameDialog) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (nameDialog.kind === 'new') {
      setBusy('new');
      try {
        // Seed BOTH the server-side project meta.name AND the in-document
        // settings.projectName so the storyboard view's "Project name"
        // field matches what the user typed. Without this, the storyboard
        // shows the default "Untitled Board".
        const seededSettings = { ...defaultSettings(), projectName: trimmed };
        // If the user is browsing a User folder, seed that as the initial
        // membership. Otherwise honor the dialog's picked folder (which
        // may also be null when the user chose "All Projects only").
        const chosenFolder = folder === undefined ? nameDialog.defaultFolder : folder;
        const p = await createProject({
          name: trimmed,
          settings: seededSettings,
          // Seed with one empty storyboard so the project opens to a real
          // storyboard page (default 3×2 grid) instead of a blank canvas.
          items: [newStoryboardItem()],
          folder: chosenFolder ?? null,
        });
        // Remember the picked folder as the default for the next dialog.
        setDefaultNewFolder(chosenFolder ?? null);
        setNameDialog(null);
        onOpen(p.id);
      } catch (err) {
        alert(`Create failed: ${(err as Error).message}`);
      } finally {
        setBusy(null);
      }
    } else {
      const p = nameDialog.project;
      if (trimmed === p.name) {
        setNameDialog(null);
        return;
      }
      try {
        await renameProject(p.id, trimmed);
        setNameDialog(null);
        await refresh();
      } catch (err) {
        alert(`Rename failed: ${(err as Error).message}`);
      }
    }
  }

  function handleRename(p: ProjectSummary) {
    setNameDialog({ kind: 'rename', project: p, defaultValue: p.name });
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
            onClick={openNewDialog}
            disabled={busy === 'new'}
            title="New project"
          >
            + New Project
          </button>
        </div>
      </div>

      <div className="projects-dash-body">
        <FolderSidebar
          folders={folders}
          allCount={allCount}
          selected={folderFilter}
          renamingId={renamingFolderId}
          allProjectsExpanded={allProjectsExpanded}
          onToggleAllProjects={() => setAllProjectsExpanded((v) => !v)}
          onSelect={setFolderFilter}
          onNewFolder={openNewFolderDialog}
          onStartRename={(id) => setRenamingFolderId(id)}
          onCancelRename={() => setRenamingFolderId(null)}
          onCommitRename={handleRenameFolder}
          onDelete={handleDeleteFolder}
          onDropProject={handleDropOnFolder}
        />
        <div className="projects-dash-main">
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
              ) : folderFilter === null ? (
                <>
                  No projects yet. Click <b>+ New Project</b> to start.
                </>
              ) : (
                <>No projects in “{folderFilter}” yet. Drag any project from <b>All Projects</b> here to add it.</>
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
                  activeFolder={folderFilter}
                  onOpen={() => onOpen(p.id)}
                  onRename={() => handleRename(p)}
                  onDuplicate={() => handleDuplicate(p)}
                  onDelete={() => handleDelete(p)}
                  onExport={() => handleExport(p)}
                  onMove={() => setMoveDialog(p)}
                  onRemoveFromCurrentFolder={
                    folderFilter !== null
                      ? () => handleRemoveFromFolder(p.id, folderFilter)
                      : undefined
                  }
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
                  activeFolder={folderFilter}
                  onOpen={() => onOpen(p.id)}
                  onRename={() => handleRename(p)}
                  onDuplicate={() => handleDuplicate(p)}
                  onDelete={() => handleDelete(p)}
                  onExport={() => handleExport(p)}
                  onMove={() => setMoveDialog(p)}
                  onRemoveFromCurrentFolder={
                    folderFilter !== null
                      ? () => handleRemoveFromFolder(p.id, folderFilter)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {nameDialog && (
        <NameDialog
          title={nameDialog.kind === 'new' ? 'New Project' : 'Rename Project'}
          label={nameDialog.kind === 'new' ? 'Project name' : 'Project name'}
          confirmLabel={nameDialog.kind === 'new' ? 'Create' : 'Save'}
          defaultValue={nameDialog.defaultValue}
          busy={busy === 'new'}
          onCancel={() => setNameDialog(null)}
          onConfirm={submitNameDialog}
          showFolderPicker={nameDialog.kind === 'new'}
          defaultFolder={nameDialog.kind === 'new' ? nameDialog.defaultFolder : null}
          allFolders={folderList}
        />
      )}

      {moveDialog && (
        <FolderMembershipDialog
          project={moveDialog}
          allFolders={folderList}
          busy={busy === moveDialog.id}
          onCancel={() => setMoveDialog(null)}
          onSubmit={(next) => void handleSetFolders(moveDialog, next)}
        />
      )}
    </div>
  );
}

/**
 * Left-hand sidebar layout:
 *   • "All Projects" section header (twirldown for future hierarchical
 *     subfolders). Clicking the row itself selects the global view.
 *   • "Users" section header — alphabetical list of user-defined folders
 *     (aliases). A project can belong to multiple User folders. The + button
 *     next to "Users" creates a new empty folder ready for drag-drop.
 */
type FolderSidebarProps = {
  folders: FolderRecord[];
  allCount: number;
  selected: string | null;
  renamingId: string | null;
  allProjectsExpanded: boolean;
  onToggleAllProjects: () => void;
  onSelect: (folder: string | null) => void;
  onNewFolder: () => void;
  onStartRename: (id: string) => void;
  onCancelRename: () => void;
  onCommitRename: (id: string, newName: string) => void;
  onDelete: (id: string) => void;
  onDropProject: (projectId: string, folderName: string | null) => void;
};

function FolderSidebar({
  folders,
  allCount,
  selected,
  renamingId,
  allProjectsExpanded,
  onToggleAllProjects,
  onSelect,
  onNewFolder,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onDelete,
  onDropProject,
}: FolderSidebarProps) {
  const [hoverDropTarget, setHoverDropTarget] = useState<string | null>(null);

  function onDragOverAny(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('application/x-boardfish-project')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  function readDroppedProjectId(e: React.DragEvent): string | null {
    return e.dataTransfer.getData('application/x-boardfish-project') || null;
  }

  return (
    <aside className="projects-dash-sidebar" aria-label="Folders">
      {/* All Projects: twirldown row + count. Clicking the label selects
          the global view; clicking the chevron toggles expansion for
          future hierarchical subfolders. */}
      <div
        className={`folder-item folder-item-all${selected === null ? ' is-active' : ''}`}
      >
        <button
          type="button"
          className="folder-item-twirl"
          onClick={(e) => { e.stopPropagation(); onToggleAllProjects(); }}
          aria-label={allProjectsExpanded ? 'Collapse All Projects' : 'Expand All Projects'}
          title={allProjectsExpanded ? 'Collapse' : 'Expand'}
        >
          {allProjectsExpanded ? '▾' : '▸'}
        </button>
        <button
          type="button"
          className="folder-item-btn"
          onClick={() => onSelect(null)}
        >
          <span className="folder-item-icon">▣</span>
          <span className="folder-item-name">All Projects</span>
          <span className="folder-item-count">{allCount}</span>
        </button>
      </div>

      {/* Reserved slot for hierarchical subfolders under All Projects.
          Empty for now — real subfolder containment ships in a follow-up. */}
      {allProjectsExpanded && (
        <div className="folder-item-subhint">
          Subfolders coming soon
        </div>
      )}

      <div className="projects-dash-sidebar-section">
        <span className="projects-dash-sidebar-title">Users</span>
        <button
          type="button"
          className="projects-dash-sidebar-new"
          onClick={onNewFolder}
          title="New User folder"
          aria-label="New User folder"
        >
          +
        </button>
      </div>
      {folders.length === 0 && (
        <div className="folder-item-subhint">
          Click + to create a User folder. Drag projects here to organize.
        </div>
      )}
      {folders.map((f) => (
        <FolderRow
          key={f.id}
          folder={f}
          isActive={selected === f.name}
          isRenaming={renamingId === f.id}
          isDropHover={hoverDropTarget === f.name}
          onSelect={() => onSelect(f.name)}
          onStartRename={() => onStartRename(f.id)}
          onCancelRename={onCancelRename}
          onCommitRename={(newName) => onCommitRename(f.id, newName)}
          onDelete={() => onDelete(f.id)}
          onDragOver={(e) => { onDragOverAny(e); setHoverDropTarget(f.name); }}
          onDragLeave={() => setHoverDropTarget((cur) => (cur === f.name ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            setHoverDropTarget(null);
            const projId = readDroppedProjectId(e);
            if (projId) onDropProject(projId, f.name);
          }}
        />
      ))}
    </aside>
  );
}

/**
 * A single folder row in the sidebar. Renders as a button by default;
 * flips into an inline text input when isRenaming is true. Double-click
 * to start editing; Enter to commit, Escape to cancel, blur to commit.
 * A trash icon on hover deletes the folder.
 */
type FolderRowProps = {
  folder: FolderRecord;
  isActive: boolean;
  isRenaming: boolean;
  isDropHover: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onCommitRename: (newName: string) => void;
  onDelete: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
};

function FolderRow({
  folder,
  isActive,
  isRenaming,
  isDropHover,
  onSelect,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onDelete,
  onDragOver,
  onDragLeave,
  onDrop,
}: FolderRowProps) {
  const [draft, setDraft] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(folder.name);
  }, [folder.name, isRenaming]);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  if (isRenaming) {
    return (
      <div
        className={`folder-item is-renaming${isActive ? ' is-active' : ''}${isDropHover ? ' is-drop-hover' : ''}`}
      >
        <span className="folder-item-icon">📁</span>
        <input
          ref={inputRef}
          className="folder-item-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommitRename(draft);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={() => onCommitRename(draft)}
          maxLength={80}
        />
      </div>
    );
  }

  return (
    <div
      className={
        `folder-item${isActive ? ' is-active' : ''}` +
        (isDropHover ? ' is-drop-hover' : '')
      }
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="folder-item-btn"
        onClick={onSelect}
        onDoubleClick={(e) => { e.preventDefault(); onStartRename(); }}
        title={folder.name}
      >
        <span className="folder-item-icon">📁</span>
        <span className="folder-item-name">{folder.name}</span>
        <span className="folder-item-count">{folder.count}</span>
      </button>
      <button
        type="button"
        className="folder-item-rename"
        onClick={(e) => { e.stopPropagation(); onStartRename(); }}
        title="Rename"
        aria-label="Rename"
      >
        ✎
      </button>
      <button
        type="button"
        className="folder-item-delete"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Delete folder"
        aria-label="Delete folder"
      >
        ×
      </button>
    </div>
  );
}

/**
 * Folder-membership dialog. Multi-select checklist: a project can live
 * in zero or more User folders (aliases). Includes an inline "create new
 * folder" input that adds a fresh folder into the selection set.
 */
type FolderMembershipDialogProps = {
  project: ProjectSummary;
  allFolders: string[];
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (folders: string[]) => void;
};

function FolderMembershipDialog({
  project,
  allFolders,
  busy,
  onCancel,
  onSubmit,
}: FolderMembershipDialogProps) {
  const initial = useMemo(
    () => project.folders || (project.folder ? [project.folder] : []),
    [project],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial));
  // Any locally-typed folders that don't exist server-side yet.
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [newFolder, setNewFolder] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function toggle(name: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function addNew() {
    const t = newFolder.trim();
    if (!t) return;
    if (!allFolders.includes(t) && !extraFolders.includes(t)) {
      setExtraFolders((cur) => [...cur, t]);
    }
    setSelected((cur) => new Set(cur).add(t));
    setNewFolder('');
  }

  function submit() {
    onSubmit(Array.from(selected));
  }

  const shown = useMemo(
    () => Array.from(new Set([...allFolders, ...extraFolders])).sort((a, b) => a.localeCompare(b)),
    [allFolders, extraFolders],
  );

  return createPortal(
    <div className="name-dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="name-dialog move-folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Folders"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="name-dialog-title">
          Folders for “{project.name}”
        </div>
        <div className="move-folder-current">
          A project can live in <b>multiple</b> User folders. Toggle to add or remove.
        </div>
        <div className="move-folder-choices">
          {shown.length === 0 && (
            <div style={{ color: '#8a8a92', fontSize: 12, padding: '4px 2px' }}>
              No User folders yet. Create one below.
            </div>
          )}
          {shown.map((f) => {
            const isOn = selected.has(f);
            return (
              <button
                key={f}
                type="button"
                className={`move-folder-choice${isOn ? ' is-current' : ''}`}
                onClick={() => toggle(f)}
                disabled={busy}
              >
                <span>{isOn ? '☑' : '☐'}</span> <span>📁</span> {f}
              </button>
            );
          })}
        </div>
        <div className="name-dialog-field">
          <span>Create new folder</span>
          <input
            type="text"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addNew();
              }
            }}
            placeholder="Folder name…"
            maxLength={80}
          />
        </div>
        <div className="name-dialog-actions">
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={submit}
            disabled={busy}
          >
            {busy ? '…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Simple modal dialog for entering a project name.
 *
 * Autofocuses + selects the input on mount. Enter submits, Escape cancels,
 * backdrop click cancels. Trims whitespace; empty submit is a no-op.
 */
type NameDialogProps = {
  title: string;
  label: string;
  confirmLabel: string;
  defaultValue: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (value: string, folder?: string | null) => void;
  /** When true, render a folder picker below the name field. */
  showFolderPicker?: boolean;
  defaultFolder?: string | null;
  allFolders?: string[];
};

function NameDialog({
  title,
  label,
  confirmLabel,
  defaultValue,
  busy,
  onCancel,
  onConfirm,
  showFolderPicker,
  defaultFolder,
  allFolders,
}: NameDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const [folder, setFolder] = useState<string | null>(defaultFolder ?? null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Autofocus + select the whole default name so typing replaces it.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function submit() {
    const t = value.trim();
    if (!t) return;
    onConfirm(t, showFolderPicker ? folder : undefined);
  }

  return createPortal(
    <div className="name-dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="name-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="name-dialog-title">{title}</div>
        <label className="name-dialog-field">
          <span>{label}</span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Untitled Project"
            maxLength={120}
          />
        </label>
        {showFolderPicker && (
          <div className="name-dialog-field">
            <span>Folder</span>
            <div className="name-dialog-folder-chips">
              <button
                type="button"
                className={`move-folder-choice${!folder ? ' is-current' : ''}`}
                onClick={() => setFolder(null)}
              >
                <span>∅</span> Uncategorized
              </button>
              {(allFolders ?? []).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`move-folder-choice${folder === f ? ' is-current' : ''}`}
                  onClick={() => setFolder(f)}
                >
                  <span>📁</span> {f}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="name-dialog-actions">
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={submit}
            disabled={busy || !value.trim()}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type TileProps = {
  project: ProjectSummary;
  busy: boolean;
  /** null = viewing All Projects; string = viewing that User folder. */
  activeFolder: string | null;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExport: () => void;
  onMove: () => void;
  /** Only defined when a User folder is currently selected. */
  onRemoveFromCurrentFolder?: () => void;
};

function ProjectTile({
  project,
  busy,
  activeFolder,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
  onMove,
  onRemoveFromCurrentFolder,
}: TileProps) {
  return (
    <div
      className="project-tile"
      // Single-click no longer opens; double-click still does. This
      // matches finder-style tile browsing so drag/drop and selection
      // don't accidentally navigate away.
      onDoubleClick={onOpen}
      draggable
      onDragStart={(e) => {
        // Boardfish-specific MIME so unrelated drops (files, images) don't
        // accidentally hit the folder targets.
        e.dataTransfer.setData('application/x-boardfish-project', project.id);
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
    >
      <div
        className="project-tile-thumb"
        aria-label={`${project.name} thumbnail (double-click to open)`}
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
      </div>
      <div className="project-tile-meta">
        <div
          className="project-tile-name"
          title={project.name}
        >
          {project.name}
        </div>
        <div className="project-tile-sub">
          <span>{formatWhen(project.modified)}</span>
          <span className="dot">·</span>
          <span>{formatBytes(project.bytes)}</span>
        </div>
      </div>
      <div className="project-tile-actions">
        <button type="button" onClick={onOpen} title="Open">Open</button>
        <TileMoreMenu
          folders={project.folders || (project.folder ? [project.folder] : [])}
          activeFolder={activeFolder}
          onRename={onRename}
          onDuplicate={onDuplicate}
          onExport={onExport}
          onDelete={onDelete}
          onMove={onMove}
          onRemoveFromCurrentFolder={onRemoveFromCurrentFolder}
        />
      </div>
    </div>
  );
}

/**
 * Controlled “⋯ more” dropdown for the tile actions row.
 *
 * The tile itself has `overflow: hidden` so its rounded thumbnail clips.
 * A popup inside that container would get clipped too, so we portal the
 * menu to <body> and position it with `position: fixed` anchored to the
 * button's bounding rect. Click-outside + Escape dismiss.
 */
type TileMoreMenuProps = {
  folders: string[];
  activeFolder: string | null;
  onRename: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onMove: () => void;
  onRemoveFromCurrentFolder?: () => void;
};

function TileMoreMenu({
  folders,
  activeFolder,
  onRename,
  onDuplicate,
  onExport,
  onDelete,
  onMove,
  onRemoveFromCurrentFolder,
}: TileMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    // Menu is ~180px wide; align its right edge with the button's right edge.
    // Positioned just below the button with a small gap.
    const menuWidth = 180;
    setPos({ top: r.bottom + 4, left: Math.max(8, r.right - menuWidth) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const call = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="project-tile-menu">
      <button
        ref={btnRef}
        type="button"
        className={`project-tile-menu-summary${open ? ' is-open' : ''}`}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              className="project-tile-menu-body"
              role="menu"
              style={{ position: 'fixed', top: pos.top, left: pos.left, width: 180 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button type="button" role="menuitem" onClick={call(onRename)}>Rename…</button>
              <button type="button" role="menuitem" onClick={call(onDuplicate)}>Duplicate</button>
              <button type="button" role="menuitem" onClick={call(onMove)}>
                Folders…
                {folders.length > 0 ? (
                  <span className="menu-hint"> ({folders.length})</span>
                ) : null}
              </button>
              {activeFolder && onRemoveFromCurrentFolder ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={call(onRemoveFromCurrentFolder)}
                >
                  Remove from “{activeFolder}”
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={call(onExport)}>Export JSON…</button>
              <button type="button" role="menuitem" className="danger" onClick={call(onDelete)}>Delete…</button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function ProjectRow({
  project,
  busy,
  activeFolder,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
  onMove,
  onRemoveFromCurrentFolder,
}: TileProps) {
  return (
    <div
      className="projects-dash-row"
      // Double-click to open (matches tile behavior).
      onDoubleClick={onOpen}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-boardfish-project', project.id);
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
    >
      <div className="col-thumb thumb-btn" aria-label={`${project.name} thumbnail`}>
        {project.thumbnailMediaUrl ? (
          <img src={project.thumbnailMediaUrl} alt="" />
        ) : (
          <div className="thumb-empty">▨</div>
        )}
      </div>
      <span className="col-name name-btn" title={project.name}>
        {project.name}
      </span>
      <span className="col-modified">{formatWhen(project.modified)}</span>
      <span className="col-size">{formatBytes(project.bytes)}</span>
      <span className="col-actions">
        <button type="button" onClick={onOpen} disabled={busy}>Open</button>
        <button type="button" onClick={onRename} disabled={busy}>Rename</button>
        <button type="button" onClick={onDuplicate} disabled={busy}>Duplicate</button>
        <button type="button" onClick={onMove} disabled={busy}>Folders…</button>
        {activeFolder && onRemoveFromCurrentFolder ? (
          <button type="button" onClick={onRemoveFromCurrentFolder} disabled={busy}>
            Remove
          </button>
        ) : null}
        <button type="button" onClick={onExport} disabled={busy}>Export</button>
        <button type="button" className="danger" onClick={onDelete} disabled={busy}>Delete</button>
      </span>
    </div>
  );
}
