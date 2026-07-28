/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#000000",
        surface: "#0c0c0d",
        foreground: "#f2f2f2",
        muted: "rgba(255,255,255,0.60)",
        dim: "rgba(255,255,255,0.40)",
        green: "#f2f2f2",
        emerald: "#f2f2f2",
        emeraldDarkCheck: "#050505",
        card: "rgba(255,255,255,0.045)",
        cardHover: "rgba(255,255,255,0.065)",
        cardActive: "rgba(255,255,255,0.09)",
        line: "rgba(255,255,255,0.08)",
        iconIdle: "rgba(255,255,255,0.52)",
        backdrop: "rgba(0,0,0,0.76)",
        radio: "rgba(255,255,255,0.045)",
        podcast: "rgba(255,255,255,0.045)",
      },
      borderRadius: {
        card: "10px",
        row: "8px",
        art: "12px",
      },
    },
  },
  plugins: [],
};
