import React, { useRef, useEffect, useCallback } from 'react';
import type { WorkspaceState } from '../types';
import { PREVIEW_SCALE } from '../constants';

interface RulersProps {
    workspaceState: WorkspaceState;
    rulerSize: number;
    onGuideDragStart: (orientation: 'horizontal' | 'vertical', e: React.MouseEvent<HTMLDivElement>) => void;
}

export const Rulers: React.FC<RulersProps> = ({ workspaceState, rulerSize, onGuideDragStart }) => {
    const hRulerRef = useRef<HTMLCanvasElement>(null);
    const vRulerRef = useRef<HTMLCanvasElement>(null);

    const drawRulers = useCallback(() => {
        const hRuler = hRulerRef.current;
        const vRuler = vRulerRef.current;
        if (!hRuler || !vRuler) return;

        const hCtx = hRuler.getContext('2d')!;
        const vCtx = vRuler.getContext('2d')!;
        const { zoom, pan } = workspaceState;

        hRuler.width = hRuler.parentElement!.clientWidth;
        hRuler.height = rulerSize;
        vRuler.width = rulerSize;
        vRuler.height = vRuler.parentElement!.clientHeight;

        hCtx.clearRect(0, 0, hRuler.width, hRuler.height);
        vCtx.clearRect(0, 0, vRuler.width, vRuler.height);

        hCtx.fillStyle = '#1f2937'; // gray-800
        vCtx.fillStyle = '#1f2937'; // gray-800
        hCtx.fillRect(0, 0, hRuler.width, hRuler.height);
        vCtx.fillRect(0, 0, vRuler.width, vRuler.height);

        hCtx.font = '10px Inter, sans-serif';
        hCtx.fillStyle = '#9ca3af'; // gray-400
        vCtx.font = '10px Inter, sans-serif';
        vCtx.fillStyle = '#9ca3af'; // gray-400
        vCtx.textAlign = 'center';
        
        const mmPerPixel = 1 / (PREVIEW_SCALE * zoom);
        
        // --- Calculate Tick Intervals ---
        const minTickSpacingPx = 50; // Try to keep major ticks at least 50px apart
        const majorTickIntervalsMm = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
        // At small zoom NO preset interval clears the spacing target; the old
        // code then fell back to the SMALLEST (0.1mm) → a million-step loop and
        // a frozen tab. Default to the largest and keep doubling past it.
        let majorTickMm = majorTickIntervalsMm[majorTickIntervalsMm.length - 1];
        for (const interval of majorTickIntervalsMm) {
            if (interval / mmPerPixel > minTickSpacingPx) {
                majorTickMm = interval;
                break;
            }
        }
        while (majorTickMm / mmPerPixel <= minTickSpacingPx) majorTickMm *= 2;
        const minorTickMm = majorTickMm / 5;

        // --- Draw Horizontal Ruler ---
        const startX_mm = (-pan.x - rulerSize) * mmPerPixel;
        const endX_mm = (hRuler.width - pan.x) * mmPerPixel;
        const firstMajorTickX = Math.ceil(startX_mm / majorTickMm) * majorTickMm;
        
        for (let mm = firstMajorTickX; mm < endX_mm; mm += minorTickMm) {
            const x = mm / mmPerPixel + pan.x + rulerSize;
            if (x < rulerSize) continue;
            const isMajor = Math.abs(mm % majorTickMm) < 0.001;
            const tickHeight = isMajor ? 10 : 5;
            
            hCtx.beginPath();
            hCtx.moveTo(x, rulerSize);
            hCtx.lineTo(x, rulerSize - tickHeight);
            hCtx.strokeStyle = '#9ca3af';
            hCtx.stroke();

            if (isMajor) {
                hCtx.fillText(String(Math.round(mm)), x + 2, 12);
            }
        }

        // --- Draw Vertical Ruler ---
        const startY_mm = (-pan.y - rulerSize) * mmPerPixel;
        const endY_mm = (vRuler.height - pan.y) * mmPerPixel;
        const firstMajorTickY = Math.ceil(startY_mm / majorTickMm) * majorTickMm;

        for (let mm = firstMajorTickY; mm < endY_mm; mm += minorTickMm) {
             const y = mm / mmPerPixel + pan.y + rulerSize;
             if (y < rulerSize) continue;
             const isMajor = Math.abs(mm % majorTickMm) < 0.001;
             const tickWidth = isMajor ? 10 : 5;

             vCtx.beginPath();
             vCtx.moveTo(rulerSize, y);
             vCtx.lineTo(rulerSize - tickWidth, y);
             vCtx.strokeStyle = '#9ca3af';
             vCtx.stroke();

             if (isMajor) {
                vCtx.save();
                vCtx.translate(12, y - 2);
                vCtx.rotate(-Math.PI / 2);
                vCtx.fillText(String(Math.round(mm)), 0, 0);
                vCtx.restore();
             }
        }

    }, [workspaceState, rulerSize]);

    useEffect(() => {
        drawRulers();
        const observer = new ResizeObserver(drawRulers);
        const hParent = hRulerRef.current?.parentElement;
        const vParent = vRulerRef.current?.parentElement;
        if (hParent) observer.observe(hParent);
        if (vParent) observer.observe(vParent);
        return () => observer.disconnect();
    }, [drawRulers]);

    return (
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none">
            {/* Horizontal Ruler */}
            <div
                className="absolute top-0 left-0 w-full"
                style={{ height: rulerSize }}
                onMouseDown={(e) => onGuideDragStart('horizontal', e)}
            >
                <canvas ref={hRulerRef} className="w-full h-full pointer-events-auto cursor-ns-resize" />
            </div>
            {/* Vertical Ruler */}
            <div
                className="absolute top-0 left-0 h-full"
                style={{ width: rulerSize }}
                onMouseDown={(e) => onGuideDragStart('vertical', e)}
            >
                 <canvas ref={vRulerRef} className="w-full h-full pointer-events-auto cursor-ew-resize" />
            </div>
            {/* Corner Box */}
            <div
                className="absolute top-0 left-0 bg-gray-800 border-r border-b border-gray-700"
                style={{ width: rulerSize, height: rulerSize }}
            />
        </div>
    );
};