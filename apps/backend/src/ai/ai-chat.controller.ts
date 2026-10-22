import { Body, Controller, Headers, Param, Post, Req } from '@nestjs/common';
import { LlmClient } from './llm.client';
import { AiToolsService } from './ai-tools.service';
import { RESTAURANT_TOOLS } from './tools.definition';
import { withOutletScope } from './prompts';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { enforceRateLimit } from '../rate-limit.util';
import { maskPhone } from './phone-mask.util';

export interface ChatMessageRequest {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

type PendingMutation = { toolName: string; args: Record<string, any> };
const MUTATION_TOOLS = new Set(['create_reservation', 'update_reservation', 'cancel_reservation']);

@Controller('ai/chat')
export class AiChatController {
  constructor(
    private readonly llmClient: LlmClient,
    private readonly aiToolsService: AiToolsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':tenantId')
  async chat(
    @Param('tenantId') tenantId: string,
    @Body() body: ChatMessageRequest,
    @Headers('x-session-id') sessionIdHeader?: string,
    @Req() request?: { ip?: string },
  ) {
    enforceRateLimit(`chat:${tenantId}:${request?.ip ?? 'unknown'}`, 20, 60_000);
    const session = await this.getOrCreateSession(tenantId, sessionIdHeader);
    const sessionId = session.id;
    const pending = session.pendingMutation as PendingMutation | null;
    if (pending) {
      if (session.pendingMutationExpiresAt && session.pendingMutationExpiresAt <= new Date()) {
        await this.clearPendingMutation(sessionId);
      } else if (/^(batal|tidak|jangan)\b/i.test(body.message.trim())) {
        await this.clearPendingMutation(sessionId);
        return { sessionId, reply: 'Baik, tindakan reservasi dibatalkan.' };
      } else if (this.isExplicitConfirmation(body.message)) {
        const result = await this.aiToolsService.executeTool(
          tenantId,
          pending.toolName,
          pending.args,
          sessionId,
        );
        await this.clearPendingMutation(sessionId);
        return { sessionId, reply: this.fallbackFromTools([{ name: pending.toolName, result }]) };
      } else {
        return {
          sessionId,
          reply: 'Masih ada tindakan reservasi yang menunggu persetujuan. Balas “ya” untuk melanjutkan atau kirim “batal”.',
        };
      }
    }
    // shortcut: the earliest active outlet is the chat scope; add an explicit outlet selector when multi-outlet chat is needed.
    const outlet = await this.prisma.outlet.findFirst({
      where: { tenantId, isActive: true },
      select: { name: true, slug: true },
      orderBy: { createdAt: 'asc' },
    });

    // Construct prompt history
    const conversation: any[] = [
      { role: 'system', content: withOutletScope(outlet || undefined) },
      ...(body.history || [])
        .filter(
          (h): h is { role: 'user' | 'assistant'; content: string } =>
            (h?.role === 'user' || h?.role === 'assistant') && typeof h.content === 'string',
        )
        .map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: body.message },
    ];

    // First LLM turn
    const firstResponse = await this.llmClient.chatCompletion(conversation, RESTAURANT_TOOLS);
    const message = firstResponse.message;

    // Handle tool call chaining
    if (message.tool_calls && message.tool_calls.length > 0) {
      conversation.push(message);
      const toolResults: Array<{ name: string; result: unknown }> = [];

      for (const call of message.tool_calls) {
        if (
          !call?.id ||
          typeof call.function?.name !== 'string' ||
          typeof call.function?.arguments !== 'string'
        ) {
          toolResults.push({
            name: 'invalid_tool_call',
            result: { error: 'Respons tool dari AI tidak valid.' },
          });
          continue;
        }

        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = JSON.parse(call.function.arguments);
        } catch {
          toolResults.push({
            name: call.function.name,
            result: { error: 'Argumen tool dari AI tidak valid.' },
          });
          continue;
        }

        if (outlet && ['check_availability', 'create_reservation'].includes(call.function.name)) {
          parsedArgs.outletSlug ||= outlet.slug;
        }

        if (MUTATION_TOOLS.has(call.function.name)) {
          if (this.isExplicitConfirmation(body.message)) {
            const result = await this.aiToolsService.executeTool(
              tenantId,
              call.function.name,
              parsedArgs,
              sessionId,
            );
            return { sessionId, reply: this.fallbackFromTools([{ name: call.function.name, result }]) };
          }
          await this.prisma.chatSession.update({
            where: { id: sessionId },
            data: {
              pendingMutation: { toolName: call.function.name, args: parsedArgs },
              pendingMutationExpiresAt: new Date(Date.now() + 15 * 60_000),
            },
          });
          return {
            sessionId,
            reply: this.pendingMutationReply(call.function.name, parsedArgs),
          };
        }

        const toolResult = await this.aiToolsService.executeTool(
          tenantId,
          call.function.name,
          parsedArgs,
          sessionId,
        );
        toolResults.push({ name: call.function.name, result: toolResult });

        conversation.push({
          role: 'tool',
          name: call.function.name,
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        });
      }

