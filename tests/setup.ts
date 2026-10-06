import { vi } from 'vitest';

// happy-dom does not implement the canvas 2D context. geometry.ts and
// iplGenerator.ts use an offscreen canvas only for text metrics and
// rasterization, so a lightweight stub is sufficient for unit tests.
const ctx2dStub = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    measureText: (text: string) => ({ width: String(text).length * 10 }),
    createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4), width: w, height: h,
    }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: () => undefined,
    drawImage: () => undefined,
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => null,
    fillText: () => undefined,
    strokeText: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    clearRect: () => undefined,
    beginPath: () => undefined,
    rect: () => undefined,
    roundRect: () => undefined,
    arc: () => undefined,
    ellipse: () => undefined,
    stroke: () => undefined,
    fill: () => undefined,
    clip: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    quadraticCurveTo: () => undefined,
    bezierCurveTo: () => undefined,
    closePath: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    scale: () => undefined,
    setTransform: () => undefined,
    transform: () => undefined,
    resetTransform: () => undefined,
    setLineDash: () => undefined,
    getLineDash: () => [] as number[],
} as unknown as CanvasRenderingContext2D;

if (typeof HTMLCanvasElement !== 'undefined') {
    // drawElements reads ctx.canvas.width/height, so the stub carries a fake
    // element back-reference (added for the App-mount E2E; unit suites that
    // never paint are unaffected).
    (ctx2dStub as unknown as { canvas: { width: number; height: number } }).canvas = { width: 800, height: 600 };
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(ctx2dStub);
}
