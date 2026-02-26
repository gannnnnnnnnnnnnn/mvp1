import { execSync } from "node:child_process";

function getTrackedUploads() {
  try {
    const output = execSync("git ls-files uploads", { encoding: "utf8" }).trim();
    if (!output) return [];
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const tracked = getTrackedUploads();
const forbidden = tracked.filter((file) =>
  /\.(pdf|json|csv)$/i.test(file) || /^uploads\/.+/i.test(file)
);

if (forbidden.length > 0) {
  console.error("guard_no_tracked_uploads FAIL: local uploads artifacts are tracked:");
  for (const file of forbidden) {
    console.error(` - ${file}`);
  }
  process.exit(1);
}

console.log("guard_no_tracked_uploads PASS");
