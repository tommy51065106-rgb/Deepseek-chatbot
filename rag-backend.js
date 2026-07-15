require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3001);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-embedding-001';
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
const MEMORY_DIR = path.join(__dirname, 'memory-store');
const DEFAULT_MEMORY_KEY = 'default';
const DEFAULT_TOP_K = 3;
const MAX_UPLOADED_CONTEXT_CHARS = 12000;
const MAX_HISTORY_MESSAGES = 30;

const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are an expert Fitness Coach.
STRICT DATA-FIRST RULE: Before providing any general facts, you must first reference specific metrics from the uploaded health data (e.g., activity %, HRV, or sleep).
Answer in 3 bullet points maximum and 2-3 suggestions.
Each point must be concise under 30 words. If the answer is complete in fewer points, skip the rest.
Replace vague advice with specific exercises such as HIIT, sprints, or power cycling based on the context.
If the user asks about a date range, use the current date provided in the next system message.
If the answer is not in the provided expert knowledge or uploaded content, say you only know the provided context.
Always personalize the answer using uploaded user health data when available.
If user health data conflicts with generic guidance, prioritize safety and the uploaded health data.
For supplement questions, screen for contraindications from uploaded health data before giving recommendations.
Do not use symbols in the answer, except percent and period.
Provide some suggestion after the 3 bullet points up to 2-3 suggestions. Each suggestion should be concise and actionable, ideally recommending specific exercises or lifestyle changes based on the user's health data and the expert knowledge provided.`,
};

const knowledgeState = {
  chunks: [],
  files: [],
  indexedAt: null,
};

async function getGeminiEmbeddings(texts) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY environment variable');
  }

  const url = `${BASE_URL}/${MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`;
  const body = {
    requests: texts.map(text => ({
      model: `models/${MODEL}`,
      content: { parts: [{ text }] },
    })),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok || !data.embeddings) {
    throw new Error(`Gemini API error: ${JSON.stringify(data)}`);
  }

  return data.embeddings.map(item => item.values);
}

function chunkText(text, chunkSize = 600) {
  const paragraphs = text
    .split(/\n+/)
    .map(item => item.trim())
    .filter(Boolean);

  const output = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if ((current + '\n' + paragraph).trim().length > chunkSize && current.length > 0) {
      output.push(current.trim());
      current = paragraph;
      continue;
    }

    current = current ? `${current}\n${paragraph}` : paragraph;
  }

  if (current.trim()) {
    output.push(current.trim());
  }

  return output;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function ensureKnowledgeDirectory() {
  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });
}

async function ensureMemoryDirectory() {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
}

function getMemoryFilePath() {
  return path.join(MEMORY_DIR, `${DEFAULT_MEMORY_KEY}.json`);
}

function normalizeStoredMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map(message => {
      if (!message || !message.text) {
        return null;
      }

      const sender = message.sender === 'user' ? 'user' : 'ai';
      return {
        id: Number(message.id) || Date.now(),
        text: String(message.text),
        sender,
        timestamp: message.timestamp || new Date().toLocaleTimeString(),
      };
    })
    .filter(Boolean);
}

