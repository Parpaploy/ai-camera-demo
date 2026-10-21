/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#f4f6f2",
        panel: "#ffffff",
        line: "#dce5df",
        accent: "#087d6d",
        warn: "#b4531b",
        white: "#17332d",
        slate: {
          50: "#142b26",
          100: "#203832",
          200: "#2d453d",
          300: "#40564e",
          400: "#52685f",
          500: "#61756b",
          600: "#788a81",
          700: "#93a29a",
          800: "#aebbb3",
          900: "#ccd5cf",
          950: "#e6ece7",
        },
        orange: {
          200: "#7c3516",
          300: "#a84f25",
          400: "#bd612e",
        },
        amber: {
          200: "#755200",
          300: "#8f6500",
        },
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
