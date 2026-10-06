import React, { useState } from 'react';
import { getServerToken, setServerToken, type ServerKind } from '../services/serverTokens';

/** Token field for the three server-address rows (print, library, database).
 *  Shown always but compact: empty = the server runs without --token (the
 *  single-station default), filled = sent as `Authorization: Bearer` on every
 *  request that row's backend makes. Stored in localStorage, never logged. */
export const ServerTokenInput: React.FC<{ kind: ServerKind; compact?: boolean }> = ({ kind, compact = false }) => {
    const [token, setToken] = useState(() => getServerToken(kind));
    const [saved, setSaved] = useState(() => getServerToken(kind) !== '');
    const [show, setShow] = useState(false);
    return (
        <span className={`inline-flex items-center gap-1 ${compact ? '' : 'ml-1'}`} title="Token the server was started with (--token). Leave empty when the server runs without one.">
            <input
                type={show ? 'text' : 'password'}
                value={token}
                // Persist while typing (like LabelSettingsEditor), not only on
                // blur: programmatic/autofill edits can bypass React's change
                // tracking, and a token that looks typed but was never stored
                // fails every request with a 401 the user cannot explain.
                onChange={e => { const v = e.target.value; setToken(v); setServerToken(kind, v); setSaved(v.trim() !== ''); }}
                onBlur={e => { const v = e.target.value; setToken(v); setServerToken(kind, v); setSaved(v.trim() !== ''); }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                placeholder="Token (if set)"
                aria-label="Server token"
                autoComplete="off"
                className={`${compact ? 'w-28 text-[11px]' : 'w-32 text-xs'} p-1.5 bg-gray-900 border border-gray-600 rounded-md outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500`}
            />
            <button type="button" onClick={() => setShow(s => !s)}
                className="p-1 rounded hover:bg-gray-700 text-gray-400" title={show ? 'Hide token' : 'Show token'}
                aria-label={show ? 'Hide token' : 'Show token'}>
                <span className="material-icons text-sm leading-none">{show ? 'visibility_off' : 'visibility'}</span>
            </button>
            {saved && <span className="text-[10px] text-emerald-400" title="A token is stored for this server">●</span>}
        </span>
    );
};
