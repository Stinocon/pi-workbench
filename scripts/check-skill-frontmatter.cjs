/**
 * check-skill-frontmatter.cjs — validate every skill's SKILL.md frontmatter with the SAME
 * YAML parser Pi uses, plus the fields generate-skills-doc.py depends on.
 *
 * Two failure classes caught here that a regex scan (or no check at all) misses:
 *   1. Invalid YAML — e.g. an unquoted `description:` containing ": " (colon+space) is a
 *      "nested mapping in compact mapping" YAML error; Pi surfaces it as a [Skill conflicts]
 *      warning at load. A regex does not see it.
 *   2. Fields the README generator needs — `name`/`description`/`summary` must be present,
 *      non-empty and single-line; a block-style (`>`) description is valid YAML but renders
 *      empty in the README's single-line frontmatter extraction.
 *
 * Exit codes:
 *   0 — all frontmatter clean
 *   1 — at least one invalid frontmatter (refuse the commit)
 *   2 — yaml module not found (check unavailable)
 *
 * Usage:
 *   node check-skill-frontmatter.cjs [skillsDir] [-q|--quiet]
 *     skillsDir — scan this directory's SKILL.md files (default: the repo's skills/).
 *     -q        — suppress the success line.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const quiet = args.includes("-q") || args.includes("--quiet");
const target = args.find((a) => !a.startsWith("-"));
const skillsDir = target ? path.resolve(target) : path.join(REPO, "skills");

function globalModuleRoots() {
	const roots = [];
	try {
		const r = execSync("npm root -g", { encoding: "utf8" }).trim();
		if (r) roots.push(r);
	} catch {
		/* npm not on PATH — fall back to hardcoded roots below */
	}
	for (const r of [
		"/opt/homebrew/lib/node_modules", // macOS (Homebrew)
		"/usr/local/lib/node_modules", // macOS (Intel) / Linux
		"/usr/lib/node_modules", // Linux distros
	]) {
		roots.push(r);
	}
	return [...new Set(roots)];
}

function findYaml() {
	for (const root of globalModuleRoots()) {
		for (const rel of [
			"@earendil-works/pi-coding-agent/node_modules/yaml", // nested under pi
			"yaml", // hoisted
		]) {
			const p = path.join(root, rel);
			if (fs.existsSync(p)) return p;
		}
	}
	try {
		return require.resolve("yaml");
	} catch {
		/* not resolvable from here */
	}
	return null;
}

const yamlPath = findYaml();
if (!yamlPath) {
	console.error("check-skill-frontmatter: yaml module not found (pi not installed in a known global location).");
	process.exit(2);
}
const { parse } = require(yamlPath);

let bad = 0;
const names = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [];
for (const name of names) {
	const sk = path.join(skillsDir, name, "SKILL.md");
	if (!fs.existsSync(sk)) continue;

	const txt = fs.readFileSync(sk, "utf8");
	const m = txt.match(/^---\n([\s\S]*?)\n---/);
	if (!m) {
		console.error(`  ${name}/SKILL.md: no frontmatter block`);
		bad++;
		continue;
	}

	let fm;
	try {
		fm = parse(m[1]);
	} catch (e) {
		console.error(`  YAML  ${name}/SKILL.md -> ${String(e.message).split("\n")[0]}`);
		bad++;
		continue;
	}

	if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
		console.error(`  ${name}/SKILL.md: frontmatter is not a mapping`);
		bad++;
		continue;
	}

	for (const key of ["name", "description", "summary"]) {
		const v = fm[key];
		if (typeof v !== "string" || !v.trim()) {
			console.error(`  ${name}/SKILL.md: missing/empty '${key}'`);
			bad++;
		} else if (v.includes("\n")) {
			console.error(`  ${name}/SKILL.md: '${key}' must be single-line (block-style renders empty in README)`);
			bad++;
		}
	}
}

if (bad > 0) {
	console.error(`check-skill-frontmatter: ${bad} skill(s) have invalid frontmatter — refusing to ship.`);
	process.exit(1);
}
if (!quiet) console.log(`check-skill-frontmatter: ${names.length} skill(s) frontmatter clean`);
process.exit(0);
