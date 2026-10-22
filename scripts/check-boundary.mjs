#!/usr/bin/env node
/**
 * Module-boundary checker (see docs/module-spec.md §4.4 and AGENTS.md §2).
 * Static, dependency-free: parses import specifiers and enforces layer rules.
 *   R1  src/price/**  : pure core — only `zod` (+ relative files inside price/).
 *   R2  src/task/**, src/platform/** : may import interfaces, never concrete impls.
 *   R3  src/tools/**  : must not reach into ctx.jobs/storageDomain or device/ocr impls.
 *   R5  src/device/**, src/ocr/** : capability — must not import price/task/platform/tools.
 *   R6  src/core/**   : must not import device/platform/task/tools impls.
 *   R4  no import cycles.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = existsSync(SRC) ? walk(SRC) : []

const IMPORT_RE =
  /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

function importsOf(file) {
  const s = readFileSync(file, 'utf8')
  const out = []
  let m
  while ((m = IMPORT_RE.exec(s))) out.push(m[1] ?? m[2])
  return out
}

function resolveRel(from, spec) {
  const base = resolve(dirname(from), spec)
  for (const cand of [base, base + '.ts', join(base, 'index.ts')]) {
    if (existsSync(cand) && cand.endsWith('.ts')) return cand
  }
  return null
}

const rel = (p) => relative(ROOT, p)
const violations = []

const IMPL_IMPORTS = ['device/adb', 'device/appium', 'device/mock', 'tesseract']

for (const f of files) {
  const r = rel(f)
  const imps = importsOf(f)
  const inPrice = r.startsWith('src/price/')
  const inTaskPlatform = r.startsWith('src/task/') || r.startsWith('src/platform/')
  const inTools = r.startsWith('src/tools/')
  const inDeviceOcr = r.startsWith('src/device/') || r.startsWith('src/ocr/')
  const inCore = r.startsWith('src/core/')

  for (const spec of imps) {
    const bare = spec.replace(/^node:/, '')
    // R1 price purity
    if (inPrice) {
      const isRelInsidePrice = spec.startsWith('.') && !spec.includes('..') // './x'
      const isZod = spec === 'zod'
      if (!isRelInsidePrice && !isZod) {
        violations.push(`R1 ${r}: price/* may only import {zod} or local files, got '${spec}'`)
      }
    }
    // R2 no concrete impls in task/platform
    if (inTaskPlatform && IMPL_IMPORTS.some((x) => spec.includes(x))) {
      violations.push(`R2 ${r}: must import interfaces not impls, got '${spec}'`)
    }
    // R3 tools must not reach device/ocr impls or storage/jobs services directly
    if (inTools) {
      if (/\.\.\/(device|ocr)\b/.test(spec) || IMPL_IMPORTS.some((x) => spec.includes(x))) {
        violations.push(`R3 ${r}: tools/* must go through task/*, got '${spec}'`)
      }
      if (/storageDomain|ctx\.jobs|\bjobs\/local\b|dsh-jobs/.test(spec)) {
        violations.push(`R3 ${r}: tools/* must not import storage/jobs directly, got '${spec}'`)
      }
    }
    // R5 device/ocr must not import price/task/platform/tools
    if (inDeviceOcr && /\.\.\/(price|task|platform|tools)\b/.test(spec)) {
      violations.push(
        `R5 ${r}: device/ocr must not import price/task/platform/tools, got '${spec}'`,
      )
    }
    // R6 core must not import task/tools or device impls (concrete).
    // Exception: core/container.ts is the DI composition root — the ONE place
    // allowed to pick mock|adb implementations (module-spec §10-core).
    if (inCore && !/src\/core\/container\.ts$/.test(r)) {
      if (/\.\.\/(task|tools)\b/.test(spec) || /\.\.\/device\/(adb|mock)\b/.test(spec)) {
        violations.push(`R6 ${r}: core/* must not import task/tools or device impls, got '${spec}'`)
      }
    }
    void bare
  }
}

// R4 cycle detection over relative imports
const graph = new Map()
for (const f of files) {
  const deps = []
  for (const spec of importsOf(f)) {
    if (!spec.startsWith('.')) continue
    const t = resolveRel(f, spec)
    if (t) deps.push(t)
  }
  graph.set(f, deps)
}
const WHITE = 0,
  GRAY = 1,
  BLACK = 2
const color = new Map()
const stack = []
function dfs(n) {
  color.set(n, GRAY)
  stack.push(n)
  for (const d of graph.get(n) ?? []) {
    const c = color.get(d) ?? WHITE
    if (c === GRAY) {
      const idx = stack.indexOf(d)
      const cyc = stack.slice(idx).concat(d).map(rel).join(' -> ')
      violations.push(`R4 import cycle: ${cyc}`)
    } else if (c === WHITE) dfs(d)
  }
  stack.pop()
  color.set(n, BLACK)
}
for (const f of files) if ((color.get(f) ?? WHITE) === WHITE) dfs(f)

if (violations.length) {
  console.error('✖ module boundary violations:\n' + violations.map((v) => '  - ' + v).join('\n'))
  process.exit(1)
} else {
  console.log(`✔ module boundaries OK (${files.length} files checked)`)
}
