import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

function ensureUnhandledRejectionsWarn() {
  try {
    const cur = String(process.env.NODE_OPTIONS || '').trim()
    if (!/--unhandled-rejections=/.test(cur)) {
      process.env.NODE_OPTIONS = (cur ? `${cur} ` : '') + '--unhandled-rejections=warn'
    }
  } catch {
    // ignore
  }
}
ensureUnhandledRejectionsWarn()

// Ensure we always restore any temporary registry/xml changes even when Node sees an unhandled rejection.
// This can happen on some machines due to WPS registry quirks or child-process launch failures.
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[wpsjs-debug] unhandledRejection:', reason)
  } catch {
    // ignore
  }
  try {
    restoreJspluginsXml()
    restorePackageJson()
  } catch {
    // ignore
  }
  // Preserve Node default non-zero exit behavior for unhandled rejections.
  process.exitCode = 1
})
process.on('uncaughtException', (err) => {
  try {
    console.error('[wpsjs-debug] uncaughtException:', err)
  } catch {
    // ignore
  }
  try {
    restoreJspluginsXml()
    restorePackageJson()
  } catch {
    // ignore
  }
  process.exit(1)
})

function normalizeHost(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (v === 'all') return 'all'
  if (v === 'wps') return 'wps'
  if (v === 'et' || v === 'ex' || v === 'excel' || v === 'sheet' || v === 'spreadsheet') return 'et'
  if (v === 'wpp' || v === 'ppt' || v === 'pptx' || v === 'powerpoint' || v === 'presentation') return 'wpp'
  return null
}

const target = normalizeHost(process.argv[2]) || 'wps'
const addonTypeForWpsjs = target === 'all' ? 'wps' : target

const pkgPath = path.resolve(process.cwd(), 'package.json')
const originalText = fs.readFileSync(pkgPath, 'utf8')
const originalJson = JSON.parse(originalText)

let restored = false
let jspluginsRestored = false
let jspluginsFiles = [] // [{ filePath, originalText }]
let publishFiles = [] // [{ filePath, originalText }]
let pinnedKeepAliveTimer = null
let regTouched = false
let regRestored = false
let regBackup = null

function ensureTrailingSlash(u) {
  const s = String(u || '').trim()
  if (!s) return s
  return s.endsWith('/') ? s : (s + '/')
}

function resolveDevUrl() {
  const override = String(process.env.BID_WPSJS_URL || '').trim()
  if (override) return ensureTrailingSlash(override)

  // Prefer wpsjs.config.js port (wpsjs debug uses its own dev server, not Vite's 3889).
  try {
    const cfgPath = path.resolve(process.cwd(), 'wpsjs.config.js')
    if (fs.existsSync(cfgPath)) {
      const txt = fs.readFileSync(cfgPath, 'utf8')
      const m = txt.match(/port\\s*:\\s*(\\d+)/)
      if (m && m[1]) return `http://127.0.0.1:${Number(m[1])}/`
    }
  } catch {
    // ignore
  }

  return 'http://127.0.0.1:3889/'
}

function readManifestName() {
  try {
    const candidates = [
      // Some repos keep manifest at the project root.
      path.resolve(process.cwd(), 'manifest.xml'),
      // This repo outputs the WPS plugin to wps-plugin/.
      path.resolve(process.cwd(), 'wps-plugin', 'manifest.xml'),
    ]
    let txt = ''
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          txt = fs.readFileSync(p, 'utf8')
          if (txt) break
        }
      } catch {
        // try next
      }
    }
    if (!txt) return ''

    // Use RegExp(string) to avoid any parser ambiguity around `/<Name>.../` in newer Node runtimes.
    const re = new RegExp('<Name>\\\\s*([^<]+)\\\\s*<\\\\/Name>', 'i')
    const m = txt.match(re)
    return m && m[1] ? String(m[1]).trim() : ''
  } catch {
    return ''
  }
}

function _escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function _removeOurEntriesFromXml(xmlText, namesToRemove) {
  const names = (namesToRemove || []).map((n) => String(n || '').trim()).filter(Boolean)
  if (!xmlText || names.length === 0) return xmlText
  // Match both single/double quotes; keep other plugins intact.
  const re = new RegExp(
    `<jspluginonline\\b[^>]*\\bname\\s*=\\s*(['\"])(${names.map(_escapeRegExp).join('|')})\\1[^>]*/?>\\s*\\n?`,
    'gi'
  )
  return String(xmlText).replace(re, '')
}

