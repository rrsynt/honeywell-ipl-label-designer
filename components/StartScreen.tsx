// Fase 1: the document library. Replaces the Load/Delete dropdown as the way
// designs are found again — thumbnails, search, and folder tags — while New
// and Templates stay exactly the actions they were (App owns the unsaved-work
// confirm and the dispatch). This component only reads the library and reports
// which name was chosen.

import React, { useEffect, useMemo, useState } from 'react';
import { indexedDbBackend, listLibrary, memoryBackend, setLibraryBackend, type LibraryMeta } from '../services/libraryStore';
import { getLibraryServerUrl, pingLibraryServer, remoteBackend, setLibraryServerUrl } from '../services/libraryRemoteBackend';
import { ServerTokenInput } from './ServerTokenInput';

const formatSize = (m: LibraryMeta): string => {
    const mm = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    return `${mm(m.widthMm)} × ${mm(m.heightMm)} mm · ${m.dpi} dpi`;
};

const formatWhen = (ms: number): string => {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export const StartScreen: React.FC<{
    onClose: () => void;
    onNew: () => void;
    onTemplates: () => void;
    onOpen: (name: string) => void;
    /** Bumped by the parent after a save/delete so the grid re-reads storage. */
    revision: number;
    /** The parent bumps `revision` — this screen can't, it doesn't own the state. */
    onRevision: () => void;
}> = ({ onClose, onNew, onTemplates, onOpen, revision, onRevision }) => {
    const [records, setRecords] = useState<LibraryMeta[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [query, setQuery] = useState('');
    const [tag, setTag] = useState<string | null>(null);
    // The shared library. What is stored and what the field shows are kept
    // apart: the field is edited freely, and only "Use" commits it.
    const [serverUrl, setServerUrl] = useState(() => getLibraryServerUrl());
    const [serverDraft, setServerDraft] = useState(serverUrl);
    const [serverState, setServerState] = useState<{ text: string; ok: boolean } | null>(null);

    useEffect(() => {
        let live = true;
        listLibrary()
            .then(list => { if (live) setRecords(list); })
            .catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
    }, [revision]);

    const tags = useMemo(() => {
        const all = new Set<string>();
        for (const r of records ?? []) for (const t of r.tags) all.add(t);
        return [...all].sort();
    }, [records]);

    // Point the library at a shared server, or back at this browser. The grid
    // re-reads because `revision` changes; a server that does not answer
    // leaves the grid showing the failure the list already renders.
    const applyServer = async () => {
        let clean = '';
        try {
            clean = setLibraryServerUrl(serverDraft);
        } catch (e) {
            setServerState({ text: e instanceof Error ? e.message : String(e), ok: false });
            return;
        }
        if (clean === '') {
            const hasIndexedDb = typeof indexedDB !== 'undefined' && indexedDB !== null;
            setLibraryBackend(hasIndexedDb ? indexedDbBackend() : memoryBackend());
        } else {
            const hasIndexedDb = typeof indexedDB !== 'undefined' && indexedDB !== null;
            setLibraryBackend(remoteBackend({ serverUrl: clean, local: hasIndexedDb ? indexedDbBackend() : memoryBackend() }));
        }
        setServerUrl(clean);
        setServerDraft(clean);
        setRecords(null);
        setFailed(false);
        onRevision();
        if (clean === '') { setServerState({ text: 'Designs stay on this computer.', ok: true }); return; }
        const up = await pingLibraryServer(clean);
        setServerState(up
            ? { text: 'Connected. Designs are shared from this server.', ok: true }
            : { text: 'Saved, but the server did not answer. Start it with: node tools/library-server.mjs', ok: false });
    };

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (records ?? []).filter(r =>
            (q === '' || r.name.toLowerCase().includes(q)) &&
            (tag === null || r.tags.includes(tag)));
    }, [records, query, tag]);

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" onClick={onClose} role="presentation">
            <div className="bg-gray-800 rounded-lg shadow-2xl p-6 w-full max-w-4xl mx-4 text-gray-200 flex flex-col" style={{ maxHeight: '85vh' }}
                onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Design library"
                onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
                <div className="flex justify-between items-center border-b border-gray-700 pb-3 mb-4">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                        <span className="material-icons">inventory_2</span>Designs
                    </h2>
                    <button onClick={onClose} className="p-1 rounded-full hover:bg-gray-700" aria-label="Close">
                        <span className="material-icons">close</span>
                    </button>
                </div>

                <div className="flex items-center gap-2 mb-4">
                    <button onClick={onNew} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 hover:bg-blue-700 text-white">New design</button>
                    <button onClick={onTemplates} className="px-3 py-1.5 text-sm rounded-md bg-gray-700 hover:bg-gray-600 text-white">From template</button>
                    <div className="flex-1" />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search by name"
                        aria-label="Search designs"
                        className="w-56 text-sm p-1.5 bg-gray-700 rounded-md border border-gray-600 focus:ring-1 focus:ring-blue-500 outline-none"
                    />
                </div>

                <div className="flex items-center gap-2 mb-4">
                    <span className="material-icons text-gray-400 text-base" title="Share this library with other computers">lan</span>
                    <input
                        value={serverDraft}
                        onChange={e => setServerDraft(e.target.value)}
                        placeholder="Shared server, e.g. http://192.168.1.10:9182"
                        aria-label="Shared library server"
                        className="flex-1 text-sm p-1.5 bg-gray-700 rounded-md border border-gray-600 focus:ring-1 focus:ring-blue-500 outline-none"
                    />
                    <button onClick={() => void applyServer()}
                        className="px-3 py-1.5 text-sm rounded-md bg-gray-700 hover:bg-gray-600 text-white">
                        {serverDraft.trim() === '' ? 'Keep local' : 'Use server'}
                    </button>
                    <ServerTokenInput kind="library" />
                    {serverUrl !== '' && (
                        <span className="text-[11px] text-blue-300 whitespace-nowrap">shared</span>
                    )}
                </div>
                {serverState && (
                    <p className={`text-xs mb-3 -mt-2 ${serverState.ok ? 'text-green-400' : 'text-red-400'}`}>{serverState.text}</p>
                )}

                {tags.length > 0 && (
                    <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                        <TagChip label="All" active={tag === null} onClick={() => setTag(null)} />
                        {tags.map(t => <TagChip key={t} label={t} active={tag === t} onClick={() => setTag(tag === t ? null : t)} />)}
                    </div>
                )}

                <div className="flex-1 overflow-y-auto pr-1">
                    {failed && <p className="text-sm text-red-400">Could not read the design library. Your designs are still saved — export a copy from the editor as a backup.</p>}
                    {records === null && !failed && <p className="text-sm text-gray-400">Loading…</p>}
                    {records !== null && records.length === 0 && (
                        <p className="text-sm text-gray-400">No saved designs yet. Save the current one (Ctrl+S) and it will appear here.</p>
                    )}
                    {records !== null && records.length > 0 && shown.length === 0 && (
                        <p className="text-sm text-gray-400">Nothing matches.</p>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                        {shown.map(r => (
                            <button key={r.name} onClick={() => onOpen(r.name)}
                                className="text-left rounded-lg border border-gray-700 bg-gray-900/60 hover:border-blue-500 p-2 transition-colors">
                                <div className="aspect-[4/3] bg-white rounded mb-2 flex items-center justify-center overflow-hidden">
                                    {r.thumbnail
                                        ? <img src={r.thumbnail} alt="" className="max-w-full max-h-full object-contain" />
                                        : <span className="material-icons text-gray-400 text-4xl">label</span>}
                                </div>
                                <div className="font-semibold text-sm truncate" title={r.name}>{r.name}</div>
                                <div className="text-[11px] text-gray-400 truncate">{formatSize(r)}</div>
                                <div className="text-[11px] text-gray-500 truncate">{formatWhen(r.updatedAt)}</div>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

const TagChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
    <button onClick={onClick}
        className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${active ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
        {label}
    </button>
);
