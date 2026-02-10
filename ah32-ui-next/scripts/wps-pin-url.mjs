import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function ensureTrailingSlash(u) {
  const s = String(u || '').trim()
  if (!s) return s
  return s.endsWith('/') ? s : (s + '/')
}

function normalizeHost(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (v === 'all') return 'all'
  if (v === 'wps') return 'wps'
  if (v === 'et' || v === 'ex' || v === 'excel' || v === 'sheet' || v === 'spreadsheet') return 'et'
  if (v === 'wpp' || v === 'ppt' || v === 'pptx' || v === 'powerpoint' || v === 'presentation') return 'wpp'
  return null
}

function readManifestName() {
  try {
    const candidates = [
      path.resolve(process.cwd(), 'manifest.xml'),
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
    const re = new RegExp('<Name>\\s*([^<]+)\\s*<\\/Name>', 'i')
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

function _upsertEntries({ filePath, addinId, url, types, publish }) {
  if (!filePath) return { changed: false, filePath }
  const pkgPath = path.resolve(process.cwd(), 'package.json')
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch {
    pkg = null
  }
  const legacyNames = Array.from(new Set([String(pkg?.name || '').trim(), 'Ah32', 'ah32'].filter(Boolean)))

  let txt = ''
  try {
    txt = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
  } catch (e) {
    throw new Error(`Failed to read ${filePath}: ${e && e.message ? e.message : String(e)}`)
  }
  const originalFileText = txt

  txt = _removeOurEntriesFromXml(txt, [addinId, ...legacyNames])
  const { header, body, footer } = _ensureXmlRoot(txt)

  const lines = []
  for (const t of types || []) {
    const type = String(t || '').trim()
    if (!type) continue
    if (publish) {
      lines.push(`  <jspluginonline name="${addinId}" type="${type}" url="${url}" enable="enable_dev" install="null"/>`)
    } else {
      lines.push(`  <jspluginonline name="${addinId}" type="${type}" url="${url}" />`)
    }
  }
  const next = `${header}${(body || '').trim() ? (body.trim() + '\n') : ''}${lines.join('\n')}\n${footer}`
  if (originalFileText === next) return { changed: false, filePath }
  try {
    // Backup next to the file for easy recovery.
    try {
      if (fs.existsSync(filePath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z')
        const bak = `${filePath}.bak.${ts}`
        if (!fs.existsSync(bak)) fs.copyFileSync(filePath, bak)
      }
    } catch {
      // ignore backup failures; still attempt to write
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, next, 'utf8')
  } catch (e) {
    throw new Error(`Failed to write ${filePath}: ${e && e.message ? e.message : String(e)}`)
  }
  return { changed: true, filePath }
}

function resolveJsaddonsDir() {
  const appdata = process.env.APPDATA
  if (!appdata) return null
  return path.resolve(appdata, 'kingsoft', 'wps', 'jsaddons')
}

function resolveXmlPaths() {
  const dir = resolveJsaddonsDir()
  if (!dir) return { jsplugins: null, publish: null }
  return {
    jsplugins: path.resolve(dir, 'jsplugins.xml'),
    publish: path.resolve(dir, 'publish.xml'),
  }
}

function resolveDefaultUrl() {
  const dir = path.resolve(process.cwd(), 'wps-plugin')
  const url = ensureTrailingSlash(pathToFileURL(dir).href)
  return url
}

function main() {
  const host = normalizeHost(process.argv[2]) || 'wps'
  const mode = String(process.argv[3] || '').trim().toLowerCase()

  const manifestName = readManifestName()
  const addinId = String(process.env.BID_WPSJS_ADDIN_ID || process.env.BID_WPSJS_NAME || manifestName || 'Ah32').trim() || 'Ah32'

  let url = ''
  if (mode === 'file' || !mode) {
    url = resolveDefaultUrl()
  } else if (mode === 'url') {
    url = ensureTrailingSlash(String(process.argv[4] || '').trim())
  } else {
    throw new Error(`Unknown mode: ${mode} (use: file | url <baseUrl>)`)
  }
  if (!url) throw new Error('url is empty')

  const types = host === 'all' ? ['wps', 'et', 'wpp'] : [host]
  const paths = resolveXmlPaths()
  if (!paths.jsplugins && !paths.publish) throw new Error('WPS jsaddons dir not found (APPDATA missing?)')

  const r1 = paths.jsplugins
    ? _upsertEntries({ filePath: paths.jsplugins, addinId, url, types, publish: false })
    : { changed: false, filePath: null }
  const r2 = paths.publish
    ? _upsertEntries({ filePath: paths.publish, addinId, url, types, publish: true })
    : { changed: false, filePath: null }

  console.log('[wps-pin-url] done', { addinId, host, url, jsplugins: r1, publish: r2 })
}

main()
