import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const planned = (headings) => ({ headings, status: ['planned', 'implemented'] });
const subsystem = planned(['Scope', 'Interfaces', 'Behavior', 'Acceptance']);

// This manifest owns required sections, lifecycle values, and entry word ceilings.
const requirements = {
  'AGENTS.md': { headings: ['Start here', 'Working rules', 'Git'] },
  'README.md': { headings: ['Development'] },
  '.ai/AGENTS.md': { headings: ['Ownership', 'Writing', 'Decisions and tasks', 'Validation'] },
  '.ai/README.md': { headings: ['Decision records'] },
  '.ai/status.md': { headings: ['Current stage', 'Active task', 'Blockers', 'Next entry point'] },
  '.ai/architecture.md': planned(['Composition', 'Module responsibilities', 'Dependency direction', 'Interfaces and jobs']),
  '.ai/product/requirements.md': planned(['Goal', 'Release scope', 'Priorities and boundaries']),
  '.ai/design/interaction.md': planned(['Visual language', 'Navigation and screens', 'Reading controls', 'Acceptance']),
  '.ai/design/motion.md': planned(['Scope', 'Page contract', 'Ownership and execution', 'Acceptance']),
  '.ai/subsystems/reader.md': subsystem,
  '.ai/subsystems/library.md': subsystem,
  '.ai/subsystems/sources.md': subsystem,
  '.ai/subsystems/rss.md': subsystem,
  '.ai/subsystems/sync.md': subsystem,
  '.ai/subsystems/aigc.md': subsystem,
  '.ai/engineering/workflow.md': { headings: ['Scope and task ownership', 'Implementation discipline', 'Documentation and review', 'Git and handoff'] },
  '.ai/engineering/testing.md': { headings: ['Available checks', 'Application checks to establish', 'Selecting scope', 'Reporting evidence'] },
  '.ai/plans/roadmap.md': planned(['Stage dependencies', 'M0: Foundation', 'M1: Local reading', 'M2: Online content', 'M3: Cross-device reading', 'Later: AI assistance']),
  '.ai/plans/task-template.md': { headings: ['Outcome', 'Scope', 'Interfaces', 'Acceptance criteria', 'Verification', 'Handoff'], status: ['template'] },
};

const budgets = {
  'AGENTS.md': 450,
  '.ai/AGENTS.md': 650,
  '.ai/README.md': 350,
  '.ai/status.md': 180,
  '.ai/architecture.md': 800,
};

function inside(root, path) {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function stripFences(body) {
  let fence;
  return body.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence && marker) {
      fence = marker[1];
      return '';
    }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    return line;
  }).join('\n');
}

function headingsIn(body) {
  return [...body.matchAll(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/gm)]
    .map((match) => ({ level: match[1].length, text: match[2] }));
}

function anchorsIn(body) {
  const used = new Set();
  for (const { text } of headingsIn(stripFences(body))) {
    const base = text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    let anchor = base;
    let suffix = 0;
    while (used.has(anchor)) anchor = `${base}-${++suffix}`;
    used.add(anchor);
  }
  return used;
}

function lifecycle(path) {
  if (path.startsWith('.ai/notes/proposed/')) {
    return { headings: ['Problem', 'Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks'], status: ['proposed'] };
  }
  if (path.startsWith('.ai/notes/implemented/')) {
    return { headings: ['Problem', 'Decision', 'Alternatives considered', 'Consequences'], status: ['implemented'] };
  }
  if (path.startsWith('.ai/plans/') && !requirements[path]) {
    return { headings: ['Outcome', 'Scope', 'Interfaces', 'Acceptance criteria', 'Verification', 'Handoff'], status: ['planned', 'in-progress', 'completed'] };
  }
  return undefined;
}

/** Validate root and .ai Markdown without changing files or fetching remote URLs.
 * Optional rules/budgets allow focused temporary fixtures to exercise failures.
 */
