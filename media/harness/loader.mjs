// TypeScript resolve hook for learner code (spec V1-2, V1-11). A relative, absolute or file:
// specifier that names a missing '.js' / '.mjs' / '.cjs' file, or has no extension, resolves to an
// existing '.ts' / '.mts' / '.cts' file next to it, the way tsc's module resolution reads
// `import { x } from './util.js'` in a TypeScript project.
//
// Two ways in:
// - module.registerHooks({ resolve: resolveSync }) on Node 22.15+ / 23.5+: in-thread, so it works
//   under --permission (harness.mjs uses this).
// - module.register(new URL('./loader.mjs', import.meta.url)) on older Node: the async `resolve`
//   below runs on a hooks thread, which --permission blocks unless --allow-worker is given.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TS_FOR = { '.js': ['.ts'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false; // missing, or not readable under --permission
  }
}

/** file: URL of the TypeScript file `specifier` stands for, or undefined. */
export function tsAlternative(specifier, parentURL) {
  let file;
  try {
    if (specifier.startsWith('file:')) file = fileURLToPath(specifier);
    else if (path.isAbsolute(specifier)) file = specifier;
    else if (/^\.\.?(?:[\\/]|$)/.test(specifier) && parentURL && parentURL.startsWith('file:')) {
      file = fileURLToPath(new URL(specifier.replace(/\\/g, '/'), parentURL));
    } else return undefined;
  } catch {
    return undefined;
  }
  const ext = path.extname(file).toLowerCase();
  let candidates;
  if (TS_FOR[ext]) candidates = TS_FOR[ext].map((t) => file.slice(0, -ext.length) + t);
  else if (ext === '' || !/^\.[a-z0-9]+$/.test(ext)) candidates = ['.ts', '.mts', '.cts'].map((t) => file + t).concat(path.join(file, 'index.ts'));
  else return undefined;
  const hit = candidates.find(isFile);
  return hit ? pathToFileURL(hit).href : undefined;
}

/** Async resolve hook for module.register(). */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    const alt = tsAlternative(specifier, context.parentURL);
    if (alt) return nextResolve(alt, context);
    throw e;
  }
}

/** Synchronous resolve hook for module.registerHooks(). */
export function resolveSync(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (e) {
    const alt = tsAlternative(specifier, context.parentURL);
    if (alt) return nextResolve(alt, context);
    throw e;
  }
}
