// ============================================================
// RAG ENGINE v2 — Hybrid keyword + vector search
// Features:
// - Exact page tracking during indexing
// - Keyword + vector combined scoring
// - Surrounding context chunks
// - Document-aware retrieval
// ============================================================

import { extractSectionsFromBookmarks } from './bookmarks.js';
import fs from 'fs';

const vectorStore = [];
const sectionIndex = [];

const VECTORS_FILE = process.env.VECTORS_FILE || "C:\\manuals\\vectors.json";

// ─────────────────────────────────────────────
// VECTOR PERSISTENCE
// Save/load vectors to avoid re-indexing
// ─────────────────────────────────────────────
export function saveVectors() {
  try {
    const data = {
      savedAt: new Date().toISOString(),
      vectorStore: vectorStore.map(e => ({
        ...e,
        vector: Array.from(e.vector) // ensure serializable
      })),
      sectionIndex,
    };
    fs.writeFileSync(VECTORS_FILE, JSON.stringify(data));
    console.log(`[VECTORS] Saved ${vectorStore.length} vectors to disk`);
  } catch (err) {
    console.log(`[WARN] Could not save vectors: ${err.message}`);
  }
}

export function loadVectors() {
  try {
    if (!fs.existsSync(VECTORS_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf8'));
    if (!data.vectorStore || data.vectorStore.length === 0) return false;

    // Load into memory
    vectorStore.length = 0;
    sectionIndex.length = 0;
    vectorStore.push(...data.vectorStore);
    sectionIndex.push(...(data.sectionIndex || []));

    console.log(`[VECTORS] Loaded ${vectorStore.length} vectors from disk (saved ${data.savedAt})`);
    return true;
  } catch (err) {
    console.log(`[WARN] Could not load vectors: ${err.message}`);
    return false;
  }
}

export function getVectorFilenames() {
  const docs = {};
  for (const entry of vectorStore) {
    docs[entry.filename] = true;
  }
  return Object.keys(docs);
}

// ─────────────────────────────────────────────
// SECTION INDEX
// Detects section headings during indexing
// Maps section names to page numbers
// ─────────────────────────────────────────────

// Common section patterns in technical manuals
const SECTION_PATTERNS = [
  { regex: /spare\s*parts?|replacement\s*parts?|7\.9|section\s*7/i, name: 'spare parts', keywords: ['sku', 'part number', 'spare', 'replace', 'order code', 'ordering'] },
  { regex: /specification|technical\s*data|electrical\s*spec/i, name: 'specifications', keywords: ['spec', 'voltage', 'current', 'power', 'dimension', 'weight', 'temperature'] },
  { regex: /installation|mounting|wiring/i, name: 'installation', keywords: ['install', 'mount', 'wire', 'connect', 'setup'] },
  { regex: /maintenance|service\s*schedule|cleaning/i, name: 'maintenance', keywords: ['maintain', 'service', 'clean', 'inspect', 'filter'] },
  { regex: /troubleshoot|fault|error\s*code|alarm/i, name: 'troubleshooting', keywords: ['fault', 'error', 'alarm', 'trouble', 'problem', 'issue'] },
  { regex: /configuration|setting|program/i, name: 'configuration', keywords: ['config', 'setting', 'program', 'threshold', 'parameter'] },
  { regex: /ordering\s*information|order\s*code|part\s*list/i, name: 'ordering', keywords: ['order', 'sku', 'part number', 'buy', 'purchase'] },
];

function detectSections(chunks, filename) {
  const detected = [];
  const totalChunks = chunks.length;

  // Skip first 15% of document — likely table of contents
  const startChunk = Math.floor(totalChunks * 0.15);

  // First pass — skip TOC, find real sections
  for (let i = startChunk; i < chunks.length; i++) {
    const chunk = chunks[i];
    for (const pattern of SECTION_PATTERNS) {
      if (pattern.regex.test(chunk.text)) {
        const existing = detected.find(s => s.name === pattern.name && s.filename === filename);
        if (!existing) {
          detected.push({
            filename,
            name: pattern.name,
            page: chunk.pageNumber,
            keywords: pattern.keywords,
          });
          console.log(`   [SECTION] Found "${pattern.name}" at page ${chunk.pageNumber}`);
        }
      }
    }
  }

  // Second pass — for sections not found after TOC, fall back to full document
  for (const pattern of SECTION_PATTERNS) {
    const alreadyFound = detected.find(s => s.name === pattern.name && s.filename === filename);
    if (!alreadyFound) {
      for (const chunk of chunks) {
        if (pattern.regex.test(chunk.text)) {
          detected.push({
            filename,
            name: pattern.name,
            page: chunk.pageNumber,
            keywords: pattern.keywords,
          });
          console.log(`   [SECTION] Found "${pattern.name}" at page ${chunk.pageNumber} (fallback)`);
          break;
        }
      }
    }
  }

  return detected;
}

// Look up which page a section starts on for a given question
export function findSectionPage(question, filename) {
  const qLower = question.toLowerCase();
  const relevant = sectionIndex.filter(s =>
    (!filename || s.filename === filename) &&
    s.keywords.some(k => qLower.includes(k))
  );
  if (relevant.length === 0) return null;
  // Return the best match
  relevant.sort((a, b) => {
    const aMatches = a.keywords.filter(k => qLower.includes(k)).length;
    const bMatches = b.keywords.filter(k => qLower.includes(k)).length;
    return bMatches - aMatches;
  });
  return relevant[0];
}

// ─────────────────────────────────────────────
// STEP 1: CHUNK
// Split text into overlapping passages
// Track approximate page number per chunk
// ─────────────────────────────────────────────
export function chunkText(text, totalPages = 1, { chunkSize = 300, overlap = 60 } = {}) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ");
  const chunks = [];
  const totalWords = words.length;

  let start = 0;
  let chunkIndex = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    const chunkWords = words.slice(start, end);
    const chunkText = chunkWords.join(" ");

    if (chunkText.length > 50) {
      // Calculate real page number based on word position
      const wordPosition = (start + end) / 2;
      const pageNumber = Math.max(1, Math.ceil((wordPosition / totalWords) * totalPages));

      chunks.push({ text: chunkText, pageNumber, chunkIndex });
      chunkIndex++;
    }

    if (end === words.length) break;
    start += chunkSize - overlap;
  }

  return chunks;
}