function _ensureXmlRoot(xmlText) {
  const s = String(xmlText || '').trim()
  if (!s) return { header: `<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n`, footer: `</jsplugins>\n`, body: '' }
  const m = s.match(/^(.*?<jsplugins>)([\s\S]*?)(<\/jsplugins>.*)$/i)
  if (!m) return { header: `<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n`, footer: `</jsplugins>\n`, body: '' }
  return { header: m[1] + '\n', body: m[2] || '', footer: '\n' + m[3] + '\n' }
}

function _upsertDevEntries({ filePath, addinId, url, types, publish }) {
  try {
    if (!filePath) return
    const legacyNames = Array.from(new Set([String(originalJson?.name || '').trim(), 'Ah32'].filter(Boolean)))
    let txt = ''
    try {
      txt = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
    } catch {
      txt = ''
    }
    const originalFileText = txt

    // Remove our current + legacy entries first (prevents duplicate entrances).
    txt = _removeOurEntriesFromXml(txt, [addinId, ...legacyNames])
    const { header, body, footer } = _ensureXmlRoot(txt)

    const lines = []
    for (const t of types || []) {
      const type = String(t || '').trim()
      if (!type) continue
      if (publish) {
        lines.push(`  <jspluginonline name="${addinId}" type="${type}" url="${url}" enable="enable_dev" install="null" />`)
      } else {
        lines.push(`  <jspluginonline name="${addinId}" type="${type}" url="${url}" />`)
      }
    }

    const next = `${header}${(body || '').trim() ? (body.trim() + '\n') : ''}${lines.join('\n')}\n${footer}`
    // Avoid touching the file when no content change is needed. This is important because some WPS builds
    // may reload addins when jsplugins.xml/publish.xml timestamp changes (causing taskpane "flash/reload").
    if (originalFileText === next) return
    ensureDir(filePath)
    fs.writeFileSync(filePath, next, 'utf8')
  } catch {
    // ignore
  }
}

function restorePackageJson() {
  if (restored) return
  restored = true
  try {
    // wpsjs debug may mutate scripts in package.json. Restore the exact original.
    fs.writeFileSync(pkgPath, originalText, 'utf8')
  } catch {
    // ignore
  }

  // Restore temporary HKCU AddinEngines pins (needed on some WPS builds for ET/WPP).
  try {
    if (regTouched && !regRestored && Array.isArray(regBackup) && process.platform === 'win32') {
      regRestored = true
      for (const item of regBackup) {
        const key = item.key
        if (!item.existed) {
          spawnSync('reg', ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore' })
          continue
        }

        if (item.pathValue == null) {
          spawnSync('reg', ['delete', key, '/v', 'Path', '/f'], { windowsHide: true, stdio: 'ignore' })
        } else {
          spawnSync('reg', ['add', key, '/v', 'Path', '/t', 'REG_SZ', '/d', item.pathValue, '/f'], { windowsHide: true, stdio: 'ignore' })
        }

        if (item.typeValue == null) {
          spawnSync('reg', ['delete', key, '/v', 'Type', '/f'], { windowsHide: true, stdio: 'ignore' })
        } else {
          spawnSync('reg', ['add', key, '/v', 'Type', '/t', 'REG_SZ', '/d', item.typeValue, '/f'], { windowsHide: true, stdio: 'ignore' })
        }
      }
    }
  } catch {
    // ignore
  }
}

function resolveJspluginsPath(host = 'wps') {
  const appdata = process.env.APPDATA
  if (!appdata) return null
  // WPS JSAPI addins are discovered from a single jsplugins.xml on Windows:
  // %APPDATA%\\kingsoft\\wps\\jsaddons\\jsplugins.xml
  // (wpsjs uses this path too). The <jspluginonline type="et|wpp"> entries
  // control which host loads the addin.
  return path.resolve(appdata, 'kingsoft', 'wps', 'jsaddons', 'jsplugins.xml')
}

function resolvePublishPath(host = 'wps') {
  const appdata = process.env.APPDATA
  if (!appdata) return null
  return path.resolve(appdata, 'kingsoft', 'wps', 'jsaddons', 'publish.xml')
}

function execRegQuery(regKey) {
  // Windows only; returns the raw value string from `reg query ... /ve`.
  return new Promise((resolve, reject) => {
    const child = spawn('reg', ['query', regKey, '/ve'], { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(err || `reg query failed: ${regKey}`))
      resolve(out)
    })
  })
}

function parseRegDefaultValue(text) {
  // Typical output:
  // HKEY_...\n    (Default)    REG_SZ    "C:\\...\\wps.exe" /prometheus /et /t "%1"\n
  const lines = String(text || '').split(/\r?\n/)
  for (const line of lines) {
    if (line.includes('REG_SZ')) {
      const parts = line.split('REG_SZ')
      if (parts.length >= 2) return parts.slice(1).join('REG_SZ').trim()
    }
  }
  return ''
}

