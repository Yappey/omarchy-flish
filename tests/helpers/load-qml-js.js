// Load a QML .js file into a plain JS object.
//
// QML .js files declare bare top-level functions and export nothing -- that is
// the shape QML's `import "X.js" as X` expects, and it is the house style in
// omarchy-shell (NotificationLogic.js, OsdModel.js). Adding `module.exports` to
// suit Node would put test-only scaffolding into shipped code, so instead the
// source is wrapped in an IIFE that returns its own top-level declarations.
//
// The upshot: tutor/TutorProtocol.js stays byte-identical to what QML loads.
//
// It runs in *this* realm rather than a fresh vm context on purpose. A new
// context gets its own Object.prototype, so every object the module returns
// would fail assert.deepStrictEqual against a host-realm literal despite being
// structurally identical. The IIFE keeps the declarations scoped, so running
// here costs no isolation that matters.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import vm from "node:vm"

const here = dirname(fileURLToPath(import.meta.url))

// The house idiom is plain top-level `function` and `var` declarations, so the
// exported surface can be read straight off the source.
function declaredNames(source) {
  const names = new Set()
  for (const m of source.matchAll(/^(?:function|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1])
  }
  return [...names]
}

export function loadQmlJs(relativePath) {
  const path = resolve(here, "..", "..", relativePath)
  const source = readFileSync(path, "utf8")
  const names = declaredNames(source)

  if (names.length === 0) {
    throw new Error(`${relativePath} declares no top-level functions or vars`)
  }

  const wrapped = `(function () {\n${source}\nreturn { ${names.join(", ")} };\n})()`
  const exported = vm.runInThisContext(wrapped, { filename: path })

  return new Proxy(exported, {
    get(target, prop) {
      if (typeof prop === "string" && !(prop in target)) {
        throw new Error(
          `${relativePath} does not define "${prop}" (found: ${names.join(", ")})`)
      }
      return target[prop]
    }
  })
}
