import React, { useState, useEffect, useRef } from 'react';

export const CodePanel: React.FC<{ iplCode: string }> = ({ iplCode }) => {
    const [copyText, setCopyText] = useState('Copy');
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    
    useEffect(() => { if (textareaRef.current) { textareaRef.current.style.height = 'auto'; textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`; } }, [iplCode]);

    const handleCopy = () => { navigator.clipboard.writeText(iplCode).then(() => { setCopyText('Copied!'); setTimeout(() => setCopyText('Copy'), 2000); }); };
    const handleDownload = () => {
        const blob = new Blob([iplCode], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'label.ipl.txt';
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    };
    return (
        <div className="flex flex-col h-full">
            <div className="flex justify-end gap-2 mb-2 flex-shrink-0">
                 <button onClick={handleCopy} title="Copy IPL code to clipboard" className="flex items-center gap-1.5 text-xs px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded-md transition-colors w-20 justify-center"><span className="material-icons text-sm">content_copy</span>{copyText}</button>
                 <button onClick={handleDownload} title="Download IPL code as a .txt file" className="flex items-center gap-1.5 text-xs px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded-md transition-colors"><span className="material-icons text-sm">download</span>Download</button>
            </div>
            <textarea ref={textareaRef} readOnly value={iplCode} className="w-full flex-grow p-2 font-mono text-xs bg-gray-900 text-green-400 rounded-md border border-gray-700 focus:ring-blue-500 focus:border-blue-500 resize-none"></textarea>
        </div>
    );
};