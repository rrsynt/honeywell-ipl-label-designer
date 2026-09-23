// Batch D (2026-09-21): the designer canvas renders barcodes through the
// SAME encoder as the viewer (services/ipl/barcodes.ts / bwip-js). This
// adapter is the single translation point from the Design model (BarcodeField
// + mm/dot magnitudes + designer-specific code39_checkDigit/code128_subset
// enums) to the encoder's symbology + BarcodeParams domain, including the
// PRM sizing rules the viewer parser applies (POSTNET magnification, Planet/
// MaxiCode fixed size). Replaces the JsBarcode CDN path, which covered only
// 6 linear formats and placeholdered everything else.

import type { BarcodeField } from '../types';
import { applyI2of5Padding, type BarcodeParams } from './ipl/barcodes';

export interface DesignerBarcodeRender {
    symbology: string;
    /** Data as the encoder should receive it (I2of5 odd-length padding applied). */
    data: string;
    params: BarcodeParams;
    /** Effective narrow-module width in dots after PRM sizing rules. */
    moduleDots: number;
    /** Effective bar height in dots after PRM sizing rules. */
    heightDots: number;
    /** true when the symbology ignores h/w (Planet, MaxiCode, POSTNET cells). */
    fixedSize: boolean;
}

/** Designer enums -> the encoder's c-parameter string domain. */
export const designerBarcodeParams = (field: BarcodeField): BarcodeParams => {
    const params: BarcodeParams = {
        ratio: 1, // the designer has no r control yet; encoder default 3:1
        narrowDots: field.w_mag,
    };
    if (field.symbology === '0') {
        if (field.code39_checkDigit === 'printer-generated') params.code39Mode = '1';
        else if (field.code39_checkDigit === 'host-verifies') params.code39Mode = '2';
    }
    if (field.symbology === '6' && field.code128_subset && field.code128_subset !== 'auto') {
        params.code128StartSubset = { a: '1', b: '2', c: '3' }[field.code128_subset];
    }
    if (field.qrModel !== undefined) params.qrModel = String(field.qrModel);
    if (field.qrEcl !== undefined) params.qrEcl = field.qrEcl;
    if (field.qrMask !== undefined) params.qrMask = String(field.qrMask);
    if (field.microColumns !== undefined) params.microColumns = String(field.microColumns);
    if (field.microRows !== undefined) params.microRows = String(field.microRows);
    if (field.rssVersion !== undefined) params.rssVersion = String(field.rssVersion);
    if (field.rssSepHeight !== undefined) params.rssSepHeight = String(field.rssSepHeight);
    if (field.rssSegments !== undefined) params.rssSegments = String(field.rssSegments);
    if (field.maxiMode !== undefined) params.maxiMode = String(field.maxiMode);
    // hibcMode is viewer-issue metadata only — bwip's HIBC encoders
    // auto-detect the format from the data, so it is not an encoder input.
    return params;
};

/**
 * PRM sizing rules mirrored from the viewer parser:
 * - POSTNET (c11): h/w are cell magnifications (base cell 13 dots tall;
 *   bwip's natural raster is the 2x2 spec size, so width stretch = round(w/2)).
 *   Quantize the designer's dot height to the nearest magnification so the
 *   canvas matches what the generator re-emits (h = 13*mag).
 * - Planet (c22) / MaxiCode (c14): fixed-size — h/w ignored, natural raster.
 */
export const designerBarcodeRender = (field: BarcodeField, data: string): DesignerBarcodeRender => {
    const params = designerBarcodeParams(field);
    const symbology = field.symbology;
    let moduleDots = Math.max(1, field.w_mag);
    let heightDots = Math.max(1, field.h_mag);
    let fixedSize = false;
    if (symbology === '11') {
        const magH = Math.max(1, Math.min(10, Math.round(field.h_mag / 13)));
        heightDots = 13 * magH;
        moduleDots = Math.max(1, Math.min(5, Math.round(field.w_mag / 2)));
        params.narrowDots = moduleDots;
    } else if (symbology === '22') {
        heightDots = 26;
        moduleDots = 1;
        fixedSize = true;
        params.narrowDots = 1;
    } else if (symbology === '14') {
        heightDots = 101;
        moduleDots = 1;
        fixedSize = true;
        params.narrowDots = 1;
    } else {
        params.narrowDots = moduleDots;
    }
    return { symbology, data: applyI2of5Padding(symbology, data), params, moduleDots, heightDots, fixedSize };
};
