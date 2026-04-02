// ============================================================
// SERVER v3 — Simplified RAG, no vision, better doc selection
// ============================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import pdf from "pdf-parse/lib/pdf-parse.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import {
  indexDocument,
  searchRelevantChunks,
  getIndexedDocuments,
  clearDocument,
  clearAll,
  saveVectors,
  loadVectors,
  getVectorFilenames,
} from "./rag.js";
import { saveTableData, searchTables, formatTableAnswer } from "./table_search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const MANUALS_DIR = process.env.MANUALS_DIR || "C:\\manuals";
const CORRECTIONS_FILE = process.env.CORRECTIONS_FILE || path.join(MANUALS_DIR, "corrections.json");
const CONFIDENCE_THRESHOLD = 0.40;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are accepted"));
  },
});

// ─────────────────────────────────────────────
// PDF EXTRACTION via pdfplumber (Python)
// ─────────────────────────────────────────────
function extractPdfWithPython(pdfPath) {
  try {
    const scriptPath = path.join(__dirname, 'extract_pdf.py');
    const result = execSync(`python "${scriptPath}" "${pdfPath}"`, {
      maxBuffer: 100 * 1024 * 1024,
      encoding: 'buffer'
    });
    return JSON.parse(result.toString('utf-8'));
  } catch (err) {
    console.log(`[WARN] Python extraction failed: ${err.message}`);
    return null;
  }
}

function buildTextFromPdfData(pdfData) {
  // Separate regular pages from facts pages
  // Facts pages get indexed separately for better embeddings
  return pdfData.pages
    .filter(p => !p.is_facts)
    .map(p => p.content)
    .join('\n\n');
}

function buildFactsFromPdfData(pdfData) {
  // Return only the dedicated facts chunks
  return pdfData.pages
    .filter(p => p.is_facts)
    .map(p => p.content);
}

// ─────────────────────────────────────────────
// CONVERSATION CONTEXT SUMMARY
// Summarises recent history to inject into search
// ─────────────────────────────────────────────
function buildConversationContext(history) {
  if (!history || history.length === 0) return "";
  const recent = history.slice(-8);
  const lines = [];
  for (const msg of recent) {
    if (msg.role === 'user') lines.push(`User asked: ${msg.content}`);
    else if (msg.role === 'assistant') lines.push(`Assistant answered: ${msg.content.slice(0, 150)}...`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// SELF VERIFICATION
// Checks answer against source chunks
// Corrects wrong answers before sending to user
// ─────────────────────────────────────────────
function verifyAnswer(answer) {
  // Simple hallucination detection — fix known bad model names
  // Don't do full verification — too many false positives
  if (!answer) return answer;

  const fixes = [
    { wrong: /\bVEP-4\b/g, correct: 'VEP-A10-P' },
    { wrong: /\bVEP-3\b/g, correct: 'VEP-A00-P' },
    { wrong: /\bVEP-1\b/g, correct: 'VEP-A00-1P' },
    { wrong: /\bVLS-E\b/g, correct: 'VLS' },
  ];

  let fixed = answer;
  for (const fix of fixes) {
    if (fix.wrong.test(fixed)) {
      console.log(`   [VERIFY] Fixed model name: ${fix.wrong} → ${fix.correct}`);
      fixed = fixed.replace(fix.wrong, fix.correct);
    }
  }
  return fixed;
}

// ─────────────────────────────────────────────
// FEW-SHOT EXAMPLES FROM CORRECTIONS
// Injects verified corrections into system prompt
// Guides Claude to give consistent answers
// ─────────────────────────────────────────────
function buildFewShotExamples() {
  const corrections = loadCorrections();
  const verified = corrections.filter(c => c.confidence === 'verified');
  if (verified.length === 0) return "";

  const examples = verified
    .slice(0, 10) // max 10 to keep prompt size manageable
    .map(c => `Q: ${c.question}\nA: ${c.answer}`)
    .join('\n\n');

  return `\nVERIFIED ANSWERS FROM PAST CORRECTIONS — use these as reference when answering similar questions:\n${examples}\n`;
}

// ─────────────────────────────────────────────
// QUERY EXPANSION
// Generates technical variants of user question
// Improves retrieval for plain English questions
// ─────────────────────────────────────────────
async function expandQuery(question, history = []) {
  try {
    // Build conversation context for rewriting
    const convContext = buildConversationContext(history);
    const userContent = convContext
      ? `Conversation so far:\n${convContext}\n\nCurrent question: ${question}`
      : question;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: `You are a search query expander for VESDA fire detection system manuals.
Given a user question (and optional conversation context), generate 3 alternative search 
queries that capture the FULL intent including any context from the conversation.
For example if user was discussing 4000 sq m room coverage and asks "can I use multiple VEP?"
expand to include coverage context: "multiple VEP detectors covering 4000 sq m area"

Output ONLY a JSON array of 3 strings. No explanation, no markdown.`,
        messages: [{ role: "user", content: userContent }]
      }),
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim() || '[]';
    const variants = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (Array.isArray(variants) && variants.length > 0) {
      console.log(`   [EXPAND] Variants: ${variants.join(' | ')}`);
      return [question, ...variants.slice(0, 3)];
    }
    return [question];
  } catch (err) {
    return [question];
  }
}

// ─────────────────────────────────────────────
// CORRECTIONS
// ─────────────────────────────────────────────
function loadCorrections() {
  try {
    if (fs.existsSync(CORRECTIONS_FILE)) {
      return JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
    }
  } catch (err) {}
  return [];
}

function saveCorrections(corrections) {
  try {
    fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(corrections, null, 2));
  } catch (err) {}
}

