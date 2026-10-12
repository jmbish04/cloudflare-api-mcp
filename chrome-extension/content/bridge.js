/**
 * Content Script Bridge (Runs in ISOLATED world).
 *
 * Bridges events from the page's MAIN world to the extension's background service worker.
 */

;(() => {
  window.addEventListener('__cf_error_captured__', (event) => {
    const detail = event.detail
    if (!detail) return

    try {
      chrome.runtime.sendMessage({
        type: 'CAPTURED_ERROR',
        payload: detail
      }).catch(() => {
        // Service worker may be asleep or re-initializing
      })
    } catch (e) {
      // Ignore
    }
  })

  // Listen for actions from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TRIGGER_TEST_ERROR') {
      window.dispatchEvent(
        new CustomEvent('__cf_error_captured__', {
          detail: {
            category: 'test',
            level: 'error',
            message: message.customMessage || '[TEST ERROR] Verified browser extension error capture pipeline',
            stack: new Error().stack,
            url: window.location.href,
            timestamp: Date.now(),
            metadata: { trigger: 'user-initiated-test' }
          }
        })
      )
      sendResponse({ success: true })
    }
    return true
  })
})()
