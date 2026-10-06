import React, { useState, useEffect, useRef } from 'react';
import type { Design } from '../../types';
import { PropInput, inputClasses, convertFromMm, convertToMm } from './PanelBits';

export const LabelSettingsEditor: React.FC<{ settings: Design['labelSettings']; dispatch: React.Dispatch<any>; }> = ({ settings, dispatch }) => {

    const [width, setWidth] = useState(convertFromMm(settings.width, settings.unit).toFixed(2));
    const [height, setHeight] = useState(convertFromMm(settings.height, settings.unit).toFixed(2));
    const [cols, setCols] = useState((settings.columns || 1).toString());
    const [rows, setRows] = useState((settings.rows || 1).toString());
    // A panel switch unmounts these inputs, and React fires no blur on
    // unmount — so a blur-only commit loses whatever was typed. Track which
    // field has focus so the sync effect below cannot clobber a live edit.
    const focusedRef = useRef<string | null>(null);

    useEffect(() => {
        if (focusedRef.current !== 'width') setWidth(convertFromMm(settings.width, settings.unit).toFixed(2));
        if (focusedRef.current !== 'height') setHeight(convertFromMm(settings.height, settings.unit).toFixed(2));
        if (focusedRef.current !== 'columns') setCols((settings.columns || 1).toString());
        if (focusedRef.current !== 'rows') setRows((settings.rows || 1).toString());
    }, [settings]);

    const markFocused = (id: string) => () => { focusedRef.current = id; };
    const markBlurred = () => { focusedRef.current = null; };

    const handleUpdate = (updates: Partial<Design['labelSettings']>) => {
        dispatch({ type: 'UPDATE_SETTING', payload: { settingType: 'labelSettings', updates } });
    };
    
    const handleUnitChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        handleUpdate({ unit: e.target.value as 'mm' | 'cm' | 'in' });
    };

    const handleDimensionBlur = (
        localValue: string,
        propName: 'width' | 'height'
    ) => {
        let numValue = parseFloat(localValue);
        const fallback = settings[propName];
        if (isNaN(numValue) || numValue < 0.1) {
            numValue = convertFromMm(fallback, settings.unit);
        }

        const valueInMm = convertToMm(numValue, settings.unit);

        if (valueInMm !== settings[propName]) {
            handleUpdate({ [propName]: valueInMm });
        } else {
            if (propName === 'width') setWidth(numValue.toFixed(2));
            if (propName === 'height') setHeight(numValue.toFixed(2));
        }
    };

    // Commit while typing, not on blur: switching tabs unmounts these inputs
    // and React fires no blur then, so a blur-only commit loses the edit. An
    // incomplete entry (empty, or the "1" of "150") is left to blur to
    // normalize, never written to the design mid-keystroke.
    const handleDimensionChange = (e: React.ChangeEvent<HTMLInputElement>, propName: 'width' | 'height') => {
        const raw = e.target.value;
        if (propName === 'width') setWidth(raw); else setHeight(raw);
        const n = parseFloat(raw);
        if (raw.trim() === '' || isNaN(n) || n < 0.1) return;
        const valueInMm = convertToMm(n, settings.unit);
        if (valueInMm !== settings[propName]) handleUpdate({ [propName]: valueInMm });
    };

    const handleOrientationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        handleUpdate({ orientation: e.target.value as 'portrait' | 'landscape' });
    };

    const handleGridBlur = (
        localValue: string,
        propName: 'columns' | 'rows'
    ) => {
         let numValue = parseInt(localValue);
         const fallback = settings[propName] || 1;
         if (isNaN(numValue) || numValue < 1) {
            numValue = fallback;
         }
         if (numValue !== fallback) {
             handleUpdate({ [propName]: numValue });
         } else {
             if (propName === 'columns') setCols(numValue.toString());
             if (propName === 'rows') setRows(numValue.toString());
         }
    };

    const handleGridChange = (e: React.ChangeEvent<HTMLInputElement>, propName: 'columns' | 'rows') => {
        const raw = e.target.value;
        if (propName === 'columns') setCols(raw); else setRows(raw);
        const n = parseInt(raw);
        if (raw.trim() === '' || isNaN(n) || n < 1) return;
        if (n !== (settings[propName] || 1)) handleUpdate({ [propName]: n });
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur();
    };

    return (
        <div className="grid grid-cols-2 gap-3">
            <PropInput label={`Width (${settings.unit})`}><input type="number" min="1" step="0.1" value={width} onChange={e => handleDimensionChange(e, 'width')} onFocus={markFocused('width')} onBlur={() => { markBlurred(); handleDimensionBlur(width, 'width'); }} onKeyDown={handleKeyDown} className={inputClasses} title="Total width of the label stock"/></PropInput>
            <PropInput label={`Height (${settings.unit})`}><input type="number" min="1" step="0.1" value={height} onChange={e => handleDimensionChange(e, 'height')} onFocus={markFocused('height')} onBlur={() => { markBlurred(); handleDimensionBlur(height, 'height'); }} onKeyDown={handleKeyDown} className={inputClasses} title="Total height of the label stock"/></PropInput>
            <PropInput label="Unit" fullWidth>
                <select value={settings.unit} onChange={handleUnitChange} className={inputClasses}>
                    <option value="mm">mm</option>
                    <option value="cm">cm</option>
                    <option value="in">in</option>
                </select>
            </PropInput>
             <PropInput label="Orientation" fullWidth>
                 <select value={settings.orientation} onChange={handleOrientationChange} className={inputClasses}>
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                </select>
            </PropInput>
            <PropInput label="Grid Columns"><input type="number" min="1" value={cols} onChange={e => handleGridChange(e, 'columns')} onFocus={markFocused('columns')} onBlur={() => { markBlurred(); handleGridBlur(cols, 'columns'); }} onKeyDown={handleKeyDown} className={inputClasses} title="Number of labels horizontally across the stock"/></PropInput>
            <PropInput label="Grid Rows"><input type="number" min="1" value={rows} onChange={e => handleGridChange(e, 'rows')} onFocus={markFocused('rows')} onBlur={() => { markBlurred(); handleGridBlur(rows, 'rows'); }} onKeyDown={handleKeyDown} className={inputClasses} title="Number of labels vertically down the stock"/></PropInput>
        </div>
    );
};
