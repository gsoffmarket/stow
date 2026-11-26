// Builds the installable glasses package for one Stow server.
//
// The API origin is fixed at build time and must also be on the manifest's
// network whitelist, or the phone refuses the request. Taking it once here
// keeps the two from drifting, and keeps any real host out of app.json.
//
//   STOW_API_URL=https://stow.example.com node pack.ts

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const raw = process.env.STOW_API_URL ?? "";
let origin: string;
try {
  origin = new URL(raw).origin;
} catch {
  throw new Error("set STOW_API_URL to the server's https origin, e.g. https://stow.example.com");
}
if (!origin.startsWith("https://")) throw new Error(`STOW_API_URL must use https, got ${origin}`);

const manifest = JSON.parse(readFileSync("app.json", "utf8"));
manifest.permissions = manifest.permissions.map((permission: { name: string }) =>
  permission.name === "network" ? { ...permission, whitelist: [origin] } : permission,
);
const manifestPath = join(mkdtempSync(join(tmpdir(), "stow-pack-")), "app.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const run = (command: string, args: string[]) =>
  execFileSync(command, args, { stdio: "inherit", env: { ...process.env, VITE_STOW_API_URL: origin } });
run("pnpm", ["exec", "vite", "build"]);
run("pnpm", ["exec", "evenhub", "pack", manifestPath, "dist", "-o", "stow.ehpk"]);
