import React, { useState, useEffect, useRef } from 'react';
import type { Design, PrinterLanguage } from '../../types';
import { PropInput, inputClasses } from './PanelBits';
import { PRINTER_MODELS, UNPRINTABLE_MARGIN_MM } from '../../constants';

export const PrinterSettingsEditor: React.FC<{ settings: Design['printerSettings']; dispatch: React.Dispatch<any>; }> = ({ settings, dispatch }) => {
    
    const [quantity, setQuantity] = useState(settings.quantity.toString());
    // See LabelSettingsEditor: this panel unmounts on a tab switch and React
    // fires no blur then, so quantity has to be committed as it is typed.
    const quantityFocusedRef = useRef(false);

    useEffect(() => {
        if (!quantityFocusedRef.current) setQuantity(settings.quantity.toString());
    }, [settings.quantity]);

    useEffect(() => {
        if (!Object.keys(PRINTER_MODELS).includes(settings.model)) {
            const defaultModel = Object.keys(PRINTER_MODELS)[0] as keyof typeof PRINTER_MODELS;
            const availableDPIs = PRINTER_MODELS[defaultModel];
            const newDpi = availableDPIs.includes(settings.dpi) ? settings.dpi : availableDPIs[0];
            dispatch({ 
                type: 'UPDATE_SETTING', 
                payload: { 
                    settingType: 'printerSettings', 
                    updates: { model: defaultModel, dpi: newDpi } 
                } 
            });
        }
    }, [settings.model, settings.dpi, dispatch]);
    
    const handleUpdate = (updates: Partial<Design['printerSettings']>) => {
        dispatch({ type: 'UPDATE_SETTING', payload: { settingType: 'printerSettings', updates } });
    };

    const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const model = e.target.value;
        const availableDPIs = PRINTER_MODELS[model] ?? PRINTER_MODELS['Generic'];
        const dpi = availableDPIs.includes(settings.dpi) ? settings.dpi : availableDPIs[0];
        handleUpdate({ model, dpi });
    };

    const handleQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        setQuantity(raw);
        const n = parseInt(raw);
        if (raw.trim() === '' || isNaN(n) || n < 1) return;
        if (n !== settings.quantity) handleUpdate({ quantity: n });
    };

    const handleQuantityBlur = () => {
        quantityFocusedRef.current = false;
        let numValue = parseInt(quantity);
        if (isNaN(numValue) || numValue < 1) {
            numValue = settings.quantity || 1;
        }
        setQuantity(numValue.toString());
        if (numValue !== settings.quantity) {
            handleUpdate({ quantity: numValue });
        }
    };
    
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur();
    };


    return (
        <div className="grid grid-cols-2 gap-3">
            <PropInput label="Printer Language" fullWidth>
                <select value={settings.language ?? 'ipl'} aria-label="Printer language"
                    onChange={e => handleUpdate({ language: e.target.value as PrinterLanguage })}
                    className={inputClasses} title="Language the Code panel and the download button emit. The canvas does not change.">
                    <option value="ipl">IPL (Honeywell)</option>
                    <option value="zpl">ZPL (Zebra)</option>
                    <option value="epl">EPL (Eltron/Zebra desktop)</option>
                    <option value="tspl">TSPL (TSC)</option>
                    <option value="dpl">DPL (Datamax/Honeywell)</option>
                </select>
            </PropInput>
            <PropInput label="Printer Model" fullWidth>
                <select value={settings.model} onChange={handleModelChange} className={inputClasses} title="Select target printer model">
                    {Object.keys(PRINTER_MODELS).map(model => <option key={model} value={model}>{model}</option>)}
                </select>
            </PropInput>
            <PropInput label="DPI">
                 <select value={String(settings.dpi)} onChange={e => handleUpdate({ dpi: parseInt(e.target.value) as Design['printerSettings']['dpi'] })} className={inputClasses} title="Printer resolution in Dots Per Inch">
                    {(PRINTER_MODELS[settings.model as keyof typeof PRINTER_MODELS] || []).map(dpi => <option key={dpi} value={String(dpi)}>{dpi}</option>)}
                </select>
            </PropInput>
            <PropInput label="Quantity">
                <input type="number" min="1" value={quantity} onChange={handleQuantityChange} onFocus={() => { quantityFocusedRef.current = true; }} onKeyDown={handleKeyDown} onBlur={handleQuantityBlur} className={inputClasses} title="Number of copies to print"/>
            </PropInput>
            <PropInput label="Media Type" fullWidth>
                <select value={settings.mediaType} onChange={e => handleUpdate({ mediaType: e.target.value as Design['printerSettings']['mediaType'] })} className={inputClasses} title="Type of label media being used">
                    <option value="thermal-transfer">Thermal Transfer (Ribbon)</option>
                    <option value="direct-thermal">Direct Thermal</option>
                </select>
            </PropInput>
            <PropInput label="Media Sensing" fullWidth>
                <select value={settings.mediaSenseMode} onChange={e => handleUpdate({ mediaSenseMode: e.target.value as Design['printerSettings']['mediaSenseMode'] })} className={inputClasses} title="How the printer detects the start of a new label">
                    <option value="gap">Gap (Labels with Gaps)</option>
                    <option value="reflective">Reflective (Black Mark)</option>
                    <option value="continuous">Continuous (No Gaps)</option>
                </select>
            </PropInput>
            <PropInput label="Print Speed">
                 <select value={String(settings.printSpeed)} onChange={e => handleUpdate({ printSpeed: parseInt(e.target.value) })} className={inputClasses} title="Printer speed setting">
                    {[...Array(11).keys()].map(i => <option key={i+1} value={String(i+1)}>{i+1}</option>)}
                </select>
            </PropInput>
            <PropInput label="Darkness (Heat)">
                 <select value={String(settings.darkness)} onChange={e => handleUpdate({ darkness: parseInt(e.target.value) })} className={inputClasses} title="Printer darkness/heat setting">
                    {[...Array(20).keys()].map(i => <option key={i} value={String(i)}>{i}</option>)}
                </select>
            </PropInput>
            <PropInput label="Image Graphics" fullWidth>
                <select value={settings.directGraphics ? 'g1' : 'stored'} onChange={e => handleUpdate({ directGraphics: e.target.value === 'g1' })} className={inputClasses} title="How image fields are written into the IPL stream">
                    <option value="stored">Stored graphic (G/U, compact)</option>
                    <option value="g1">Direct Graphics (ASCII hex, paste-safe)</option>
                </select>
            </PropInput>
            {(UNPRINTABLE_MARGIN_MM[settings.model] ?? 0) > 0 && (
                <p className="col-span-2 text-xs text-orange-300/80" title="From the printer driver's own model table (Stock.UnprintableWidth), not an estimate. It covers the two edges across the print head; the leading and trailing edges are not inset.">
                    Unprintable margin: {UNPRINTABLE_MARGIN_MM[settings.model]} mm per edge — shown as the dashed orange guide on the canvas.
                </p>
            )}
        </div>
    );
};
