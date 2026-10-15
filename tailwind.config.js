/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#12151a",
        panel: "#1a1f27",
        line: "#2a3140",
        accent: "#5eead4",
        warn: "#fb923c",
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "monospace"],
        sans: ["'IBM Plex Sans Thai'", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Manrope", "'IBM Plex Sans Thai'", "sans-serif"],
      },
    },
  },
  plugins: [],
};
