import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { Script } from "node:vm"
import Mustache from "mustache"
import { parse as parseYaml } from "yaml"
import * as zod from "zod"

export const toolDescription = [
  "Check every file of the rule library against its rules",
  "Step 1 read every file in auth sources checks and reports",
  "Step 2 check each file against the rules of its kind",
  "Step 3 give back one item per broken rule and one passed item per good file",
].join("\n")
export const inputSchema = {}
export const outputSchema = {
  items: zod.array(zod.object({
    id: zod.string().describe("File id with a number"),
    target: zod.string().describe("File path in the library"),
    found: zod.string().describe("yes for a broken rule or no for a good file"),
    actual: zod.string().describe("What is wrong or that nothing is"),
    expected: zod.string().describe("What the rule needs"),
    evidence: zod.array(zod.string()).describe("Always empty"),
  })).describe("One item per broken rule and one per good file"),
}
const LIBRARY_SUBFOLDERS = { auth: ".yaml", sources: ".yaml", checks: ".yaml", reports: ".mustache" }
const ID_PATTERN = /^[a-z][a-z0-9_]*$/
const PLACEHOLDER_PATTERN = /\{([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)\}/g
const SYSTEM_PLACEHOLDERS = ["system.workdir", "system.date"]
const PRIORITY_VALUES = ["high", "medium", "low"]
const ACTION_VALUES = ["keep", "add", "fix", "delete", "migrate", "investigate"]

export async function main(toolInput, serverConfig) {
  const libraryFiles = await readLibraryFiles(serverConfig.libraryFolder)
  const specsByKind = groupSpecs(libraryFiles)
  return { items: buildItems(libraryFiles.map(libraryFile => ({ libraryFile, problemList: findProblems(libraryFile, specsByKind) }))) }
}

async function readLibraryFiles(libraryFolder) {
  const libraryFiles = []
  for (const [subfolderName, fileExtension] of Object.entries(LIBRARY_SUBFOLDERS)) {
    const fileNames = await readdir(join(libraryFolder, subfolderName)).catch(() => [])
    for (const fileName of fileNames.filter(fileName => fileName.endsWith(fileExtension)).sort()) {
      libraryFiles.push(await readLibraryFile(libraryFolder, subfolderName, join(subfolderName, fileName)))
    }
  }
  return libraryFiles
}

async function readLibraryFile(libraryFolder, fileKind, filePath) {
  const fileText = await readFile(join(libraryFolder, filePath), "utf8").catch(() => null)
  const parsedFile = fileText !== null && filePath.endsWith(".yaml") ? parseSpec(fileText) : { spec: {}, parseError: "" }
  return { kind: fileKind, path: filePath, id: basename(filePath).replace(/\.[^.]+$/, ""), text: fileText, ...parsedFile }
}

function parseSpec(fileText) {
  try {
    return { spec: parseYaml(fileText) ?? {}, parseError: "" }
  } catch (yamlError) {
    return { spec: {}, parseError: yamlError.message.split("\n")[0] }
  }
}

function groupSpecs(libraryFiles) {
  const specsByKind = { auth: {}, sources: {}, checks: {} }
  for (const libraryFile of libraryFiles.filter(libraryFile => libraryFile.kind in specsByKind)) {
    specsByKind[libraryFile.kind][libraryFile.id] = libraryFile.spec
  }
  return specsByKind
}

function findProblems(libraryFile, specsByKind) {
  if (libraryFile.parseError) return [buildProblem(libraryFile.parseError, "Valid YAML")]
  if (libraryFile.kind === "checks") return checkCheckFile(libraryFile, specsByKind)
  if (libraryFile.kind === "sources") return checkSourceFile(libraryFile, specsByKind)
  if (libraryFile.kind === "auth") return checkLoginFile(libraryFile, specsByKind)
  return checkReportFile(libraryFile)
}

function buildProblem(actualText, expectedText) {
  return { actual: actualText, expected: expectedText }
}

function requireFields(fileSpec, fieldNames) {
  return fieldNames.filter(fieldName => !fileSpec[fieldName]).map(fieldName => buildProblem(`No ${fieldName}`, `${fieldName} is set`))
}

function checkCheckFile(libraryFile, specsByKind) {
  const checkSpec = libraryFile.spec
  return [
    ...checkCommonRules(libraryFile, specsByKind),
    ...requireFields(checkSpec, ["description", "reference", "recommendation"]),
    ...requireChoice(checkSpec, "priority", PRIORITY_VALUES),
    ...requireChoice(checkSpec, "action", ACTION_VALUES),
    ...requireSources(checkSpec.sources ?? [], specsByKind.sources),
    ...(checkSpec.js || checkSpec.prompt ? [] : [buildProblem("No js and no prompt", "js or prompt or both")]),
    ...compileJs(checkSpec.js),
  ]
}

function checkCommonRules(libraryFile, specsByKind) {
  const usageCount = Object.values(specsByKind).filter(specsById => libraryFile.id in specsById).length
  return [
    ...requireFields(libraryFile.spec, ["title"]),
    ...(ID_PATTERN.test(libraryFile.id) ? [] : [buildProblem(`File name ${libraryFile.id} is not snake_case`, "Lowercase letters, numbers and _ starting with a letter")]),
    ...(usageCount > 1 ? [buildProblem(`Id ${libraryFile.id} is used in more than one of auth, sources and checks`, "Every id is unique")] : []),
  ]
}

function requireChoice(fileSpec, fieldName, allowedValues) {
  if (allowedValues.includes(fileSpec[fieldName])) return []
  return [buildProblem(`${fieldName} is ${fileSpec[fieldName] ?? "missing"}`, `${fieldName} is ${allowedValues.join(", ")}`)]
}

function requireSources(sourceIds, sourceSpecs) {
  if (!Array.isArray(sourceIds)) return [buildProblem("sources is not a list", "sources is a list of source ids")]
  return sourceIds.filter(sourceId => !sourceSpecs[sourceId])
    .map(sourceId => buildProblem(`Source ${sourceId} does not exist`, "Every source is the id of a file in sources"))
}

function compileJs(jsText) {
  if (!jsText) return []
  try {
    new Script(`(function () {\n${jsText}\n})`)
    return []
  } catch (compileError) {
    return [buildProblem(`js does not compile: ${compileError.message}`, "js that compiles")]
  }
}

function checkSourceFile(libraryFile, specsByKind) {
  const sourceSpec = libraryFile.spec
  const missingLogin = sourceSpec.auth && !specsByKind.auth[sourceSpec.auth]
  return [
    ...checkCommonRules(libraryFile, specsByKind),
    ...requireFields(sourceSpec, ["run"]),
    ...(missingLogin ? [buildProblem(`Login ${sourceSpec.auth} does not exist`, "auth is the id of a file in auth")] : []),
    ...requireOutputs(sourceSpec, true),
    ...checkPlaceholders(sourceSpec, listAllowedKeys(sourceSpec, specsByKind)),
  ]
}

function requireOutputs(runnableSpec, needsFields) {
  const outputEntries = Object.entries(runnableSpec.outputs ?? {})
  if (!outputEntries.length) return [buildProblem("No outputs", "At least one output")]
  if (!needsFields) return []
  return outputEntries.filter(([, outputSpec]) => !outputSpec?.fields?.id)
    .map(([outputName]) => buildProblem(`Output ${outputName} has no id field`, "Every output lists its fields with an id field"))
}

function checkPlaceholders(runnableSpec, allowedKeys) {
  const templateTexts = [String(runnableSpec.run ?? ""), ...Object.values(runnableSpec.env ?? {}).map(String)]
  const usedKeys = templateTexts.flatMap(templateText => [...templateText.matchAll(PLACEHOLDER_PATTERN)].map(placeholderMatch => placeholderMatch[1]))
  return [...new Set(usedKeys)].filter(usedKey => !allowedKeys.includes(usedKey))
    .map(usedKey => buildProblem(`Unknown placeholder {${usedKey}}`, "Placeholders are inputs, auth outputs, system.workdir or system.date"))
}

function listAllowedKeys(runnableSpec, specsByKind) {
  const loginOutputs = Object.keys(specsByKind.auth[runnableSpec.auth]?.outputs ?? {}).map(outputName => `auth.${outputName}`)
  return [...Object.keys(runnableSpec.inputs ?? {}), ...loginOutputs, ...SYSTEM_PLACEHOLDERS]
}

function checkLoginFile(libraryFile, specsByKind) {
  const loginSpec = libraryFile.spec
  return [
    ...checkCommonRules(libraryFile, specsByKind),
    ...requireFields(loginSpec, ["run"]),
    ...(loginSpec.auth ? [buildProblem("Has auth", "A login does not use another login")] : []),
    ...requireOutputs(loginSpec, false),
    ...checkPlaceholders(loginSpec, listAllowedKeys({ ...loginSpec, auth: "" }, specsByKind)),
  ]
}

function checkReportFile(libraryFile) {
  try {
    Mustache.parse(libraryFile.text)
    return []
  } catch (templateError) {
    return [buildProblem(`Template does not parse: ${templateError.message}`, "A valid mustache template")]
  }
}

function buildItems(fileResults) {
  const ownerCounts = {}
  return fileResults.flatMap(({ libraryFile, problemList }) => {
    const itemProblems = problemList.length ? problemList : [buildProblem("No broken rules", "Every rule of its kind")]
    return itemProblems.map(itemProblem => {
      ownerCounts[libraryFile.id] = (ownerCounts[libraryFile.id] ?? 0) + 1
      return {
        id: `${libraryFile.id}#${ownerCounts[libraryFile.id]}`,
        target: libraryFile.path,
        found: problemList.length ? "yes" : "no",
        actual: itemProblem.actual,
        expected: itemProblem.expected,
        evidence: [],
      }
    })
  })
}