function splitExeAndArgs(cmdline) {
  let s = String(cmdline || '').trim()
  if (!s) return null
  // Remove "%1" placeholders like wpsjs does.
  s = s.replace(/\"%1\"/g, '').replace(/\s%1/g, '').trim()

  let exe = ''
  let rest = ''
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 1) {
      exe = s.slice(1, end)
      rest = s.slice(end + 1).trim()
    }
  } else {
    // Some registry values forget to quote paths with spaces. Prefer a ".exe" split.
    const mExe = s.match(/^(.+?\.exe)(?:\s+(.*))?$/i)
    if (mExe && mExe[1]) {
      exe = mExe[1]
      rest = (mExe[2] || '').trim()
    } else {
      const idx = s.indexOf(' ')
      if (idx === -1) {
        exe = s
        rest = ''
      } else {
        exe = s.slice(0, idx)
        rest = s.slice(idx + 1).trim()
      }
    }
  }

  exe = String(exe || '').trim().replace(/^\"+|\"+$/g, '')
  if (!exe) return null
  let args = rest ? rest.split(/\s+/).filter(Boolean) : []
  // Drop shell placeholders like "%1" so we can start the host without a file argument.
  args = args
    .map((a) => String(a || '').trim())
    .filter(Boolean)
    .filter((a) => !/%[1lL\*]/.test(a))
  return { exe, args }
}

