/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3483fa',
          600: '#2968c8',
          700: '#1f4fa8',
          800: '#173d85',
          900: '#0f2c63',
        },
        meli: {
          blue: '#3483fa',
          blueDark: '#2968c8',
          yellow: '#ffe600',
          yellowDark: '#f2c200',
          ink: '#2d3277',
          bg: '#ebebeb',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px -12px rgba(15, 23, 42, 0.18)',
      },
    },
  },
  plugins: [],
};