function findCorrection(question) {
  const corrections = loadCorrections();
  const qLower = question.toLowerCase();
  // Only use corrections that aren't rejected
  return corrections.find(c => {
    if (c.confidence === 'rejected') return false;
    const cWords = c.question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matches = cWords.filter(w => qLower.includes(w)).length;
    return matches >= Math.ceil(cWords.length * 0.6);
  }) || null;
}

async function addCorrection(question, answer, filename, page) {
  const corrections = loadCorrections();
  const filtered = corrections.filter(c => c.question.toLowerCase() !== question.toLowerCase());

  // Verify correction against manuals
  const verification = await verifyCorrection(question, answer);

  filtered.push({
    question,
    answer,
    filename,
    page,
    confidence: verification.confidence,
    flagged: verification.confidence === 'pending',
    verificationNote: verification.note,
    savedAt: new Date().toISOString()
  });

  saveCorrections(filtered);
  console.log(`[CORRECTION] Saved: "${question}" confidence: ${verification.confidence}`);
  return verification;
}

async function verifyCorrection(question, answer) {
  try {
    // Search manuals for evidence
    const chunks = await searchRelevantChunks(question, 8, null);
    const context = chunks.slice(0, 5)
      .map(c => c.text)
      .join('\n\n');

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: `You are a fact checker for technical manuals.
Given manual excerpts and a proposed answer, determine if the answer is:
- VERIFIED: clearly supported by the manual excerpts
- PENDING: not contradicted but not clearly supported either
- REJECTED: directly contradicts the manual excerpts

Respond with ONLY a JSON object:
{"result": "VERIFIED|PENDING|REJECTED", "note": "brief reason"}`,
        messages: [{
          role: "user",
          content: `Manual excerpts:\n${context}\n\nQuestion: ${question}\nProposed answer: ${answer}`
        }]
      }),
    });

    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim() || '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    if (parsed.result === 'VERIFIED') {
      return { confidence: 'verified', note: parsed.note };
    } else if (parsed.result === 'REJECTED') {
      return { confidence: 'rejected', note: parsed.note };
    } else {
      return { confidence: 'pending', note: parsed.note };
    }
  } catch (err) {
    return { confidence: 'pending', note: 'Could not verify against manuals' };
  }
}

