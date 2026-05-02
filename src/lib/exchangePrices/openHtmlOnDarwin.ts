import { spawn } from "node:child_process";

/**
 * Opens a file via macOS `open` if the platform supports it. No-op on
 * other platforms — callers don't need to feature-detect.
 */
export function openHtmlOnDarwin({ path }: { readonly path: string }): void {
  if (process.platform !== "darwin") {
    return;
  }
  spawn("open", [path], { detached: true, stdio: "ignore" }).unref();
}
