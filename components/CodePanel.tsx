import React, { useState, useEffect, useRef } from 'react';
import type { FontSubstitution } from '../services/iplGenerator';

export const CodePanel: React.FC<{ iplCode: string; fontWarnings?: FontSubstitution[]; suppressionWarnings?: string[]; zplWarnings?: string[] }> = ({ iplCode, fontWarnings = [], suppressionWarnings = [], zplWarnings = [] }) => {
    const [copyText, setCopyText] = useState('Copy');
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    
    useEffect(() => { if (textareaRef.current) { textareaRef.current.style.height = 'auto'; textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`; } }, [iplCode]);

    const handleCopy = () => { navigator.clipboard.writeText(iplCode).then(() => { setCopyText('Copied!'); setTimeout(() => setCopyText('Copy'), 2000); }); };
    const handleDownload = () => {
        const blob = new Blob([iplCode], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        // The panel shows whichever language the printer setting asked for, so the
        // file extension has to follow the content. ^XA is ZPL; everything else
        // this panel can produce is IPL.
        const ext = /^\s*\^XA/.test(iplCode) ? 'zpl' : 'ipl';
        const a = document.createElement('a'); a.href = url; a.download = `label.${ext}.txt`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    };
    return (
        <div className="flex flex-col h-full">
            <div className="flex justify-end gap-2 mb-2 flex-shrink-0">
                 <button onClick={handleCopy} title="Copy IPL code to clipboard" className="flex items-center gap-1.5 text-xs px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded-md transition-colors w-20 justify-center"><span className="material-icons text-sm">content_copy</span>{copyText}</button>
                 <button onClick={handleDownload} title="Download IPL code as a .txt file" className="flex items-center gap-1.5 text-xs px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded-md transition-colors"><span className="material-icons text-sm">download</span>Download</button>
            </div>
            {fontWarnings.map(w => (
                <p key={w.font} className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/30 rounded-md px-2 py-1 mb-2">
                    "{w.font}" is not a printer font, so the stream uses the nearest resident face. The printed line runs about {Math.round(w.delta * 100)}% off the width shown on screen.
                </p>
            ))}
            {suppressionWarnings.map(w => (
                <p key={w} className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/30 rounded-md px-2 py-1 mb-2">
                    Suppression ignored — {w} The field prints anyway.
                </p>
            ))}
            {zplWarnings.map(w => (
                <p key={w} className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/30 rounded-md px-2 py-1 mb-2">{w}</p>
            ))}
            <textarea ref={textareaRef} readOnly value={iplCode} className="w-full flex-grow p-2 font-mono text-xs bg-gray-900 text-green-400 rounded-md border border-gray-700 focus:ring-blue-500 focus:border-blue-500 resize-none"></textarea>
        </div>
    );
};