async function launchWpsHostFromRegistry(progId) {
  if (process.platform !== 'win32') return false
  try {
    // Prefer "open" so we can drop "%1" and still launch the app.
    const regKeys = [
      `HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`,
      `HKEY_CLASSES_ROOT\\${progId}\\shell\\new\\command`,
    ]
    let parsed = null
    for (const regKey of regKeys) {
      try {
        const raw = await execRegQuery(regKey)
        const val = parseRegDefaultValue(raw)
        parsed = splitExeAndArgs(val)
        if (parsed) break
      } catch {
        // try next
      }
    }
    if (!parsed) return false
    try {
      const child = spawn(parsed.exe, parsed.args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      return true
    } catch {
      // Fallback: `cmd /c start "" <exe> ...args` is more tolerant with quoting.
      try {
        const child = spawn('cmd', ['/c', 'start', '""', parsed.exe, ...parsed.args], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        return true
      } catch {
        return false
      }
    }
  } catch {
    return false
  }
}

function ensureDir(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
  } catch {
    // ignore
  }
}

function restoreJspluginsXml() {
  if (jspluginsRestored) return
  jspluginsRestored = true
  try {
    if (pinnedKeepAliveTimer) clearInterval(pinnedKeepAliveTimer)
    for (const it of (jspluginsFiles || [])) {
      const p = it?.filePath
      if (!p) continue
      if (it.originalText == null) {
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } else {
        ensureDir(p)
        fs.writeFileSync(p, it.originalText, 'utf8')
      }
    }
    for (const it of (publishFiles || [])) {
      const p = it?.filePath
      if (!p) continue
      if (it.originalText == null) {
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } else {
        ensureDir(p)
        fs.writeFileSync(p, it.originalText, 'utf8')
      }
    }
  } catch {
    // ignore
  }
}

function setAddonType(addonType, nextName) {
  const next = JSON.parse(JSON.stringify(originalJson))
  next.addonType = addonType
  // Make wpsjs write publish.xml using the real addin id (manifest <Name>), otherwise
  // it may re-inject a stale entry like name="ah32-ui-next" and cause "two entrances".
  if (nextName && String(nextName).trim()) {
    next.name = String(nextName).trim()
  }
  fs.writeFileSync(pkgPath, JSON.stringify(next, null, '\t') + '\n', 'utf8')
}

process.on('SIGINT', () => {
  restoreJspluginsXml()
  restorePackageJson()
  process.exit(130)
})
process.on('SIGTERM', () => {
  restoreJspluginsXml()
  restorePackageJson()
  process.exit(143)
})
process.on('exit', () => {
  restoreJspluginsXml()
  restorePackageJson()
})

// Determine our addin id for all modes (not only "all").
const manifestName = readManifestName()
const defaultName = String(manifestName || 'Ah32').trim() || 'Ah32'
const addinId = String(process.env.BID_WPSJS_ADDIN_ID || process.env.BID_WPSJS_NAME || defaultName).trim() || defaultName
const devUrl = resolveDevUrl()

// Ensure wpsjs uses the correct addin id when it patches publish.xml.
setAddonType(addonTypeForWpsjs, addinId)

// Before running wpsjs debug, proactively clean stale registrations created by earlier runs
// (e.g. publish.xml containing name="ah32-ui-next" causes Writer to show 2 entrances).
try {
  const jsPath = resolveJspluginsPath()
  const pubPath = resolvePublishPath()
  const types = target === 'all' ? ['wps', 'et', 'wpp'] : [addonTypeForWpsjs]
  if (jsPath) _upsertDevEntries({ filePath: jsPath, addinId, url: devUrl, types, publish: false })
  if (pubPath) _upsertDevEntries({ filePath: pubPath, addinId, url: devUrl, types, publish: true })
} catch {
  // ignore
}

// Writer often shows entries from BOTH publish.xml and AddinEngines. To avoid "two entrances",
// we rely on publish.xml/jsplugins.xml only and remove our AddinEngines keys proactively.
try {
  if (process.platform === 'win32') {
    const legacyNames = Array.from(
      new Set([String(originalJson?.name || '').trim(), 'Ah32', 'ah32'].filter(Boolean))
    )
    for (const n of [addinId, ...legacyNames]) {
      if (!n) continue
      spawnSync('reg', ['delete', `HKCU\\Software\\Kingsoft\\Office\\WPS\\AddinEngines\\${n}`, '/f'], { windowsHide: true, stdio: 'ignore' })
    }
  }
} catch {
  // ignore
}

// In "all" mode, make the plugin visible in all hosts by writing 3 entries into
// both jsplugins.xml and publish.xml (wpsjs chooses one depending on WPS version).
if (target === 'all') {
  const hosts = ['wps', 'et', 'wpp']
  jspluginsFiles = hosts
    .map((h) => {
      const filePath = resolveJspluginsPath(h)
      if (!filePath) return null
      let originalText = null
      try {
        originalText = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
      } catch {
        originalText = null
      }
      return { host: h, filePath, originalText }
    })
    .filter(Boolean)
  publishFiles = hosts
    .map((h) => {
      const filePath = resolvePublishPath(h)
      if (!filePath) return null
      let originalText = null
      try {
        originalText = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
      } catch {
        originalText = null
      }
      return { host: h, filePath, originalText }
    })
    .filter(Boolean)

  const url = devUrl

  // De-dupe file list because we pin a single jsplugins.xml/publish.xml for all hosts.
  const dedupeFiles = (arr) => {
    const seen = new Set()
    const out = []
    for (const it of arr || []) {
      const p = it?.filePath
      if (!p || seen.has(p)) continue
      seen.add(p)
      out.push(it)
    }
    return out
  }
  jspluginsFiles = dedupeFiles(jspluginsFiles)
  publishFiles = dedupeFiles(publishFiles)

  const jspluginsXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<jsplugins>\n` +
    `  <jspluginonline name="${addinId}" type="wps" url="${url}" />\n` +
    `  <jspluginonline name="${addinId}" type="et" url="${url}" />\n` +
    `  <jspluginonline name="${addinId}" type="wpp" url="${url}" />\n` +
    `</jsplugins>\n`

  // publish.xml is used by newer WPS builds (wpsjs auto-switches to "publish debug").
  // Keep the attribute set minimal but compatible with wpsjs defaults.
  const publishXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<jsplugins>\n` +
    `  <jspluginonline name="${addinId}" type="wps" url="${url}" enable="enable_dev" install="null" />\n` +
    `  <jspluginonline name="${addinId}" type="et" url="${url}" enable="enable_dev" install="null" />\n` +
    `  <jspluginonline name="${addinId}" type="wpp" url="${url}" enable="enable_dev" install="null" />\n` +
    `</jsplugins>\n`

  const writePinned = () => {
    try {
      for (const it of (jspluginsFiles || [])) {
        if (!it?.filePath) continue
        ensureDir(it.filePath)
        // Merge into existing file to avoid clobbering other addins; remove duplicates for our ids.
        _upsertDevEntries({ filePath: it.filePath, addinId, url, types: ['wps', 'et', 'wpp'], publish: false })
      }
      for (const it of (publishFiles || [])) {
        if (!it?.filePath) continue
        ensureDir(it.filePath)
        _upsertDevEntries({ filePath: it.filePath, addinId, url, types: ['wps', 'et', 'wpp'], publish: true })
      }
    } catch {
      // ignore
    }
  }

  writePinned()
  // Keepalive is only to re-pin when wpsjs overwrites these files; do not spam writes.
  // Default to 5s; allow override via env for troubleshooting.
  const keepAliveMs = Math.max(600, Number(process.env.BID_WPSJS_PIN_INTERVAL_MS || 5000) || 5000)
  pinnedKeepAliveTimer = setInterval(writePinned, keepAliveMs)

  // Some WPS builds rely on HKCU\\Software\\Kingsoft\\Office\\{HOST}\\AddinEngines\\{AddinId}
  // to discover JS addins, especially for ET/WPP.
  if (process.platform === 'win32') {
    try {
      const taskpanePath = path.resolve(process.cwd(), 'taskpane.html')
      const toKey = (h) => `HKCU\\Software\\Kingsoft\\Office\\${h}\\AddinEngines\\${addinId}`
      // If the addin id changed (common when package.json name differs from manifest <Name>),
      // remove the legacy keys so Writer doesn't get confused by stale registrations.
      try {
        const legacy = String(originalJson?.name || '').trim()
        if (legacy && legacy !== addinId) {
          for (const h of ['WPS', 'ET', 'WPP']) {
            spawnSync('reg', ['delete', `HKCU\\Software\\Kingsoft\\Office\\${h}\\AddinEngines\\${legacy}`, '/f'], { windowsHide: true, stdio: 'ignore' })
          }
        }
      } catch {
        // ignore
      }
      // Also remove older "Ah32" id if it points to our previous debug install.
      try {
        for (const h of ['WPS', 'ET', 'WPP']) {
          const key = `HKCU\\Software\\Kingsoft\\Office\\${h}\\AddinEngines\\Ah32`
          const res = spawnSync('reg', ['query', key, '/v', 'Path'], { windowsHide: true, encoding: 'utf8' })
          const out = String(res.stdout || '')
          if (out && /\\WPS\\Addins\\Ah32\\taskpane\.html/i.test(out)) {
            spawnSync('reg', ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore' })
          }
        }
      } catch {
        // ignore
      }
      const queryKey = (key) => {
        const res = spawnSync('reg', ['query', key], { windowsHide: true, encoding: 'utf8' })
        if (res.status !== 0) return { existed: false, pathValue: null, typeValue: null }
        const out = String(res.stdout || '')
        const pick = (valueName) => {
          const re = new RegExp(`^\\s*${valueName}\\s+REG_SZ\\s+(.+)$`, 'mi')
          const m = out.match(re)
          return m && m[1] ? m[1].trim() : null
        }
        return { existed: true, pathValue: pick('Path'), typeValue: pick('Type') }
      }

      regBackup = ['WPS', 'ET', 'WPP'].map((h) => ({ key: toKey(h), ...queryKey(toKey(h)) }))
      for (const { key } of regBackup) {
        spawnSync('reg', ['add', key, '/f'], { windowsHide: true, stdio: 'ignore' })
        spawnSync('reg', ['add', key, '/v', 'Path', '/t', 'REG_SZ', '/d', taskpanePath, '/f'], { windowsHide: true, stdio: 'ignore' })
        spawnSync('reg', ['add', key, '/v', 'Type', '/t', 'REG_SZ', '/d', 'js', '/f'], { windowsHide: true, stdio: 'ignore' })
      }
      regTouched = true
    } catch {
      // ignore
    }
  }

  console.log(
    '[wpsjs-debug] Pinned plugins for wps/et/wpp:',
    {
      cwd: process.cwd(),
      manifestName,
      jspluginsFiles: (jspluginsFiles || []).map((f) => ({ host: f.host, filePath: f.filePath })),
      publishFiles: (publishFiles || []).map((f) => ({ host: f.host, filePath: f.filePath })),
      url,
      addinId,
    }
  )

  // Ensure ET/WPP actually load the corresponding plugin types (WPS caches by start mode).
  setTimeout(() => {
    // wpsjs itself launches ONE host based on `addonTypeForWpsjs`.
    // If we also launch the same host, users see duplicate windows (e.g. two Writer instances).
    // So we only launch the *other* hosts in `all` mode.
    if (target === 'all') {
      // Spreadsheets / Presentation
      launchWpsHostFromRegistry('KET.Sheet.12').catch(() => {})
      launchWpsHostFromRegistry('KWPP.Presentation.12').catch(() => {})
    }
  }, 2200)
}

// Run the JS entry directly to avoid Windows `.cmd` spawning quirks (EINVAL) and PATH issues.
const entry = path.resolve(process.cwd(), 'node_modules', 'wpsjs', 'src', 'index.js')
const child = spawn(process.execPath, [entry, 'debug'], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  restoreJspluginsXml()
  restorePackageJson()
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
child.on('error', (err) => {
  restoreJspluginsXml()
  restorePackageJson()
  // Re-throw to surface a clear error in the npm script output.
  throw err
})