// ─────────────────────────────────────────────
// STEP 2: EMBED
// Real ML embeddings via Voyage AI
// voyage-3 is optimised for technical documents
// ─────────────────────────────────────────────
async function embedText(text) {
  return embedBatch([text]).then(vectors => vectors[0]);
}

// Batch embed multiple texts in one API call
async function embedBatch(texts) {
  try {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "voyage-3",
        input: texts.map(t => t.slice(0, 4000)),
      }),
    });

    const data = await response.json();
    if (data?.data && data.data.length > 0) {
      return data.data.map(d => d.embedding);
    }
    console.log("[WARN] Voyage API error, falling back to local:", data?.detail || data);
    return texts.map(t => localEmbedText(t));
  } catch (err) {
    console.log("[WARN] Voyage API failed, falling back to local:", err.message);
    return texts.map(t => localEmbedText(t));
  }
}

// Fallback local embedding if Voyage API fails
function localEmbedText(text) {
  const dims = 128;
  const vector = new Array(dims).fill(0);
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    for (let ci = 0; ci < word.length; ci++) {
      const code = word.charCodeAt(ci);
      vector[code % dims] += 1.0;
      vector[(code * 31 + ci) % dims] += 0.5;
      vector[(code + wi * 7) % dims] += 0.3;
    }
    if (wi < words.length - 1) {
      const bigram = word + words[wi + 1];
      let hash = 0;
      for (let i = 0; i < bigram.length; i++) {
        hash = (hash * 31 + bigram.charCodeAt(i)) % dims;
      }
      vector[hash] += 2.0;
    }
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map(v => v / magnitude);
}

// ─────────────────────────────────────────────
// COSINE SIMILARITY
// ─────────────────────────────────────────────
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

// ─────────────────────────────────────────────
// KEYWORD SCORE
// Exact word matching bonus
// ─────────────────────────────────────────────
function keywordScore(text, question) {
  const textLower = text.toLowerCase();
  const words = question.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3); // ignore short words

  if (words.length === 0) return 0;

  let matches = 0;
  for (const word of words) {
    if (textLower.includes(word)) matches++;
  }
  return matches / words.length;
}

// ─────────────────────────────────────────────
// CONTEXTUAL RETRIEVAL
// Generate context summary for each chunk
// Makes chunks self-contained and searchable
// ─────────────────────────────────────────────
async function generateChunkContext(chunkText, documentText, filename) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        system: `You are a technical document indexer. Given a chunk from a technical manual, 
write a 1-2 sentence context that explains:
- What product/system this is about
- What section or topic this chunk covers
- Key technical terms or values mentioned
Be specific and concise. Output ONLY the context sentences, nothing else.`,
        messages: [{
          role: "user",
          content: `Document: ${filename}\n\nDocument excerpt (first 2000 chars):\n${documentText.slice(0, 2000)}\n\nChunk to contextualize:\n${chunkText}`
        }]
      }),
    });
    const data = await response.json();
    return data?.content?.[0]?.text?.trim() || "";
  } catch (err) {
    return "";
  }
}

