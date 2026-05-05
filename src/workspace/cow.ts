import fs from "node:fs";
import path from "node:path";

const FICLONE = (fs.constants as any).COPYFILE_FICLONE ?? 0;
const FICLONE_FORCE = (fs.constants as any).COPYFILE_FICLONE_FORCE ?? 0;

export function supportsReflink(): boolean {
  // Node >= 16.7 exposes COPYFILE_FICLONE on Linux/macOS if the kernel supports it.
  // We do a quick probe: try to reflink a small temp file to itself.
  if (!FICLONE) return false;
  try {
    const probe = path.join(process.cwd(), ".antcode", ".reflink_probe");
    fs.writeFileSync(probe, "x", "utf8");
    const probe2 = probe + "_copy";
    fs.copyFileSync(probe, probe2, FICLONE);
    fs.unlinkSync(probe);
    fs.unlinkSync(probe2);
    return true;
  } catch {
    return false;
  }
}

let _reflinkSupported: boolean | undefined;

export function reflinkSupported(): boolean {
  if (_reflinkSupported === undefined) _reflinkSupported = supportsReflink();
  return _reflinkSupported;
}

/**
 * Fast recursive copy that uses reflink (COW) when available.
 * Falls back to normal copy on failure.
 * This is dramatically faster on Btrfs/XFS/APFS.
 */
export function fastCopyRecursive(
  srcDir: string,
  dstDir: string,
  useReflink = reflinkSupported(),
): void {
  fs.mkdirSync(dstDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      fastCopyRecursive(src, dst, useReflink);
    } else {
      try {
        if (useReflink && FICLONE) {
          fs.copyFileSync(src, dst, FICLONE);
        } else {
          fs.copyFileSync(src, dst);
        }
      } catch {
        // Fallback if reflink failed mid-way (e.g., crossing mount points)
        fs.copyFileSync(src, dst);
      }
    }
  }
}

/**
 * Create an overlayfs mount on Linux (requires CAP_SYS_ADMIN or root).
 * This is the fastest approach: no copy at all, just a virtual merge.
 * Falls back to fastCopyRecursive if overlayfs fails.
 */
export function tryOverlayMount(
  lowerDir: string,
  upperDir: string,
  workDir: string,
  mountPoint: string,
): boolean {
  if (process.platform !== "linux") return false;
  try {
    fs.mkdirSync(upperDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(mountPoint, { recursive: true });
    const { execSync } = require("node:child_process");
    execSync(
      `mount -t overlay overlay -o lowerdir=${lowerDir},upperdir=${upperDir},workdir=${workDir} ${mountPoint}`,
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

export function unmountOverlay(mountPoint: string): void {
  if (process.platform !== "linux") return;
  try {
    const { execSync } = require("node:child_process");
    execSync(`umount ${mountPoint}`, { stdio: "ignore" });
  } catch {
    // ignore
  }
}