async function loadMemory() {
  await ensureMemoryDirectory();

  const filePath = getMemoryFilePath();

  try {
    const fileContents = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(fileContents);
    return normalizeStoredMessages(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function saveMemory(messages) {
  await ensureMemoryDirectory();

  const filePath = getMemoryFilePath();
  await fs.writeFile(filePath, JSON.stringify(normalizeStoredMessages(messages), null, 2), 'utf8');
}

async function readKnowledgeFiles() {
  await ensureKnowledgeDirectory();

  const entries = await fs.readdir(KNOWLEDGE_DIR, { withFileTypes: true });
  const textFiles = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .map(entry => entry.name);

  const files = await Promise.all(
    textFiles.map(async fileName => {
      const fullPath = path.join(KNOWLEDGE_DIR, fileName);
      const content = await fs.readFile(fullPath, 'utf8');
      return { fileName, content };
    })
  );

  return files.filter(file => file.content.trim().length > 0);
}

async function indexKnowledgeBase() {
  const files = await readKnowledgeFiles();

  if (files.length === 0) {
    knowledgeState.chunks = [];
    knowledgeState.files = [];
    knowledgeState.indexedAt = new Date().toISOString();
    return { fileCount: 0, chunkCount: 0 };
  }

  const chunkRecords = files.flatMap(file =>
    chunkText(file.content).map((text, index) => ({
      text,
      source: file.fileName,
      chunkIndex: index,
    }))
  );

  const embeddings = await getGeminiEmbeddings(chunkRecords.map(record => record.text));

  knowledgeState.chunks = chunkRecords.map((record, index) => ({
    ...record,
    embedding: embeddings[index],
  }));
  knowledgeState.files = files.map(file => file.fileName);
  knowledgeState.indexedAt = new Date().toISOString();

  return {
    fileCount: knowledgeState.files.length,
    chunkCount: knowledgeState.chunks.length,
  };
}

function retrieveChunks(queryEmbedding, topK) {
  return knowledgeState.chunks
    .map(chunk => ({
      ...chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map(({ embedding, ...chunk }) => chunk);
}

function normalizeConversationMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map(message => {
      if (!message || !message.text) {
        return null;
      }

      return {
        role: message.sender === 'user' ? 'user' : 'assistant',
        content: String(message.text),
      };
    })
    .filter(Boolean);
}

function buildDatePrompt() {
  const currentDate = new Date().toISOString().slice(0, 10);
  return {
    role: 'system',
    content: `Assume today is ${currentDate}. Use this date for any relative time questions like last 7 days.`,
  };
}

function buildUploadedContextPrompt(uploadedContext) {
  if (!uploadedContext || !String(uploadedContext).trim()) {
    return null;
  }

  const trimmed = String(uploadedContext).slice(0, MAX_UPLOADED_CONTEXT_CHARS);
  return {
    role: 'system',
    content: `User health profile and constraints. You must use this to personalize the answer and safety-check recommendations: ${trimmed}`,
  };
}

async function createChatCompletion({ query, messages, uploadedContext }) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('Missing DEEPSEEK_API_KEY environment variable');
  }

  let expertContextPrompt = null;

  if (knowledgeState.chunks.length > 0) {
    try {
      const [queryEmbedding] = await getGeminiEmbeddings([String(query)]);
      const matches = retrieveChunks(queryEmbedding, DEFAULT_TOP_K);

      if (matches.length > 0) {
        expertContextPrompt = {
          role: 'system',
          content: `Use the following expert knowledge for your responses: ${matches.map(match => match.text).join('\n\n')}`,
        };
      }
    } catch (error) {
      console.warn('RAG context unavailable for this request:', error.message);
    }
  }

  const payload = {
    model: 'deepseek-chat',
    messages: [
      SYSTEM_PROMPT,
      buildDatePrompt(),
      ...(expertContextPrompt ? [expertContextPrompt] : []),
      ...(buildUploadedContextPrompt(uploadedContext) ? [buildUploadedContextPrompt(uploadedContext)] : []),
      ...normalizeConversationMessages(messages),
      { role: 'user', content: String(query) },
    ],
    max_tokens: 1500,
    temperature: 0.7,
  };

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${JSON.stringify(data)}`);
  }

  return {
    reply: data.choices?.[0]?.message?.content || '',
  };
}

function trimHistory(messages, maxItems = MAX_HISTORY_MESSAGES) {
  if (!Array.isArray(messages) || messages.length <= maxItems) {
    return Array.isArray(messages) ? messages : [];
  }

  return messages.slice(messages.length - maxItems);
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    indexedAt: knowledgeState.indexedAt,
    fileCount: knowledgeState.files.length,
    chunkCount: knowledgeState.chunks.length,
    knowledgeDir: KNOWLEDGE_DIR,
  });
});

app.get('/knowledge/status', (req, res) => {
  res.json({
    files: knowledgeState.files,
    indexedAt: knowledgeState.indexedAt,
    chunkCount: knowledgeState.chunks.length,
  });
});

app.post('/knowledge/reload', async (req, res) => {
  try {
    const result = await indexKnowledgeBase();
    res.json({ status: 'ok', ...result, indexedAt: knowledgeState.indexedAt });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to reload knowledge base' });
  }
});

app.post('/retrieve', async (req, res) => {
  try {
    const { query, topK = DEFAULT_TOP_K } = req.body;

    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'No query provided' });
    }

    if (knowledgeState.chunks.length === 0) {
      return res.status(400).json({ error: 'Knowledge base is empty. Add .txt files to /knowledge and reload.' });
    }

    const [queryEmbedding] = await getGeminiEmbeddings([String(query)]);
    const matches = retrieveChunks(queryEmbedding, Number(topK) || DEFAULT_TOP_K);

    res.json({
      query,
      matches,
      context: matches.map(match => match.text),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Retrieval failed' });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { query, uploadedContext = '' } = req.body;

    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'No query provided' });
    }

    const history = await loadMemory();
    const trimmedHistory = trimHistory(history);

    const result = await createChatCompletion({
      query: String(query),
      messages: trimmedHistory,
      uploadedContext,
    });

    const updatedHistory = trimHistory([
      ...trimmedHistory,
      {
        id: Date.now(),
        text: String(query),
        sender: 'user',
        timestamp: new Date().toLocaleTimeString(),
      },
      {
        id: Date.now() + 1,
        text: result.reply,
        sender: 'ai',
        timestamp: new Date().toLocaleTimeString(),
      },
    ]);

    await saveMemory(updatedHistory);

    res.json({
      reply: result.reply,
      messages: updatedHistory,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Chat request failed' });
  }
});

app.get('/memory', async (req, res) => {
  try {
    const messages = await loadMemory();
    res.json({ messages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to load memory' });
  }
});

app.delete('/memory', async (req, res) => {
  try {
    await saveMemory([]);
    res.json({ status: 'ok', messages: [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to clear memory' });
  }
});

async function startServer() {
  try {
    let result = { fileCount: 0, chunkCount: 0 };

    try {
      result = await indexKnowledgeBase();
    } catch (error) {
      console.warn('Knowledge indexing skipped at startup:', error.message);
      knowledgeState.chunks = [];
      knowledgeState.files = [];
      knowledgeState.indexedAt = new Date().toISOString();
    }

    app.listen(PORT, () => {
      console.log(`Gemini RAG backend running on http://localhost:${PORT}`);
      console.log(`Knowledge directory: ${KNOWLEDGE_DIR}`);
      console.log(`Indexed ${result.fileCount} files into ${result.chunkCount} chunks`);
    });
  } catch (error) {
    console.error('Failed to start RAG backend:', error.message);
    process.exit(1);
  }
}

startServer();