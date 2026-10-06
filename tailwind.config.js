/** NEXT (audit TECH-03, 2026-10-06): Tailwind as a local build instead of the
 *  play CDN. Same utility classes, but the CSS is purged to what the code
 *  actually uses and the app no longer needs the network to render. */
export default {
    content: ['./index.html', './App.tsx', './components/**/*.{ts,tsx}', './services/**/*.{ts,tsx}'],
    theme: { extend: {} },
    plugins: [],
};