// ─────────────────────────────────────────────
// STEP 3: INDEX a document
// Chunk → Embed → Store with page numbers
// ─────────────────────────────────────────────
export async function indexDocument(text, filename, pdfPages = 1, pdfPath = null) {
  console.log(`[INFO] Indexing: ${filename} (${pdfPages} pages)`);

  const chunks = chunkText(text, pdfPages);
  console.log(`   -> ${chunks.length} chunks created`);

// Try bookmarks first (most accurate)
  // pdfPath is passed in so we can read the actual PDF file
  let sections = [];
  if (pdfPath) {
    sections = await extractSectionsFromBookmarks(pdfPath, filename);
  }
  // Fall back to text scanning if no bookmarks found
  if (sections.length === 0) {
    console.log(`   [SECTION] No bookmarks — falling back to text scanning`);
    sections = detectSections(chunks, filename);
  }
  sectionIndex.push(...sections);

// Process in batches of 20 with 22 second delay between batches
  // This respects Voyage AI free tier (3 requests/min = 1 per 20 seconds)
  const BATCH_SIZE = 20;
  // Generate context for each chunk (contextual retrieval)
  console.log(`   -> Generating context for ${chunks.length} chunks...`);
  const enrichedChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const context = await generateChunkContext(chunk.text, text, filename);
    const enrichedText = context ? `${context}\n\n${chunk.text}` : chunk.text;
    enrichedChunks.push({ ...chunk, text: enrichedText, originalText: chunk.text });
    process.stdout.write(`\r   -> Context ${i + 1}/${chunks.length}`);
    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log('');

  // Embed in batches
  for (let i = 0; i < enrichedChunks.length; i += BATCH_SIZE) {
    const batch = enrichedChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map(c => c.text);

    process.stdout.write(`\r   -> Embedding chunks ${i + 1}-${Math.min(i + BATCH_SIZE, enrichedChunks.length)} of ${enrichedChunks.length}...`);

    const vectors = await embedBatch(texts);

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      vectorStore.push({
        id: `${filename}-chunk-${chunk.chunkIndex}`,
        filename,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunks.length,
        pageNumber: chunk.pageNumber,
        text: chunk.text,
        originalText: chunk.originalText,
        vector: vectors[j],
      });
    }

    // Delay between batches to respect Voyage AI rate limit
    if (i + BATCH_SIZE < enrichedChunks.length) {
      await new Promise(resolve => setTimeout(resolve, 22000));
    }
  }
  console.log(`[OK] Done indexing ${filename}`);
  return { filename, chunks: chunks.length };
}

// ─────────────────────────────────────────────
// STEP 4: HYBRID SEARCH
// Combines vector similarity + keyword matching
// Also adds surrounding chunks for context
// ─────────────────────────────────────────────
export async function searchRelevantChunks(question, topK = 6, filenameFilter = null) {
  if (vectorStore.length === 0) return [];

  const questionVector = await embedText(question);

  // Filter by filename if specified
  const pool = filenameFilter
    ? vectorStore.filter(e => e.filename.toLowerCase().includes(filenameFilter.toLowerCase()))
    : vectorStore;

  if (pool.length === 0) return [];

  // Score every chunk using hybrid scoring
  const scored = pool.map(entry => {
    const vectorSim = cosineSimilarity(questionVector, entry.vector);
    const kwScore = keywordScore(entry.text, question);
    // 60% vector similarity + 40% keyword matching
    const hybridScore = (vectorSim * 0.5) + (kwScore * 0.5);
    return { ...entry, score: hybridScore, vectorSim, kwScore };
  });

  // Sort by hybrid score
  scored.sort((a, b) => b.score - a.score);
  const topChunks = scored.slice(0, topK);

  // Add surrounding chunks for context
  const enriched = [];
  const addedIds = new Set();

  for (const chunk of topChunks) {
    // Add the chunk itself
    if (!addedIds.has(chunk.id)) {
      enriched.push(chunk);
      addedIds.add(chunk.id);
    }

    // Add chunk before and after for context
    const prevChunk = vectorStore.find(e =>
      e.filename === chunk.filename && e.chunkIndex === chunk.chunkIndex - 1
    );
    const nextChunk = vectorStore.find(e =>
      e.filename === chunk.filename && e.chunkIndex === chunk.chunkIndex + 1
    );

    if (prevChunk && !addedIds.has(prevChunk.id)) {
      enriched.push({ ...prevChunk, score: chunk.score * 0.8, context: 'before' });
      addedIds.add(prevChunk.id);
    }
    if (nextChunk && !addedIds.has(nextChunk.id)) {
      enriched.push({ ...nextChunk, score: chunk.score * 0.8, context: 'after' });
      addedIds.add(nextChunk.id);
    }
  }

  // Sort again and return
  enriched.sort((a, b) => b.score - a.score);
  return enriched.slice(0, topK * 2);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
export function getIndexedDocuments() {
  const docs = {};
  for (const entry of vectorStore) {
    if (!docs[entry.filename]) docs[entry.filename] = 0;
    docs[entry.filename]++;
  }
  return Object.entries(docs).map(([filename, chunks]) => ({ filename, chunks }));
}

export function clearDocument(filename) {
  const before = vectorStore.length;
  for (let i = vectorStore.length - 1; i >= 0; i--) {
    if (vectorStore[i].filename === filename) vectorStore.splice(i, 1);
  }
  // Also clear section index for this document
  for (let i = sectionIndex.length - 1; i >= 0; i--) {
    if (sectionIndex[i].filename === filename) sectionIndex.splice(i, 1);
  }
  return before - vectorStore.length;
}

export function clearAll() {
  vectorStore.length = 0;
  sectionIndex.length = 0;
}