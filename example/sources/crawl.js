import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { chromium } from "playwright"

const FILE_PATTERN = /\.(pdf|zip|jpe?g|png|gif|svg|webp|mp4|mp3|docx?|xlsx?|pptx?|csv)$/i
const DEFAULT_LIMIT = 20
const PAGE_TIMEOUT = 30000
const TAG_WAIT = 3000
const WORK_FOLDER = process.env.WORKDIR
const commandArgs = readCommandArgs()
const startUrl = parseStartUrl(commandArgs.url)
const pageLimit = Number(commandArgs.limit) || DEFAULT_LIMIT
const crawlRecords = await crawlSite(startUrl, pageLimit).catch(exitWithError)

if (crawlRecords.pageRecords[0].error) exitWithReason(`Could not open ${startUrl.href}: ${crawlRecords.pageRecords[0].error}`)
await writeJson(join(WORK_FOLDER, "pages.json"), crawlRecords.pageRecords)
await writeJson(join(WORK_FOLDER, "requests.json"), crawlRecords.requestRecords)

function readCommandArgs() {
  return parseArgs({ options: { url: { type: "string" }, limit: { type: "string" } } }).values
}

function parseStartUrl(rawUrl) {
  try {
    return new URL(/^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
  } catch {
    exitWithReason(`Not a url: ${rawUrl}`)
  }
}

function exitWithReason(failReason) {
  process.stderr.write(`${failReason}\n`)
  process.exit(1)
}

async function crawlSite(startUrl, pageLimit) {
  const crawlRecords = { pageRecords: [], requestRecords: [] }
  const pageQueue = [startUrl.href]
  const seenUrls = new Set(pageQueue)
  const headlessBrowser = await chromium.launch()
  const browserContext = await headlessBrowser.newContext()
  let siteOrigin = null

  while (pageQueue.length && crawlRecords.pageRecords.length < pageLimit) {
    const pageVisit = await visitPage(browserContext, pageQueue.shift(), crawlRecords)
    siteOrigin ??= pageVisit.finalOrigin
    const newLinks = pageVisit.linkHrefs.filter(linkHref => !seenUrls.has(linkHref) && isSiteLink(linkHref, siteOrigin))
    newLinks.forEach(linkHref => seenUrls.add(linkHref))
    pageQueue.push(...newLinks)
  }

  await headlessBrowser.close()
  return crawlRecords
}

async function visitPage(browserContext, pageHref, crawlRecords) {
  const pageUrl = new URL(pageHref)
  const pageRecord = { id: `page#${crawlRecords.pageRecords.length + 1}`, path: pageUrl.pathname + pageUrl.search, error: "" }
  const browserTab = await browserContext.newPage()
  crawlRecords.pageRecords.push(pageRecord)
  browserTab.on("request", browserRequest =>
    crawlRecords.requestRecords.push(buildRequestRecord(browserRequest, pageRecord.id, crawlRecords.requestRecords.length)))

  try {
    const pageResponse = await browserTab.goto(pageUrl.href, { waitUntil: "load", timeout: PAGE_TIMEOUT })
    await browserTab.waitForTimeout(TAG_WAIT)
    pageRecord.error = describeHttpError(pageResponse)
    await writeLog(`${pageRecord.id} ${pageUrl.href} ${pageRecord.error}`)
    return { finalOrigin: new URL(browserTab.url()).origin, linkHrefs: await readLinkHrefs(browserTab) }
  } catch (pageError) {
    pageRecord.error = pageError.message.split("\n")[0]
    await writeLog(`${pageRecord.id} ${pageUrl.href} ${pageError.stack}`)
    return { finalOrigin: null, linkHrefs: [] }
  } finally {
    await browserTab.goto("about:blank").catch(() => {})
    await browserTab.close()
  }
}

function buildRequestRecord(browserRequest, pageId, requestCount) {
  return { id: `req#${requestCount + 1}`, page: pageId, url: browserRequest.url(), body: browserRequest.postData() ?? "" }
}

function describeHttpError(pageResponse) {
  const statusCode = pageResponse?.status() ?? 0
  return statusCode >= 400 ? `HTTP ${statusCode}` : ""
}

function writeLog(logLine) {
  return appendFile(join(WORK_FOLDER, "crawl.log"), `${new Date().toISOString()} ${logLine}\n`)
}

async function readLinkHrefs(browserTab) {
  const anchorHrefs = await browserTab.$$eval("a[href]", anchorElements => anchorElements.map(anchorElement => anchorElement.href))
  return [...new Set(anchorHrefs.map(removeHash).filter(Boolean))]
}

function removeHash(anchorHref) {
  try {
    const linkUrl = new URL(anchorHref)
    linkUrl.hash = ""
    return linkUrl.href
  } catch {
    return ""
  }
}

function isSiteLink(linkHref, siteOrigin) {
  const linkUrl = new URL(linkHref)
  return linkUrl.origin === siteOrigin && !FILE_PATTERN.test(linkUrl.pathname)
}

async function exitWithError(crawlError) {
  await writeLog(crawlError.stack)
  exitWithReason(crawlError.message.split("\n")[0])
}

function writeJson(filePath, jsonData) {
  return writeFile(filePath, JSON.stringify(jsonData, null, 2) + "\n")
}
