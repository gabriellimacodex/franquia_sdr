import { z } from 'zod';

export const IncomingMessageSchema = z.object({
  id: z.string().min(1).max(256), text: z.string().max(16000).default(''),
  type: z.enum(['text','audio','image','document','unsupported']).default('text'),
  actor: z.enum(['candidate','human','agent']).default('candidate'),
  timestamp: z.string().datetime().optional(), mediaId: z.string().max(256).optional(),
  transcriptOrigin: z.enum(['kapso','openai']).optional(),
});
export const TurnInputSchema = z.object({
  phoneNumberId: z.string().regex(/^\d{5,30}$/), conversationId: z.string().min(1).max(256),
  contactId: z.string().min(1).max(256), contactPhone: z.string().max(64).optional(),
  messageId: z.string().min(1).max(256), text: z.string().max(16000).default(''),
  audio: z.object({mediaId:z.string(),transcript:z.string().optional()}).optional(),
  executionId: z.string().max(256).optional(), resumeReason: z.string().optional(),
  controlFingerprint: z.string().max(256).optional(), nativeState: z.unknown().optional(),
  messages: z.array(IncomingMessageSchema).max(100).default([]),
}).strict();
export type TurnInput = z.infer<typeof TurnInputSchema>;
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
export const ControlSchema = z.object({
  phoneNumberId:z.string(), event:z.enum(['handoff','resume','stop']),
  executionId:z.string().optional(), eventId:z.string().optional(), controlFingerprint:z.string().optional(),
});
export const EvaluationSchema = z.object({
  jobId:z.string(),clarity:z.number().int().min(1).max(5),relevance:z.number().int().min(1).max(5),
  naturalness:z.number().int().min(1).max(5),briefingUtility:z.number().int().min(1).max(5),notes:z.string().max(4000),
}).strict();
export type TurnView = {id:string,state:'pending'|'ready'|'handoff'|'ignored'|'stale'|'sent'|'unknown',reply:string[],contextVersion:number,errorCode?:string,authorized?:boolean};
