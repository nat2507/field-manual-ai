// ============================================================
// BOOKMARK READER
// Extracts PDF outline/bookmarks to find exact section pages
// ============================================================

import { PDFDocument, PDFName } from 'pdf-lib';
import fs from 'fs';

const SECTION_MAPPINGS = [
  { keywords: ['spare part', 'spare parts', 'ordering information', 'order code', 'parts list', 'part list', '7.9', 'sku', 'part number'], name: 'spare parts' },
  { keywords: ['specification', 'technical data', 'electrical', 'performance'], name: 'specifications' },
  { keywords: ['installation', 'mounting', 'wiring', 'commissioning'], name: 'installation' },
  { keywords: ['maintenance', 'service', 'cleaning', 'filter'], name: 'maintenance' },
  { keywords: ['troubleshoot', 'fault', 'error', 'alarm', 'diagnostic'], name: 'troubleshooting' },
  { keywords: ['configuration', 'setting', 'programming', 'threshold'], name: 'configuration' },
  { keywords: ['ordering', 'order code', 'part number', 'sku'], name: 'ordering' },
];

function matchSectionName(title) {
  const lower = title.toLowerCase();
  for (const mapping of SECTION_MAPPINGS) {
    if (mapping.keywords.some(k => lower.includes(k))) {
      return mapping.name;
    }
  }
  return null;
}

async function traverseOutline(node, pdfDoc, pageMap, bookmarks, depth = 0) {
  if (!node) return;
  try {
    const titleObj = node.lookup(PDFName.of('Title'));
    const title = titleObj?.value || titleObj?.decodeText?.() || null;

    let pageNum = null;
    const dest = node.lookup(PDFName.of('Dest'));
    const action = node.lookup(PDFName.of('A'));

    if (dest) {
      pageNum = resolvePageNumber(dest, pageMap);
    } else if (action) {
      const actionDest = action.lookup?.(PDFName.of('D'));
      if (actionDest) pageNum = resolvePageNumber(actionDest, pageMap);
    }

    if (title && pageNum !== null) {
      const sectionName = matchSectionName(title);
      bookmarks.push({ title, page: pageNum, depth, sectionName });
    }

    const first = node.lookup(PDFName.of('First'));
    if (first) await traverseOutline(first, pdfDoc, pageMap, bookmarks, depth + 1);

    const next = node.lookup(PDFName.of('Next'));
    if (next) await traverseOutline(next, pdfDoc, pageMap, bookmarks, depth);

  } catch (err) {}
}

function buildPageMap(pdfDoc) {
  const pages = pdfDoc.getPages();
  const pageMap = {};
  pages.forEach((page, i) => {
    const objNum = page.ref?.objectNumber;
    if (objNum) pageMap[objNum] = i + 1;
  });
  return pageMap;
}

function resolvePageNumber(dest, pageMap) {
  try {
    if (dest?.constructor?.name === 'PDFArray') {
      const arr = dest.asArray();
      if (arr && arr.length > 0) {
        const pageRef = arr[0];
        const objNum = pageRef?.objectNumber;
        if (objNum && pageMap[objNum]) return pageMap[objNum];
      }
    }
  } catch (_) {}
  return null;
}

export async function extractSectionsFromBookmarks(pdfPath, filename) {
  try {
    const buffer = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const catalog = pdfDoc.catalog;

    const outlines = catalog.lookup(PDFName.of('Outlines'));
    if (!outlines) {
      console.log(`   [BOOKMARKS] No bookmarks in ${filename}`);
      return [];
    }

    const first = outlines.lookup(PDFName.of('First'));
    if (!first) return [];

    const pageMap = buildPageMap(pdfDoc);
    const bookmarks = [];
    await traverseOutline(first, pdfDoc, pageMap, bookmarks);
    console.log(`   [BOOKMARKS] Found ${bookmarks.length} bookmarks`);

    // Map to sections
    const sections = [];
    for (const bm of bookmarks) {
      if (bm.sectionName && bm.page) {
        const existing = sections.find(s => s.name === bm.sectionName);
        if (!existing) {
          sections.push({
            filename,
            name: bm.sectionName,
            page: bm.page,
            keywords: SECTION_MAPPINGS.find(m => m.name === bm.sectionName)?.keywords || [],
            source: 'bookmark',
          });
          console.log(`   [BOOKMARK] "${bm.title}" → "${bm.sectionName}" at page ${bm.page}`);
        }
      }
    }

    if (sections.length === 0) {
      console.log(`   [BOOKMARKS] No matching sections found in bookmarks`);
    }

    return sections;

  } catch (err) {
    console.log(`   [BOOKMARKS] Error: ${err.message}`);
    return [];
  }
}