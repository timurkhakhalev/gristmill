import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('.', import.meta.url))

test('copied consumer enforces policy and supports narrow exceptions', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'typescript-policy-consumer-'))

  try {
    cpSync(join(root, 'plugin'), join(consumer, 'plugin'), { recursive: true })
    cpSync(join(root, '.oxlintrc.json'), join(consumer, '.oxlintrc.json'))
    cpSync(join(root, '.oxfmtrc.json'), join(consumer, '.oxfmtrc.json'))
    writeFileSync(join(consumer, 'package.json'), '{"type":"module"}')
    symlinkSync(join(root, 'node_modules'), join(consumer, 'node_modules'), 'dir')

    const run = (tool, args) => {
      const result = spawnSync(join(root, 'node_modules/.bin', tool), args, { cwd: consumer, encoding: 'utf8', timeout: 20000 })
      assert.ifError(result.error)

      return { status: result.status, output: result.stdout + result.stderr }
    }

    const cases = [
      ['export function bad(value: string | number) { return typeof value === "number" }', 'no-runtime-typeof'],
      ['export function bad(value: unknown) { return value }', 'no-unknown-parameters'],
      ['export type Value = unknown', 'no-unknown-type-aliases'],
      ['export function bad(): unknown { return 1 }', 'no-unknown-returns'],
      ['export type Metadata = Record<string, unknown>', 'no-unsafe-dictionary-type'],
      ['export function bad(value: object) { return value }', 'no-object-parameters'],
      ['export function bad(value: any) { return value }', 'no-explicit-any'],
      ['export function bad(value: string | null) { return value! }', 'no-non-null-assertion'],
      ['export function bad(value: string | number) { return value as string }', 'require-safety-comment-for-type-assertion'],
      ['export function bad(value: string) { return value as unknown as number }', 'no-chained-type-assertions'],
      ['export const value: unknown = 1', 'no-known-value-widening'],
      ['export const original = 1; const wide: unknown = original; export const narrow = wide as number', 'no-widen-then-assert'],
      ['export const items = [1, 2].reduce<number[]>((acc, item) => acc.concat([item]), [])', 'no-reduce-accumulator-copy'],
      ['export const items = [1, 2].reduce<number[]>((acc, item) => [...acc, item], [])', 'no-accumulating-spread'],
      ['export function first() { return 1 }\nexport function second() { return 2 }', 'require-readable-spacing'],
    ]

    for (const [source, rule] of cases) {
      writeFileSync(join(consumer, 'sample.ts'), source)
      const result = run('oxlint', ['sample.ts'])
      assert.equal(result.status, 1, `${rule}: ${result.output}`)
      assert.ok(result.output.includes(rule), `${rule}: ${result.output}`)
    }

    const allowed = `export function isNumber(value: string | number): value is number {\n  return typeof value === 'number'\n}\n\nexport const browserAvailable = typeof document !== 'undefined'\n\nexport const kind = 'ready' as const\n\nexport function checked(value: string | number): string {\n  if (isNumber(value)) throw new Error('Expected string')\n\n  // SAFETY: the preceding guard rejects numbers from this string | number union.\n  return value as string\n}\n`
    writeFileSync(join(consumer, 'sample.ts'), allowed)
    const accepted = run('oxlint', ['sample.ts'])
    assert.equal(accepted.status, 0, accepted.output)
    // Tests receive the same assertion restrictions as production code.
    writeFileSync(join(consumer, 'sample.test.ts'), 'export const value = 1 as number')
    assert.ok(run('oxlint', ['sample.test.ts']).output.includes('require-safety-comment-for-type-assertion'))
    const configPath = join(consumer, '.oxlintrc.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.overrides = [{ files: ['parse-input.ts'], rules: { 'quality/no-unknown-parameters': 'off' } }]
    writeFileSync(configPath, JSON.stringify(config))
    const parser = `export function isString(value: unknown): value is string {\n  return typeof value === 'string'\n}\n\nexport function parseInput(value: unknown): string {\n  if (isString(value)) return value\n\n  throw new Error('Expected string')\n}\n`
    writeFileSync(join(consumer, 'parse-input.ts'), parser)
    assert.equal(run('oxlint', ['parse-input.ts']).status, 0)
    writeFileSync(join(consumer, 'other-input.ts'), parser)
    assert.ok(run('oxlint', ['other-input.ts']).output.includes('no-unknown-parameters'))
    writeFileSync(join(consumer, 'sample.ts'), 'export function one(){return 1}\nexport function two(){return 2}\n')

    for (let pass = 0; pass < 2; pass++) {
      assert.equal(run('oxlint', ['sample.ts', '--fix']).status, 0)
      assert.equal(run('oxfmt', ['sample.ts', '--write']).status, 0)
      const output = readFileSync(join(consumer, 'sample.ts'), 'utf8')

      if (pass === 0) writeFileSync(join(consumer, 'expected.txt'), output)
      else assert.equal(output, readFileSync(join(consumer, 'expected.txt'), 'utf8'))
    }

    assert.equal(run('oxlint', ['sample.ts']).status, 0)

    // The bundle config carries its own ignore patterns. An excluded path is
    // skipped, which oxfmt reports as a failed run: "all matched files may have
    // been excluded". The paired in-scope file is formatted. Comparing the two
    // proves the skip is a scope decision and not an already-formatted file.
    mkdirSync(join(consumer, 'coverage'), { recursive: true })
    const unformatted = 'export const value = {a:1,   b:2}\n'
    writeFileSync(join(consumer, 'coverage/excluded.ts'), unformatted)
    writeFileSync(join(consumer, 'formatted.ts'), unformatted)
    assert.equal(run('oxfmt', ['coverage/excluded.ts', '--write']).status, 2)
    assert.equal(readFileSync(join(consumer, 'coverage/excluded.ts'), 'utf8'), unformatted)
    assert.equal(run('oxfmt', ['formatted.ts', '--write']).status, 0)
    assert.notEqual(readFileSync(join(consumer, 'formatted.ts'), 'utf8'), unformatted)
    assert.equal(run('oxfmt', ['coverage/excluded.ts', '--check']).status, 2)

    mkdirSync(join(consumer, 'tools/quality'), { recursive: true })
    cpSync(join(root, 'plugin'), join(consumer, 'tools/quality/plugin'), { recursive: true })
    cpSync(join(root, '.oxlintrc.json'), join(consumer, 'tools/quality/.oxlintrc.json'))
    writeFileSync(configPath, JSON.stringify({ extends: ['./tools/quality/.oxlintrc.json'] }))
    writeFileSync(join(consumer, 'sample.ts'), allowed)
    const inherited = run('oxlint', ['sample.ts'])
    assert.equal(inherited.status, 0, inherited.output)
    writeFileSync(join(consumer, 'sample.ts'), cases[0][0])
    assert.ok(run('oxlint', ['sample.ts']).output.includes('no-runtime-typeof'))
  } finally {
    rmSync(consumer, { recursive: true, force: true })
  }
})
