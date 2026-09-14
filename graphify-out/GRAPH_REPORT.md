# Graph Report - tor-spec-service  (2026-09-14)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 145 nodes · 261 edges · 17 communities (13 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13

## God Nodes (most connected - your core abstractions)
1. `el()` - 16 edges
2. `handleFile()` - 15 edges
3. `mergeAndRenderDoubleSpec()` - 13 edges
4. `handleCustomTplUpload()` - 12 edges
5. `handleUpdateDiagramPreview()` - 9 edges
6. `setStatus()` - 9 edges
7. `extractTextFromFile()` - 8 edges
8. `handleDoubleSpecFile()` - 7 edges
9. `handleGenerateCustomDocx()` - 7 edges
10. `readOffsetInputs()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `handleAddToJournal()` --calls--> `buildDriveFilename()`  [EXTRACTED]
  js/app.js → js/app.js  _Bridges community 1 → community 2_
- `handleCustomTplUpload()` --calls--> `xFracToMm()`  [EXTRACTED]
  js/app.js → js/app.js  _Bridges community 1 → community 3_
- `handleDoubleSpecFile()` --calls--> `mergeAndRenderDoubleSpec()`  [EXTRACTED]
  js/app.js → js/app.js  _Bridges community 12 → community 3_
- `handleDoubleSpecFile()` --calls--> `setStatus()`  [EXTRACTED]
  js/app.js → js/app.js  _Bridges community 12 → community 2_
- `handleCustomTplUpload()` --calls--> `el()`  [EXTRACTED]
  js/app.js → js/app.js  _Bridges community 2 → community 3_

## Import Cycles
- None detected.

## Communities (17 total, 1 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.20
Nodes (13): BELTO_LINES, deriveMonoblockValues(), extractNumbers(), extractUnitFromLine(), extractValuesForRule(), isMonoblockText(), mergeTwoStageSpecs(), MONOBLOCK_LINES (+5 more)

### Community 1 - "Community 1"
Cohesion: 0.20
Nodes (14): buildDriveFilename(), buildLetterheadValues(), buildLogEntry(), currentDebugMatches, currentFieldValues, formatCalcNumber(), formatExecutorCombined(), formatTodayDateDMY() (+6 more)

### Community 2 - "Community 2"
Cohesion: 0.23
Nodes (15): buildOutputFilename(), bytesToBase64(), el(), getDiagramCrops(), handleAddToJournal(), handleGenerateCustomDocx(), handleUpdateDiagramPreview(), hidePreviewImage() (+7 more)

### Community 3 - "Community 3"
Cohesion: 0.36
Nodes (12): applyDefaultFieldValues(), applyParsedValues(), buildAutoTextWarning(), getModelPartsForCurrentTemplate(), handleCustomTplUpload(), handleFile(), mergeAndRenderDoubleSpec(), refreshCertificatesFromPdf() (+4 more)

### Community 4 - "Community 4"
Cohesion: 0.18
Nodes (10): buildLetterheadMapping(), BUILTIN_LETTERHEAD_TEMPLATES, BUILTIN_PDF_FIELD_KEYS, DEFAULT_CERTIFICATES_TEXT, DEFAULT_PORT_LEGEND_TEXT, DIAGRAM_BOX, LETTERHEAD_FIELDS, LETTERHEAD_PAGE (+2 more)

### Community 5 - "Community 5"
Cohesion: 0.32
Nodes (11): extractTextFromFile(), extractTextFromHtml(), extractTextFromImage(), extractTextFromPdf(), fileToDataUrl(), htmlDocToLines(), ocrByTableRows(), parseBeltoHtmlStructured() (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.42
Nodes (9): canvasToDiagramImage(), cropCanvasZone(), cropDiagramFromPdf(), cropZoneFromPdf(), renderPdfPageToCanvas(), trimBorderFromCanvas(), colDarkFraction(), grayAt() (+1 more)

### Community 7 - "Community 7"
Cohesion: 0.33
Nodes (6): buildCertificatesRawXml(), estimateCertificatesNoteHeightPt(), fillDocxTemplate(), fitSize(), tightenRowHeight(), xmlEscape()

### Community 8 - "Community 8"
Cohesion: 0.33
Nodes (6): fillPdfTemplate(), getDejaVuFontBytes(), letterheadOffsetStorageKey(), loadLetterheadOffset(), saveLetterheadOffset(), wrapTextToWidth()

### Community 9 - "Community 9"
Cohesion: 0.43
Nodes (7): extractCertificatesTextFromPdf(), extractModelPartsFromPdf(), extractPortLegendFromPdf(), fixDegreeArtifacts(), getPdfPageLines(), getPdfPageLinesWithPos(), parseModelLine()

### Community 10 - "Community 10"
Cohesion: 0.43
Nodes (4): convertDpToKgfCm2(), convertValue(), parseNumber(), UNIT_CONVERTERS

### Community 11 - "Community 11"
Cohesion: 0.53
Nodes (4): buildVsdx(), findShapeById(), loadTemplateZip(), setShapeText()

### Community 12 - "Community 12"
Cohesion: 0.50
Nodes (5): handleDoubleSpecFile(), initSpecModeToggle(), parseSpecFile(), renderDoubleSlotsStatus(), resetDoubleSpecSlots()

## Knowledge Gaps
- **18 isolated node(s):** `BELTO_LINES`, `MONOBLOCK_LINES`, `MONOBLOCK_REPLACED_KEYS`, `currentDebugMatches`, `currentFieldValues` (+13 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 34 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `el()` connect `Community 2` to `Community 1`, `Community 3`, `Community 12`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `handleFile()` connect `Community 3` to `Community 1`, `Community 2`, `Community 12`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Why does `handleCustomTplUpload()` connect `Community 3` to `Community 1`, `Community 2`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **What connects `BELTO_LINES`, `MONOBLOCK_LINES`, `MONOBLOCK_REPLACED_KEYS` to the rest of the system?**
  _18 weakly-connected nodes found - possible documentation gaps or missing edges._