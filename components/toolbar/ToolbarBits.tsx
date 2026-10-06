// Shared bits of the top toolbar (split from TopBar.tsx, layout phase 2).
import React from 'react';

export const btnClasses = "px-3 py-1 text-sm rounded-md text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

export const IconButton: React.FC<{ icon: string; onClick: () => void; disabled?: boolean; tooltip: string; className?: string }> = ({ icon, onClick, disabled = false, tooltip, className = '' }) => (
    <button onClick={onClick} disabled={disabled} title={tooltip} className={`px-2 py-1 text-sm rounded-md hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${className}`}>
         <span className="material-icons text-xl">{icon}</span>
    </button>
);

export const AlignmentButton: React.FC<{ icon: string; onClick: () => void; tooltip: string; disabled?: boolean }> = ({ icon, onClick, tooltip, disabled = false }) => (
    <button onClick={onClick} disabled={disabled} title={tooltip} className="px-1.5 py-0.5 text-sm rounded-md text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
         <span className="material-icons text-lg">{icon}</span>
    </button>
);

export const Divider: React.FC<{ className?: string }> = ({ className = 'h-6 border-l border-gray-600 mx-2' }) => (
    <div className={className}></div>
);
