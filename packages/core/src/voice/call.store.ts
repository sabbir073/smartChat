import type {
  Call,
  CallEndReason,
  CallEvent,
  CallEventType,
  CallLeg,
  CallLegKind,
  Database,
} from '@smartchat/database';
import { toJson } from '@smartchat/database';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { toMessageDto, type MessageDto, type SystemMessageEvent } from '../realtime/events.js';

/**
 * Everything the call service reads and writes, behind one interface.
 *
 * The state machine is the thing worth testing, and it is tested against an in-memory store
 * (`call.service.test.ts`), so the Prisma calls live here and nowhere in the service. Each
 * method is small and does one thing; the service decides what happens, this records it.
 */

export type CallRow = Call;
export type CallLegRow = CallLeg;

export interface MemberSummary {
  id: string;
  name: string | null;
}

export interface CallStore {
  createCall(data: {
    accountId: string;
    propertyId: string;
    conversationId: string;
    visitorId: string;
    roomName: string;
    language: string | null;
    now: Date;
  }): Promise<CallRow>;
  getCall(accountId: string, callId: string): Promise<CallRow | null>;
  getCallByRoom(roomName: string): Promise<CallRow | null>;
  /** The visitor's call that has not ended, if any. */
  liveCallForVisitor(accountId: string, visitorId: string): Promise<CallRow | null>;
  updateCall(callId: string, data: Partial<Omit<Call, 'id' | 'accountId'>>): Promise<CallRow>;
  listCalls(
    accountId: string,
    filter: { propertyIds?: string[]; status?: Call['status']; limit: number },
  ): Promise<CallRow[]>;
  /** Calls that look stuck: ringing or connecting for too long, or active far past the limit. */
  staleCalls(now: Date): Promise<CallRow[]>;

  createLeg(data: {
    accountId: string;
    callId: string;
    kind: CallLegKind;
    memberId: string | null;
    identity: string;
    now: Date;
    joined?: boolean;
  }): Promise<CallLegRow>;
  updateLeg(
    legId: string,
    data: Partial<Pick<CallLeg, 'joinedAt' | 'leftAt'>>,
  ): Promise<CallLegRow>;
  legs(callId: string): Promise<CallLegRow[]>;

  addEvent(data: {
    accountId: string;
    callId: string;
    type: CallEventType;
    memberId?: string | null;
    targetMemberId?: string | null;
    data?: Record<string, unknown>;
    now: Date;
  }): Promise<CallEvent>;

  /** Members who said they are available and may see this website, with their names. */
  onlineMembers(accountId: string, propertyId: string): Promise<MemberSummary[]>;
  member(accountId: string, memberId: string): Promise<MemberSummary | null>;
  /** The visitor as the chat head shows them. */
  visitor(
    accountId: string,
    visitorId: string,
  ): Promise<{ name: string | null; email: string | null } | null>;
  property(accountId: string, propertyId: string): Promise<{ name: string } | null>;
  /** Whether the website's AI is set up at all, and what it is called. */
  assistant(accountId: string, propertyId: string): Promise<{ name: string; configured: boolean }>;

  /** A system message in the conversation the call belongs to, for the timeline on both sides. */
  insertSystemMessage(input: {
    accountId: string;
    propertyId: string;
    conversationId: string;
    body: string;
    event: SystemMessageEvent;
    now: Date;
  }): Promise<MessageDto>;
}

export class PrismaCallStore implements CallStore {
  constructor(private readonly db: Database) {}

  createCall(data: {
    accountId: string;
    propertyId: string;
    conversationId: string;
    visitorId: string;
    roomName: string;
    language: string | null;
    now: Date;
  }): Promise<CallRow> {
    return this.db.call.create({
      data: {
        accountId: data.accountId,
        propertyId: data.propertyId,
        conversationId: data.conversationId,
        visitorId: data.visitorId,
        roomName: data.roomName,
        language: data.language,
        startedAt: data.now,
      },
    });
  }

  getCall(accountId: string, callId: string): Promise<CallRow | null> {
    return this.db.call.findFirst({ where: { accountId, id: callId } });
  }

  getCallByRoom(roomName: string): Promise<CallRow | null> {
    return this.db.call.findUnique({ where: { roomName } });
  }

  liveCallForVisitor(accountId: string, visitorId: string): Promise<CallRow | null> {
    return this.db.call.findFirst({
      where: { accountId, visitorId, status: { not: 'ended' } },
      orderBy: { startedAt: 'desc' },
    });
  }

  updateCall(callId: string, data: Partial<Omit<Call, 'id' | 'accountId'>>): Promise<CallRow> {
    return this.db.call.update({ where: { id: callId }, data });
  }

