import React from 'react';

export const HelpModal: React.FC<{ onClose: () => void; }> = ({ onClose }) => {
  const Shortcut: React.FC<{ keys: string; description: string }> = ({ keys, description }) => (<div className="flex justify-between items-center py-2 border-b border-gray-700"><span className="text-gray-300">{description}</span><kbd className="px-2 py-1 text-xs font-semibold text-gray-200 bg-gray-600 border border-gray-500 rounded-md">{keys}</kbd></div>);
  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-800 rounded-lg shadow-2xl p-6 w-full max-w-lg mx-4 text-gray-200" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center border-b border-gray-700 pb-3 mb-4"><h2 className="text-2xl font-bold flex items-center gap-2"><span className="material-icons">help_outline</span>Help & Shortcuts</h2><button onClick={onClose} className="p-1 rounded-full hover:bg-gray-700"><span className="material-icons">close</span></button></div>
        <div className="space-y-4">
            <div><h3 className="font-semibold text-lg text-blue-400 mb-2">Workspace</h3><Shortcut keys="Ctrl + Mouse Wheel" description="Zoom In / Out" /><Shortcut keys="Space + Drag" description="Pan Workspace" /><Shortcut keys="Middle Mouse Drag" description="Pan Workspace" /></div>
            <div><h3 className="font-semibold text-lg text-blue-400 mb-2">Object Manipulation</h3><Shortcut keys="Click" description="Select an Object" /><Shortcut keys="Shift + Click" description="Add/Remove from Selection" /><Shortcut keys="Drag Object" description="Move Selection" /><Shortcut keys="Arrow Keys" description="Nudge Selection" /><Shortcut keys="Shift + Arrow Keys" description="Nudge by Larger Increment" /><Shortcut keys="Drag Corner Handle" description="Resize Object" /><Shortcut keys="Drag Top Handle" description="Rotate Object" /><Shortcut keys="Ctrl + Shift + H / V" description="Distribute Horizontally / Vertically" /><Shortcut keys="Ctrl + G" description="Group Selected Objects" /><Shortcut keys="Ctrl + Shift + G" description="Ungroup" /></div>
            <div><h3 className="font-semibold text-lg text-blue-400 mb-2">Editing</h3><Shortcut keys="Ctrl + Z / Y" description="Undo / Redo" /><Shortcut keys="Ctrl + S" description="Save Design" /><Shortcut keys="Ctrl + N" description="New Label" /><Shortcut keys="Ctrl + P" description="Print Center" /><Shortcut keys="Ctrl + C / X / V" description="Copy / Cut / Paste" /><Shortcut keys="Ctrl + D" description="Duplicate" /><Shortcut keys="Ctrl + A" description="Select All" /><Shortcut keys="Delete / Backspace" description="Delete" /><Shortcut keys="Enter (in text edit)" description="Confirm Text Changes" /><Shortcut keys="Escape (in text edit)" description="Cancel Text Changes" /></div>
        </div>
        <div className="mt-6 text-right"><button onClick={onClose} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-colors">Got it!</button></div>
      </div>
    </div>
  );
};
