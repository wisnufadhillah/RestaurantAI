import { Injectable, Logger } from '@nestjs/common';

export interface ChatMessageDto {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ToolCallResult {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    this.baseUrl = process.env.LLM_BASE_URL || process.env.OPENROUTER_BASE_URL || 'http://localhost:8000/v1';
    this.apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || 'dev-key';
    this.model = process.env.LLM_MODEL || process.env.LLM_DEFAULT_MODEL || 'hermes-3-llama-3.1-8b';
  }

  async chatCompletion(
    messages: ChatMessageDto[],
    tools?: any[],
    toolChoice: 'auto' | 'none' = 'auto',
  ): Promise<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCallResult[];
    };
  }> {
    const payload = {
      model: this.model,
      messages,
      tools: tools?.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: tools && tools.length > 0 ? toolChoice : undefined,
      temperature: 0.2,
    };

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`LLM Gateway error (${res.status}): ${errorText}`);
      }

      const data = await res.json();
      return data.choices[0];
    } catch (err: any) {
      this.logger.error(`Failed to invoke LLM Gateway: ${err.message}`);
      throw err;
    }
  }
}
