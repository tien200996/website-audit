import { readdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import Mustache from "mustache"
import * as zod from "zod"

export const toolDescription = [
  "Build the report page of one audit",
  "Step 1 read the findings and rules of this audit",
  "Step 2 stop with every finding where a problem was found or is unsure and has no decision yet",
  "Step 3 save the decisions for every finding",
  "Step 4 build the report page from the chosen template and give back its path",
].join("\n")
export const inputSchema = {
  id: zod.string().describe("Audit id"),
  decisions: zod.record(zod.string(), zod.object({
    action: zod.string().describe("keep or add or fix or delete or migrate or investigate"),
    note: zod.string().optional().describe("Why this action was chosen"),
  })).optional().describe("All decisions by check id for all its findings or by finding id for one finding"),
  template: zod.string().optional().describe("Report template id and empty means default"),
}
export const outputSchema = {
  items: zod.array(zod.object({
    id: zod.string().describe("Finding id"),
    target: zod.string().describe("What was checked such as a page path"),
    found: zod.string().describe("yes or unsure"),
    actual: zod.string().describe("What was seen"),
    expected: zod.string().describe("What it should be"),
    evidence: zod.array(zod.string()).describe("Record ids that prove it"),
  })).describe("Findings that still need a decision"),
  checks: zod.array(zod.object({
    id: zod.string().describe("Check id"),
    title: zod.string().describe("Check name"),
    priority: zod.string().describe("high or medium or low"),
    action: zod.string().describe("Action the check suggests"),
    recommendation: zod.string().describe("How to fix"),
  })).describe("Checks of those findings"),
  report: zod.string().describe("Path of the report page and empty while decisions are missing"),
}
const AUDIT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
const DEFAULT_TEMPLATE = "default"

export async function main({ id: auditId, decisions: givenDecisions = {}, template: templateId = DEFAULT_TEMPLATE }, serverConfig) {
  const auditFolder = findAuditFolder(serverConfig.auditsFolder, auditId)
  const auditData = await readAuditData(auditFolder)

  const openFindings = auditData.findingItems.filter(findingItem => findingItem.found !== "no")
  const decisionItems = resolveDecisions(openFindings, givenDecisions)
  const undecidedFindings = openFindings.filter(findingItem => !decisionItems.some(decisionItem => decisionItem.id === findingItem.id))
  if (undecidedFindings.length) return { items: undecidedFindings, checks: listChecks(undecidedFindings, auditData.savedLibrary), report: "" }

  await writeJson(join(auditFolder, "review.json"), { items: decisionItems })

  const reportPath = join(auditFolder, "report.html")
  const pageTemplate = findTemplate(auditData.savedLibrary, templateId)
  const pageView = buildPageView(auditId, auditData, decisionItems)
  await writeFile(reportPath, Mustache.render(pageTemplate, pageView, partialName => findPartial(auditData.savedLibrary, partialName)))
  return { items: [], checks: [], report: reportPath }
}

function findAuditFolder(auditsFolder, auditId) {
  if (!AUDIT_ID_PATTERN.test(auditId)) throw new Error(`Unknown audit id ${auditId}`)
  return join(auditsFolder, auditId)
}

async function readAuditData(auditFolder) {
  const savedFindings = await readJson(join(auditFolder, "findings.json")).catch(() => {
    throw new Error("No findings saved for this audit yet")
  })
  return {
    savedLibrary: await readJson(join(auditFolder, "library.json")),
    savedInputs: await readJson(join(auditFolder, "inputs.json")),
    findingItems: savedFindings.items,
    checkedIds: savedFindings.checked ?? [],
    sourceOutputs: await readSourceOutputs(join(auditFolder, "sources")),
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

async function readSourceOutputs(sourcesFolder) {
  const sourceOutputs = {}
  for (const fileName of await readdir(sourcesFolder)) {
    const [sourceId, outputName] = basename(fileName, ".json").split(".")
    sourceOutputs[sourceId] ??= {}
    sourceOutputs[sourceId][outputName] = await readJson(join(sourcesFolder, fileName))
  }
  return sourceOutputs
}

function resolveDecisions(openFindings, givenDecisions) {
  return openFindings
    .map(findingItem => ({ id: findingItem.id, decision: givenDecisions[findingItem.id] ?? givenDecisions[readCheckId(findingItem.id)] }))
    .filter(resolvedEntry => resolvedEntry.decision)
    .map(resolvedEntry => ({ id: resolvedEntry.id, action: resolvedEntry.decision.action, note: resolvedEntry.decision.note ?? "" }))
}

function readCheckId(findingId) {
  return findingId.slice(0, findingId.lastIndexOf("#"))
}

function listChecks(undecidedFindings, savedLibrary) {
  const checkIds = [...new Set(undecidedFindings.map(findingItem => readCheckId(findingItem.id)))]
  return checkIds.map(checkId => {
    const checkSpec = savedLibrary.checks[checkId]
    return {
      id: checkId,
      title: checkSpec.title ?? "",
      priority: checkSpec.priority ?? "",
      action: checkSpec.action ?? "",
      recommendation: checkSpec.recommendation ?? "",
    }
  })
}

function writeJson(filePath, jsonData) {
  return writeFile(filePath, JSON.stringify(jsonData, null, 2) + "\n")
}

function findTemplate(savedLibrary, templateId) {
  const reportSpec = savedLibrary.reports[templateId]
  if (!reportSpec) throw new Error(`No report template ${templateId}, pick one of: ${Object.keys(savedLibrary.reports).join(", ") || "none in the library"}`)
  return reportSpec.template
}

function buildPageView(auditId, auditData, decisionItems) {
  const decisionsById = Object.fromEntries(decisionItems.map(decisionItem => [decisionItem.id, decisionItem]))
  return {
    audit: { id: auditId, date: formatLocalDate(new Date()) },
    inputs: auditData.savedInputs.inputs,
    skips: auditData.savedInputs.skips,
    summary: countActions(auditData.findingItems, decisionsById),
    checks: Object.entries(auditData.savedLibrary.checks)
      .map(([checkId, checkSpec]) => buildCheckView(checkId, checkSpec, auditData, decisionsById)),
    library: auditData.savedLibrary,
    sources: auditData.sourceOutputs,
  }
}

function formatLocalDate(dateValue) {
  return [dateValue.getFullYear(), dateValue.getMonth() + 1, dateValue.getDate()].map(datePart => String(datePart).padStart(2, "0")).join("-")
}

function countActions(findingItems, decisionsById) {
  const actionCounts = {}
  for (const findingItem of findingItems) {
    const actionName = decisionsById[findingItem.id]?.action ?? "passed"
    actionCounts[actionName] = (actionCounts[actionName] ?? 0) + 1
  }
  return Object.entries(actionCounts).map(([actionName, actionCount]) => ({ action: actionName, count: actionCount }))
}

function buildCheckView(checkId, checkSpec, auditData, decisionsById) {
  const checkSources = (checkSpec.sources ?? []).map(sourceId => auditData.sourceOutputs[sourceId] ?? {})
  const findingViews = auditData.findingItems
    .filter(findingItem => readCheckId(findingItem.id) === checkId)
    .map(findingItem => ({
      ...findingItem,
      decision: decisionsById[findingItem.id] ?? { id: findingItem.id, action: "", note: "" },
      records: findingItem.evidence.map(evidenceId => buildRecordView(evidenceId, checkSources)),
    }))
  const openFindings = findingViews.filter(findingView => findingView.found !== "no")
  const referenceText = checkSpec.reference ?? ""
  return {
    ...checkSpec,
    id: checkId,
    referenceUrl: /^https?:\/\//.test(referenceText) ? referenceText : "",
    findings: findingViews,
    openFindings,
    isChecked: auditData.checkedIds.includes(checkId),
    hasOpenFindings: openFindings.length > 0,
    passedCount: findingViews.length - openFindings.length,
  }
}

function buildRecordView(evidenceId, checkSources) {
  const evidenceRecord = checkSources
    .flatMap(sourceOutput => Object.values(sourceOutput).flat())
    .find(sourceRecord => sourceRecord.id === evidenceId)
  return { id: evidenceId, record: evidenceRecord ?? {}, text: JSON.stringify(evidenceRecord ?? "Record not found", null, 2) }
}

function findPartial(savedLibrary, partialName) {
  const savedPartials = savedLibrary.partials ?? {}
  if (!savedPartials[partialName]) throw new Error(`No report partial ${partialName}, pick one of: ${Object.keys(savedPartials).join(", ") || "none in the library"}`)
  return savedPartials[partialName].template
}
