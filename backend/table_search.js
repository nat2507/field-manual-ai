// ============================================================
// TABLE SEARCH — keyword search engine for structured table data
// Much more reliable than vector search for exact lookups
// ============================================================

import fs from 'fs';
import path from 'path';

const TABLES_FILE = process.env.TABLES_FILE || "C:\\manuals\\tables.json";

// Load all table data
export function loadTableData() {
  try {
    if (fs.existsSync(TABLES_FILE)) {
      return JSON.parse(fs.readFileSync(TABLES_FILE, 'utf8'));
    }
  } catch (err) {
    console.log('[WARN] Could not load tables.json:', err.message);
  }
  return [];
}

// Save table data from a PDF extraction
export function saveTableData(filename, tableEntries) {
  const existing = loadTableData();
  // Remove old entries for this file
  const filtered = existing.filter(e => e.filename !== filename);
  // Add new entries
  const updated = [...filtered, ...tableEntries];
  try {
    fs.writeFileSync(TABLES_FILE, JSON.stringify(updated, null, 2));
    console.log(`[TABLES] Saved ${tableEntries.length} entries for ${filename}`);
  } catch (err) {
    console.log('[WARN] Could not save tables.json:', err.message);
  }
}

// ─────────────────────────────────────────────
// KEYWORD SEARCH
// Find table entries matching a question
// ─────────────────────────────────────────────
export function searchTables(question) {
  const tableData = loadTableData();
  if (tableData.length === 0) return null;

  const qLower = question.toLowerCase();

  // Extract meaningful keywords from question (ignore short/common words)
  const stopWords = new Set(['what', 'is', 'the', 'for', 'how', 'can', 'you',
    'tell', 'me', 'give', 'find', 'show', 'get', 'need', 'want', 'please',
    'about', 'of', 'in', 'on', 'at', 'to', 'a', 'an', 'and', 'or', 'are']);

  const keywords = qLower
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return null;

  // Score each table entry
  const scored = tableData.map(entry => {
    const searchable = (entry.searchable || '').toLowerCase();
    const description = (entry.description || entry.key || '').toLowerCase();
    const code = (entry.code || '').toLowerCase();

    let score = 0;

    for (const keyword of keywords) {
      // Exact match in searchable text
      if (searchable.includes(keyword)) score += 2;
      // Match in description/key
      if (description.includes(keyword)) score += 3;
      // Match in code
      if (code.includes(keyword)) score += 2;
      // Partial match (keyword is part of a word)
      if (searchable.split(/\s+/).some(w => w.includes(keyword))) score += 1;
    }

    return { ...entry, score };
  });

  // Detect question intent
  const intentPatterns = {
    parts: ['sku', 'part number', 'part no', 'order code', 'ordering number', 'spare part'],
    specs: ['specification', 'value', 'range', 'rating', 'consumption', 'voltage', 'current', 'power', 'dimension', 'size', 'weight', 'speed', 'temperature'],
    status: ['mean', 'indicate', 'led', 'status', 'state', 'condition', 'what does'],
    errors: ['error', 'fault', 'code', 'alarm'],
  };

  let intentType = null;
  for (const [type, patterns] of Object.entries(intentPatterns)) {
    if (patterns.some(p => qLower.includes(p))) {
      intentType = type;
      break;
    }
  }

  // Filter by intent if detected
  let filtered = scored.filter(e => e.score > 0);
  if (intentType) {
    const intentMatches = filtered.filter(e => e.type === intentType || 
      (intentType === 'specs' && ['specs', 'dimensions', 'general'].includes(e.type)));
    // Only use intent filter if it returns results
    if (intentMatches.length > 0) {
      filtered = intentMatches;
    }
  }

  const matches = filtered
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (matches.length === 0) return null;

  return matches;
}

// ─────────────────────────────────────────────
// FORMAT TABLE RESULTS as natural language
// ─────────────────────────────────────────────
export function formatTableAnswer(matches, question) {
  if (!matches || matches.length === 0) return null;

  const qLower = question.toLowerCase();

  // Group by type
  const partMatches = matches.filter(m => m.type === 'parts');
  const specMatches = matches.filter(m => m.type === 'specs' || m.type === 'dimensions');
  const statusMatches = matches.filter(m => m.type === 'status');
  const otherMatches = matches.filter(m => !['parts', 'specs', 'dimensions', 'status'].includes(m.type));

  const lines = [];

  // Parts/SKU results
  if (partMatches.length > 0) {
    const isAskingForCode = ['sku', 'part number', 'code', 'order'].some(w => qLower.includes(w));
    const isAskingForDescription = ['what is', 'describe', 'description'].some(w => qLower.includes(w));

    if (partMatches.length === 1) {
      const m = partMatches[0];
      lines.push(`The part number is ${m.code} — ${m.description}.`);
    } else {
      lines.push(`Here are the matching parts:`);
      partMatches.forEach(m => {
        lines.push(`${m.code}: ${m.description}`);
      });
    }
    lines.push(`(from ${partMatches[0].filename.replace('.pdf', '')}, page ${partMatches[0].page})`);
  }

// Spec/dimension results
  if (specMatches.length > 0) {
    specMatches.forEach(m => {
      // Get all non-empty cells for a complete picture
      const allCells = m.cells.filter(c => c.trim());
      if (allCells.length >= 2) {
        // Format: "Key: value1, value2" or just join all cells
        const key = allCells[0] || m.key;
        const values = allCells.slice(1).join(', ');
        if (key && values) {
          lines.push(`${key}: ${values}`);
        } else if (values) {
          lines.push(values);
        }
      }
    });
    if (specMatches[0]) {
      lines.push(`(from ${specMatches[0].filename.replace('.pdf', '')}, page ${specMatches[0].page})`);
    }
  }

  // Status results
  if (statusMatches.length > 0) {
    statusMatches.forEach(m => {
      // Use all non-empty cells
      const allCells = m.cells.filter(c => c.trim());
      if (allCells.length >= 2) {
        const key = allCells[0];
        // Last cell usually has the description
        const description = allCells[allCells.length - 1];
        if (key && description && key !== description) {
          lines.push(`${key}: ${description}`);
        } else if (description) {
          lines.push(description);
        }
      }
    });
    if (statusMatches[0]) {
      lines.push(`(from ${statusMatches[0].filename.replace('.pdf', '')}, page ${statusMatches[0].page})`);
    }
  }

  // Other results
  if (otherMatches.length > 0 && lines.length === 0) {
    otherMatches.forEach(m => {
      const cells = (m.cells || []).filter(c => c.trim());
      if (cells.length >= 2) {
        lines.push(cells.join(': '));
      }
    });
    if (otherMatches[0]) {
      lines.push(`(from ${otherMatches[0].filename.replace('.pdf', '')}, page ${otherMatches[0].page})`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}