export async function checkDocuments(root, options = {}) {
  root = await realpath(root);
  const rules = options.requirements ?? requirements;
  const limits = options.budgets ?? budgets;
  const errors = [];
  const documents = new Map();
  let links = 0;

  async function readDocument(path) {
    try {
      const absolute = resolve(root, path);
      if (!inside(root, await realpath(absolute))) {
        errors.push(`${path}: document resolves outside the repository`);
        return;
      }
      documents.set(path, await readFile(absolute, 'utf8'));
    } catch (error) {
      errors.push(`${path}: cannot read document (${error.code ?? error.message})`);
    }
  }

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(resolve(root, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(`${directory}: cannot list documents (${error.code ?? error.message})`);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) errors.push(`${path}: documentation symlinks are not supported`);
      else if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) await readDocument(path);
    }
  }

  for (const path of ['AGENTS.md', 'README.md']) {
    try {
      await stat(resolve(root, path));
      await readDocument(path);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(`${path}: cannot inspect document (${error.code ?? error.message})`);
    }
  }
  await visit('.ai');

  for (const path of Object.keys(rules)) {
    if (!documents.has(path)) errors.push(`${path}: required document is missing`);
  }

  for (const [path, body] of documents) {
    if (body.includes('\r') || !body.endsWith('\n')) errors.push(`${path}: use LF and a final newline`);
    const prose = stripFences(body);
    const headings = headingsIn(prose);
    if (headings.filter((heading) => heading.level === 1).length !== 1) errors.push(`${path}: require exactly one H1 title`);
    const rule = rules[path] ?? lifecycle(path);
    for (const heading of rule?.headings ?? []) {
      if (!headings.some((item) => item.level === 2 && item.text === heading)) errors.push(`${path}: missing section "${heading}"`);
    }
    const statuses = [...prose.matchAll(/^Status:\s*(.+)$/gm)].map((match) => match[1].trim());
    if (rule?.status && (statuses.length !== 1 || !rule.status.includes(statuses[0]))) {
      errors.push(`${path}: expected exactly one status from ${rule.status.join(', ')}`);
    }
    if (path.startsWith('.ai/notes/') && !lifecycle(path)) errors.push(`${path}: unsupported note lifecycle directory`);
    const words = body.match(/\S+/g)?.length ?? 0;
    if (limits[path] && words > limits[path]) errors.push(`${path}: ${words} words exceed limit ${limits[path]}`);

    // Maintained docs use inline links; reject unsupported reference syntax explicitly.
    const linkProse = prose.replace(/(`+)[\s\S]*?\1/g, '');
    if (/^ {0,3}\[[^\]\n]+\]:/m.test(linkProse) || /\[[^\]\n]+\]\[[^\]\n]*\]/.test(linkProse)) {
      errors.push(`${path}: use inline Markdown links instead of reference-style links`);
    }
    const inlineLinks = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\)/g;
    for (const match of linkProse.matchAll(inlineLinks)) {
      const target = match[1] ?? match[2];
      if (/^file:/i.test(target) || target.startsWith('/')) {
        errors.push(`${path}: use repository-relative links (${target})`);
        continue;
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      links++;
      try {
        const hash = target.indexOf('#');
        const rawFile = (hash < 0 ? target : target.slice(0, hash)).split('?')[0];
        const anchor = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
        const file = decodeURIComponent(rawFile);
        const absolute = file ? resolve(dirname(resolve(root, path)), file) : resolve(root, path);
        if (!inside(root, absolute) || !inside(root, await realpath(absolute))) {
          errors.push(`${path}: link escapes repository (${target})`);
          continue;
        }
        const info = await stat(absolute);
        if (anchor && absolute.endsWith('.md') && info.isFile()) {
          const linked = documents.get(relative(root, absolute).split(sep).join('/')) ?? await readFile(absolute, 'utf8');
          if (!anchorsIn(linked).has(anchor)) errors.push(`${path}: missing heading anchor (${target})`);
        }
      } catch (error) {
        errors.push(`${path}: invalid local link ${target} (${error.code ?? error.message})`);
      }
    }
  }
  return { documents: documents.size, links, errors };
}

// macOS temp paths can enter through /var while ESM resolves them under /private/var.
const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-docs.mjs');
    const result = await checkDocuments(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    if (result.errors.length) {
      for (const error of result.errors) process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Documentation checks passed: ${result.documents} files, ${result.links} local links.\n`);
    }
  } catch (error) {
    process.stderr.write(`Documentation check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
