import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { chromium } from "playwright"

const FILE_PATTERN = /\.(pdf|zip|jpe?g|png|gif|svg|webp|mp4|mp3|docx?|xlsx?|pptx?|csv)$/i
const BUTTON_SELECTOR = "button, a, [role=button], input[type=button], input[type=submit]"
const BOX_PATTERN = /cookie|consent|gdpr|onetrust|optanon|cybot|didomi|usercentrics|cky-|truste|qc-cmp|cmpbox|cmpwrapper|cmplz|iubenda|osano|termly/i
const DEFAULT_LIMIT = 5
const PAGE_TIMEOUT = 30000
const CLICK_TIMEOUT = 5000
const TAG_WAIT = 3000
const TEXT_LENGTH = 80
const WORK_FOLDER = process.env.WORKDIR
const commandArgs = readCommandArgs()
const startUrl = parseStartUrl(commandArgs.url)
const pageLimit = Number(commandArgs.limit) || DEFAULT_LIMIT
const visitRecords = await visitSite(startUrl, pageLimit, commandArgs.accept).catch(exitWithError)

if (visitRecords.pageRecords[0].error) exitWithReason(`${startUrl.href}: ${visitRecords.pageRecords[0].error}`)
await writeJson(join(WORK_FOLDER, "pages.json"), visitRecords.pageRecords)
await writeJson(join(WORK_FOLDER, "requests.json"), visitRecords.requestRecords)
await writeJson(join(WORK_FOLDER, "buttons.json"), visitRecords.buttonRecords)

function readCommandArgs() {
  return parseArgs({ options: { url: { type: "string" }, limit: { type: "string" }, accept: { type: "string" } } }).values
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

async function visitSite(startUrl, pageLimit, acceptSelector) {
  const visitRecords = { pageRecords: [], requestRecords: [], buttonRecords: [], isRecording: !acceptSelector }
  const pageQueue = [startUrl.href]
  const seenUrls = new Set(pageQueue)
  const headlessBrowser = await chromium.launch()
  const browserContext = await headlessBrowser.newContext()
  let siteOrigin = null

  while (pageQueue.length && visitRecords.pageRecords.length < pageLimit && !visitRecords.pageRecords[0]?.error) {
    const pageVisit = await visitPage(browserContext, pageQueue.shift(), visitRecords, acceptSelector)
    siteOrigin ??= pageVisit.finalOrigin
    const newLinks = pageVisit.linkHrefs.filter(linkHref => !seenUrls.has(linkHref) && isSiteLink(linkHref, siteOrigin))
    newLinks.forEach(linkHref => seenUrls.add(linkHref))
    pageQueue.push(...newLinks)
  }

  await headlessBrowser.close()
  return visitRecords
}

async function visitPage(browserContext, pageHref, visitRecords, acceptSelector) {
  const pageUrl = new URL(pageHref)
  const pageRecord = { id: `page#${visitRecords.pageRecords.length + 1}`, path: pageUrl.pathname + pageUrl.search, error: "" }
  const isFirstPage = !visitRecords.pageRecords.length
  const browserTab = await browserContext.newPage()
  visitRecords.pageRecords.push(pageRecord)
  browserTab.on("request", browserRequest => {
    if (visitRecords.isRecording) visitRecords.requestRecords.push(buildRequestRecord(browserRequest, pageRecord.id, visitRecords.requestRecords.length))
  })

  try {
    const pageResponse = await browserTab.goto(pageUrl.href, { waitUntil: "load", timeout: PAGE_TIMEOUT })
    await browserTab.waitForTimeout(TAG_WAIT)
    pageRecord.error = describeHttpError(pageResponse)
    await writeLog(`${pageRecord.id} ${pageUrl.href} ${pageRecord.error}`)
    if (isFirstPage) visitRecords.buttonRecords.push(...await readButtons(browserTab))
    if (isFirstPage && acceptSelector) await clickAccept(browserTab, acceptSelector, visitRecords)
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
  return appendFile(join(WORK_FOLDER, "visit.log"), `${new Date().toISOString()} ${logLine}\n`)
}

async function readButtons(browserTab) {
  const buttonInfos = await browserTab.locator(BUTTON_SELECTOR).evaluateAll((buttonElements, boxSource) => {
    const boxPattern = new RegExp(boxSource, "i")
    return buttonElements.filter(buttonElement => buttonElement.checkVisibility()).map(buttonElement => {
      let parentElement = buttonElement.parentElement ?? buttonElement.getRootNode().host
      let boxName = ""
      while (parentElement && !boxName) {
        const elementName = `${parentElement.id} ${parentElement.getAttribute("class") ?? ""}`
        if (boxPattern.test(elementName)) boxName = parentElement.id ? `#${parentElement.id}` : elementName.trim()
        parentElement = parentElement.parentElement ?? parentElement.getRootNode().host
      }
      return {
        tagName: buttonElement.tagName.toLowerCase(),
        elementId: buttonElement.id,
        testId: buttonElement.getAttribute("data-testid") ?? "",
        buttonText: (buttonElement.innerText || buttonElement.value || buttonElement.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
        boxName,
      }
    })
  }, BOX_PATTERN.source)
  return buttonInfos
    .filter(buttonInfo => buttonInfo.buttonText && (buttonInfo.tagName !== "a" || buttonInfo.boxName))
    .map((buttonInfo, buttonIndex) => ({
      id: `button#${buttonIndex + 1}`,
      text: buttonInfo.buttonText.slice(0, TEXT_LENGTH),
      selector: buildSelector(buttonInfo),
      box: buttonInfo.boxName.slice(0, TEXT_LENGTH),
    }))
}

function buildSelector(buttonInfo) {
  if (/^[A-Za-z][\w-]*$/.test(buttonInfo.elementId)) return `#${buttonInfo.elementId}`
  if (buttonInfo.elementId) return `[id="${buttonInfo.elementId.replace(/"/g, '\\"')}"]`
  if (buttonInfo.testId) return `[data-testid="${buttonInfo.testId.replace(/"/g, '\\"')}"]`
  return `${buttonInfo.tagName}:has-text("${buttonInfo.buttonText.slice(0, TEXT_LENGTH).replace(/"/g, '\\"')}")`
}

async function clickAccept(browserTab, acceptSelector, visitRecords) {
  visitRecords.isRecording = true
  await browserTab.locator(acceptSelector).first().click({ timeout: CLICK_TIMEOUT }).catch(() => {
    throw new Error(`Accept button ${acceptSelector} not found or not clickable`)
  })
  await browserTab.waitForTimeout(TAG_WAIT)
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

async function exitWithError(visitError) {
  await writeLog(visitError.stack)
  exitWithReason(visitError.message.split("\n")[0])
}

function writeJson(filePath, jsonData) {
  return writeFile(filePath, JSON.stringify(jsonData, null, 2) + "\n")
}
