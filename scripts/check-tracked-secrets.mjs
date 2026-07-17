import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const ALLOWED_ENV_FILES = new Set([
  ".env.example",
  ".env.local.example",
  ".env.test",
  "apps/webapp/.env.development",
  "apps/webapp/.env.production",
]);
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);

const violations = [];
for (const file of tracked) {
  const basename = path.basename(file);
  const lower = basename.toLowerCase();
  const forbiddenName =
    (lower.startsWith(".env") && !ALLOWED_ENV_FILES.has(file)) ||
    /\.(?:pem|key|p12)$/i.test(lower) ||
    /^(?:credentials|secrets)\.json$/i.test(lower);
  if (forbiddenName) violations.push(`${file}: forbidden secret-bearing filename`);

  if (statSync(file).size > MAX_SCANNED_BYTES) continue;
  const content = readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [label, pattern] of [
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ["OpenAI project key", /\bsk-proj-[A-Za-z0-9_-]{30,}\b/],
    ["Telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ]) {
    if (pattern.test(text)) violations.push(`${file}: possible ${label}`);
  }
}

if (violations.length > 0) {
  console.error("Tracked secret check failed:\n" + violations.map((v) => `- ${v}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Tracked secret check passed (${tracked.length} files).`);
}
