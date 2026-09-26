// Fase 6: the Print Center — sheet preview, print queue and print log.
//
// One modal rather than three commands because they are one workflow: look at
// the sheet, queue the job, then read the log when the roll came out wrong.
//
// Two things this UI refuses to do quietly:
//
//   - A retry after a failure may print up to one chunk twice. The bridge
//     reports `written` only after the socket flushed, so a chunk that failed
//     can still have reached the paper. The confirm says so and names the
//     chunk and its label count, because the alternative — a cheerful "retry
//     is safe" — is a lie a shift pays for in media.
//   - ZPL has no per-record output, so a record range against a ZPL target is
//     refused with the reason, not sent with the records silently dropped.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Design, PrinterLanguage } from '../types';
import { SheetPreview } from './SheetPreview';
import { designHasRecords, designJobPlan, designRecordCount } from '../services/printRecords';
import { printSequence, PRINT_CHUNK_LABELS } from '../services/printJob';
import {
    ambiguousChunk, cancelPrintJob, createPrintJob, jobChunks, jobSendabilityError, jobWarnings,
    listPrintJobs, listPrintLog, prunePrintJobs, recoverInterruptedJobs, removePrintJob, runPrintJob,
    type PrintJob, type PrintJobStatus,
} from '../services/printQueue';
import {
    activatePrintTarget, defaultPrintTarget, deletePrintTarget, listPrintTargets, migrateLegacyTarget,
    savePrintTarget, validateTarget, type PrintTarget,
} from '../services/printTargets';
import { pingBridge } from '../services/bridgeSend';
import { applyPrintServerUrl, getPrintServerUrl, pingPrintServer } from '../services/printRemoteBackend';
import { notify, requestConfirm } from '../services/uiDialogs';
import { PRINTER_MODELS } from '../constants';

const inputClasses = 'w-full text-xs p-1.5 bg-gray-900 border border-gray-600 rounded-md outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

/**
 * A run that stopped talking this long ago is not running any more. The
 * runner rewrites its job on every chunk, so silence past this is a dead tab,
 * not a slow printer.
 */
const RUN_STALE_MS = 60_000;

const isRunStale = (job: PrintJob): boolean =>
    job.status === 'sending' && Date.now() - (job.updatedAt ?? 0) > RUN_STALE_MS;

const STATUS_STYLE: Record<PrintJobStatus, string> = {
    queued: 'bg-gray-600/40 text-gray-300',
    sending: 'bg-blue-600/30 text-blue-300',
    sent: 'bg-emerald-600/30 text-emerald-300',
    failed: 'bg-red-600/30 text-red-300',
    cancelled: 'bg-gray-700 text-gray-400',
};

const formatWhen = (ms: number): string =>
    ms ? new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

