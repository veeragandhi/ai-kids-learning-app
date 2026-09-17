import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { access, unlink } from "node:fs/promises";

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the ffmpeg binary to use, in priority order:
 * 1. The FFMPEG_PATH environment variable.
 * 2. The project-local ffmpeg-static package (node_modules/ffmpeg-static).
 * 3. A system ffmpeg on PATH (last resort).
 */
export async function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && (await fileExists(process.env.FFMPEG_PATH))) {
    return process.env.FFMPEG_PATH;
  }
  try {
    const staticPath = (await import("ffmpeg-static")).default;
    if (staticPath && (await fileExists(staticPath))) {
      return staticPath;
    }
  } catch {
    // ffmpeg-static is not installed; fall through to PATH
  }
  return "ffmpeg";
}

/**
 * Convert a Playwright-recorded WebM video into an H.264 MP4 file.
 *
 * @param {string} inputPath Full path to the .webm file.
 * @param {string} outputDir Directory in which to write the .mp4 file.
 * @param {{ width?: number; height?: number }} [options]
 * @returns {Promise<string>} Path of the produced .mp4 file.
 */
export async function convertToMp4(inputPath, outputDir, { width = 1440, height = 900 } = {}) {
  const ffmpeg = await resolveFfmpeg();
  const basename = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(outputDir, `${basename}.mp4`);

  await execFileAsync(
    ffmpeg,
    [
      "-y",
      "-i",
      inputPath,
      "-vf",
      `scale=${width}:${height}:flags=lanczos`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { maxBuffer: 1024 * 1024 * 64 },
  );

  return outputPath;
}

/**
 * Remove a file if it exists (used to clean up intermediate WebM files).
 */
export async function removeFileIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch {
    // Ignore missing files
  }
}