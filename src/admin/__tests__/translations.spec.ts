import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import translations, { DICT } from "../i18n"

/**
 * Contract test for the admin translation pipeline, mirroring the reorder
 * plugin's test. The dictionary lives in TypeScript rather than JSON catalogs,
 * so the key sets are compared against `DICT` instead of two catalog files.
 */
const ADMIN_DIR = join(__dirname, "..")

type Tree = { [k: string]: string | Tree }

const resource = translations as unknown as Record<string, { paypal: Tree }>

function flatten(tree: Tree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? flatten(value as Tree, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value as string]]
  )
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // The dictionary itself and this test are not "usage" sites.
      return entry === "__tests__" || entry === "i18n" ? [] : sourceFiles(full)
    }
    return /\.tsx?$/.test(entry) && !entry.endsWith(".d.ts") ? [full] : []
  })
}

/**
 * Literal net: any quoted string that starts with a DICT domain prefix and has
 * dot segments must be a defined key. Keys picked at runtime
 * (`t(\`settings.field.${key}\`)`) are invisible here - put full literals in a
 * Record map if a key must be selected dynamically.
 */
const PREFIXES = [
  ...new Set(Object.keys(DICT).map((key) => key.split(".")[0])),
]
const KEY_RE = new RegExp(
  `["']((?:${PREFIXES.join("|")})(?:\\.[A-Za-z0-9_]+)+)["']`,
  "g"
)

function usedKeys(): Array<{ key: string; file: string }> {
  return sourceFiles(ADMIN_DIR).flatMap((file) => {
    const src = readFileSync(file, "utf-8")
    const found: Array<{ key: string; file: string }> = []
    let match: RegExpExecArray | null
    while ((match = KEY_RE.exec(src)) !== null) {
      found.push({ key: match[1], file })
    }
    return found
  })
}

function routeConfigs(): Array<{ file: string; label: string; ns: boolean }> {
  return sourceFiles(join(ADMIN_DIR, "routes"))
    .map((file) => {
      const src = readFileSync(file, "utf-8")
      const label = src.match(/label:\s*"((?:menuItems\.)[A-Za-z0-9_.]+)"/)
      return label
        ? { file, label: label[1], ns: src.includes('translationNs: "paypal"') }
        : null
    })
    .filter((x): x is { file: string; label: string; ns: boolean } => x !== null)
}

describe("admin translations", () => {
  it("has a non-empty en and zh value for every key", () => {
    const empty = Object.entries(DICT)
      .filter(([, entry]) => !entry.en.trim() || !entry.zh.trim())
      .map(([key]) => key)

    expect(empty).toEqual([])
  })

  it("registers en and zhCN under the paypal namespace", () => {
    expect(Object.keys(resource).sort()).toEqual(["en", "zhCN"])

    const expectedKeys = Object.keys(DICT).sort()

    for (const lang of ["en", "zhCN"] as const) {
      expect(Object.keys(resource[lang])).toEqual(["paypal"])
      expect(flatten(resource[lang].paypal).map(([key]) => key).sort()).toEqual(
        expectedKeys
      )
    }
  })

  it("serves every key with the DICT value for its language", () => {
    const mismatched = Object.entries(DICT).flatMap(([key, entry]) => {
      const en = new Map(flatten(resource.en.paypal))
      const zh = new Map(flatten(resource.zhCN.paypal))
      const problems: string[] = []

      if (en.get(key) !== entry.en) problems.push(`${key} (en)`)
      if (zh.get(key) !== entry.zh) problems.push(`${key} (zhCN)`)

      return problems
    })

    expect(mismatched).toEqual([])
  })

  it("resolves every translation-key literal used in src/admin", () => {
    const known = new Set(Object.keys(DICT))
    const missing = usedKeys()
      .filter(({ key }) => !known.has(key))
      .map(({ key, file }) => `${key} (${file})`)

    expect(missing).toEqual([])
  })

  it("uses translationNs on every sidebar route config", () => {
    const bad = routeConfigs().filter((config) => !config.ns)

    expect(bad.map((config) => config.file)).toEqual([])
  })

  it("finds a route config for each menuItems label", () => {
    const labels = routeConfigs().map((config) => config.label).sort()

    expect(labels).toEqual([
      "menuItems.auditLog",
      "menuItems.paypal",
      "menuItems.subscriptions",
    ])
  })
})
