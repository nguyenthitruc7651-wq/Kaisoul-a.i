const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Security Middlewares
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "*"]
    }
  }
}));

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiter: Tối đa 60 requests mỗi 1 phút cho mỗi IP
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: 'Gửi quá nhiều yêu cầu. Vui lòng thử lại sau 1 phút.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// Helper function để gọi AI API
async function callAIAdapter({ messages, customConfig = {} }) {
  const apiKey = customConfig.apiKey || process.env.AI_API_KEY;
  const apiUrl = customConfig.apiUrl || process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
  const model = customConfig.model || process.env.AI_MODEL || 'gpt-4o-mini';
  const temperature = parseFloat(customConfig.temperature) || 0.7;
  const maxTokens = parseInt(customConfig.maxTokens, 10) || 2048;

  if (!apiKey) {
    throw { status: 401, message: 'Kaisoul A.I. chưa được cấu hình API Key ở Backend.' };
  }

  const payload = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
    stream: true
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      let parsedErr = errText;
      try { parsedErr = JSON.parse(errText); } catch(e) {}
      
      if (response.status === 401) throw { status: 401, message: 'API key không hợp lệ hoặc đã hết hạn.' };
      if (response.status === 429) throw { status: 429, message: 'API đang bị giới hạn lượt gọi (Rate Limit). Thử lại sau.' };
      throw { status: response.status, message: parsedErr.error?.message || 'Lỗi khi gọi provider API.' };
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw { status: 504, message: 'Yêu cầu vượt quá thời gian phản hồi (Timeout 60s).' };
    }
    throw error;
  }
}

// 2. Chat API Endpoint với Streaming Proxy
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, customConfig } = req.body;

    // Input Validation
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Nội dung cuộc trò chuyện không hợp lệ.' });
    }

    // Limit Prompt Length
    const lastMsg = messages[messages.length - 1]?.content || '';
    if (lastMsg.length > 10000) {
      return res.status(400).json({ error: 'Tin nhắn quá dài (Giới hạn tối đa 10,000 ký tự).' });
    }

    const aiStreamResponse = await callAIAdapter({ messages, customConfig });

    // Stream SSE back to client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = aiStreamResponse.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
    }

    res.end();
  } catch (err) {
    const status = err.status || 500;
    const msg = err.message || 'Lỗi máy chủ nội bộ.';
    if (!res.headersSent) {
      res.status(status).json({ error: msg });
    } else {
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      res.end();
    }
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 KAISOUL A.I. Engine active on: http://localhost:${PORT}`);
});
