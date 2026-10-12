/**
 * In-Page Error Tracker (Runs in MAIN world).
 *
 * Directly hooks page context to catch:
 *   - React render errors & component boundary crashes
 *   - Astro island hydration errors ([astro-island] Error hydrating...)
 *   - shadcn / Radix / ReUI component lifecycle errors
 *   - Unhandled JavaScript exceptions & promise rejections
 *   - console.error & console.warn invocations
 */

;(() => {
  if (window.__CF_ERROR_TRACKER_INSTALLED__) return
  window.__CF_ERROR_TRACKER_INSTALLED__ = true

  const seenErrors = new Map() // message -> lastSeenMs

  function shouldReport(key) {
    const now = Date.now()
    const lastSeen = seenErrors.get(key)
    if (lastSeen && now - lastSeen < 2000) {
      return false // Debounce identical bursts
    }
    seenErrors.set(key, now)
    // Keep map small
    if (seenErrors.size > 200) {
      const oldestKey = seenErrors.keys().next().value
      seenErrors.delete(oldestKey)
    }
    return true
  }

  function emitError(detail) {
    const key = `${detail.category}:${detail.message}`
    if (!shouldReport(key)) return

    try {
      window.dispatchEvent(
        new CustomEvent('__cf_error_captured__', {
          detail: {
            ...detail,
            url: window.location.href,
            timestamp: Date.now()
          }
        })
      )
    } catch (e) {
      // Avoid recursive errors
    }
  }

  // 1. Unhandled runtime errors
  window.addEventListener('error', (event) => {
    // Ignore benign cross-origin script load errors without detail
    if (!event.message && !event.error) return

    let category = 'unhandled'
    const msg = event.message || (event.error ? String(event.error.message || event.error) : 'Script error')

    if (msg.includes('astro-island') || msg.includes('hydrate')) {
      category = 'astro-island'
    } else if (msg.includes('React') || msg.includes('Minified React error') || msg.includes('Hooks')) {
      category = 'react'
    } else if (msg.includes('radix') || msg.includes('reui') || msg.includes('shadcn')) {
      category = 'ui-library'
    }

    emitError({
      category,
      level: 'error',
      message: msg,
      stack: event.error?.stack || `${event.filename || 'unknown'}:${event.lineno}:${event.colno}`,
      metadata: {
        source: 'window.onerror',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      }
    })
  })

  // 2. Unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : JSON.stringify(reason || 'Unhandled Promise Rejection')

    let category = 'unhandled-promise'
    if (msg.includes('hydrate') || msg.includes('astro')) {
      category = 'astro-island'
    } else if (msg.includes('React')) {
      category = 'react'
    }

    emitError({
      category,
      level: 'error',
      message: msg,
      stack: reason instanceof Error ? reason.stack : null,
      metadata: {
        source: 'window.onunhandledrejection'
      }
    })
  })

  // 3. Intercept console.error & console.warn
  const origConsoleError = console.error.bind(console)
  console.error = function (...args) {
    origConsoleError(...args)

    try {
      const formatted = args
        .map((arg) => {
          if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`
          if (typeof arg === 'object' && arg !== null) {
            try {
              return JSON.stringify(arg)
            } catch {
              return String(arg)
            }
          }
          return String(arg)
        })
        .join(' ')

      // Categorize
      let category = 'console.error'
      if (formatted.includes('[astro-island]') || formatted.includes('Error hydrating')) {
        category = 'astro-island'
      } else if (
        formatted.includes('The above error occurred in the <') ||
        formatted.includes('Consider adding an error boundary') ||
        formatted.includes('Minified React error') ||
        formatted.includes('Hydration failed')
      ) {
        category = 'react'
      } else if (
        formatted.includes('@radix-ui') ||
        formatted.includes('@reui') ||
        formatted.includes('shadcn')
      ) {
        category = 'ui-library'
      }

      // Find stack from error object if passed
      const errObj = args.find((a) => a instanceof Error)
      const stack = errObj?.stack || (new Error().stack?.split('\n').slice(2).join('\n') ?? null)

      emitError({
        category,
        level: 'error',
        message: formatted,
        stack,
        metadata: {
          source: 'console.error'
        }
      })
    } catch {
      // Safe fallback
    }
  }

  // 4. Astro island monitoring for hydration failures
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'ssr') {
        const target = mutation.target
        if (target.nodeName.toLowerCase() === 'astro-island') {
          // Check if island failed
          const compUrl = target.getAttribute('component-url') || target.getAttribute('component-export')
          if (target.innerHTML.includes('Error') || target.getAttribute('props')?.includes('error')) {
            emitError({
              category: 'astro-island',
              level: 'error',
              message: `Astro island hydration failure: ${compUrl || 'unknown component'}`,
              stack: null,
              metadata: {
                islandUrl: compUrl,
                component: target.getAttribute('component-export')
              }
            })
          }
        }
      }
    }
  })

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['ssr', 'client']
  })

  // 5. Expose trigger helper for easy extension testing
  window.__triggerTestError__ = (customMsg) => {
    console.error(
      customMsg ||
        '[TEST ERROR] Simulating React / Astro island render failure on ' + window.location.href
    )
  }
})()
