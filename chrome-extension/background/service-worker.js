/**
 * Background Service Worker (Manifest V3).
 *
 * Ephemeral event-driven background processor.
 * Receives captured errors from content scripts, updates action badge,
 * stores recent logs in chrome.storage.local, and automatically POSTs to
 * the Cloudflare Worker API endpoint at /api/logs.
 */

const DEFAULT_API_URL = 'https://cloudflare-api-mcp.hacolby.workers.dev'
const DEFAULT_API_KEY = '4156582389'

// Initialize default settings on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['apiUrl', 'apiKey', 'autoPost', 'errorCount', 'recentLogs'])
  await chrome.storage.local.set({
    apiUrl: existing.apiUrl || DEFAULT_API_URL,
    apiKey: existing.apiKey || DEFAULT_API_KEY,
    autoPost: existing.autoPost !== false,
    errorCount: existing.errorCount || 0,
    recentLogs: existing.recentLogs || []
  })
})

/**
 * Send captured error to Cloudflare Worker endpoint
 */
async function postErrorToWorker(errorPayload) {
  const { apiUrl = DEFAULT_API_URL, apiKey = DEFAULT_API_KEY, autoPost = true } =
    await chrome.storage.local.get(['apiUrl', 'apiKey', 'autoPost'])

  if (!autoPost) {
    return { skipped: true, reason: 'autoPost disabled in settings' }
  }

  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/logs`

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Api-Key': apiKey
      },
      body: JSON.stringify({
        url: errorPayload.url,
        message: errorPayload.message,
        stack: errorPayload.stack,
        level: errorPayload.level || 'error',
        metadata: {
          category: errorPayload.category,
          capturedAt: new Date(errorPayload.timestamp || Date.now()).toISOString(),
          ...errorPayload.metadata
        },
        timestamp: errorPayload.timestamp || Date.now()
      })
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      return { success: false, status: resp.status, error: errText }
    }

    const data = await resp.json().catch(() => ({}))
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURED_ERROR') {
    ;(async () => {
      const payload = message.payload
      const { recentLogs = [], errorCount = 0 } = await chrome.storage.local.get([
        'recentLogs',
        'errorCount'
      ])

      const newCount = errorCount + 1
      const logEntry = {
        id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        ...payload,
        posted: false
      }

      // Post to Worker API
      const postResult = await postErrorToWorker(payload)
      logEntry.posted = postResult.success === true
      logEntry.postResult = postResult

      // Update recent logs list (keep last 50)
      const updatedLogs = [logEntry, ...recentLogs].slice(0, 50)

      await chrome.storage.local.set({
        errorCount: newCount,
        recentLogs: updatedLogs
      })

      // Update badge
      await chrome.action.setBadgeText({ text: String(newCount) })
      await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' })

      sendResponse({ success: true, count: newCount, postResult })
    })()
    return true // Keep channel open for async response
  }

  if (message.type === 'CLEAR_LOGS') {
    ;(async () => {
      await chrome.storage.local.set({
        errorCount: 0,
        recentLogs: []
      })
      await chrome.action.setBadgeText({ text: '' })
      sendResponse({ success: true })
    })()
    return true
  }

  if (message.type === 'TEST_CONNECTION') {
    ;(async () => {
      const { apiUrl = DEFAULT_API_URL } = await chrome.storage.local.get(['apiUrl'])
      try {
        const healthUrl = `${apiUrl.replace(/\/$/, '')}/health`
        const resp = await fetch(healthUrl)
        const data = await resp.json().catch(() => ({}))
        sendResponse({ success: resp.ok, status: resp.status, data })
      } catch (err) {
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return true
  }

  return false
})
