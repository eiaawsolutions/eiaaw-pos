#!/usr/bin/env node
/**
 * Staged-content secret scan.
 *
 * Prefers gitleaks when it is on PATH. Falls back to the patterns below so the
 * hook is effective on a machine that has not installed it — a hook that
 * silently no-ops is worse than no hook, because it is trusted.
 *
 * Scoped to what this codebase actually handles: PSP and Anthropic keys, the
 * Infisical bootstrap credentials, and database URLs carrying a real password.
 * Under the EIAAW deploy contract the only raw secrets that may ever appear in
 * committed config are the three INFISICAL_* bootstrap values, and even those
 * belong in the deployment target's secret store rather than the repository.
 */
import { execFileSync } from 'node:child_process';

const RULES = [
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'Stripe live secret key', re: /\bsk_live_[A-Za-z0-9]{16,}/ },
  { name: 'Stripe test secret key', re: /\bsk_test_[A-Za-z0-9]{16,}/ },
  { name: 'Stripe restricted key', re: /\brk_live_[A-Za-z0-9]{16,}/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  {
    name: 'Database URL with password',
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@/,
  },
  {
    name: 'Infisical machine identity secret',
    re: /INFISICAL_APP_CLIENT_SECRET\s*[=:]\s*["']?[A-Za-z0-9_-]{16,}/,
  },
  {
    name: 'Assigned secret-looking value',
    re: /\b(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[=:]\s*["'][A-Za-z0-9/+_-]{24,}["']/i,
  },
];

/**
 * Lines that are demonstrably not real credentials.
 *
 * Kept deliberately narrow. A bare /example/ here suppressed a genuine finding
 * during testing — a production database URL was allowed through because its
 * host was db.example.com. An allowlist entry has to match the *placeholder*,
 * not merely appear somewhere on the line, or it turns into a false negative
 * in exactly the case the scan exists for.
 */
const ALLOW = [
  /\bchange[-_]?me\b/i,
  /\bplaceholder\b/i,
  /\bredacted\b/i,
  /\bdummy\b/i,
  /\bnot-?a-?real\b/i,
  /\bdev-only\b/i,
  /\byour[-_][a-z]/i, // your-api-key, your_token
  /(?:^|[^A-Za-z0-9])x{6,}(?:[^A-Za-z0-9]|$)/i, // xxxxxx redaction
  // postgres:postgres on a loopback address is the documented development and
  // test credential pair, not a secret. Loopback only — the same user:password
  // against a real host is exactly what this rule should still catch.
  /postgres:postgres@(?:localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)\b/,
  /secret:\/\//, // an Infisical handle is a reference, not a value
];

function tracked(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

// Prefer gitleaks when available.
try {
  execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
  const res = execFileSync('gitleaks', ['protect', '--staged', '--redact', '--no-banner'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  process.stdout.write(res);
  process.exit(0);
} catch (err) {
  // Distinguish "gitleaks not installed" from "gitleaks found something".
  if (err?.status && err.status !== 0 && err.stdout !== undefined) {
    process.stderr.write(String(err.stdout || '') + String(err.stderr || ''));
    console.error('\nSecret scan failed (gitleaks). Commit aborted.');
    process.exit(1);
  }
  // Not installed — fall through to the built-in scan.
}

const staged = tracked('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'])
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)
  // .env.example is expected to hold secret:// handles, never values; it is
  // still scanned, because a handle and a value look different and the whole
  // point is catching the day someone pastes a value there.
  .filter((f) => !/^(?:package-lock\.json$|.*\.(?:png|jpe?g|gif|webp|ico|pdf|docx|woff2?)$)/i.test(f));

let findings = 0;
for (const file of staged) {
  const content = tracked('git', ['show', `:${file}`]);
  if (!content) continue;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue; // minified or generated
    if (ALLOW.some((a) => a.test(line))) continue;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        const redacted = line
          .trim()
          .slice(0, 60)
          .replace(/[A-Za-z0-9_-]{12,}/g, '****');
        console.error(`  ${file}:${i + 1}  ${rule.name}\n      ${redacted}`);
        findings++;
        break;
      }
    }
  }
}

if (findings > 0) {
  console.error(
    `\n${findings} potential secret(s) in staged content. Commit aborted.\n\n` +
      'Secrets belong in Infisical, referenced from config as a\n' +
      '  secret://<project>/<env>/<NAME>\n' +
      'handle. See references/eiaaw-deploy-playbook.md.\n\n' +
      'If this is a false positive, adjust scripts/scan-secrets.mjs rather than\n' +
      'bypassing the hook, so the next person is still protected.',
  );
  process.exit(1);
}

console.log(`  secret scan: ${staged.length} staged file(s), clean`);
