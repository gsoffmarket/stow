import { defineConfig } from "vite";

// Relative asset paths: the app is served under /glasses/ on the host, and
// from inside a packaged .ehpk on the phone.
export default defineConfig({ base: "./" });
