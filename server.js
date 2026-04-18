const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 1. VERIFY: Use exact model IDs from the NVIDIA NIM catalog
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'z-ai/glm5.1',
  'gpt-4': 'moonshotai/kimi-k2.5',
  'gpt-4-turbo': 'z-ai/glm4.7'
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.get(['/v1/models', '/models'], (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
  try {
    const {
      model,
      messages,
      temperature,
      max_tokens,
      stream = false,
      enable_thinking = false
    } = req.body;

    const nimModel = MODEL_MAPPING[model] || MODEL_MAPPING['gpt-3.5-turbo'];

    // 2. FIX: Build the request with explicit thinking control
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: enable_thinking ? 0.6 : (temperature || 0),
      max_tokens: max_tokens || 1024,
      stream: stream
    };

    // Crucially, add chat_template_kwargs for GLM-4.7
    if (nimModel === 'z-ai/glm4.7') {
      nimRequest.chat_template_kwargs = {
        enable_thinking: enable_thinking,
        clear_thinking: false
      };
    }

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    // --- Handle Streaming ---
    if (stream) {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
      return;
    }

    // --- Handle Non-Streaming ---
    const assistantMessage = response.data.choices[0].message;

    // 3. FIX: Build a reliable OpenAI-compatible response
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

    // Include reasoning trace if thinking was enabled and it exists
    if (enable_thinking && assistantMessage.reasoning_content) {
      openaiResponse.choices[0].message.reasoning_content = assistantMessage.reasoning_content;
    }

    res.json(openaiResponse);

  } catch (error) {
    console.error('Proxy error:', error.message);
    if (error.response) {
      console.error('NIM API error details:', error.response.data);
    }

    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Catch-all for unknown endpoints
app.all('*', (req, res) => {
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
