import type { Config } from 'tailwindcss';

// Material Design 3-inspired token set, mirroring school.teraren.com's
// palette so the dam site sits in the same visual family.
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b1220',
        accent: '#0057c0',
        muted: '#6b7280',
        primary: '#0057c0',
        'primary-container': '#0057c0',
        'primary-fixed-dim': '#bcd0ff',
        'on-surface': '#1a1c1e',
        'on-surface-variant': '#42474e',
        surface: '#f7f9fb',
        'surface-container': '#eff2f6',
        'surface-container-low': '#f3f5f8',
        'outline-variant': '#c4c7cd',
      },
      fontFamily: {
        display: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'sans-serif'],
        code: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        h2: ['2rem', { lineHeight: '1.15', fontWeight: '700' }],
        h3: ['1.4rem', { lineHeight: '1.25', fontWeight: '600' }],
        'body-lg': ['1.125rem', { lineHeight: '1.55' }],
        'body-md': ['1rem', { lineHeight: '1.55' }],
      },
    },
  },
} satisfies Config;
