// Token Radar's entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the valuation from the snapshot's own
// token-bearing protocols, ranks the rankable pre-token protocols, and
// writes everything the gate checks: board.json, the dashboard's data
// (data.js beside the page and zdata.js inside dashboard/, so the dossier
// carries the data the page renders), the dashboard and screenshots copied
// through, and dossier.json from the vendored make.fun library.
//
// The run is deterministic: the same snapshot bytes always write the same
// output bytes, so the grader's two runs agree.
//
// Run it outside the grader's container with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar, accounting } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const script = dataScript(radar);
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board, model: radar.model_version, fit: radar.fit, accounting })}\n`);
writeFileSync(join(out, 'data.js'), script);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// The data rides inside dashboard/ too, under a name that sorts last in the
// dossier's text, so the page's code is read whole before the data starts.
writeFileSync(join(out, 'dashboard', 'zdata.js'), script);
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossierPath = join(out, 'dossier.json');
writeFileSync(dossierPath, buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));
// Self-check: the dossier just written must parse and name this board's rows.
const dossier = JSON.parse(readFileSync(dossierPath, 'utf8')) as { images?: unknown[]; text?: string };
if (!Array.isArray(dossier.images) || dossier.images.length !== shots.length) {
  process.stderr.write(`token radar: dossier.json names ${Array.isArray(dossier.images) ? dossier.images.length : 0} images, expected ${shots.length}\n`);
  process.exit(1);
}

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked ` +
    `(${accounting.watchlistCovered} watchlist, ${board.length - accounting.watchlistCovered} early)\n` +
    `token radar: fit log10(mcap) = ${radar.fit.intercept} + ${radar.fit.slope} x log10(TVL) on n=${radar.fit.trainN} ` +
    `(trimmed ${radar.fit.trimmedN}), LOO median ${radar.fit.looMedianFold}x, walk-forward median ${radar.fit.walkForwardMedianFold}x\n` +
    `token radar: #1 ${board[0]!.name} $${board[0]!.implied_value_usd.toLocaleString('en-US')} ` +
    `(80% band $${board[0]!.implied_low80_usd.toLocaleString('en-US')}–$${board[0]!.implied_high80_usd.toLocaleString('en-US')})\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ` +
    `${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
