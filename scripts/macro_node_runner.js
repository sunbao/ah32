// Node-side macro runner used by scripts/macro_bench_30.py.
//
// This is NOT WPS. It is a pragmatic smoke test that:
// - Parses code via `new Function(...)` (catches SyntaxError early).
// - Executes it with best-effort stubs for `window.Application` and global `BID`.
//
// Goal: catch the most common failure modes (syntax + obvious ReferenceError/TypeError)
// without requiring a WPS GUI session.

const fs = require('fs')

function mkRange() {
  let _text = ''
  const range = {
    Start: 0,
    End: 0,
    get Text() { return _text },
    set Text(v) { _text = String(v ?? '') },
    InsertAfter: function (t) { _text += String(t ?? '') },
    InsertBefore: function (t) { _text = String(t ?? '') + _text },
    Delete: function () { _text = '' },
    SetRange: function () {},
    Select: function () {},
    Tables: { Add: function () { return { Borders: { Enable: 1 }, Rows: function(){return { HeadingFormat: 0 }} } } },
    InlineShapes: { AddChart2: function () { return { Width: 0, Height: 0 } } },
  }
  return range
}

function mkSelection() {
  const range = mkRange()
  return {
    Range: range,
    SetRange: function () {},
    TypeParagraph: function () { range.InsertAfter('\n') },
    TypeText: function (t) { range.InsertAfter(String(t ?? '')) },
    HomeKey: function () {},
    EndKey: function () {},
    GoTo: function () {},
    MoveDown: function () {},
    StartOf: function () {},
    EndOf: function () {},
  }
}

function mkWriterDoc() {
  const doc = {
    Name: 'bench.doc',
    Content: { End: 0 },
    Range: function () { return mkRange() },
    Tables: { Add: function () { return { Borders: { Enable: 1 }, Rows: function(){return { HeadingFormat: 0 }} } } },
    InlineShapes: { AddChart2: function () { return { Width: 0, Height: 0 } } },
    Shapes: {
      AddChart2: function () { return { Width: 0, Height: 0, Anchor: null } },
      AddTextEffect: function () { return { Anchor: null } },
    },
  }
  return doc
}

function mkEtSheet(name) {
  const cells = new Map()
  function key(r, c) { return `${r},${c}` }
  return {
    Name: name || 'Sheet1',
    Cells: function (r, c) {
      const k = key(Number(r)||1, Number(c)||1)
      if (!cells.has(k)) cells.set(k, { Value: null })
      return cells.get(k)
    },
    Range: function () { return { Value: null, Values: null, Select: function(){}, Clear: function(){} } },
    Charts: { Add: function () { return { ChartType: 0, SetSourceData: function(){}, HasTitle: 0, ChartTitle: { Text: '' } } } },
  }
}

function mkEtWorkbook() {
  const sheets = [mkEtSheet('Sheet1')]
  return {
    Name: 'bench.xlsx',
    Sheets: {
      Count: sheets.length,
      Add: function () {
        const s = mkEtSheet(`Sheet${sheets.length + 1}`)
        sheets.push(s)
        this.Count = sheets.length
        return s
      },
      Item: function (i) { return sheets[(Number(i)||1)-1] || sheets[0] },
    },
  }
}

function mkWppPresentation() {
  const slides = [{ Shapes: { AddTextbox: function(){}, AddTextEffect: function(){ return {} } } }]
  return {
    Name: 'bench.ppt',
    Slides: {
      Count: slides.length,
      Add: function () {
        const s = { Shapes: { AddTextbox: function(){}, AddTextEffect: function(){ return {} } } }
        slides.push(s)
        this.Count = slides.length
        return s
      },
      Item: function (i) { return slides[(Number(i)||1)-1] || slides[0] },
    },
  }
}

function mkApplication(host) {
  const sel = mkSelection()
  if (host === 'et') {
    const wb = mkEtWorkbook()
    const sheet = wb.Sheets.Item(1)
    return { ActiveWorkbook: wb, ActiveSheet: sheet, Selection: sel }
  }
  if (host === 'wpp') {
    const pres = mkWppPresentation()
    return { ActivePresentation: pres, Selection: sel }
  }
  const doc = mkWriterDoc()
  return { ActiveDocument: doc, Selection: sel }
}

function mkBID(host) {
  return {
    upsertBlock: function (_id, fn /*, opts */) {
      if (typeof fn === 'function') return fn()
      return undefined
    },
    insertTable: function () { return { ok: true } },
    insertChartFromSelection: function () { return { ok: true } },
    insertWordArt: function () { return { ok: true } },
    findTextRange: function () { return null },
    insertAfterText: function () { return true },
    insertBeforeText: function () { return true },
  }
}

function main() {
  const host = String(process.argv[2] || 'wps').toLowerCase()
  const path = process.argv[3]
  if (!path) {
    process.stdout.write(JSON.stringify({ ok: false, stage: 'arg', error: 'missing code path' }))
    process.exitCode = 2
    return
  }
  const code = fs.readFileSync(path, 'utf8')

  // Stage 1: parse
  try {
    // eslint-disable-next-line no-new-func
    new Function(code)
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, stage: 'parse', error: String(e && (e.name || 'Error')) + ': ' + String(e && e.message || e) }))
    process.exitCode = 2
    return
  }

  // Stage 2: execute with stubs
  try {
    global.window = { Application: mkApplication(host) }
    global.BID = mkBID(host)
    // eslint-disable-next-line no-new-func
    const fn = new Function(code)
    const ret = fn()
    process.stdout.write(JSON.stringify({ ok: true, stage: 'exec', return_value: ret === undefined ? null : ret }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, stage: 'exec', error: String(e && (e.name || 'Error')) + ': ' + String(e && e.message || e) }))
    process.exitCode = 3
  }
}

main()