const formatBytes = (n: number): string => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export const PrintCenter: React.FC<{ design: Design; onClose: () => void }> = ({ design, onClose }) => {
    const [tab, setTab] = useState<'sheet' | 'jobs' | 'log'>('sheet');
    const recordCount = designRecordCount(design);
    const hasRecords = designHasRecords(design);

    const [from, setFrom] = useState('1');
    const [to, setTo] = useState(String(recordCount));
    const [copies, setCopies] = useState('1');
    const [collation, setCollation] = useState<'collated' | 'uncollated'>('collated');
    const [targets, setTargets] = useState<PrintTarget[]>([]);
    const [targetId, setTargetId] = useState('');
    const [jobs, setJobs] = useState<PrintJob[]>([]);
    const [log, setLog] = useState<Awaited<ReturnType<typeof listPrintLog>>>([]);
    const [bridgeOk, setBridgeOk] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [revision, setRevision] = useState(0);
    const runningRef = useRef(false);
    const [serverUrl, setServerUrl] = useState(() => getPrintServerUrl());
    const [serverDraft, setServerDraft] = useState(() => getPrintServerUrl());
    const [serverState, setServerState] = useState<{ text: string; ok: boolean } | null>(null);
    const sharing = serverUrl !== '';

    const refresh = useCallback(async () => {
        // A queue on a server that is down must not blank the panel: the
        // error surfaces through `serverState`, and the lists keep what they
        // last showed instead of throwing into the void.
        try {
            const [nextTargets, nextJobs, nextLog] = await Promise.all([listPrintTargets(), listPrintJobs(), listPrintLog()]);
            setTargets(nextTargets);
            setJobs(nextJobs);
            setLog(nextLog);
            // Keep the current selection unless it is gone — re-picking the
            // first target on every refresh would silently move a
            // half-configured job to a different printer.
            setTargetId(id => (id && nextTargets.some(t => t.id === id) ? id : (nextTargets[0]?.id ?? '')));
        } catch (e) {
            if (sharing) {
                setServerState({ text: e instanceof Error ? e.message : String(e), ok: false });
                return;
            }
            throw e;
        }
    }, [sharing]);

    /**
     * Point the queue at a shared print server, or back at this browser.
     * The backend swap and the "empty means local" rule live in the service,
     * so this and the app's startup effect cannot drift apart.
     */
    const applyServer = async () => {
        let clean = '';
        try {
            clean = applyPrintServerUrl(serverDraft);
        } catch (e) {
            setServerState({ text: e instanceof Error ? e.message : String(e), ok: false });
            return;
        }
        setServerUrl(clean);
        setServerDraft(clean);
        setTargets([]);
        setJobs([]);
        setLog([]);
        setTargetId('');
        setRevision(r => r + 1); // re-read the queue we just switched to
        if (clean === '') {
            setServerState({ text: 'The queue and the printer list stay on this computer.', ok: true });
            return;
        }
        const up = await pingPrintServer(clean);
        setServerState(up
            ? { text: 'Connected. The queue and the printer list are shared from this server.', ok: true }
            : { text: `Saved, but no answer from ${clean}. Start it with: node tools/print-server.mjs`, ok: false });
    };

    useEffect(() => {
        void (async () => {
            // A job left mid-send by a closed tab must become retryable before
            // the list is shown, or it reads as "still printing" forever.
            //
            // NOT on a shared queue, which is the one place recovery stops
            // being safe: "the process that was sending is gone" becomes false
            // when the sender is another station, and this would flip a live
            // job to failed and clear its run token. A stale job is recoverable
            // by hand instead — Cancel, then Send.
            if (!sharing) await recoverInterruptedJobs().catch(() => 0);
            // Adding this browser's legacy printer to a SHARED list would put
            // one station's machine on everyone's picker, so the migration
            // stays local too.
            if (!sharing) await migrateLegacyTarget().catch(() => false);
            await refresh();
        })();
    }, [refresh, sharing, revision]);

    // Status of the thing that actually carries the stream: the shared server
    // when the queue is on it, the local bridge otherwise.
    useEffect(() => {
        let live = true;
        if (sharing) {
            void pingPrintServer(serverUrl).then(ok => {
                if (!live) return;
                setServerState(ok
                    ? { text: 'Connected. The queue and the printer list are shared from this server.', ok: true }
                    : { text: `No answer from ${serverUrl}. Start it with: node tools/print-server.mjs`, ok: false });
            });
        } else {
            void pingBridge().then(ok => { if (live) setBridgeOk(ok); });
        }
        return () => { live = false; };
    }, [sharing, serverUrl, revision]);

    useEffect(() => { setTo(String(recordCount)); }, [recordCount]);

    const target = targets.find(t => t.id === targetId) ?? null;
    const refusal = target ? jobSendabilityError(design, target) : (hasRecords && targets.length === 0 ? 'Add a printer before starting a job.' : null);
    const warnings = target ? jobWarnings(design, target) : [];

    const fromN = parseInt(from) || 1;
    const toN = parseInt(to) || recordCount;
    const copiesN = Math.max(1, parseInt(copies) || 1);
    const sequence = hasRecords ? printSequence({ from: fromN, to: toN }, copiesN, collation, recordCount) : [];
    const labels = hasRecords ? sequence.length : copiesN;
    const chunks = hasRecords ? Math.max(1, Math.ceil(labels / PRINT_CHUNK_LABELS)) : 1;

    const startJob = async () => {
        if (!target || refusal || runningRef.current) return;
        runningRef.current = true;
        setBusy(true);
        try {
            activatePrintTarget(target);
            const job = await createPrintJob(design, {
                recordFrom: fromN, recordTo: toN, copies: copiesN, collation,
                target: { id: target.id, name: target.name, host: target.host, port: target.port, language: target.language, dpi: target.dpi },
            });
            await refresh();
            setTab('jobs');
            notify(`Job queued: ${job.labels} label(s) in ${job.chunkCount} chunk(s).`, 'info');
        } catch (e) {
            notify(e instanceof Error ? e.message : String(e));
        } finally {
            runningRef.current = false;
            setBusy(false);
        }
    };

    const send = async (job: PrintJob) => {
        if (runningRef.current) return;
        // A send is physical and irreversible, so the confirm must name what
        // THIS send prints — which on a resume is the remaining chunks, not the
        // job's total. Quoting the total would overstate a retry by whatever
        // already went out.
        const remaining = jobChunks(job).slice(job.sentChunks);
        const labelsNow = remaining.reduce((sum, chunk) => sum + chunk.labels, 0);
        const ambiguous = job.status === 'failed' ? await ambiguousChunk(job.id) : null;
        const caution = ambiguous
            ? ` Up to ${ambiguous.labels} label(s) from the failed attempt may already have printed; retrying re-sends them.`
            : '';
        const proceed = await requestConfirm({
            title: job.status === 'failed' ? 'Retry print job?' : 'Send print job?',
            message: `Sends ${labelsNow} label(s) in ${remaining.length} chunk(s) to ${job.target.name} (${job.target.host}:${job.target.port}).${caution} The printer starts immediately.`,
            confirmLabel: job.status === 'failed' ? 'Retry' : 'Send',
            danger: true,
        });
        if (!proceed) return;
        runningRef.current = true;
        setBusy(true);
        try {
            // The job as STORED, not the copy in state: another tab may have
            // advanced it, and progress must come from the queue's own record.
            const stored = (await listPrintJobs()).find(j => j.id === job.id) ?? job;
            const done = await runPrintJob(stored, {}, updated => {
                setJobs(current => current.map(j => (j.id === updated.id ? updated : j)));
            });
            await refresh();
            if (done.status === 'sent') notify(`Job sent: ${done.labels} label(s) to ${done.target.name}.`, 'info');
            else if (done.status !== 'cancelled') notify(`Job failed: ${done.lastError ?? 'unknown error'}`);
        } catch (e) {
            notify(`Job failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            runningRef.current = false;
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" onClick={onClose} role="presentation">
            <div className="bg-gray-800 rounded-lg shadow-2xl w-full max-w-5xl mx-4 text-gray-200 flex flex-col" style={{ maxHeight: '90vh', height: '90vh' }}
                onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Print center"
                onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
                <div className="flex justify-between items-center border-b border-gray-700 px-5 py-3 flex-shrink-0">
                    <h2 className="text-lg font-bold flex items-center gap-2">
                        <span className="material-icons">print</span>Print Center
                        <span className="text-xs font-normal text-gray-400 ml-2">{design.name}</span>
                    </h2>
                    <div className="flex items-center gap-2">
                        {sharing ? (
                            <span className={`text-xs flex items-center gap-1.5 ${serverState === null ? 'text-gray-400' : serverState.ok ? 'text-emerald-400' : 'text-amber-400'}`}
                                title={serverUrl}>
                                <span className={`w-2 h-2 rounded-full ${serverState === null ? 'bg-gray-600' : serverState.ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                                {serverState === null ? 'Server…' : serverState.ok ? 'Server up' : 'Server down'}
                            </span>
                        ) : (
                            <span className={`text-xs flex items-center gap-1.5 ${bridgeOk === null ? 'text-gray-400' : bridgeOk ? 'text-emerald-400' : 'text-amber-400'}`}
                                title={bridgeOk === false ? 'Start it with: node tools/ipl-bridge.mjs' : 'Local bridge reachable'}>
                                <span className={`w-2 h-2 rounded-full ${bridgeOk === null ? 'bg-gray-600' : bridgeOk ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                                {bridgeOk === null ? 'Bridge…' : bridgeOk ? 'Bridge up' : 'Bridge down'}
                            </span>
                        )}
                        <button onClick={onClose} className="p-1 rounded-full hover:bg-gray-700" aria-label="Close"><span className="material-icons">close</span></button>
                    </div>
                </div>

                {/* Share the queue with the shop. Same shape as the library's
                    row on the Designs screen, because it is the same idea. */}
                <div className="flex items-center gap-2 px-5 py-2 border-b border-gray-700 flex-shrink-0">
                    <span className="material-icons text-gray-400 text-base" title="Share the queue with other computers">lan</span>
                    <input
                        value={serverDraft}
                        onChange={e => setServerDraft(e.target.value)}
                        placeholder="Shared print server, e.g. http://192.168.1.10:9183"
                        aria-label="Shared print server"
                        className="flex-1 text-xs p-1.5 bg-gray-900 border border-gray-600 rounded-md outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                    <button onClick={() => void applyServer()} className="px-3 py-1.5 text-xs rounded-md bg-gray-700 hover:bg-gray-600 text-white">
                        {serverDraft.trim() === '' ? 'Keep local' : 'Use server'}
                    </button>
                    {sharing && <span className="text-[11px] text-blue-300 whitespace-nowrap">shared</span>}
                </div>
                {sharing && serverState && (
                    <p className={`px-5 py-1 text-[11px] flex-shrink-0 ${serverState.ok ? 'text-emerald-400' : 'text-amber-400'}`}>{serverState.text}</p>
                )}

                <div className="flex bg-gray-900/50 flex-shrink-0">
                    {(['sheet', 'jobs', 'log'] as const).map(name => (
                        <button key={name} onClick={() => setTab(name)}
                            className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider ${tab === name ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-700/50'}`}>
                            {name === 'sheet' ? 'Sheet' : name === 'jobs' ? `Jobs${jobs.filter(j => j.status === 'queued' || j.status === 'failed').length ? ` (${jobs.filter(j => j.status === 'queued' || j.status === 'failed').length})` : ''}` : 'Log'}
                        </button>
                    ))}
                </div>

                {tab === 'sheet' && (
                    <div className="flex-1 min-h-0 flex">
                        <div className="flex-1 min-h-0 p-4">
                            <SheetPreview design={design} from={fromN} to={toN} revision={revision} />
                        </div>
                        <div className="w-72 border-l border-gray-700 p-4 overflow-y-auto flex-shrink-0">
                            <h3 className="text-xs font-bold uppercase text-gray-500 mb-2">Job</h3>
                            <div className="grid grid-cols-2 gap-2 mb-3">
                                <label className="text-[11px] text-gray-400">From record
                                    <input value={from} onChange={e => setFrom(e.target.value)} className={inputClasses} inputMode="numeric" aria-label="First record" disabled={!hasRecords} />
                                </label>
                                <label className="text-[11px] text-gray-400">To record
                                    <input value={to} onChange={e => setTo(e.target.value)} className={inputClasses} inputMode="numeric" aria-label="Last record" disabled={!hasRecords} />
                                </label>
                                <label className="text-[11px] text-gray-400">Copies
                                    <input value={copies} onChange={e => setCopies(e.target.value)} className={inputClasses} inputMode="numeric" aria-label="Copies" />
                                </label>
                                <label className="text-[11px] text-gray-400">Collation
                                    {/* Meaningless without records: a single-record
                                        design prints its copies inside one stream
                                        (<RS>n), where there is no order to choose. */}
                                    <select value={collation} onChange={e => setCollation(e.target.value as 'collated' | 'uncollated')}
                                        className={inputClasses} disabled={!hasRecords}
                                        title={hasRecords ? 'Collated: 1,2,3,1,2,3. Uncollated: 1,1,2,2,3,3.' : 'A design without a data table prints its copies inside one stream, so there is no order to choose.'}>
                                        <option value="collated">Collated</option>
                                        <option value="uncollated">Uncollated</option>
                                    </select>
                                </label>
                            </div>
                            {!hasRecords && (
                                <p className="text-[11px] text-gray-500 mb-3">
                                    This design has no data table, so it prints one label. Copies are sent as a printer count, and the collation choice does not apply.
                                </p>
                            )}

                            <h3 className="text-xs font-bold uppercase text-gray-500 mb-2 mt-4">Printer</h3>
                            <select value={targetId} onChange={e => setTargetId(e.target.value)} className={inputClasses} aria-label="Printer target">
                                {targets.length === 0 && <option value="">No printers saved</option>}
                                {targets.map(t => <option key={t.id} value={t.id}>{t.name} — {t.host}:{t.port} ({t.language.toUpperCase()}, {t.dpi} dpi)</option>)}
                            </select>
                            <PrinterTargetEditor onChanged={refresh} targets={targets} />

                            <div className="mt-4 rounded-md border border-gray-700 bg-gray-900/60 p-2 text-[11px] space-y-1">
                                <div className="flex justify-between"><span className="text-gray-400">Labels</span><span className="tabular-nums">{labels}</span></div>
                                <div className="flex justify-between"><span className="text-gray-400">Chunks</span><span className="tabular-nums">{chunks}</span></div>
                                {hasRecords && (
                                    <div className="text-gray-500">
                                        {collation === 'collated'
                                            ? `Records ${fromN}–${toN} repeated ${copiesN}× in order.`
                                            : `Each of records ${fromN}–${toN} printed ${copiesN}× together.`}
                                    </div>
                                )}
                                {hasRecords && copiesN > 1 && design.dataSources.some(s => s.type === 'counter' && s.serial) && (
                                    <div className="text-amber-400">
                                        A serial counter in this design is driven by the printer, so every copy of a record prints the same number.
                                    </div>
                                )}
                            </div>

                            {refusal && <p className="mt-3 text-xs text-red-400">{refusal}</p>}
                            {warnings.map(w => <p key={w} className="mt-2 text-[11px] text-amber-400">{w}</p>)}

                            <button onClick={startJob} disabled={!!refusal || busy || !target}
                                className="mt-4 w-full px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed font-semibold text-sm flex items-center justify-center gap-1.5">
                                <span className="material-icons text-base">queue</span>Queue job
                            </button>
                            <button onClick={() => setRevision(r => r + 1)} className="mt-2 w-full px-3 py-1.5 rounded-md bg-gray-700 hover:bg-gray-600 text-xs">
                                Refresh preview
                            </button>
                        </div>
                    </div>
                )}

                {tab === 'jobs' && (
                    <div className="flex-1 min-h-0 overflow-y-auto p-4">
                        {jobs.length === 0 && <p className="text-sm text-gray-400">No print jobs yet. Queue one from the Sheet tab.</p>}
                        <div className="space-y-2">
                            {jobs.map(job => (
                                <div key={job.id} className="rounded-md border border-gray-700 bg-gray-900/60 p-3">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${STATUS_STYLE[job.status]}`}>{job.status}</span>
                                        <span className="font-semibold text-sm truncate">{job.designName}</span>
                                        <span className="text-xs text-gray-400">
                                            {job.labels} label{job.labels === 1 ? '' : 's'} · {job.sentChunks}/{job.chunkCount} chunks
                                        </span>
                                        <span className="ml-auto text-[11px] text-gray-500">{formatWhen(job.createdAt)}</span>
                                    </div>
                                    <div className="text-[11px] text-gray-400">
                                        {designHasRecords(job.design)
                                            ? `records ${job.recordFrom}–${job.recordTo}, ${job.copies}×, ${job.collation}`
                                            : `${job.copies} cop${job.copies === 1 ? 'y' : 'ies'} of one label`}
                                        {' · '}→ {job.target.name} ({job.target.host}:{job.target.port})
                                    </div>
                                    {job.lastError && <div className="text-[11px] text-red-400 mt-1">{job.lastError}</div>}
                                    <div className="flex items-center gap-2 mt-2">
                                        {/* A job 'sending' right now is either this tab or another
                                            station. Only a run that has gone SILENT is sendable — an
                                            unconditional enable would let two stations push the same
                                            chunks at the same printer. */}
                                        <button onClick={() => void send(job)} disabled={busy || job.status === 'sent' || (job.status === 'sending' && !isRunStale(job))}
                                            title={job.status === 'sending' && !isRunStale(job) ? 'This job is being sent right now. It can be sent again if the run goes quiet.' : undefined}
                                            className="text-xs px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed">
                                            {job.status === 'failed' ? 'Retry' : job.sentChunks > 0 ? 'Resume' : 'Send'}
                                        </button>
                                        <button onClick={() => void cancelPrintJob(job.id).then(refresh)}
                                            disabled={job.status === 'sent' || job.status === 'cancelled'}
                                            className="text-xs px-2.5 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed">Cancel</button>
                                        <button onClick={() => void removePrintJob(job.id).then(refresh)}
                                            className="text-xs px-2.5 py-1 rounded bg-gray-700 hover:bg-red-800 ml-auto">Delete</button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {jobs.some(j => j.status === 'sent') && (
                            <button onClick={() => void prunePrintJobs().then(refresh)} className="mt-3 text-[11px] text-gray-500 hover:text-gray-300 underline">
                                Clear finished jobs (the log keeps the record)
                            </button>
                        )}
                    </div>
                )}

                {tab === 'log' && (
                    <div className="flex-1 min-h-0 overflow-y-auto p-4">
                        {log.length === 0 && <p className="text-sm text-gray-400">Nothing sent yet.</p>}
                        {log.length > 0 && (
                            <table className="w-full text-[11px]">
                                <thead className="text-gray-500 text-left sticky top-0 bg-gray-800">
                                    <tr>
                                        <th className="py-1 pr-2 font-semibold">When</th>
                                        <th className="py-1 pr-2 font-semibold">Design</th>
                                        <th className="py-1 pr-2 font-semibold">Printer</th>
                                        <th className="py-1 pr-2 font-semibold">Chunk</th>
                                        <th className="py-1 pr-2 font-semibold">Labels</th>
                                        <th className="py-1 pr-2 font-semibold">Bytes</th>
                                        <th className="py-1 pr-2 font-semibold">Stream hash</th>
                                        <th className="py-1 font-semibold">Result</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {log.map(entry => (
                                        <tr key={entry.id} className="border-t border-gray-700/60">
                                            <td className="py-1 pr-2 text-gray-400 whitespace-nowrap">{formatWhen(entry.at)}</td>
                                            <td className="py-1 pr-2 truncate max-w-[10rem]" title={entry.designName}>{entry.designName}</td>
                                            <td className="py-1 pr-2 whitespace-nowrap" title={`${entry.host}:${entry.port}`}>{entry.targetName}</td>
                                            <td className="py-1 pr-2 tabular-nums">{entry.chunkIndex + 1}/{entry.chunkCount}</td>
                                            <td className="py-1 pr-2 tabular-nums">{entry.labels}</td>
                                            <td className="py-1 pr-2 tabular-nums">{formatBytes(entry.bytes)}</td>
                                            <td className="py-1 pr-2 font-mono text-gray-400" title="FNV-1a of the exact bytes sent">{entry.streamHash}</td>
                                            <td className={`py-1 ${entry.ok ? 'text-emerald-400' : 'text-red-400'}`} title={entry.error}>
                                                {entry.ok ? 'sent' : (entry.error ?? 'failed')}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

/** Add/edit/remove saved printers. Kept inline: it is three fields and a list. */
const PrinterTargetEditor: React.FC<{ targets: PrintTarget[]; onChanged: () => Promise<void> }> = ({ targets, onChanged }) => {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<{ id?: string; name: string; host: string; port: string; language: PrinterLanguage; dpi: 203 | 300 | 406 }>(
        { name: '', host: '', port: '9100', language: 'ipl', dpi: 203 },
    );
    const [error, setError] = useState<string | null>(null);

    const commit = async () => {
        const checked = validateTarget(draft);
        if (checked.target === null) { setError(checked.error); return; }
        try {
            await savePrintTarget({ ...draft, ...checked.target });
            setError(null);
            setOpen(false);
            setDraft({ name: '', host: '', port: '9100', language: 'ipl', dpi: 203 });
            await onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    return (
        <div className="mt-2">
            <button onClick={() => setOpen(o => !o)} className="text-[11px] text-gray-400 hover:text-gray-200 underline">
                {open ? 'Hide printer setup' : 'Add or edit printers'}
            </button>
            {open && (
                <div className="mt-2 rounded-md border border-gray-700 bg-gray-900/60 p-2 space-y-1.5">
                    <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Name (e.g. Line 1 front)" className={inputClasses} aria-label="Printer name" />
                    <div className="flex gap-1.5">
                        <input value={draft.host} onChange={e => setDraft({ ...draft, host: e.target.value })} placeholder="host" className={inputClasses} aria-label="Printer host" />
                        <input value={draft.port} onChange={e => setDraft({ ...draft, port: e.target.value })} placeholder="9100" inputMode="numeric" className={`${inputClasses} w-20`} aria-label="Printer port" />
                    </div>
                    <div className="flex gap-1.5">
                        <select value={draft.language} onChange={e => setDraft({ ...draft, language: e.target.value as PrinterLanguage })} className={inputClasses} aria-label="Printer language">
                            <option value="ipl">IPL</option>
                            <option value="zpl">ZPL</option>
                            <option value="epl">EPL</option>
                        </select>
                        <select value={String(draft.dpi)} onChange={e => setDraft({ ...draft, dpi: parseInt(e.target.value) as 203 | 300 | 406 })} className={inputClasses} aria-label="Printer dpi">
                            {[203, 300, 406].map(d => <option key={d} value={d}>{d} dpi</option>)}
                        </select>
                    </div>
                    {error && <p className="text-[11px] text-red-400">{error}</p>}
                    <div className="flex gap-1.5">
                        <button onClick={() => void commit()} className="flex-1 text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500">
                            {draft.id ? 'Save printer' : 'Add printer'}
                        </button>
                        {draft.id && (
                            <button onClick={() => { setDraft({ name: '', host: '', port: '9100', language: 'ipl', dpi: 203 }); setError(null); }}
                                className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600">New</button>
                        )}
                    </div>
                    {targets.length > 0 && (
                        <div className="pt-1 border-t border-gray-700 space-y-1">
                            {targets.map(t => (
                                <div key={t.id} className="flex items-center gap-1 text-[11px]">
                                    <button onClick={() => { setDraft({ id: t.id, name: t.name, host: t.host, port: t.port, language: t.language, dpi: t.dpi }); setError(null); }}
                                        className="truncate text-left flex-1 hover:text-blue-300" title="Edit this printer">
                                        {t.name} <span className="text-gray-500">{t.host}:{t.port}</span>
                                    </button>
                                    <button onClick={() => void deletePrintTarget(t.id).then(onChanged)} className="text-gray-500 hover:text-red-400" title="Remove this printer">
                                        <span className="material-icons text-sm">delete</span>
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <p className="text-[10px] text-gray-500">
                        Models: {Object.keys(PRINTER_MODELS).join(', ')} — DPI is a property of the machine, so it is set here rather than in the design.
                    </p>
                </div>
            )}
        </div>
    );
};
