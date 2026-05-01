import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b1220',
        accent: '#1e6dff',
        muted: '#6b7280',
      },
    },
  },
} satisfies Config;
