/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#141414",
        panel: "#1f1f1f",
        line: "#343434"
      }
    }
  },
  plugins: []
};
