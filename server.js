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

// Correct model IDs for NVIDIA NIM
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'z-ai/glm4.7',                // GLM-4.7 (no hyphen)
  'gpt-4': 'moonshotai/kimi-k2.5',               // Kimi K2.5
  'gpt-4-turbo': 'deepseek-ai/deepseek-v3.2'     // DeepSeek V3.2
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
      messages: originalMessages,
      temperature,
      max_tokens,
      stream = false,
      enable_thinking = false   // Control thinking mode
    } = req.body;

    const nimModel = MODEL_MAPPING[model] || MODEL_MAPPING['gpt-3.5-turbo'];

    // Build messages with proper system prompt for thinking control
    let messages = [...originalMessages];
    
    if (enable_thinking) {
      // Add or replace system prompt to enable detailed thinking
      const hasSystemPrompt = messages.some(m => m.role === 'system');
      if (hasSystemPrompt) {
        // Replace existing system prompt
        messages = messages.map(m => 
          m.role === 'system' ? { ...m, content: "detailed thinking on" } : m
        );
      } else {
        // Add system prompt at the beginning
        messages.unshift({ role: "system", content: "detailed thinking on" });
      }
    } else {
      // Ensure thinking is disabled via system prompt
      const hasSystemPrompt = messages.some(m => m.role === 'system');
      if (!hasSystemPrompt) {
        messages.unshift({ role: "system", content: "detailed thinking off" });
      }
    }

    // Build NVIDIA NIM request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: enable_thinking ? 0.6 : (temperature || 0.7),
      max_tokens: max_tokens || 1024,
      stream: stream
    };

    // For GLM-4.7, use proper thinking budget control if needed
    if (enable_thinking) {
      nimRequest.top_p = 0.95;  // Recommended for thinking mode
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

      // Parse streaming chunks to extract both reasoning and content
      response.data.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        const lines = chunkStr.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
          if (line.includes('[DONE]')) {
            res.write('data: [DONE]\n\n');
            continue;
          }
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.choices && parsed.choices[0].delta) {
                const delta = parsed.choices[0].delta;
                // Ensure we capture both reasoning and content
                if (!delta.content && delta.reasoning_content) {
                  // If only reasoning is present, we might want to include it
                  // But for now, we'll pass it through
                  parsed.choices[0].delta.content = parsed.choices[0].delta.content || '';
                }
              }
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            } catch (e) {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      });
      
      response.data.on('end', () => {
        res.end();
      });
      return;
    }

    // --- Handle Non-Streaming ---
    const assistantMessage = response.data.choices[0].message;

    // Build OpenAI-compatible response
    const openaiResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: assistantMessage.role,
          content: assistantMessage.content || ""   // Final answer
        },
        finish_reason: response.data.choices[0].finish_reason
      }],
      usage: response.data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    // If thinking was enabled, add the reasoning trace as an extra field
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
