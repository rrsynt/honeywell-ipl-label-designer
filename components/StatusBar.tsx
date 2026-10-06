import React from 'react';
import type { Design } from '../types';
import { DPI_MAP } from '../constants';

/** Bottom status bar, BarTender-style: size, cursor, zoom, printer — always
 *  visible so the operator never has to hunt the property panel for them. The
 *  floating canvas read-out stays; this bar is the persistent copy. */
export const StatusBar: React.FC<{
    design: Design;
    zoom: number;
    mouseCoords: { x: number; y: number } | null;
    dirty: boolean;
}> = ({ design, zoom, mouseCoords, dirty }) => {
    const { width, height, orientation, columns, rows } = design.labelSettings;
    const { model, dpi } = design.printerSettings;
    const dotsPerMm = DPI_MAP[dpi] ?? 8;
    const mm = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    return (
        <footer className="flex items-center gap-4 px-3 h-7 text-xs bg-gray-800 border-t border-gray-700 text-gray-300 flex-shrink-0 overflow-x-auto whitespace-nowrap"
            aria-label="Label status">
            <span title="Stock size in millimetres">
                {mm(width)} × {mm(height)} mm · {orientation}
                {(columns > 1 || rows > 1) && ` · ${columns}×${rows}`}
            </span>
            <span className="text-gray-500" title="Stock size in printer dots">
                {Math.round(width * dotsPerMm)} × {Math.round(height * dotsPerMm)} dots @ {dpi} dpi
            </span>
            <span className="tabular-nums" title="Cursor position on the label">
                {mouseCoords ? `X: ${mouseCoords.x.toFixed(1)}  Y: ${mouseCoords.y.toFixed(1)} mm` : 'X: —  Y: —'}
            </span>
            <span title="Canvas zoom">{Math.round(zoom * 100)}%</span>
            <span title="Target printer">{model}</span>
            <span title="Objects on the canvas">{design.fields.length} object{design.fields.length === 1 ? '' : 's'}</span>
            <span className="flex-1" />
            <span className={dirty ? 'text-amber-400' : 'text-gray-500'}
                title={dirty ? 'Unsaved changes' : 'All changes saved'}>
                {dirty ? '● Unsaved' : 'Saved'}
            </span>
        </footer>
    );
};