// ─────────────────────────────────────────────
// DOCUMENT SELECTION
// Scores each manual separately and picks best
// ─────────────────────────────────────────────
function selectBestDocument(chunks, question) {
  // Group chunks by document and calculate per-document score
  const docScores = {};
  for (const chunk of chunks) {
    if (!docScores[chunk.filename]) {
      docScores[chunk.filename] = { total: 0, count: 0, topScore: 0 };
    }
    docScores[chunk.filename].total += chunk.score;
    docScores[chunk.filename].count += 1;
    docScores[chunk.filename].topScore = Math.max(
      docScores[chunk.filename].topScore,
      chunk.score
    );
  }

  // Calculate weighted score for each document
  // 70% top score + 30% average score
  const ranked = Object.entries(docScores).map(([filename, scores]) => ({
    filename,
    weightedScore: (scores.topScore * 0.7) + ((scores.total / scores.count) * 0.3),
    topScore: scores.topScore,
    chunkCount: scores.count,
  }));

  ranked.sort((a, b) => b.weightedScore - a.weightedScore);

  console.log(`   [DOC SCORES] ${ranked.map(d => `${d.filename.split('_').slice(-3, -1).join('_')}:${d.weightedScore.toFixed(3)}`).join(', ')}`);

  return ranked[0]?.filename || null;
}

// ─────────────────────────────────────────────
// FUZZY MATCHING for document detection
// ─────────────────────────────────────────────
function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i-1] === a[j-1]
        ? matrix[i-1][j-1]
        : 1 + Math.min(matrix[i-1][j-1], matrix[i-1][j], matrix[i][j-1]);
    }
  }
  return matrix[b.length][a.length];
}

function fuzzyMatch(qWord, target) {
  if (qWord === target) return true;
  const lengthDiff = Math.abs(qWord.length - target.length);
  if (lengthDiff > 2) return false;
  const maxDistance = target.length <= 6 ? 1 : 2;
  return levenshtein(qWord, target) <= maxDistance;
}

function detectMentionedDocument(question) {
  const docs = getIndexedDocuments();
  const qLower = question.toLowerCase();
  const qWords = qLower.split(/\s+/);
  const ignoreWords = ['product', 'guide', 'manual', 'installation', 'application',
    'note', 'lores', 'vesda', 'xtralis', 'page', 'section', 'document'];

  for (const doc of docs) {
    const nameParts = doc.filename.toLowerCase().replace('.pdf', '').split(/[_\-\s]+/);
    const meaningfulParts = nameParts.filter(p => p.length > 3 && !ignoreWords.includes(p));
    const matchCount = meaningfulParts.filter(part =>
      qWords.some(qWord => fuzzyMatch(qWord, part))
    ).length;
    if (matchCount >= 2) return doc.filename;
  }
  return null;
}

// ─────────────────────────────────────────────
// AUTO-LOAD manuals on startup
// ─────────────────────────────────────────────
async function autoLoadManuals() {
  if (!fs.existsSync(MANUALS_DIR)) {
    fs.mkdirSync(MANUALS_DIR, { recursive: true });
    return;
  }

  const files = fs.readdirSync(MANUALS_DIR).filter(f => f.endsWith(".pdf"));
  if (files.length === 0) {
    console.log(`[INFO] No PDFs found in ${MANUALS_DIR}`);
    return;
  }

  // ── Try loading from saved vectors first ──
  const loaded = loadVectors();
  if (loaded) {
    const loadedFiles = getVectorFilenames();
    const allPresent = files.every(f => loadedFiles.includes(f));
    const noNew = loadedFiles.every(f => files.includes(f));

    if (allPresent && noNew) {
      console.log(`\n[OK] Loaded ${getIndexedDocuments().length} manual(s) from saved vectors — skipping re-index\n`);
      return;
    }
    console.log(`[INFO] PDF list changed — re-indexing...`);
    // Clear loaded vectors so we start fresh
    loadedFiles.forEach(f => {});
  }

  console.log(`\n[INFO] Auto-loading ${files.length} manual(s)...`);
  for (const filename of files) {
    try {
      const pdfPath = path.join(MANUALS_DIR, filename);
      let text = null;
      let numpages = 1;

      const pyData = extractPdfWithPython(pdfPath);
      if (pyData) {
        text = buildTextFromPdfData(pyData);
        numpages = pyData.total_pages;
        console.log(`[INFO] ${filename}: ${numpages} pages, ${text.length} chars`);
      } else {
        const buffer = fs.readFileSync(pdfPath);
        const pdfData = await pdf(buffer);
        text = pdfData.text;
        numpages = pdfData.numpages;
      }

      if (!text || text.trim().length < 50) continue;
      await indexDocument(text, filename, numpages, pdfPath);

      // Index facts chunks separately for better embeddings
      if (pyData) {
        const factsList = buildFactsFromPdfData(pyData);
        for (const factsText of factsList) {
          if (factsText.trim().length > 50) {
            await indexDocument(factsText, filename, numpages, null);
            console.log(`[INFO] Indexed ${factsText.split('\n').length} facts separately`);
          }
        }
      }

      // Save structured table data for keyword search
      if (pyData?.table_data?.length > 0) {
        saveTableData(filename, pyData.table_data);
      }
    } catch (err) {
      console.log(`[ERR] Failed to load ${filename}: ${err.message}`);
    }
  }

  // Save vectors to disk for next startup
  saveVectors();
  console.log(`\n[OK] Auto-load complete - ${getIndexedDocuments().length} manual(s) ready\n`);
}

