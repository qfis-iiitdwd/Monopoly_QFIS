/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./admin/index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          dark: '#0a0d14',
          card: '#0e131f',
          cardBorder: '#1c2438',
          subtle: '#8892b0',
          accentRed: '#ef4444',
          activeTab: '#32161c',
          activeTabBorder: '#7f1d2d',
          gold: '#eab308',
          success: '#10b981',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
