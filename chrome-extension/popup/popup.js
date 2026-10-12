/**
 * ReUI Cloudflare Worker Error Watcher Dashboard Controller.
 * Provides per-worker error grouping, single-click copy for all errors,
 * and per-worker Markdown blocks tailored for AI coding agents.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const errorCountBadge = document.getElementById('errorCountBadge')
  const workerListEl = document.getElementById('workerList')
  const btnCopyAll = document.getElementById('btnCopyAll')
  const btnTest = document.getElementById('btnTest')
  const btnClear = document.getElementById('btnClear')
  const btnToggleSettings = document.getElementById('btnToggleSettings')
  const settingsDrawer = document.getElementById('settingsDrawer')
  const apiUrlInput = document.getElementById('apiUrl')
  const apiKeyInput = document.getElementById('apiKey')
  const autoPostInput = document.getElementById('autoPost')
  const btnSaveSettings = document.getElementById('btnSaveSettings')
  const btnTestConn = document.getElementById('btnTestConn')
  const connStatusEl = document.getElementById('connStatus')

  let currentLogs = []

  // Load state from storage
  async function loadState() {
    const data = await chrome.storage.local.get([
      'apiUrl',
      'apiKey',
      'autoPost',
      'errorCount',
      'recentLogs'
    ])

    apiUrlInput.value = data.apiUrl || 'https://cloudflare-api-mcp.hacolby.workers.dev'
    apiKeyInput.value = data.apiKey || '4156582389'
    autoPostInput.checked = data.autoPost !== false

    currentLogs = data.recentLogs || []
    const totalCount = currentLogs.length

    errorCountBadge.textContent = `${totalCount} Error${totalCount === 1 ? '' : 's'}`
    btnCopyAll.disabled = totalCount === 0

    renderWorkerGroups(currentLogs)
  }

  // Extract worker name from URL
  function extractWorkerInfo(urlStr) {
    try {
      const parsed = new URL(urlStr)
      const hostname = parsed.hostname
      let workerName = hostname
        .replace(/\.hacolby\.workers\.dev$/i, '')
        .replace(/\.hacolby\.app$/i, '')

      return {
        workerName: workerName || hostname,
        hostname: hostname,
        pathname: parsed.pathname
      }
    } catch {
      return {
        workerName: urlStr || 'unknown-worker',
        hostname: urlStr || 'unknown-host',
        pathname: ''
      }
    }
  }

  // Group logs by worker hostname
  function groupLogsByWorker(logs) {
    const groups = {}
    for (const log of logs) {
      const { hostname, workerName } = extractWorkerInfo(log.url)
      const key = hostname
      if (!groups[key]) {
        groups[key] = {
          hostname,
          workerName,
          logs: []
        }
      }
      groups[key].logs.push(log)
    }
    return Object.values(groups)
  }

  // Format single error into markdown
  function formatErrorMarkdown(log, idx) {
    const timeStr = new Date(log.timestamp || Date.now()).toISOString()
    const category = log.category || 'console-error'

    let md = `#### Error ${idx + 1} [${category}]\n`
    md += `- **Timestamp:** ${timeStr}\n`
    md += `- **Page URL:** ${log.url}\n`
    md += `- **Message:** ${log.message}\n`

    if (log.metadata && Object.keys(log.metadata).length > 0) {
      md += `- **Metadata:** \`${JSON.stringify(log.metadata)}\`\n`
    }

    if (log.stack) {
      md += `\n**Stack Trace:**\n\`\`\`text\n${log.stack}\n\`\`\`\n`
    } else {
      md += `\n*No stack trace available*\n`
    }

    return md
  }

  // Format all errors for a single worker into markdown
  function formatWorkerMarkdown(group) {
    let md = `## Cloudflare Worker Errors: ${group.workerName}\n`
    md += `- **Host:** ${group.hostname}\n`
    md += `- **Total Errors:** ${group.logs.length}\n`
    md += `- **Report Generated:** ${new Date().toISOString()}\n\n`

    group.logs.forEach((log, i) => {
      md += formatErrorMarkdown(log, i) + '\n---\n\n'
    })

    return md
  }

  // Format ALL errors across all workers into markdown
  function formatAllErrorsMarkdown(logs) {
    const groups = groupLogsByWorker(logs)
    let md = `# Cloudflare Worker Console Errors Report for AI Coding Agent\n\n`
    md += `> Paste this report to your coding agent to fix runtime and build errors across Cloudflare Workers.\n\n`
    md += `- **Total Monitored Errors:** ${logs.length}\n`
    md += `- **Total Affected Workers:** ${groups.length}\n`
    md += `- **Timestamp:** ${new Date().toISOString()}\n\n`

    groups.forEach((group) => {
      md += `============================================================\n`
      md += formatWorkerMarkdown(group)
    })

    return md
  }

  // Copy text to clipboard with button feedback
  async function copyToClipboard(text, btnElement, defaultLabel = '📋 Copy') {
    try {
      await navigator.clipboard.writeText(text)
      const prevHtml = btnElement.innerHTML
      btnElement.innerHTML = '✓ Copied!'
      btnElement.classList.add('reui-badge-success-light')
      setTimeout(() => {
        btnElement.innerHTML = prevHtml
        btnElement.classList.remove('reui-badge-success-light')
      }, 2200)
    } catch (err) {
      console.error('Clipboard copy failed:', err)
      alert('Failed to copy to clipboard')
    }
  }

  // Render logs grouped by worker
  function renderWorkerGroups(logs) {
    if (!logs || logs.length === 0) {
      workerListEl.innerHTML = `
        <div class="reui-empty-state">
          <div class="reui-empty-icon">🛡️</div>
          <h3 class="reui-empty-title">All Workers Healthy</h3>
          <p class="reui-empty-desc">No errors detected on *.hacolby.workers.dev or *.hacolby.app. React crashes, Astro island hydration errors, and unhandled exceptions will appear here.</p>
        </div>
      `
      return
    }

    workerListEl.innerHTML = ''
    const groups = groupLogsByWorker(logs)

    groups.forEach((group) => {
      const frame = document.createElement('div')
      frame.className = 'reui-frame'

      const header = document.createElement('div')
      header.className = 'reui-frame-header'

      const titleGroup = document.createElement('div')
      titleGroup.className = 'reui-frame-title-group'

      const title = document.createElement('h3')
      title.className = 'reui-frame-title'
      title.innerHTML = `
        <span>⚡ ${escapeHtml(group.workerName)}</span>
        <span class="reui-badge reui-badge-destructive-light">${group.logs.length} ${group.logs.length === 1 ? 'Error' : 'Errors'}</span>
      `

      const desc = document.createElement('span')
      desc.className = 'reui-frame-description'
      desc.textContent = group.hostname

      titleGroup.appendChild(title)
      titleGroup.appendChild(desc)

      const actions = document.createElement('div')
      actions.className = 'reui-frame-actions'

      const btnCopyWorker = document.createElement('button')
      btnCopyWorker.className = 'reui-btn reui-btn-secondary reui-btn-xs'
      btnCopyWorker.innerHTML = '📋 Copy Worker Errors'
      btnCopyWorker.title = `Copy all ${group.logs.length} errors for ${group.workerName} as one block for AI`
      btnCopyWorker.addEventListener('click', () => {
        const markdown = formatWorkerMarkdown(group)
        copyToClipboard(markdown, btnCopyWorker, '📋 Copy Worker Errors')
      })

      actions.appendChild(btnCopyWorker)
      header.appendChild(titleGroup)
      header.appendChild(actions)

      const panel = document.createElement('div')
      panel.className = 'reui-frame-panel'

      group.logs.forEach((log, idx) => {
        const item = document.createElement('div')
        item.className = 'reui-error-item'

        const timeStr = new Date(log.timestamp || Date.now()).toLocaleTimeString()
        const category = log.category || 'error'

        const badgeVariant =
          category === 'react'
            ? 'reui-badge-destructive-light'
            : category === 'astro-island'
            ? 'reui-badge-warning-light'
            : 'reui-badge-info-light'

        const syncBadge = log.posted
          ? `<span class="reui-badge reui-badge-success-light">✓ D1</span>`
          : `<span class="reui-badge reui-badge-outline">Local</span>`

        const singleErrorMd = formatErrorMarkdown(log, idx)

        item.innerHTML = `
          <div class="reui-error-header">
            <div class="reui-error-badges">
              <span class="reui-badge ${badgeVariant}">${category}</span>
              ${syncBadge}
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="reui-error-time">${timeStr}</span>
              <button class="reui-btn reui-btn-ghost reui-btn-xs btn-copy-single" title="Copy single error">📋</button>
            </div>
          </div>
          <div class="reui-error-msg">${escapeHtml(log.message)}</div>
          <div class="reui-error-url">${escapeHtml(log.url)}</div>
          ${
            log.stack
              ? `
            <div class="reui-code-block">
              <div class="reui-code-header">
                <span>Stack Trace</span>
              </div>
              <pre class="reui-code-content"><code>${escapeHtml(log.stack)}</code></pre>
            </div>
          `
              : ''
          }
        `

        const btnCopySingle = item.querySelector('.btn-copy-single')
        btnCopySingle?.addEventListener('click', (e) => {
          e.stopPropagation()
          copyToClipboard(singleErrorMd, btnCopySingle, '📋')
        })

        panel.appendChild(item)
      })

      frame.appendChild(header)
      frame.appendChild(panel)
      workerListEl.appendChild(frame)
    })
  }

  function escapeHtml(str) {
    if (!str) return ''
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  // Copy All Errors Button
  btnCopyAll.addEventListener('click', () => {
    if (currentLogs.length === 0) return
    const allMarkdown = formatAllErrorsMarkdown(currentLogs)
    copyToClipboard(allMarkdown, btnCopyAll, '📋 Copy All')
  })

  // Toggle settings drawer
  btnToggleSettings.addEventListener('click', () => {
    settingsDrawer.classList.toggle('hidden')
  })

  // Save settings
  btnSaveSettings.addEventListener('click', async () => {
    const apiUrl = apiUrlInput.value.trim()
    const apiKey = apiKeyInput.value.trim()
    const autoPost = autoPostInput.checked

    await chrome.storage.local.set({ apiUrl, apiKey, autoPost })
    connStatusEl.textContent = '✓ Configuration saved!'
    connStatusEl.className = 'reui-conn-status ok'
    setTimeout(() => {
      connStatusEl.textContent = ''
    }, 2200)
  })

  // Test connection
  btnTestConn.addEventListener('click', async () => {
    connStatusEl.textContent = 'Testing connection...'
    connStatusEl.className = 'reui-conn-status'

    const response = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' })
    if (response?.success) {
      connStatusEl.textContent = '✓ Connected to Cloudflare Worker API'
      connStatusEl.className = 'reui-conn-status ok'
    } else {
      connStatusEl.textContent = `✗ Failed: ${response?.error || 'Worker unreachable'}`
      connStatusEl.className = 'reui-conn-status err'
    }
  })

  // Clear logs
  btnClear.addEventListener('click', async () => {
    if (confirm('Clear all recorded error logs?')) {
      await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' })
      await loadState()
    }
  })

  // Test error trigger on active tab
  btnTest.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) {
        alert('No active tab found')
        return
      }

      await chrome.tabs.sendMessage(tab.id, {
        type: 'TRIGGER_TEST_ERROR',
        customMessage: `[TEST ERROR] Simulated React / Astro island render failure on ${tab.url || 'current tab'}`
      })

      setTimeout(loadState, 500)
    } catch (err) {
      alert('Could not inject test error into active tab. Ensure you are on a page matching *.hacolby.workers.dev or *.hacolby.app.')
    }
  })

  // Realtime storage update listener
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.recentLogs || changes.errorCount) {
      loadState()
    }
  })

  // Initial load
  await loadState()
})