// ─────────────────────────────────────────────
// POST /upload
// ─────────────────────────────────────────────
app.post("/upload", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF file provided" });
    const filename = req.file.originalname;
    const pdfPath = path.join(MANUALS_DIR, filename);

    // Save file first
    fs.writeFileSync(pdfPath, req.file.buffer);

    // Extract with Python
    const pyData = extractPdfWithPython(pdfPath);
    let text, numpages;
    if (pyData) {
      text = buildTextFromPdfData(pyData);
      numpages = pyData.total_pages;
    } else {
      const pdfData = await pdf(req.file.buffer);
      text = pdfData.text;
      numpages = pdfData.numpages;
    }

    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: "Could not extract text from PDF." });
    }

    const result = await indexDocument(text, filename, numpages, pdfPath);
    res.json({ success: true, filename, pages: numpages, chunks: result.chunks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /chat — Simplified RAG, no vision
// ─────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { question, history = [] } = req.body;
    if (!question) return res.status(400).json({ error: "Question is required" });

    const docs = getIndexedDocuments();
    if (docs.length === 0) {
      return res.json({ answer: "No manuals loaded yet." });
    }

 console.log(`\n[Q] "${question}"`);

    // ── SOCIAL RESPONSE DETECTION ──
    const socialPhrases = ['no thanks', 'no thank you', 'not right now', 'dont need',
      "don't need", 'nevermind', 'never mind', 'ok thanks', 'okay thanks',
      'got it', 'thank you', 'thanks', 'bye', "that's all", 'thats all',
      'no more', 'im done', "i'm done", 'no i dont', "no i don't", 'not needed'];
    const isSocialResponse = socialPhrases.some(p => question.toLowerCase().includes(p));
    if (isSocialResponse) {
      console.log(`   [SOCIAL] Responding to social message`);
      return res.json({
        answer: "No problem! Let me know if you need anything else.",
        sources: []
      });
    }

    // ── TABLE SEARCH — only for direct part/SKU lookups ──
    // RAG handles everything else better
    const isDirectLookup = ['sku', 'part number', 'order code', 'spare part', 'part no']
      .some(w => question.toLowerCase().includes(w));

    if (isDirectLookup) {
      const tableMatches = searchTables(question);
      if (tableMatches && tableMatches.length > 0) {
        const tableAnswer = formatTableAnswer(tableMatches, question);
        if (tableAnswer) {
          console.log(`   [TABLE SEARCH] Found ${tableMatches.length} matches`);
          return res.json({
            answer: tableAnswer,
            sources: tableMatches.slice(0, 3).map(m => ({
              filename: m.filename,
              score: Math.round(m.score * 20),
              preview: `Page ${m.page} — ${m.searchable?.slice(0, 100)}...`,
            }))
          });
        }
      }
    }

    // ── CHECK CORRECTIONS FIRST ──
    const correction = findCorrection(question);
    if (correction) {
      console.log(`   [CORRECTION] Using saved answer (${correction.confidence})`);
      const disclaimer = correction.confidence === 'pending'
        ? '\n\nNote: This answer is from a user correction pending admin review — please verify independently.'
        : '';
      return res.json({
        answer: correction.answer + disclaimer,
        correctionId: correction.savedAt,
        confidence: correction.confidence,
        sources: [{ filename: correction.filename || 'Saved correction', score: 100, preview: `${correction.confidence === 'verified' ? '✅ Verified' : '⚠️ Pending review'} correction` }]
      });
    }

    // ── DETECT MENTIONED DOCUMENT ──
    const mentionedDoc = detectMentionedDocument(question);
    if (mentionedDoc) console.log(`   [FILTER] Focused on: ${mentionedDoc}`);

    // ── QUERY EXPANSION + HYBRID SEARCH ──
    // Skip expansion for direct lookups — table search handles those
    let allChunks = [];
    const seenIds = new Set();

    if (!isDirectLookup) {
      // Expand query for better retrieval
      const queryVariants = await expandQuery(question, history);
      for (const variant of queryVariants) {
        const variantChunks = await searchRelevantChunks(variant, 10, mentionedDoc);
        for (const chunk of variantChunks) {
          if (!seenIds.has(chunk.id)) {
            allChunks.push(chunk);
            seenIds.add(chunk.id);
          }
        }
      }
      allChunks.sort((a, b) => b.score - a.score);
    } else {
      allChunks = await searchRelevantChunks(question, 15, mentionedDoc);
    }

    const chunks = allChunks;
    const topScore = chunks[0]?.score || 0;

    // Send top chunks from ALL documents — let Claude decide what's relevant
    const bestChunks = mentionedDoc
      ? chunks.filter(c => c.filename === mentionedDoc).slice(0, 8)
      : chunks.slice(0, 8);

    console.log(`   Score: ${topScore.toFixed(3)} | Top chunks: ${bestChunks.length} | Docs: ${[...new Set(bestChunks.map(c => c.filename.split('_').pop().replace('.pdf','')))].join(', ')}`);

    // ── WEAK FOLLOW-UP CHECK ──
    const hasHistory = history.length > 0;
    const specificWords = ['how', 'what', 'where', 'when', 'why', 'which', 'show',
      'explain', 'describe', 'list', 'give', 'tell', 'summary', 'configure',
      'install', 'replace', 'reset', 'set', 'connect', 'check', 'test', 'sku',
      'part', 'spare'];
    const hasSpecificIntent = specificWords.some(w => question.toLowerCase().includes(w));
    const correctionWords = ['wrong', 'incorrect', 'not right', 'are you sure',
      'i think', 'double check', 'missing', 'does mention', 'should have',
      'actually', 'try again', 'look again', 'look at the manual', 'should find',
      'if you look', 'have a look', 'check the manual', 'is software'];
    const isCorrection = correctionWords.some(w => question.toLowerCase().includes(w));
    const isShort = question.split(' ').length < 8;
    // Questions with model numbers or technical terms should always search manuals
    const hasModelNumber = /[A-Z]{2,}-[A-Z0-9]{2,}|[A-Z]{3,}\d{2,}/i.test(question);
    const isWeakFollowUp = hasHistory && topScore < 0.50 && !hasSpecificIntent && !isCorrection && isShort && !hasModelNumber;

    if (isWeakFollowUp) {
      console.log(`   [PATH] History fallback`);
      const lastUserQ = history.slice().reverse().find(h => h.role === 'user')?.content || '';
      const combined = question.length < 15 && lastUserQ ? `${lastUserQ} ${question}` : question;

      const histRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 500,
          system: `You are a knowledgeable field support mate for VESDA fire detection systems.
Answer follow-up questions using ONLY the conversation history.
Be conversational and concise. No bold headers. No bullet points unless listing 3+ items.
If you cannot answer from history, say so briefly.`,
          messages: [...history.slice(-6), { role: "user", content: combined }],
        }),
      });
      const histData = await histRes.json();
      return res.json({
        answer: histData?.content?.[0]?.text || "I'm not sure — can you clarify?",
        sources: bestChunks.slice(0, 3).map(c => ({
          filename: c.filename, score: Math.round(c.score * 100),
          preview: `Page ${c.pageNumber} — ${c.text.slice(0, 100)}...`,
        }))
      });
    }

    // ── TEXT PATH ──
    console.log(`   [PATH] Text search`);
    const context = [...bestChunks]
      .sort((a, b) => a.pageNumber - b.pageNumber)
      .map((c, i) => `[Source ${i + 1} | ${c.filename} | Page ${c.pageNumber}]\n${c.text}`)
      .join("\n\n---\n\n");

    const textRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: `You are a knowledgeable field support mate for technicians working with VESDA fire detection systems.
Answer questions using ONLY the provided manual excerpts.
${buildFewShotExamples()}
Personality:
- Talk like a knowledgeable colleague — natural and conversational
- Get straight to the answer, no preamble
- Never use bold text (**word**) or markdown formatting
- Write in plain text only
- For simple questions answer in 1-3 sentences
- For procedures use short numbered steps
- Only mention page/manual if specifically asked
- Never start with "Based on..." or "According to..."
- If the answer is in a table in the excerpts, read it and answer directly
- Never guess specifications, voltages, currents, or measurements
- Treat SKU, part number, order code as the same thing
- If genuinely not found say "NOT_FOUND" on its own line
- If ambiguous ask ONE short clarifying question
- If told answer is wrong — acknowledge and try again with different approach
- Always consider conversation context when answering follow-up questions
- If question seems like a follow-up use conversation context to understand full intent
- Match answer depth to question complexity — simple yes/no questions get 1-3 sentences max
- Never volunteer extra information that wasn't asked for
- If user asks "can I use X?" answer yes/no + one key reason, nothing more
- Only elaborate when user explicitly asks for more detail
- For detector selection questions based on area/room size:
  1. Find coverage specs for all detectors in the excerpts
  2. VESDA-E coverage areas are: VEU=6500m², VEP-A10-P=2000m², VES=2000m², VEA=3345m²
  3. Recommend single detector if it covers the required area
  4. If no single detector covers the area calculate minimum units needed
  5. Never mention VEP-4 — it does not exist as a model
  6. Always compare ALL detector options before recommending`,
        messages: [
          ...history.slice(-6),
          { role: "user", content: buildConversationContext(history)
            ? `CONVERSATION CONTEXT:\n${buildConversationContext(history)}\n\n---\n\nMANUAL EXCERPTS:\n\n${context}\n\n---\n\nQUESTION: ${question}`
            : `MANUAL EXCERPTS:\n\n${context}\n\n---\n\nQUESTION: ${question}` }
        ],
      }),
    });

    const textData = await textRes.json();
    let answer = textData?.content?.[0]?.text || "";

    // Fix known hallucinated model names
    answer = verifyAnswer(answer);

    // If not found — try searching without document filter
    if (answer.includes("NOT_FOUND") && mentionedDoc) {
      console.log(`   [RETRY] Not found in ${mentionedDoc} — searching all manuals`);
      const allChunks = await searchRelevantChunks(question, 8, null);
      const retryContext = allChunks.slice(0, 6)
        .sort((a, b) => a.pageNumber - b.pageNumber)
        .map((c, i) => `[Source ${i + 1} | ${c.filename} | Page ${c.pageNumber}]\n${c.text}`)
        .join("\n\n---\n\n");

      const retryRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `You are a knowledgeable field support mate for VESDA fire detection systems.
Answer using ONLY the provided excerpts. Plain text, no bold, conversational tone.
If genuinely not found say so briefly.`,
          messages: [
            ...history.slice(-6),
            { role: "user", content: `MANUAL EXCERPTS:\n\n${retryContext}\n\n---\n\nQUESTION: ${question}` }
          ],
        }),
      });
      const retryData = await retryRes.json();
      answer = retryData?.content?.[0]?.text || answer;
    }

    res.json({
      answer,
      sources: bestChunks.slice(0, 5).map(c => ({
        filename: c.filename,
        score: Math.round(c.score * 100),
        preview: `Page ${c.pageNumber} — ${c.text.slice(0, 100)}...`,
      }))
    });

  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// CORRECTIONS ROUTES