      // Second turn with tool result to generate natural response
      const secondResponse = await this.llmClient.chatCompletion(conversation, RESTAURANT_TOOLS, 'none');
      const reply = secondResponse.message.content?.trim();
      return {
        sessionId,
        reply: reply && !reply.includes('<tool_call>')
          ? reply
          : this.fallbackFromTools(toolResults),
      };
    }

    return {
      sessionId,
      reply: message.content || 'Ada yang bisa kami bantu seputar menu dan reservasi Padang Sederhana?',
    };
  }

  private async getOrCreateSession(tenantId: string, sessionId?: string) {
    if (sessionId) {
      const existing = await this.prisma.chatSession.findFirst({
        where: { id: sessionId, tenantId },
        select: { id: true, pendingMutation: true, pendingMutationExpiresAt: true },
      });
      if (existing) return existing;
    }
    const session = await this.prisma.chatSession.create({
      data: { tenantId },
      select: { id: true, pendingMutation: true, pendingMutationExpiresAt: true },
    });
    return session;
  }

  private clearPendingMutation(sessionId: string) {
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { pendingMutation: Prisma.JsonNull, pendingMutationExpiresAt: null },
    });
  }

  private isExplicitConfirmation(message: string) {
    return /^(ya|iya|benar|lanjutkan|oke|ok|setuju)\b/i.test(message.trim());
  }

  private pendingMutationReply(toolName: string, args: Record<string, any>) {
    if (toolName === 'create_reservation') {
      return `Ringkasan: ${args.outletSlug} • ${args.date}, ${args.time} WIB • ${args.partySize} tamu • ${args.customerName} (${maskPhone(args.customerPhone)}). Balas “ya” untuk pesan.`;
    }
    if (toolName === 'update_reservation') {
      const changes = [args.date, args.time && `${args.time} WIB`, args.partySize && `${args.partySize} tamu`]
        .filter(Boolean)
        .join(' • ');
      return `Ubah ${args.code}${changes ? ` menjadi ${changes}` : ''}. Balas “ya” untuk simpan.`;
    }
    return `Batalkan reservasi ${args.code}. Balas “ya” untuk konfirmasi.`;
  }

  private fallbackFromTools(toolResults: Array<{ name: string; result: unknown }>) {
    const menuResult = toolResults.find((tool) => tool.name === 'search_menu')?.result;
    if (Array.isArray(menuResult)) {
      if (menuResult.length === 0) {
        return 'Maaf, menu yang dicari belum tersedia. Uni/Uda boleh sebutkan lauk atau rasa yang diinginkan.';
      }

      const items = menuResult.slice(0, 5).map((item: any) =>
        `- ${item.nama} — Rp${Number(item.harga).toLocaleString('id-ID')}`,
      );
      return `Berikut rekomendasi menu yang tersedia:\n${items.join('\n')}\n\nMau yang pedas, gurih, atau yang paling favorit?`;
    }

    const resultWithMessage = toolResults
      .map((tool) => tool.result as { message?: string })
      .find((result) => result?.message);
    return resultWithMessage?.message || 'Data sudah kami cek. Ada lagi yang ingin Uni/Uda tanyakan?';
  }
}
