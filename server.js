const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Bottleneck = require('bottleneck');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
if (!NIM_API_KEY) {
    console.error('FATAL: NIM_API_KEY not set'); process.exit(1);
}

// Rate limiter: 1 request every 1.5s (~40/min)
const nimLimiter = new Bottleneck({ minTime: 1500 });

const AVAILABLE_MODELS = [
  'mistralai/mistral-large-4-1t-a52b',
  'deepseek-ai/deepseek-v4.1-flash',
  'z-ai/glm-5.3-flash',
  'moonshotai/kimi-k3.1-pro'
];

app.get(['/v1/models', '/models'], (req, res) => {
  res.json({
    object: 'list',
    data: AVAILABLE_MODELS.map(id => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'nvidia'
    }))
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
  try {
    const {
      model,
      messages,
      temperature,
      max_tokens,
      max_completion_tokens,
      stream = false,
      enable_thinking = false
    } = req.body;

    if (!model || typeof model !== 'string') {
      return res.status(400).json({
        error: { message: 'model is required', type: 'invalid_request_error', code: 400 }
      });
    }
    const nimModel = model;

    // OpenAI precedence: max_completion_tokens wins if present
    const effectiveMaxTokens = max_completion_tokens ?? max_tokens ?? 32768;

    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature ?? (enable_thinking ? 0.6 : 0),
      max_tokens: effectiveMaxTokens,
      stream: stream,
    };

    if (nimModel.startsWith('z-ai/glm')) {
      nimRequest.chat_template_kwargs = {
        enable_thinking,
        clear_thinking: false
      };
    }

    if (nimModel === 'z-ai/glm-5.3' || nimModel === 'z-ai/glm-5.3-flash') {
      nimRequest.reasoning_effort = req.body.reasoning_effort || 'low';
    }

    if (nimModel === 'mistralai/mistral-large-4-1t-a52b') {
      nimRequest.reasoning_effort = enable_thinking ? 'high' : 'low';
    }

    const response = await nimLimiter.schedule(() =>
      axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      })
    );

    // --- Streaming ---
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      response.data.pipe(res);
      response.data.on('error', (err) => {
        console.error('Upstream stream error:', err.message);
        res.end();
      });
      req.on('close', () => response.data.destroy());
      return;
    }

    // --- Non-streaming ---
    const assistantMessage = response.data.choices[0].message;

    const openaiResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: assistantMessage.role,
          content: assistantMessage.content || "",
        },
        finish_reason: response.data.choices[0].finish_reason
      }],
      usage: response.data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    if (assistantMessage.reasoning_content) {
      openaiResponse.choices[0].message.reasoning_content = assistantMessage.reasoning_content;
    }

    res.json(openaiResponse);

  } catch (error) {
    let detail = error.message;
    if (error.response) {
      const data = error.response.data;
      if (data && typeof data.pipe === 'function') {
        let raw = '';
        for await (const chunk of data) raw += chunk;
        try { detail = JSON.parse(raw).error?.message || raw; } catch { detail = raw; }
      } else if (data?.error?.message) {
        detail = data.error.message;
      }
    }

    console.error('Proxy error:', detail);
    res.status(error.response?.status || 500).json({
      error: { message: detail, type: 'invalid_request_error',
               code: error.response?.status || 500 }
    });
  }
});

// Catch-all (app.use — works on Express 4 and 5)
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
