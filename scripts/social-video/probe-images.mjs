import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ff = require("ffmpeg-static");
for (const f of readdirSync("video/shots")) {
  try {
    execFileSync(ff, ["-hide_banner", "-i", path.join("video/shots", f)], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = String(e.stderr || e.message || "");
    const m = err.match(/Video:.*? (\d+)x(\d+)/);
    console.log(f + ": " + (m ? m[1] + "x" + m[2] : "unknown"));
  }
}
