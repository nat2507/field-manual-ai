# 🔧 Field Manual AI — RAG-Powered Chatbot

A smart chatbot that lets field workers ask questions about product manuals in plain language.
Uses **Retrieval-Augmented Generation (RAG)** to find precise answers from your PDF manuals.

---

## How It Works (Plain English)

```
1. You upload PDF manuals → backend splits them into small chunks → converts to vectors
2. Field worker asks a question → question is also converted to a vector
3. System finds the most similar chunks (relevant pages) using maths
4. Only those relevant chunks are sent to Claude AI → fast, accurate answer
```

---

## Project Structure

```
rag-chatbot/
├── backend/          ← Node.js server (RAG engine + API)
│   ├── server.js     ← Express API routes
│   ├── rag.js        ← Chunking, embedding, vector search
│   ├── .env          ← Your API key (YOU CREATE THIS)
│   └── package.json
│
└── frontend/         ← React web app (the UI)
    ├── src/App.jsx   ← Main chatbot interface
    ├── index.html
    └── package.json
```

---

## Step-by-Step Setup (Complete Beginner Guide)

### STEP 1 — Install Node.js (one time only)

Node.js lets your computer run JavaScript outside the browser.

1. Go to https://nodejs.org
2. Download the **LTS** version (the left green button)
3. Run the installer, click Next through everything
4. To verify it worked, open **Terminal** (Mac) or **Command Prompt** (Windows) and type:
   ```
   node --version
   ```
   You should see something like `v20.11.0`

---

### STEP 2 — Get your Anthropic API Key

1. Go to https://console.anthropic.com
2. Sign up / log in
3. Click **API Keys** in the left sidebar
4. Click **Create Key**, give it a name, copy the key
5. Save it somewhere safe — you only see it once!

---

### STEP 3 — Set up the Backend

Open Terminal (Mac) or Command Prompt (Windows):

```bash
# Navigate into the backend folder
cd rag-chatbot/backend

# Install dependencies (downloads required packages)
npm install

# Create your environment file (stores your API key)
cp .env.example .env
```

Now open the `.env` file in any text editor (Notepad, TextEdit, VS Code) and replace:
```
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```
with your actual key:
```
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxx
```
Save the file.

---

### STEP 4 — Start the Backend

In your Terminal (still in the backend folder):

```bash
npm start
```

You should see:
```
🚀 Field Manual RAG Server running on http://localhost:3001
   API Key: ✅ Set
```

**Keep this Terminal window open.** The backend must stay running.

---

### STEP 5 — Set up the Frontend

Open a **second** Terminal window:

```bash
# Navigate into the frontend folder
cd rag-chatbot/frontend

# Install dependencies
npm install

# Start the frontend
npm run dev
```

You should see:
```
  VITE v5.x.x  ready in 300ms
  ➜  Local:   http://localhost:5173/
```

---

### STEP 6 — Open the App

Open your browser and go to:
```
http://localhost:5173
```

🎉 Your RAG chatbot is running!

---

## Using the App

1. **Upload a manual** — Click "UPLOAD PDF" or drag a PDF into the sidebar
2. **Wait for indexing** — You'll see "X chunks indexed" when done
3. **Ask a question** — Type naturally: *"What is the torque spec for bolt A?"*
4. **See sources** — Each answer shows which manual section was used and match %

---

## API Endpoints (for developers)

| Method | Endpoint | What it does |
|--------|----------|-------------|
| POST | `/upload` | Upload and index a PDF |
| POST | `/chat` | Ask a question, get RAG answer |
| GET | `/documents` | List all indexed documents |
| DELETE | `/documents/:filename` | Remove a document |
| DELETE | `/documents` | Clear all documents |
| GET | `/health` | Check server status |

---

## Deploying to the Internet

### Option A — Quick Deploy with Railway (Recommended for beginners)

1. Go to https://railway.app and sign up (free)
2. Connect your GitHub account
3. Push this project to GitHub
4. In Railway: New Project → Deploy from GitHub → select your repo
5. Add environment variable: `ANTHROPIC_API_KEY` = your key
6. Railway gives you a public URL automatically

### Option B — Vercel (Frontend) + Railway (Backend)

- Deploy `frontend/` to Vercel (free)
- Deploy `backend/` to Railway
- Update the Vite proxy in `vite.config.js` to point to your Railway URL

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `node: command not found` | Node.js not installed — redo Step 1 |
| `ANTHROPIC_API_KEY: ❌ Missing` | Check your `.env` file |
| PDF says "could not extract text" | PDF is a scanned image — needs OCR first |
| Frontend can't reach backend | Make sure backend is running on port 3001 |
| Answers seem wrong | Try uploading a cleaner PDF; check chunk count in sidebar |

---

## Upgrading for Production

The current vector store is **in-memory** (resets when server restarts).
For production, replace it with:

- **Pinecone** — managed vector database (easy, free tier)
- **Supabase with pgvector** — Postgres + vectors (free tier)
- **Chroma** — open source, self-hosted

The `rag.js` file is designed so you only need to change the storage functions.