// ─────────────────────────────────────────────
app.post("/corrections", async (req, res) => {
  const { question, answer, filename, page } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "question and answer required" });
  const verification = await addCorrection(question, answer, filename, page);

  if (verification.confidence === 'rejected') {
    return res.json({
      success: false,
      rejected: true,
      reason: verification.note,
      message: `This correction was not saved because it contradicts the manuals: ${verification.note}`
    });
  }

  res.json({
    success: true,
    confidence: verification.confidence,
    note: verification.note,
    message: verification.confidence === 'verified'
      ? `✅ Correction verified and saved! Found supporting evidence in the manuals.`
      : `⚠️ Correction saved but flagged for admin review — could not verify against manuals.`
  });
});

app.get("/corrections", (_, res) => res.json({ corrections: loadCorrections() }));

app.patch("/corrections/:index/approve", (req, res) => {
  const corrections = loadCorrections();
  const index = parseInt(req.params.index);
  if (corrections[index]) {
    corrections[index].confidence = 'verified';
    corrections[index].flagged = false;
    corrections[index].approvedAt = new Date().toISOString();
    saveCorrections(corrections);
    res.json({ success: true, message: 'Correction approved' });
  } else {
    res.status(404).json({ error: 'Correction not found' });
  }
});

app.delete("/corrections/:index", (req, res) => {
  const corrections = loadCorrections();
  corrections.splice(parseInt(req.params.index), 1);
  saveCorrections(corrections);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// FEEDBACK ROUTES
// Thumbs up/down for reinforcement learning
// ─────────────────────────────────────────────
app.post("/feedback", async (req, res) => {
  const { question, answer, type } = req.body;
  if (!question || !answer || !type) {
    return res.status(400).json({ error: "question, answer and type required" });
  }

  const corrections = loadCorrections();

  if (type === 'up') {
    // Thumbs up — save as verified correction directly
    const existing = corrections.findIndex(
      c => c.question.toLowerCase() === question.toLowerCase()
    );
    if (existing >= 0) {
      // Update existing — increment thumbsUp
      corrections[existing].thumbsUp = (corrections[existing].thumbsUp || 0) + 1;
      corrections[existing].confidence = 'verified';
      corrections[existing].flagged = false;
    } else {
      // Save as new verified correction
      corrections.push({
        question,
        answer,
        confidence: 'verified',
        flagged: false,
        thumbsUp: 1,
        thumbsDown: 0,
        savedAt: new Date().toISOString(),
        source: 'thumbs_up'
      });
    }
    saveCorrections(corrections);
    console.log(`[FEEDBACK] 👍 Thumbs up: "${question.slice(0, 50)}"`);
    return res.json({ success: true, message: 'Thanks for the feedback!' });
  }

  if (type === 'down') {
    // Thumbs down — increment counter
    const existing = corrections.findIndex(
      c => c.question.toLowerCase() === question.toLowerCase()
    );
    if (existing >= 0) {
      corrections[existing].thumbsDown = (corrections[existing].thumbsDown || 0) + 1;
    }
    saveCorrections(corrections);
    console.log(`[FEEDBACK] 👎 Thumbs down: "${question.slice(0, 50)}"`);
    return res.json({ success: true, message: 'Thanks — please use the correction button to provide the right answer.' });
  }

  res.status(400).json({ error: "type must be 'up' or 'down'" });
});

// ─────────────────────────────────────────────
// OTHER ROUTES
// ─────────────────────────────────────────────
app.get("/documents", (_, res) => res.json({ documents: getIndexedDocuments() }));
app.get("/documents", (_, res) => res.json({ documents: getIndexedDocuments() }));

app.delete("/documents/:filename", (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  clearDocument(filename);
  res.json({ success: true });
});

app.delete("/documents", (_, res) => { clearAll(); res.json({ success: true }); });

app.get("/health", (_, res) => res.json({ status: "ok", documents: getIndexedDocuments().length }));

// ─────────────────────────────────────────────
// SERVE FRONTEND
// ─────────────────────────────────────────────
const FRONTEND_PATH = path.join(__dirname, "public");
if (fs.existsSync(FRONTEND_PATH)) {
  app.use(express.static(FRONTEND_PATH));
  app.get("*", (_, res) => {
    res.sendFile(path.join(FRONTEND_PATH, "index.html"));
  });
  console.log(`[OK] Serving frontend from ${FRONTEND_PATH}`);
}

app.listen(PORT, async () => {
  console.log(`\n[OK] Field Manual RAG Server v3 on http://localhost:${PORT}`);
  console.log(`   API Key: ${process.env.ANTHROPIC_API_KEY ? "Set" : "MISSING"}`);
  await autoLoadManuals();
});