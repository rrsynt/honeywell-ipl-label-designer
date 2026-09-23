

import React, { useState } from 'react';
import type { Field, Design } from '../types';

const LayerButton: React.FC<{ icon: string; onClick: (e: React.MouseEvent) => void; tooltip: string; }> = ({ icon, onClick, tooltip }) => (
    <button onClick={onClick} title={tooltip} className="p-1 rounded-full hover:bg-gray-600">
        <span className="material-icons text-base">{icon}</span>
    </button>
);

export const LeftPanel: React.FC<{ activeDesign: Design; selectedFieldIds: number[]; dispatch: React.Dispatch<any> }> = ({ activeDesign, selectedFieldIds, dispatch }) => {
  
  const [dragState, setDragState] = useState<{
    draggedId: number | null;
    overId: number | null;
    dropPosition: 'top' | 'bottom' | null;
  }>({ draggedId: null, overId: null, dropPosition: null });

  const handleDragStart = (e: React.DragEvent, id: number) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ type: 'layer-drag', id }));
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => {
      setDragState(prev => ({ ...prev, draggedId: id }));
    }, 0);
  };

  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    if (dragState.draggedId === null || dragState.draggedId === id) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const position = e.clientY > rect.top + rect.height / 2 ? 'bottom' : 'top';
    if (id !== dragState.overId || position !== dragState.dropPosition) {
      setDragState(prev => ({ ...prev, overId: id, dropPosition: position }));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragState.overId || !dragState.draggedId) return;
    
    try {
        const data = JSON.parse(e.dataTransfer.getData('application/json'));
        if (data.type !== 'layer-drag') return;
        const draggedId = data.id;

        dispatch({
            type: 'REORDER_LAYER',
            payload: { draggedId, targetId: dragState.overId, position: dragState.dropPosition }
        });
    } catch(e) {
        console.error("Error parsing drop data:", e);
    } finally {
        setDragState({ draggedId: null, overId: null, dropPosition: null });
    }
  };

  const handleDragEnd = () => {
    setDragState({ draggedId: null, overId: null, dropPosition: null });
  };
  
  const handleContainerDragLeave = (e: React.DragEvent) => {
      const listElement = e.currentTarget;
      // Check if the relatedTarget (where the mouse is going) is outside the list container
      if (!listElement.contains(e.relatedTarget as Node)) {
          setDragState(prev => ({ ...prev, overId: null, dropPosition: null }));
      }
  };


  const ToolbarButton: React.FC<{ icon: string; label: string; onClick: () => void; colorClass: string, title: string; }> = ({ icon, label, onClick, colorClass, title }) => (
    <button onClick={onClick} title={title} className={`flex flex-col items-center justify-center p-2 rounded-lg transition-colors duration-200 w-full bg-gray-900 hover:bg-gray-700`}>
      <span className={`material-icons text-3xl ${colorClass}`}>{icon}</span>
      <span className="text-xs font-semibold mt-1 text-gray-300">{label}</span>
    </button>
  );

  return (
    <aside className="w-60 bg-gray-800 border-r border-gray-700 flex flex-col flex-shrink-0">
      <div className="p-3 border-b border-gray-700">
        <h3 className="text-xs font-bold uppercase text-gray-500 mb-3 px-1">Toolbar</h3>
        <div className="grid grid-cols-2 gap-2">
          <ToolbarButton icon="title" label="Text" title="Add Text Field" onClick={() => dispatch({ type: 'ADD_FIELD', payload: { type: 'text' } })} colorClass="text-blue-400" />
          <ToolbarButton icon="qr_code_2" label="Barcode" title="Add Barcode Field" onClick={() => dispatch({ type: 'ADD_FIELD', payload: { type: 'barcode' } })} colorClass="text-green-400" />
          <ToolbarButton icon="check_box_outline_blank" label="Box" title="Add Box" onClick={() => dispatch({ type: 'ADD_FIELD', payload: { type: 'box' } })} colorClass="text-red-400" />
          <ToolbarButton icon="horizontal_rule" label="Line" title="Add Line" onClick={() => dispatch({ type: 'ADD_FIELD', payload: { type: 'line' } })} colorClass="text-yellow-400" />
          <ToolbarButton icon="image" label="Image" title="Add Image (pick a file in Properties)" onClick={() => dispatch({ type: 'ADD_FIELD', payload: { type: 'image' } })} colorClass="text-purple-400" />
        </div>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <h3 className="text-xs font-bold uppercase text-gray-500 px-4 py-2">Layers</h3>
        <div className="flex-1 overflow-y-auto px-2 space-y-1" onDragLeave={handleContainerDragLeave}>
          {activeDesign.fields.length === 0 && <p className="text-xs text-center text-gray-500 py-4">No layers yet.</p>}
          {(() => {
          // Stable human ordinal per group (Batch O): groups numbered by their
          // lowest member id, so every member of one group shows the same "G2"
          // chip and the numbering survives edits that don't reorder ids.
          const groupOrdinals = new Map<number, number>();
          [...activeDesign.fields]
            .filter(f => f.groupId !== undefined)
            .sort((a, b) => a.id - b.id)
            .forEach(f => { if (!groupOrdinals.has(f.groupId as number)) groupOrdinals.set(f.groupId as number, groupOrdinals.size + 1); });
          return [...activeDesign.fields].reverse().map(field => {
            const isDragged = dragState.draggedId === field.id;
            const isOver = dragState.overId === field.id;

            return (
              <div
                key={field.id}
                draggable={!field.locked}
                onDragStart={!field.locked ? (e) => handleDragStart(e, field.id) : undefined}
                onDragOver={!field.locked ? (e) => handleDragOver(e, field.id) : undefined}
                onDrop={!field.locked ? handleDrop : undefined}
                onDragEnd={handleDragEnd}
                className={`relative group flex items-center justify-between p-2 rounded-md transition-colors 
                  ${selectedFieldIds.includes(field.id) ? 'bg-blue-600/30' : 'hover:bg-gray-700'}
                  ${field.locked ? 'cursor-not-allowed' : 'cursor-pointer'}
                  ${field.visible === false ? 'opacity-50' : ''}
                  ${isDragged ? 'opacity-20' : ''}
                `}
              >
                {isOver && !isDragged && dragState.dropPosition === 'top' && <div className="absolute top-0 left-1 right-1 h-0.5 bg-blue-400 rounded-full z-10" />}
                {isOver && !isDragged && dragState.dropPosition === 'bottom' && <div className="absolute bottom-0 left-1 right-1 h-0.5 bg-blue-400 rounded-full z-10" />}
                
                <div onClick={(e) => { if (!field.locked) dispatch({ type: 'SELECT_FIELD', payload: { id: field.id, shiftKey: e.shiftKey } }) }} title={field.groupId !== undefined ? `Select layer: ${field.name} (in group G${groupOrdinals.get(field.groupId)}) — selects the whole group` : `Select layer: ${field.name}`} className="flex items-center gap-1.5 flex-1 min-w-0">
                  {field.groupId !== undefined && <span className="text-[10px] font-bold px-1 py-px rounded bg-indigo-500/30 text-indigo-300 flex-shrink-0" title={`Part of group G${groupOrdinals.get(field.groupId)}`}>G{groupOrdinals.get(field.groupId)}</span>}
                  <span className="text-sm truncate">{field.name}</span>
                </div>
                <div className="flex items-center opacity-100 md:opacity-0 group-hover:opacity-100 transition-opacity">
                   <LayerButton 
                        icon={field.visible === false ? 'visibility_off' : 'visibility'} 
                        onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_FIELD_VISIBILITY', payload: { id: field.id } })}}
                        tooltip={field.visible === false ? 'Show Layer' : 'Hide Layer'}
                    />
                    <LayerButton 
                        icon={field.locked ? 'lock' : 'lock_open'} 
                        onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_FIELD_LOCK', payload: { id: field.id } })}}
                        tooltip={field.locked ? 'Unlock Layer' : 'Lock Layer'}
                    />
                </div>
              </div>
            );
          });
          })()}
        </div>
      </div>
    </aside>
  );
};
