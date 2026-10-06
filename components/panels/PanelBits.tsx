// Shared bits of the right-panel editors (split from RightPanel.tsx, layout
// phase 2): the labelled input wrapper, the input class, and the mm/cm/in
// converters. No behaviour lives here.
import React from 'react';

export const PropInput: React.FC<{ label: string; children: React.ReactNode; fullWidth?: boolean }> = ({ label, children, fullWidth }) => (
    <div className={fullWidth ? 'col-span-2' : ''}>
        <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
        {children}
    </div>
);

export const inputClasses = "w-full p-1.5 text-sm border border-gray-600 bg-gray-700 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none";

const CM_PER_MM = 0.1;
const IN_PER_MM = 1 / 25.4;

export const convertFromMm = (value: number, unit: 'mm' | 'cm' | 'in'): number => {
    if (unit === 'cm') return value * CM_PER_MM;
    if (unit === 'in') return value * IN_PER_MM;
    return value;
};

export const convertToMm = (value: number, unit: 'mm' | 'cm' | 'in'): number => {
    if (unit === 'cm') return value / CM_PER_MM;
    if (unit === 'in') return value / IN_PER_MM;
    return value;
};