  listCalls(
    accountId: string,
    filter: { propertyIds?: string[]; status?: Call['status']; limit: number },
  ): Promise<CallRow[]> {
    return this.db.call.findMany({
      where: {
        accountId,
        ...(filter.propertyIds ? { propertyId: { in: filter.propertyIds } } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: filter.limit,
    });
  }

  staleCalls(now: Date): Promise<CallRow[]> {
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60_000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000);
    return this.db.call.findMany({
      where: {
        OR: [
          { status: { in: ['ringing', 'connecting'] }, updatedAt: { lt: fiveMinutesAgo } },
          { status: 'active', updatedAt: { lt: twoHoursAgo } },
        ],
      },
      take: 200,
    });
  }

  createLeg(data: {
    accountId: string;
    callId: string;
    kind: CallLegKind;
    memberId: string | null;
    identity: string;
    now: Date;
    joined?: boolean;
  }): Promise<CallLegRow> {
    return this.db.callLeg.create({
      data: {
        accountId: data.accountId,
        callId: data.callId,
        kind: data.kind,
        memberId: data.memberId,
        identity: data.identity,
        createdAt: data.now,
        ...(data.joined ? { joinedAt: data.now } : {}),
      },
    });
  }

  updateLeg(
    legId: string,
    data: Partial<Pick<CallLeg, 'joinedAt' | 'leftAt'>>,
  ): Promise<CallLegRow> {
    return this.db.callLeg.update({ where: { id: legId }, data });
  }

  legs(callId: string): Promise<CallLegRow[]> {
    return this.db.callLeg.findMany({ where: { callId }, orderBy: { createdAt: 'asc' } });
  }

  addEvent(data: {
    accountId: string;
    callId: string;
    type: CallEventType;
    memberId?: string | null;
    targetMemberId?: string | null;
    data?: Record<string, unknown>;
    now: Date;
  }): Promise<CallEvent> {
    return this.db.callEvent.create({
      data: {
        accountId: data.accountId,
        callId: data.callId,
        type: data.type,
        memberId: data.memberId ?? null,
        targetMemberId: data.targetMemberId ?? null,
        data: toJson(data.data),
        at: data.now,
      },
    });
  }

  async onlineMembers(accountId: string, propertyId: string): Promise<MemberSummary[]> {
    const rows = await this.db.accountMember.findMany({
      where: {
        accountId,
        availability: 'online',
        status: 'active',
        deletedAt: null,
        user: { deletedAt: null },
        OR: [{ properties: { none: {} } }, { properties: { some: { propertyId } } }],
      },
      select: { id: true, displayName: true, user: { select: { name: true } } },
    });
    return rows.map((row) => ({ id: row.id, name: row.displayName ?? row.user?.name ?? null }));
  }

  async member(accountId: string, memberId: string): Promise<MemberSummary | null> {
    const row = await this.db.accountMember.findFirst({
      where: { accountId, id: memberId, deletedAt: null },
      select: { id: true, displayName: true, user: { select: { name: true } } },
    });
    return row ? { id: row.id, name: row.displayName ?? row.user?.name ?? null } : null;
  }

  async visitor(
    accountId: string,
    visitorId: string,
  ): Promise<{ name: string | null; email: string | null } | null> {
    const row = await this.db.visitor.findFirst({
      where: { accountId, id: visitorId },
      select: { name: true, email: true },
    });
    return row ? { name: row.name, email: row.email } : null;
  }

  async property(accountId: string, propertyId: string): Promise<{ name: string } | null> {
    const row = await this.db.property.findFirst({
      where: { accountId, id: propertyId, deletedAt: null },
      select: { name: true },
    });
    return row ? { name: row.name } : null;
  }

  async assistant(
    accountId: string,
    propertyId: string,
  ): Promise<{ name: string; configured: boolean }> {
    const row = await this.db.aiSetting.findUnique({
      where: { accountId_propertyId: { accountId, propertyId } },
      select: { assistantName: true },
    });
    return { name: row?.assistantName ?? 'AI assistant', configured: row !== null };
  }

  async insertSystemMessage(input: {
    accountId: string;
    propertyId: string;
    conversationId: string;
    body: string;
    event: SystemMessageEvent;
    now: Date;
  }): Promise<MessageDto> {
    const persisted = await new ConversationRepository(this.db).insertMessage({
      accountId: input.accountId,
      propertyId: input.propertyId,
      conversationId: input.conversationId,
      senderType: 'system',
      type: 'system',
      body: input.body,
      metadata: { ...input.event },
      now: input.now,
    });
    return toMessageDto(persisted.message);
  }
}

export type { CallEndReason };
