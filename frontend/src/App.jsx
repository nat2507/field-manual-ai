import { useState, useRef, useEffect } from "react";

const API = import.meta.env.VITE_API_URL || "/api";

// ── Icons ──
const WrenchIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);
const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
const SendIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);
const TrashIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6M9 6V4h6v2" />
  </svg>
);
const BookIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);
const ChipIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /><rect x="2" y="2" width="20" height="20" rx="2" />
  </svg>
);

function TypingDots() {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "2px 0" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          width: 7, height: 7, borderRadius: "50%", background: "#f59e0b",
          animation: "bounce 1.2s ease-in-out infinite", animationDelay: `${i * 0.2}s`,
        }} />
      ))}
    </div>
  );
}

function SourceBadge({ source }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)",
      borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "#f59e0b",
      marginTop: 6, marginRight: 4,
    }}>
      <ChipIcon />
      <span>{source.filename.replace(".pdf", "")} · {source.score}% match</span>
    </div>
  );
}

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [messages, setMessages] = useState([
    { role: "assistant", content: "G'day! Your product manuals are pre-loaded and ready. Ask me anything about your product — I'll find the right answer from the manuals instantly.", sources: [] },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const fileRef = useRef();
  const chatRef = useRef();
  const inputRef = useRef();
  const historyRef = useRef([]); // keeps assistant/user history for multi-turn
  const lastDocRef = useRef(null); // tracks last document used
  const [correctingMsgIndex, setCorrectingMsgIndex] = useState(null);
  const [correctionText, setCorrectionText] = useState("");
  const [correctionStatus, setCorrectionStatus] = useState({});
  const [feedback, setFeedback] = useState({});
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminCorrections, setAdminCorrections] = useState([]);

  useEffect(() => {
    fetchDocuments();
  }, []);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, loading]);

  async function fetchDocuments() {
    try {
      const res = await fetch(`${API}/documents`);
      const data = await res.json();
      setDocuments(data.documents || []);
    } catch (_) {}
  }

  async function handleFiles(files) {
    const pdfs = Array.from(files).filter((f) => f.type === "application/pdf");
    if (!pdfs.length) return;

    setUploading(true);
    for (const file of pdfs) {
      setUploadStatus(`Indexing ${file.name}...`);
      const form = new FormData();
      form.append("pdf", file);
      try {
        const res = await fetch(`${API}/upload`, { method: "POST", body: form });
        const data = await res.json();
        if (data.success) {
          setUploadStatus(`✅ ${file.name} — ${data.chunks} chunks indexed`);
        } else {
          setUploadStatus(`❌ ${file.name}: ${data.error}`);
        }
      } catch (err) {
        setUploadStatus(`❌ Upload failed: ${err.message}`);
      }
    }
    await fetchDocuments();
    setUploading(false);
    setTimeout(() => setUploadStatus(null), 4000);
  }

  async function removeDocument(filename) {
    await fetch(`${API}/documents/${encodeURIComponent(filename)}`, { method: "DELETE" });
    await fetchDocuments();
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const question = input.trim();
    const userMsg = { role: "user", content: question };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    // Build conversation history for backend (only text, no sources)
    const history = historyRef.current;

    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history, lastDocument: lastDocRef.current }),
      });
      const data = await res.json();
 	const assistantMsg = {
        role: "assistant",
        content: data.answer || "Sorry, I couldn't generate an answer.",
        sources: data.sources || [],
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Track last document used
      if (data.lastDocument) lastDocRef.current = data.lastDocument;

      // Update history for next turn
      historyRef.current = [
        ...history,
        { role: "user", content: question },
        { role: "assistant", content: assistantMsg.content },
      ].slice(-12); // keep last 6 exchanges
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Connection error: ${err.message}`, sources: [] }]);
    }
    setLoading(false);
  }

  async function fetchCorrections() {
    try {
      const res = await fetch(`${API}/corrections`);
      const data = await res.json();
      setAdminCorrections(data.corrections || []);
    } catch (_) {}
  }

  async function approveCorrection(index) {
    await fetch(`${API}/corrections/${index}/approve`, { method: 'PATCH' });
    await fetchCorrections();
  }

  async function deleteCorrection(index) {
    await fetch(`${API}/corrections/${index}`, { method: 'DELETE' });
    await fetchCorrections();
  }

  async function submitFeedback(msgIndex, type) {
    const question = messages[msgIndex - 1]?.content || "";
    const answer = messages[msgIndex]?.content || "";
    try {
      await fetch(`${API}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answer, type }),
      });
      setFeedback(prev => ({ ...prev, [msgIndex]: type }));
      if (type === 'down') {
        setCorrectingMsgIndex(msgIndex);
        setCorrectionText("");
      }
    } catch (err) {
      console.error('Feedback error:', err);
    }
  }

  async function submitCorrection(msgIndex) {
    if (!correctionText.trim()) return;
    const question = messages[msgIndex - 1]?.content || "";
    try {
      const res = await fetch(`${API}/corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          answer: correctionText.trim(),
        }),
      });
      const data = await res.json();
      setCorrectionStatus(prev => ({
        ...prev,
        [msgIndex]: { message: data.message, rejected: data.rejected }
      }));
      if (!data.rejected) {
        setCorrectingMsgIndex(null);
        setCorrectionText("");
      }
    } catch (err) {
      setCorrectionStatus(prev => ({
        ...prev,
        [msgIndex]: { message: "Failed to save correction", rejected: true }
      }));
    }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  const SUGGESTED = [
    "What are the safety precautions?",
    "How do I troubleshoot error codes?",
    "What is the maintenance schedule?",
    "What tools are required for installation?",
  ];

  return (
    <div style={{
      minHeight: "100vh", background: "#0f1117",
      fontFamily: "'IBM Plex Mono', monospace", display: "flex", flexDirection: "column",
      backgroundImage: "radial-gradient(ellipse at 15% 50%, rgba(245,158,11,0.05) 0%, transparent 55%)",
    }}>
      <style>{`
        @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-5px)} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:#151820} ::-webkit-scrollbar-thumb{background:#2a2d38;border-radius:2px}
        .msg{animation:fadeUp 0.2s ease-out both}
        textarea:focus{outline:none!important}
        .chip:hover{background:rgba(245,158,11,0.15)!important}
        .rm:hover{color:#f87171!important}
        .sendbtn:hover:not(:disabled){background:#d97706!important}
        .upbtn:hover{border-color:#f59e0b!important;color:#f59e0b!important}
        .dropzone:hover{border-color:#555!important}
      `}</style>

      {/* ── Header ── */}
      {/* ── Admin Panel ── */}
      {showAdmin && (
        <div style={{
          background: '#0d0f16', borderBottom: '1px solid #1e2130',
          padding: '16px 24px', maxHeight: 300, overflowY: 'auto',
        }}>
          <div style={{ fontSize: 11, color: '#f59e0b', letterSpacing: '0.1em', marginBottom: 12 }}>
            ⚙️ CORRECTIONS ADMIN — {adminCorrections.length} saved
          </div>
          {adminCorrections.length === 0 ? (
            <div style={{ fontSize: 11, color: '#333' }}>No corrections saved yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ color: '#444', textAlign: 'left' }}>
                  <th style={{ padding: '4px 8px', borderBottom: '1px solid #1e2130' }}>Question</th>
                  <th style={{ padding: '4px 8px', borderBottom: '1px solid #1e2130' }}>Answer</th>
                  <th style={{ padding: '4px 8px', borderBottom: '1px solid #1e2130' }}>Status</th>
                  <th style={{ padding: '4px 8px', borderBottom: '1px solid #1e2130' }}>Feedback</th>
                  <th style={{ padding: '4px 8px', borderBottom: '1px solid #1e2130' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {adminCorrections.map((c, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #151820' }}>
                    <td style={{ padding: '6px 8px', color: '#888', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.question}</td>
                    <td style={{ padding: '6px 8px', color: '#ccc', maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.answer}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4, fontSize: 10,
                        background: c.confidence === 'verified' ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)',
                        color: c.confidence === 'verified' ? '#22c55e' : '#f59e0b',
                        border: `1px solid ${c.confidence === 'verified' ? 'rgba(34,197,94,0.2)' : 'rgba(245,158,11,0.2)'}`,
                      }}>
                        {c.confidence === 'verified' ? '✅ Verified' : '⚠️ Pending'}
                      </span>
                    </td>
                    <td style={{ padding: '6px 8px', fontSize: 11 }}>
                      <span style={{ color: '#22c55e' }}>👍 {c.thumbsUp || 0}</span>
                      {' '}
                      <span style={{ color: '#f87171' }}>👎 {c.thumbsDown || 0}</span>
                    </td>
                    <td style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
                      {c.confidence === 'pending' && (
                        <button onClick={() => approveCorrection(i)} style={{
                          background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)',
                          color: '#22c55e', padding: '3px 10px', borderRadius: 4,
                          cursor: 'pointer', fontSize: 10, fontFamily: 'inherit',
                        }}>Approve</button>
                      )}
                      <button onClick={() => deleteCorrection(i)} style={{
                        background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)',
                        color: '#f87171', padding: '3px 10px', borderRadius: 4,
                        cursor: 'pointer', fontSize: 10, fontFamily: 'inherit',
                      }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden", maxHeight: "calc(100vh - 69px)" }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: "linear-gradient(135deg, #f59e0b, #b45309)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 0 16px rgba(245,158,11,0.25)",
        }}>
          <WrenchIcon />
        </div>
        <div>
          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, letterSpacing: "0.08em", color: "#f5f0e8" }}>
            FIELD MANUAL AI <span style={{ fontSize: 12, color: "#f59e0b", letterSpacing: "0.1em" }}>· RAG</span>
          </div>
          <div style={{ fontSize: 10, color: "#444", letterSpacing: "0.06em" }}>
            {documents.length === 0 ? "NO MANUALS INDEXED" : `${documents.length} MANUAL${documents.length > 1 ? "S" : ""} INDEXED`}
            {documents.length > 0 && <span style={{ color: "#22c55e", marginLeft: 6 }}>●</span>}
          </div>
        </div>
        <button onClick={() => { setShowAdmin(!showAdmin); fetchCorrections(); }} style={{
          marginLeft: "auto", background: showAdmin ? 'rgba(245,158,11,0.1)' : 'none',
          border: `1px solid ${showAdmin ? '#f59e0b' : '#2a2d38'}`,
          color: showAdmin ? '#f59e0b' : '#888', padding: "7px 14px", borderRadius: 8,
          cursor: "pointer", fontSize: 11, fontFamily: "inherit", letterSpacing: "0.04em",
        }}>
          ⚙️ ADMIN
        </button>
        <button className="upbtn" onClick={() => fileRef.current.click()} style={{
          background: "none", border: "1px solid #2a2d38",
          color: "#888", padding: "7px 14px", borderRadius: 8, cursor: "pointer",
          fontSize: 11, display: "flex", alignItems: "center", gap: 6,
          fontFamily: "inherit", letterSpacing: "0.04em", transition: "all 0.2s",
        }}>
          <UploadIcon /> UPLOAD PDF
        </button>
        <input ref={fileRef} type="file" accept=".pdf" multiple style={{ display: "none" }}
          onChange={(e) => handleFiles(e.target.files)} />
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", maxHeight: "calc(100vh - 69px)" }}>

        {/* ── Sidebar ── */}
        <div style={{ width: 230, borderRight: "1px solid #1a1d26", background: "#0b0d13", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          <div style={{ padding: "14px 14px 8px", fontSize: 10, color: "#333", letterSpacing: "0.1em" }}>INDEXED MANUALS</div>

          {/* Auto-load status */}
          <div style={{
            margin: "0 10px 10px", borderRadius: 8, padding: "10px 12px",
            background: "rgba(34,197,94,0.05)", border: "1px solid rgba(34,197,94,0.1)",
          }}>
            <div style={{ fontSize: 10, color: "#22c55e", marginBottom: 3 }}>● AUTO-LOADED ON STARTUP</div>
            <div style={{ fontSize: 10, color: "#333", lineHeight: 1.6 }}>
              Add PDFs to<br />
              <span style={{ color: "#555" }}>backend/manuals/</span><br />
              and restart server
            </div>
          </div>

          {/* Optional extra upload */}
          <div className="dropzone"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
            onClick={() => fileRef.current.click()}
            style={{
              margin: "0 10px 10px", border: `1.5px dashed ${dragOver ? "#f59e0b" : "#1e2130"}`,
              borderRadius: 8, padding: "10px", textAlign: "center", cursor: "pointer",
              background: dragOver ? "rgba(245,158,11,0.05)" : "transparent", transition: "all 0.2s",
            }}>
            {uploading ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div style={{ width: 14, height: 14, border: "2px solid #f59e0b", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                <div style={{ fontSize: 10, color: "#555" }}>{uploadStatus || "Processing..."}</div>
              </div>
            ) : (
              <div style={{ fontSize: 10, color: "#2a2d38" }}>+ Add extra PDF</div>
            )}
          </div>

          {uploadStatus && !uploading && (
            <div style={{ margin: "0 10px 8px", fontSize: 10, color: uploadStatus.startsWith("✅") ? "#22c55e" : "#f87171", padding: "6px 8px", background: "rgba(255,255,255,0.03)", borderRadius: 6 }}>
              {uploadStatus}
            </div>
          )}

          {/* Document list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
            {documents.length === 0 ? (
              <div style={{ fontSize: 11, color: "#2a2d38", padding: "8px 6px", lineHeight: 1.7 }}>
                No manuals loaded.<br />Add PDFs to<br />backend/manuals/
              </div>
            ) : (
              documents.map((doc) => (
                <div key={doc.filename} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "7px 8px",
                  borderRadius: 6, marginBottom: 4, background: "rgba(245,158,11,0.05)",
                  border: "1px solid rgba(245,158,11,0.1)",
                }}>
                  <div style={{ color: "#f59e0b", flexShrink: 0 }}><BookIcon /></div>
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <div style={{ fontSize: 11, color: "#bbb", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {doc.filename.replace(".pdf", "")}
                    </div>
                    <div style={{ fontSize: 10, color: "#3a3d4a" }}>{doc.chunks} chunks</div>
                  </div>
                  <button className="rm" onClick={() => removeDocument(doc.filename)} style={{
                    background: "none", border: "none", color: "#2a2d38", cursor: "pointer", padding: 2, transition: "color 0.2s", flexShrink: 0,
                  }}><TrashIcon /></button>
                </div>
              ))
            )}
          </div>

          {/* RAG info */}
          <div style={{ padding: 12, borderTop: "1px solid #151820", fontSize: 10, color: "#2a2d38", lineHeight: 2 }}>
            ● Vectors stored in memory<br />
            ● Top 5 chunks retrieved per query<br />
            ● API key stays server-side
          </div>
        </div>

        {/* ── Chat ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div ref={chatRef} style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            {messages.map((msg, i) => (
              <div key={i} className="msg" style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                {msg.role === "assistant" && (
                  <div style={{
                    width: 28, height: 28, borderRadius: 8, flexShrink: 0, marginRight: 10, marginTop: 2,
                    background: "linear-gradient(135deg,#f59e0b,#b45309)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}><WrenchIcon /></div>
                )}
                <div style={{ maxWidth: "70%" }}>
                  <div style={{
                    background: msg.role === "user" ? "linear-gradient(135deg,#f59e0b,#d97706)" : "#161921",
                    color: msg.role === "user" ? "#0f1117" : "#ccc",
                    padding: "11px 15px",
                    borderRadius: msg.role === "user" ? "13px 13px 3px 13px" : "13px 13px 13px 3px",
                    fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap",
                    border: msg.role === "assistant" ? "1px solid #1e2130" : "none",
                  }}>
                    {msg.content}
                  </div>
   {/* Feedback buttons */}
                  {msg.role === 'assistant' && i > 0 && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                      {feedback[i] ? (
                        <span style={{ fontSize: 10, color: '#444' }}>
                          {feedback[i] === 'up' ? '👍 Thanks!' : '👎 Please correct below'}
                        </span>
                      ) : (
                        <>
                          <button onClick={() => submitFeedback(i, 'up')} style={{
                            background: 'none', border: '1px solid #2a2d38',
                            borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
                            fontSize: 12, color: '#555', fontFamily: 'inherit',
                          }} title="This answer is correct">👍</button>
                          <button onClick={() => submitFeedback(i, 'down')} style={{
                            background: 'none', border: '1px solid #2a2d38',
                            borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
                            fontSize: 12, color: '#555', fontFamily: 'inherit',
                          }} title="This answer is wrong">👎</button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Correction button */}
                  {msg.role === 'assistant' && i > 0 && (
                    <div style={{ marginTop: 6 }}>
                      {correctingMsgIndex === i ? (
                        <div style={{ marginTop: 8 }}>
                          <textarea
                            value={correctionText}
                            onChange={e => setCorrectionText(e.target.value)}
                            placeholder="Type the correct answer..."
                            rows={3}
                            style={{
                              width: '100%', boxSizing: 'border-box',
                              background: '#1a1d26', border: '1px solid #f59e0b',
                              borderRadius: 8, padding: '8px 12px', color: '#ccc',
                              fontSize: 12, fontFamily: 'inherit', resize: 'none',
                            }}
                          />
                          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                            <button onClick={() => submitCorrection(i)} style={{
                              background: '#f59e0b', border: 'none', color: '#0f1117',
                              padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
                              fontSize: 11, fontFamily: 'inherit',
                            }}>Save Correction</button>
                            <button onClick={() => { setCorrectingMsgIndex(null); setCorrectionText(""); }} style={{
                              background: '#1a1d26', border: '1px solid #2a2d38', color: '#888',
                              padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
                              fontSize: 11, fontFamily: 'inherit',
                            }}>Cancel</button>
                          </div>
                          {correctionStatus[i] && (
                            <div style={{
                              marginTop: 6, fontSize: 11, padding: '6px 10px', borderRadius: 6,
                              background: correctionStatus[i].rejected ? 'rgba(248,113,113,0.1)' : 'rgba(34,197,94,0.1)',
                              color: correctionStatus[i].rejected ? '#f87171' : '#22c55e',
                              border: `1px solid ${correctionStatus[i].rejected ? 'rgba(248,113,113,0.2)' : 'rgba(34,197,94,0.2)'}`,
                            }}>
                              {correctionStatus[i].message}
                            </div>
                          )}
                        </div>
                      ) : (
                        <button onClick={() => { setCorrectingMsgIndex(i); setCorrectionText(""); }} style={{
                          background: 'none', border: 'none', color: '#444',
                          cursor: 'pointer', fontSize: 10, padding: '2px 0',
                          fontFamily: 'inherit', letterSpacing: '0.03em',
                        }}>
                          ✏️ Correct this answer
                        </button>
                      )}
                    </div>
                  )}

                  {/* Source badges */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      {msg.sources.map((s, j) => <SourceBadge key={j} source={s} />)}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="msg" style={{ display: "flex", alignItems: "flex-start" }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 8, flexShrink: 0, marginRight: 10,
                  background: "linear-gradient(135deg,#f59e0b,#b45309)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}><WrenchIcon /></div>
                <div style={{ background: "#161921", border: "1px solid #1e2130", padding: "11px 15px", borderRadius: "13px 13px 13px 3px" }}>
                  <TypingDots />
                </div>
              </div>
            )}
          </div>

          {/* Suggestions */}
          {documents.length > 0 && messages.length < 3 && (
            <div style={{ padding: "0 24px 10px", display: "flex", flexWrap: "wrap", gap: 7 }}>
              {SUGGESTED.map((s) => (
                <button key={s} className="chip" onClick={() => { setInput(s); inputRef.current?.focus(); }} style={{
                  background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)",
                  color: "#888", padding: "5px 11px", borderRadius: 20,
                  fontSize: 11, cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s",
                }}>{s}</button>
              ))}
            </div>
          )}

          {/* Input bar */}
          <div style={{ padding: "14px 20px", borderTop: "1px solid #1a1d26", background: "#0b0d13", display: "flex", gap: 10, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <textarea
                ref={inputRef} value={input}
                onChange={(e) => setInput(e.target.value)} onKeyDown={handleKey}
                placeholder={documents.length ? "Ask anything about your product..." : "Upload a manual to get started..."}
                rows={1}
                style={{
                  width: "100%", boxSizing: "border-box", background: "#161921",
                  border: "1px solid #252836", borderRadius: 10, padding: "11px 14px",
                  color: "#ccc", fontSize: 13, fontFamily: "inherit", resize: "none", lineHeight: 1.5,
                  transition: "border-color 0.2s",
                }}
                onFocus={(e) => (e.target.style.borderColor = "#f59e0b")}
                onBlur={(e) => (e.target.style.borderColor = "#252836")}
              />
            </div>
            <button className="sendbtn" onClick={sendMessage} disabled={loading || !input.trim()} style={{
              width: 42, height: 42, borderRadius: 10, border: "none", flexShrink: 0,
              background: input.trim() && !loading ? "#f59e0b" : "#161921",
              color: input.trim() && !loading ? "#0f1117" : "#333",
              cursor: input.trim() && !loading ? "pointer" : "not-allowed",
              display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s",
            }}><SendIcon /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
