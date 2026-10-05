import type { Call, CallEndReason, CallLegKind } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  Permission,
  ServerEvent,
  presenceKey,
  room,
  type CallDto,
  type CallJoinGrant,
  type TenantContext,
  type VoiceLanguage,
} from '@smartchat/types';
import type { StartCallInput, TransferCallInput } from '@smartchat/validation';
import type { EntitlementService } from '../billing/entitlements.js';
import { VoiceJob } from '../queue/jobs.js';
import type { QueueProducer } from '../queue/producer.js';
import type { EventPublisher, SystemMessageEvent } from '../realtime/events.js';
import type { RedisClient } from '../redis/client.js';
import type { VisitorIdentity } from '../services/conversation.service.js';
import { requirePermission, requirePropertyAccess } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';
import type { CallRow, CallStore } from './call.store.js';
import { identity as who, type MediaRooms } from './media.js';
import type { VoiceSettingsService } from './settings.service.js';

/**
 * A call, from the Call button to the goodbye.
 *
 * The rules, in the order a call meets them:
 *
 *  - The visitor presses Call. The plan must include calling, the website must have it on, and
 *    the month's minutes must not be used up. The call hangs from the visitor's conversation, so
 *    one is opened if they have none. Everybody on the team who said they are available (and may
 *    see this website) rings at once.
 *  - The first person to press Answer gets the call; the claim is one Redis key set once, so two
 *    people answering in the same instant cannot both win. Everyone else sees "taken".
 *  - If nobody answers before the website's ring time, the AI picks up - provided the owner has
 *    allowed it, the AI is set up for the website, and the machine is not already on as many AI
 *    calls as it can carry. Otherwise the call is missed, and the conversation says so.
 *  - A transfer rings exactly one colleague, or the AI. Until they answer, the person who has the
 *    call keeps it; if they do not answer, the call goes back to that person with a notice. When
 *    they do, the one who transferred is removed from the room and the visitor hears nobody drop.
 *  - The AI can hand back to people the same way: it rings the team; if someone answers the AI
 *    leaves, if nobody does the AI carries on and offers a ticket.
 *  - A call ends when either side hangs up, when the visitor's page goes away, or when the AI
 *    says goodbye. Minutes are counted from the answer, rounded up, per call.
 *
 * Every transition writes an event row and a system message in the conversation, and publishes
 * the whole call state to the visitor and to the website's agents, so a screen that missed one
 * update is right again on the next.
 */

export interface CallServiceOptions {
  store: CallStore;
  media: MediaRooms;
  settings: VoiceSettingsService;
  entitlements: EntitlementService;
  events: EventPublisher;
  queue: QueueProducer;
  redis: RedisClient;
  conversations: {
    ensureForVisitor(
      identity: VisitorIdentity,
      preChat?: Record<string, string>,
    ): Promise<{ conversation: { id: string }; isNew: boolean }>;
  };
  /** How many calls the AI may be on at once, server-wide. The CPU decides this number. */
  aiMaxCalls: number;
  clock?: Clock;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** How long a joined party has to actually arrive in the room before the call is given up on. */
export const CONNECT_GRACE_SECONDS = 45;
/** How long a transfer rings its target. */
export const TRANSFER_RING_SECONDS = 20;
/** A room nobody joined within this is closed by the media server. */
export const ROOM_EMPTY_TIMEOUT_SECONDS = 120;
/** A token's life. Long enough to click Answer and connect; far too short to keep. */
const GRANT_TTL_SECONDS = 180;

export class CallService {
  private readonly clock: Clock;

  constructor(private readonly options: CallServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  // ---------------------------------------------------------------------------
  // The visitor's side
  // ---------------------------------------------------------------------------

  /** The visitor presses Call. */
  async start(
    identity: VisitorIdentity,
    input: StartCallInput,
  ): Promise<{ call: CallDto; join: CallJoinGrant | null }> {
    const { store } = this.options;
    const settings = await this.options.settings.forProperty(
      identity.accountId,
      identity.propertyId,
    );
    if (!settings.enabled) {
      throw new AppError(
        ErrorCode.FEATURE_NOT_AVAILABLE,
        'Calls are not available on this website.',
      );
    }
    await this.options.entitlements.assertFeature(identity.accountId, 'voice');
    const allowance = await this.options.entitlements.voiceMinutesAllowance(identity.accountId);
    if (!allowance.allowed) {
      throw new AppError(
        ErrorCode.PLAN_LIMIT_REACHED,
        'This website has used its call minutes for the month.',
        {
          context: { used: allowance.used, limit: allowance.limit, resource: 'voiceMinutes' },
        },
      );
    }

    // Pressing Call twice is one call. The widget retries on a flaky network; it must not ring
    // the team twice.
    const live = await store.liveCallForVisitor(identity.accountId, identity.visitorId);
    if (live) {
      const join = await this.options.media.grant({
        roomName: live.roomName,
        identity: who.visitor(identity.visitorId),
        displayName: identity.visitorName ?? 'Visitor',
        ttlSeconds: GRANT_TTL_SECONDS,
      });
      return { call: await this.dto(live), join };
    }

    const now = this.clock.now();
    const { conversation } = await this.options.conversations.ensureForVisitor(
      identity,
      input.preChat,
    );
    const language: VoiceLanguage = input.language ?? settings.defaultLanguage;
    const roomName = `call-${crypto.randomUUID()}`;

    await this.options.media.createRoom({
      name: roomName,
      emptyTimeoutSeconds: ROOM_EMPTY_TIMEOUT_SECONDS,
      maxParticipants: 3,
    });
    const call = await store.createCall({
      accountId: identity.accountId,
      propertyId: identity.propertyId,
      conversationId: conversation.id,
      visitorId: identity.visitorId,
      roomName,
      language,
      now,
    });
    await store.createLeg({
      accountId: call.accountId,
      callId: call.id,
      kind: 'visitor',
      memberId: null,
      identity: who.visitor(identity.visitorId),
      now,
    });
    await store.addEvent({ accountId: call.accountId, callId: call.id, type: 'started', now });
    await this.systemMessage(
      call,
      'Call started',
      { kind: 'call.started', by: 'visitor', callId: call.id },
      now,
    );

    const join = await this.options.media.grant({
      roomName,
      identity: who.visitor(identity.visitorId),
      displayName: identity.visitorName ?? 'Visitor',
      ttlSeconds: GRANT_TTL_SECONDS,
    });

    const targets = await store.onlineMembers(call.accountId, call.propertyId);
    if (targets.length > 0) {
      await store.addEvent({
        accountId: call.accountId,
        callId: call.id,
        type: 'ring',
        data: { targets: targets.map((target) => target.id) },
        now,
      });
      await this.options.queue.enqueue(
        VoiceJob.RING_TIMEOUT,
        { accountId: call.accountId, callId: call.id, ringSeq: call.ringSeq },
        { delay: settings.ringSeconds * 1000, attempts: 1 },
      );
      await this.publish(call);
      this.options.log?.('voice.call.ringing', { callId: call.id, targets: targets.length });
      return { call: await this.dto(call), join };
    }

    // Nobody to ring. The AI takes it at once, or the call is missed on the spot.
    const taken = await this.tryAi(call, settings.aiAnswers);
    if (taken) return { call: await this.dto(taken), join };
    const ended = await this.end(call, 'no_answer', { by: 'system' });
    return { call: await this.dto(ended), join: null };
  }

  /** The visitor hangs up: while it rings, or mid-call. */
  async hangUp(identity: VisitorIdentity, callId: string): Promise<CallDto> {
    const call = await this.visitorCall(identity, callId);
    if (call.status === 'ended') return this.dto(call);
    const reason: CallEndReason =
      call.status === 'ringing' && call.answeredAt === null ? 'cancelled' : 'visitor_left';
    return this.dto(await this.end(call, reason, { by: 'visitor' }));
  }

  /** The visitor's screen asks where its call is - after a reload, or when an event was missed. */
  async forVisitor(identity: VisitorIdentity, callId: string): Promise<CallDto> {
    return this.dto(await this.visitorCall(identity, callId));
  }

  /** The visitor's live call, if there is one: the widget asks on load so a reload does not lose a call. */
  async liveForVisitor(
    identity: VisitorIdentity,
  ): Promise<{ call: CallDto; join: CallJoinGrant } | null> {
    const live = await this.options.store.liveCallForVisitor(
      identity.accountId,
      identity.visitorId,
    );
    if (!live) return null;
    const join = await this.options.media.grant({
      roomName: live.roomName,
      identity: who.visitor(identity.visitorId),
      displayName: identity.visitorName ?? 'Visitor',
      ttlSeconds: GRANT_TTL_SECONDS,
    });
    return { call: await this.dto(live), join };
  }

  // ---------------------------------------------------------------------------
  // The team's side
  // ---------------------------------------------------------------------------

  async list(
    context: TenantContext,
    filter: { propertyId?: string; status?: Call['status']; limit: number },
  ): Promise<CallDto[]> {
    requirePermission(context, Permission.CONVERSATION_VIEW_ASSIGNED);
    if (filter.propertyId) requirePropertyAccess(context, filter.propertyId);
    const propertyIds = filter.propertyId
      ? [filter.propertyId]
      : context.propertyIds && context.propertyIds.size > 0
        ? [...context.propertyIds]
        : undefined;
    const rows = await this.options.store.listCalls(context.accountId, {
      ...(propertyIds ? { propertyIds } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      limit: filter.limit,
    });
    return Promise.all(rows.map((row) => this.dto(row)));
  }

  async get(context: TenantContext, callId: string): Promise<CallDto> {
    return this.dto(await this.memberCall(context, callId));
  }

  /**
   * A member presses Answer.
   *
   * Two people pressing it in the same instant is the normal case on a busy desk, so the claim
   * is one Redis key set only if it was not set already - the database row is updated by the
   * one who got it, and the other learns the call was taken.
   */
  async answer(
    context: TenantContext,
    callId: string,
  ): Promise<{ call: CallDto; join: CallJoinGrant }> {
    const memberId = this.memberOf(context);
    const call = await this.memberCall(context, callId);
    if (call.status !== 'ringing') {
      throw new AppError(
        ErrorCode.CONFLICT,
        call.status === 'ended' ? 'This call has ended.' : 'This call was already answered.',
      );
    }
    if (
      call.pendingKind === 'ai' ||
      (call.pendingKind === 'member' && call.pendingMemberId !== memberId)
    ) {
      throw new AppError(ErrorCode.CONFLICT, 'This call is being transferred to someone else.');
    }

    const claimed = await this.options.redis.set(
      presenceKey.callClaim(call.id, call.ringSeq),
      memberId,
      'EX',
      120,
      'NX',
    );
    if (claimed !== 'OK') {
      throw new AppError(ErrorCode.CONFLICT, 'Someone else answered this call first.');
    }

    const now = this.clock.now();
    const previousHolder = this.holderIdentity(call);
    const member = await this.options.store.member(call.accountId, memberId);
    const leg = await this.options.store.createLeg({
      accountId: call.accountId,
      callId: call.id,
      kind: 'member',
      memberId,
      identity: who.member(memberId),
      now,
    });
    const updated = await this.options.store.updateCall(call.id, {
      status: 'connecting',
      answeredByMemberId: memberId,
      handledByAi: false,
      pendingKind: null,
      pendingMemberId: null,
      ringSeq: call.ringSeq + 1,
      ...(call.answeredAt ? {} : { answeredAt: now }),
    });
    await this.options.store.addEvent({
      accountId: call.accountId,
      callId: call.id,
      type: call.pendingKind ? 'transfer_accepted' : 'answer',
      memberId,
      now,
    });

    if (previousHolder) {
      // A transfer: the one who handed it over leaves now that the new person is on the way.
      await this.closeOpenLegs(call.id, [previousHolder], now);
      await this.options.media
        .removeParticipant(call.roomName, previousHolder)
        .catch((error: unknown) =>
          this.options.log?.('voice.call.remove_failed', {
            callId: call.id,
            identity: previousHolder,
            error: String(error),
          }),
        );
      await this.systemMessage(
        updated,
        `Call transferred to ${member?.name ?? 'a team member'}`,
        {
          kind: 'call.transferred',
          by: this.actorOf(call),
          callId: call.id,
          targetName: member?.name ?? undefined,
        },
        now,
      );
    } else {
      await this.systemMessage(
        updated,
        `${member?.name ?? 'A team member'} answered the call`,
        {
          kind: 'call.answered',
          by: 'agent',
          callId: call.id,
          actorName: member?.name ?? undefined,
        },
        now,
      );
    }
    await this.publish(updated);

    const join = await this.options.media.grant({
      roomName: call.roomName,
      identity: who.member(memberId),
      displayName: member?.name ?? context.actorName ?? 'Agent',
      ttlSeconds: GRANT_TTL_SECONDS,
    });
    this.options.log?.('voice.call.answered', {
      callId: call.id,
      memberId,
      legId: leg.id,
      transfer: call.pendingKind !== null,
    });
    return { call: await this.dto(updated), join };
  }

  /** A member declines a ringing call. When everyone who was rung has declined, the AI takes it. */
  async decline(context: TenantContext, callId: string): Promise<CallDto> {
    const memberId = this.memberOf(context);
    const call = await this.memberCall(context, callId);
    if (call.status !== 'ringing') return this.dto(call);
    const now = this.clock.now();
    await this.options.store.addEvent({
      accountId: call.accountId,
      callId: call.id,
      type: 'decline',
      memberId,
      now,
    });

    if (call.pendingKind === 'member') {
      if (call.pendingMemberId !== memberId) return this.dto(call);
      return this.dto(await this.transferFailed(call, 'declined'));
    }

    const declinedKey = `call:declined:${call.id}:${call.ringSeq}`;
    await this.options.redis.sadd(declinedKey, memberId);
    await this.options.redis.expire(declinedKey, 300);
    const declined = await this.options.redis.scard(declinedKey);
    const targets = await this.options.store.onlineMembers(call.accountId, call.propertyId);
    const everyoneDeclined =
      targets.every((target) => target.id === memberId) || declined >= targets.length;
    if (!everyoneDeclined) return this.dto(call);

    if (call.handledByAi) {
      // The AI was ringing people on the visitor's behalf; none wanted it. Back to the AI.
      return this.dto(await this.transferFailed(call, 'declined'));
    }
    const settings = await this.options.settings.forProperty(call.accountId, call.propertyId);
    const taken = await this.tryAi(call, settings.aiAnswers);
    if (taken) return this.dto(taken);
    return this.dto(await this.end(call, 'declined', { by: 'system' }));
  }

  /** The person on the call hangs up. */
  async endByMember(context: TenantContext, callId: string): Promise<CallDto> {
    const memberId = this.memberOf(context);
    const call = await this.memberCall(context, callId);
    if (call.status === 'ended') return this.dto(call);
    if (call.answeredByMemberId !== memberId) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'Only the person on the call can end it.');
    }
    const member = await this.options.store.member(call.accountId, memberId);
    return this.dto(
      await this.end(call, 'completed', { by: 'agent', actorName: member?.name ?? undefined }),
    );
  }

  /** The person on the call sends it to one colleague, or to the AI. */
  async transfer(
    context: TenantContext,
    callId: string,
    input: TransferCallInput,
  ): Promise<CallDto> {
    const memberId = this.memberOf(context);
    const call = await this.memberCall(context, callId);
    if (call.status !== 'active' && call.status !== 'connecting') {
      throw new AppError(ErrorCode.CONFLICT, 'Only a live call can be transferred.');
    }
    if (call.answeredByMemberId !== memberId) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'Only the person on the call can transfer it.',
      );
    }
    const now = this.clock.now();

    if (input.to === 'ai') {
      const settings = await this.options.settings.forProperty(call.accountId, call.propertyId);
      const assistant = await this.options.store.assistant(call.accountId, call.propertyId);
      if (!settings.aiAnswers || !assistant.configured) {
        throw new AppError(
          ErrorCode.FEATURE_NOT_AVAILABLE,
          'The AI does not take calls on this website.',
        );
      }
      if (!(await this.options.entitlements.hasFeature(call.accountId, 'aiAgent'))) {
        throw new AppError(
          ErrorCode.FEATURE_NOT_IN_PLAN,
          'The AI agent is not included in your plan.',
        );
      }
      if (!(await this.aiHasCapacity())) {
        throw new AppError(
          ErrorCode.TEMPORARILY_UNAVAILABLE,
          'The AI is on as many calls as it can take right now. Please try again in a moment.',
        );
      }
      await this.options.store.addEvent({
        accountId: call.accountId,
        callId: call.id,
        type: 'transfer_requested',
        memberId,
        data: { to: 'ai' },
        now,
      });
      const taken = await this.dispatchAi(call, { transferFrom: who.member(memberId) });
      return this.dto(taken);
    }

    if (input.memberId === memberId) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'You already have this call.');
    }
    const targets = await this.options.store.onlineMembers(call.accountId, call.propertyId);
    const target = targets.find((candidate) => candidate.id === input.memberId);
    if (!target) {
      throw new AppError(ErrorCode.CONFLICT, 'That team member is not available right now.');
    }
    const updated = await this.options.store.updateCall(call.id, {
      status: 'ringing',
      pendingKind: 'member',
      pendingMemberId: target.id,
      ringSeq: call.ringSeq + 1,
    });
    await this.options.store.addEvent({
      accountId: call.accountId,
      callId: call.id,
      type: 'transfer_requested',
      memberId,
      targetMemberId: target.id,
      now,
    });
    await this.options.queue.enqueue(
      VoiceJob.TRANSFER_TIMEOUT,
      { accountId: call.accountId, callId: call.id, ringSeq: updated.ringSeq },
      { delay: TRANSFER_RING_SECONDS * 1000, attempts: 1 },
    );
    await this.publish(updated);
    return this.dto(updated);
  }

  /** Who the person on a call may send it to: available colleagues, by name, and the AI. */
  async transferTargets(
    context: TenantContext,
    callId: string,
  ): Promise<{ members: Array<{ id: string; name: string | null }>; ai: boolean }> {
    const memberId = this.memberOf(context);
    const call = await this.memberCall(context, callId);
    const [members, settings, assistant, planIncludesAi] = await Promise.all([
      this.options.store.onlineMembers(call.accountId, call.propertyId),
      this.options.settings.forProperty(call.accountId, call.propertyId),
      this.options.store.assistant(call.accountId, call.propertyId),
      this.options.entitlements.hasFeature(call.accountId, 'aiAgent'),
    ]);
    return {
      members: members.filter((member) => member.id !== memberId),
      ai: settings.aiAnswers && assistant.configured && planIncludesAi,
    };
  }

  /** A party reports it is in the room. Belt to the webhook's braces: either one is enough. */
  async joined(context: TenantContext, callId: string): Promise<CallDto> {
    const memberId = this.memberOf(context);
    const call = await this.memberCall(context, callId);
    return this.dto(await this.arrived(call, who.member(memberId)));
  }

  async visitorJoined(identity: VisitorIdentity, callId: string): Promise<CallDto> {
    const call = await this.visitorCall(identity, callId);
    return this.dto(await this.arrived(call, who.visitor(identity.visitorId)));
  }

  // ---------------------------------------------------------------------------
  // The AI's side (called by the voice agent process)
  // ---------------------------------------------------------------------------

  /** What the agent process needs to take a call: the row, a key to the room, the settings. */
  async aiSession(
    accountId: string,
    callId: string,
    legId: string,
  ): Promise<{
    call: CallRow;
    join: CallJoinGrant;
    assistantName: string;
    businessName: string;
  } | null> {
    const call = await this.options.store.getCall(accountId, callId);
    if (!call || call.status === 'ended' || !call.handledByAi) return null;
    const legs = await this.options.store.legs(call.id);
    const leg = legs.find((candidate) => candidate.id === legId);
    if (!leg || leg.leftAt) return null;
    const [assistant, property] = await Promise.all([
      this.options.store.assistant(call.accountId, call.propertyId),
      this.options.store.property(call.accountId, call.propertyId),
    ]);
    const join = await this.options.media.grant({
      roomName: call.roomName,
      identity: leg.identity,
      displayName: assistant.name,
      ttlSeconds: GRANT_TTL_SECONDS,
    });
    return { call, join, assistantName: assistant.name, businessName: property?.name ?? '' };
  }

  /** The AI is in the room and talking. */
  async aiConnected(accountId: string, callId: string): Promise<CallRow | null> {
    const call = await this.options.store.getCall(accountId, callId);
    if (!call || call.status === 'ended') return null;
    return this.arrived(call, who.ai(call.id));
  }

  /** The AI heard what it heard: keep the record's language current. */
  async aiLanguage(accountId: string, callId: string, language: VoiceLanguage): Promise<void> {
    const call = await this.options.store.getCall(accountId, callId);
    if (!call || call.status === 'ended' || call.language === language) return;
    await this.options.store.updateCall(call.id, { language });
  }

  /** The AI said goodbye, or gave up. */
  async aiFinished(
    accountId: string,
    callId: string,
    reason: 'ai_ended' | 'failed' | 'completed',
  ): Promise<CallRow | null> {
    const call = await this.options.store.getCall(accountId, callId);
    if (!call || call.status === 'ended') return call;
    if (!call.handledByAi) return call;
    return this.end(call, reason, { by: 'ai' });
  }

  /**
   * The AI wants a person: ring the team while the AI keeps the visitor company. Returns how many
   * were rung; zero means nobody is available and the AI should say so.
   */
  async aiRequestHuman(accountId: string, callId: string): Promise<number> {
    const call = await this.options.store.getCall(accountId, callId);
    if (!call || call.status !== 'active' || !call.handledByAi) return 0;
    const targets = await this.options.store.onlineMembers(call.accountId, call.propertyId);
    if (targets.length === 0) return 0;
    const now = this.clock.now();
    const settings = await this.options.settings.forProperty(call.accountId, call.propertyId);
    const updated = await this.options.store.updateCall(call.id, {
      status: 'ringing',
      pendingKind: null,
      pendingMemberId: null,
      ringSeq: call.ringSeq + 1,
    });
    await this.options.store.addEvent({
      accountId: call.accountId,
      callId: call.id,
      type: 'ring',
      data: { targets: targets.map((target) => target.id), by: 'ai' },
      now,
    });
    await this.options.queue.enqueue(
      VoiceJob.RING_TIMEOUT,
      { accountId: call.accountId, callId: call.id, ringSeq: updated.ringSeq },
      { delay: settings.ringSeconds * 1000, attempts: 1 },
    );
    await this.publish(updated);
    return targets.length;
  }

  // ---------------------------------------------------------------------------
  // Timers and the media server
  // ---------------------------------------------------------------------------

  /** The team rang for the website's ring time and nobody answered. */
  async ringTimeout(accountId: string, callId: string, ringSeq: number): Promise<void> {
    const call = await this.options.store.getCall(accountId, callId);
    if (!call || call.status !== 'ringing' || call.ringSeq !== ringSeq || call.pendingKind !== null)
      return;
    const now = this.clock.now();
    await this.options.store.addEvent({
      accountId: call.accountId,
      callId: call.id,
      type: 'no_answer',
      now,
    });
    if (call.handledByAi) {
      // The AI was ringing people; none came. It carries on.
      await this.transferFailed(call, 'no_answer');
      return;
    }
    const settings = await this.options.settings.forProperty(call.accountId, call.propertyId);
    const taken = await this.tryAi(call, settings.aiAnswers);
    if (!taken) await this.end(call, 'no_answer', { by: 'system' });
  }

  /** The one person a call was transferred to did not answer in time. */
  async transferTimeout(accountId: string, callId: string, ringSeq: number): Promise<void> {
    const call = await this.options.store.getCall(accountId, callId);
    if (
      !call ||
      call.status !== 'ringing' ||
      call.ringSeq !== ringSeq ||
      call.pendingKind !== 'member'
    )
      return;
    await this.transferFailed(call, 'no_answer');
  }

  /** What the media server tells us: who arrived, who left, when the room closed. */
  async onMediaEvent(event: {
    event: string;
    roomName: string | null;
    participantIdentity: string | null;
  }): Promise<void> {
    if (!event.roomName) return;
    const call = await this.options.store.getCallByRoom(event.roomName);
    if (!call) return;
    switch (event.event) {
      case 'participant_joined':
        if (event.participantIdentity) await this.arrived(call, event.participantIdentity);
        return;
      case 'participant_left':
        if (event.participantIdentity) await this.left(call, event.participantIdentity);
        return;
      case 'room_finished':
        if (call.status !== 'ended')
          await this.end(call, call.answeredAt ? 'completed' : 'no_answer', { by: 'system' });
        return;
      default:
        return;
    }
  }

  /** Calls that got stuck because a timer or a webhook never came. Every minute. */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const stale = await this.options.store.staleCalls(now);
    let ended = 0;
    for (const call of stale) {
      try {
        if (call.status === 'ringing') {
          if (call.pendingKind === 'member') await this.transferFailed(call, 'no_answer');
          else await this.ringTimeout(call.accountId, call.id, call.ringSeq);
        } else if (call.status === 'connecting') {
          await this.end(call, 'failed', { by: 'system' });
        } else if (call.status === 'active') {
          const present = await this.options.media.participants(call.roomName);
          if (present.length === 0) await this.end(call, 'completed', { by: 'system' });
        }
        ended += 1;
      } catch (error) {
        this.options.log?.('voice.sweep.failed', { callId: call.id, error: String(error) });
      }
    }
    return ended;
  }

  // ---------------------------------------------------------------------------

  /** The AI takes the call if it is allowed to and there is room for it. */
  private async tryAi(call: CallRow, aiAnswers: boolean): Promise<CallRow | null> {
    if (!aiAnswers) return null;
    const [assistant, planIncludesAi] = await Promise.all([
      this.options.store.assistant(call.accountId, call.propertyId),
      this.options.entitlements.hasFeature(call.accountId, 'aiAgent'),
    ]);
    if (!assistant.configured || !planIncludesAi) return null;
    if (!(await this.aiHasCapacity())) {
      this.options.log?.('voice.ai.no_capacity', { callId: call.id });
      return null;
    }
    return this.dispatchAi(call, {});
  }

  private async aiHasCapacity(): Promise<boolean> {
    const raw = await this.options.redis.get(presenceKey.aiCalls());
    const busy = raw ? Number.parseInt(raw, 10) || 0 : 0;
    return busy < this.options.aiMaxCalls;
  }

  /**
   * Hand the call to the AI: a leg for it, the record updated, the agent process asked to join.
   * When a person transferred it, they are removed once the AI is actually in the room - see
   * `arrived` - so the visitor is never alone.
   */
  private async dispatchAi(call: CallRow, options: { transferFrom?: string }): Promise<CallRow> {
    const now = this.clock.now();
    const leg = await this.options.store.createLeg({
      accountId: call.accountId,
      callId: call.id,
      kind: 'ai',
      memberId: null,
      identity: who.ai(call.id),
      now,
    });
    const updated = await this.options.store.updateCall(call.id, {
      status: 'connecting',
      handledByAi: true,
      answeredByMemberId: null,
      pendingKind: options.transferFrom ? 'ai' : null,
      pendingMemberId: null,
      ringSeq: call.ringSeq + 1,
      ...(call.answeredAt ? {} : { answeredAt: now }),
    });
    await this.options.store.addEvent({
      accountId: call.accountId,
      callId: call.id,
      type: 'ai_joined',
      data: options.transferFrom ? { transferFrom: options.transferFrom } : {},
      now,
    });
    await this.options.queue.enqueue(
      VoiceJob.AI_JOIN,
      { accountId: call.accountId, callId: call.id, legId: leg.id },
      { attempts: 2 },
    );
    if (!options.transferFrom) {
      const assistant = await this.options.store.assistant(call.accountId, call.propertyId);
      await this.systemMessage(
        updated,
        `${assistant.name} answered the call`,
        { kind: 'call.answered', by: 'ai', callId: call.id, actorName: assistant.name },
        now,
      );
    }
    await this.publish(updated);
    this.options.log?.('voice.ai.dispatched', {
      callId: call.id,
      legId: leg.id,
      transfer: Boolean(options.transferFrom),
    });
    return updated;
  }

  /** A transfer that did not happen: the call goes back to whoever had it. */
  private async transferFailed(call: CallRow, why: 'declined' | 'no_answer'): Promise<CallRow> {
    const now = this.clock.now();
    const updated = await this.options.store.updateCall(call.id, {
      status: 'active',
      pendingKind: null,
      pendingMemberId: null,
      ringSeq: call.ringSeq + 1,
    });
    await this.options.store.addEvent({
      accountId: call.accountId,
      callId: call.id,
      type: 'transfer_failed',
      targetMemberId: call.pendingMemberId,
      data: { why },
      now,
    });
    await this.publish(updated);
    return updated;
  }

  /** Somebody is in the room. The first time both the visitor and the holder are, the call is live. */
  private async arrived(call: CallRow, participant: string): Promise<CallRow> {
    const now = this.clock.now();
    const legs = await this.options.store.legs(call.id);
    const leg = [...legs]
      .reverse()
      .find((candidate) => candidate.identity === participant && candidate.leftAt === null);
    if (leg && leg.joinedAt === null) await this.options.store.updateLeg(leg.id, { joinedAt: now });

    if (call.status !== 'connecting') return call;
    const holder = this.holderIdentity(call);
    if (!holder) return call;
    const present = new Set(
      legs
        .filter(
          (candidate) =>
            candidate.leftAt === null &&
            (candidate.joinedAt !== null || candidate.identity === participant),
        )
        .map((candidate) => candidate.identity),
    );
    if (!present.has(holder) || !present.has(who.visitor(call.visitorId))) return call;

    const updated = await this.options.store.updateCall(call.id, {
      status: 'active',
      ...(call.pendingKind === 'ai' ? { pendingKind: null } : {}),
    });
    // The AI arrived on a transfer: the person who handed over leaves now.
    if (call.pendingKind === 'ai' && call.handledByAi) {
      const human = legs
        .filter((candidate) => candidate.kind === 'member' && candidate.leftAt === null)
        .map((candidate) => candidate.identity);
      await this.closeOpenLegs(call.id, human, now);
      for (const identity of human) {
        await this.options.media
          .removeParticipant(call.roomName, identity)
          .catch((error: unknown) =>
            this.options.log?.('voice.call.remove_failed', {
              callId: call.id,
              identity,
              error: String(error),
            }),
          );
      }
      const assistant = await this.options.store.assistant(call.accountId, call.propertyId);
      await this.systemMessage(
        updated,
        `Call transferred to ${assistant.name}`,
        { kind: 'call.transferred', by: 'agent', callId: call.id, targetName: assistant.name },
        now,
      );
    }
    await this.publish(updated);
    return updated;
  }

  /** Somebody left the room. The visitor leaving ends the call; the holder leaving does too. */
  private async left(call: CallRow, participant: string): Promise<void> {
    if (call.status === 'ended') return;
    const now = this.clock.now();
    await this.closeOpenLegs(call.id, [participant], now);
    const kind = who.kindOf(participant);
    if (kind === 'visitor') {
      await this.end(call, call.answeredAt ? 'visitor_left' : 'cancelled', { by: 'visitor' });
      return;
    }
    // A removed party (a completed transfer) is expected to leave; only the current holder
    // dropping is the end of the call.
    if (participant !== this.holderIdentity(call)) return;
    if (call.status === 'ringing' && call.pendingKind === null && call.handledByAi) return;
    if (kind === 'ai') await this.end(call, 'ai_ended', { by: 'ai' });
    else await this.end(call, 'agent_left', { by: 'agent' });
  }

  private async end(
    call: CallRow,
    reason: CallEndReason,
    by: { by: SystemMessageEvent['by']; actorName?: string },
  ): Promise<CallRow> {
    const fresh = await this.options.store.getCall(call.accountId, call.id);
    if (!fresh || fresh.status === 'ended') return fresh ?? call;
    const now = this.clock.now();
    const legs = await this.options.store.legs(call.id);
    const durationSeconds = fresh.answeredAt
      ? Math.max(0, Math.round((now.getTime() - fresh.answeredAt.getTime()) / 1000))
      : 0;
    const aiSeconds = legs
      .filter((leg) => leg.kind === 'ai' && leg.joinedAt)
      .reduce(
        (sum, leg) =>
          sum +
          Math.max(0, Math.round(((leg.leftAt ?? now).getTime() - leg.joinedAt!.getTime()) / 1000)),
        0,
      );
    const updated = await this.options.store.updateCall(call.id, {
      status: 'ended',
      endedAt: now,
      endReason: reason,
      durationSeconds,
      aiSeconds,
      pendingKind: null,
      pendingMemberId: null,
      ringSeq: fresh.ringSeq + 1,
    });
    await this.closeOpenLegs(
      call.id,
      legs.filter((leg) => leg.leftAt === null).map((leg) => leg.identity),
      now,
    );
    await this.options.store.addEvent({
      accountId: call.accountId,
      callId: call.id,
      type: 'ended',
      data: { reason },
      now,
    });
    await this.options.media
      .deleteRoom(call.roomName)
      .catch((error: unknown) =>
        this.options.log?.('voice.call.delete_room_failed', {
          callId: call.id,
          error: String(error),
        }),
      );
    const missed = !fresh.answeredAt;
    await this.systemMessage(
      updated,
      missed ? 'Missed call' : `Call ended (${formatDuration(durationSeconds)})`,
      {
        kind: missed ? 'call.missed' : 'call.ended',
        by: by.by,
        callId: call.id,
        durationSeconds,
        ...(by.actorName ? { actorName: by.actorName } : {}),
      },
      now,
    );
    await this.publish(updated);
    this.options.log?.('voice.call.ended', { callId: call.id, reason, durationSeconds, aiSeconds });
    return updated;
  }

  private async closeOpenLegs(callId: string, identities: string[], now: Date): Promise<void> {
    if (identities.length === 0) return;
    const legs = await this.options.store.legs(callId);
    for (const leg of legs) {
      if (leg.leftAt === null && identities.includes(leg.identity)) {
        await this.options.store.updateLeg(leg.id, { leftAt: now });
      }
    }
  }

  private holderIdentity(call: CallRow): string | null {
    if (call.handledByAi) return who.ai(call.id);
    if (call.answeredByMemberId) return who.member(call.answeredByMemberId);
    return null;
  }

  private actorOf(call: CallRow): SystemMessageEvent['by'] {
    return call.handledByAi ? 'ai' : 'agent';
  }

  private memberOf(context: TenantContext): string {
    if (!context.memberId)
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'Only a member of the team can do this.');
    requirePermission(context, Permission.CONVERSATION_REPLY);
    return context.memberId;
  }

  private async memberCall(context: TenantContext, callId: string): Promise<CallRow> {
    requirePermission(context, Permission.CONVERSATION_VIEW_ASSIGNED);
    const call = await this.options.store.getCall(context.accountId, callId);
    if (!call) throw new AppError(ErrorCode.NOT_FOUND, 'Call not found');
    requirePropertyAccess(context, call.propertyId, ErrorCode.NOT_FOUND);
    return call;
  }

  private async visitorCall(identity: VisitorIdentity, callId: string): Promise<CallRow> {
    const call = await this.options.store.getCall(identity.accountId, callId);
    if (!call || call.visitorId !== identity.visitorId || call.propertyId !== identity.propertyId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Call not found');
    }
    return call;
  }

  private async systemMessage(
    call: CallRow,
    body: string,
    event: SystemMessageEvent,
    now: Date,
  ): Promise<void> {
    try {
      const message = await this.options.store.insertSystemMessage({
        accountId: call.accountId,
        propertyId: call.propertyId,
        conversationId: call.conversationId,
        body,
        event,
        now,
      });
      await this.options.events.publish({
        type: ServerEvent.MESSAGE_NEW,
        accountId: call.accountId,
        propertyId: call.propertyId,
        conversationId: call.conversationId,
        visitorId: call.visitorId,
        payload: { message, room: room.conversation(call.conversationId) },
      });
    } catch (error) {
      // The timeline is a record, not the call itself: a failure here must not drop a call.
      this.options.log?.('voice.call.system_message_failed', {
        callId: call.id,
        error: String(error),
      });
    }
  }

  /** Tell everyone who can see this call where it is now. */
  private async publish(call: CallRow): Promise<void> {
    const dto = await this.dto(call);
    await this.options.events.publish({
      type: ServerEvent.CALL_UPDATED,
      accountId: call.accountId,
      propertyId: call.propertyId,
      conversationId: call.conversationId,
      visitorId: call.visitorId,
      agentsOnly: true,
      payload: { call: dto },
    });
    await this.options.events.publish({
      type: ServerEvent.CALL_UPDATED,
      accountId: call.accountId,
      propertyId: call.propertyId,
      visitorId: call.visitorId,
      toVisitor: true,
      payload: { call: dto },
    });
  }

  async dto(call: CallRow): Promise<CallDto> {
    const [visitor, answeredBy, pendingMember] = await Promise.all([
      this.options.store.visitor(call.accountId, call.visitorId),
      call.answeredByMemberId
        ? this.options.store.member(call.accountId, call.answeredByMemberId)
        : null,
      call.pendingKind === 'member' && call.pendingMemberId
        ? this.options.store.member(call.accountId, call.pendingMemberId)
        : null,
    ]);
    const assistant = call.handledByAi
      ? await this.options.store.assistant(call.accountId, call.propertyId)
      : null;
    return {
      id: call.id,
      propertyId: call.propertyId,
      conversationId: call.conversationId,
      visitorId: call.visitorId,
      status: call.status,
      answeredByMemberId: call.answeredByMemberId,
      answeredByName: call.handledByAi
        ? (assistant?.name ?? 'AI assistant')
        : (answeredBy?.name ?? null),
      handledByAi: call.handledByAi,
      pending:
        call.pendingKind === 'ai'
          ? { kind: 'ai' }
          : call.pendingKind === 'member' && call.pendingMemberId
            ? { kind: 'member', memberId: call.pendingMemberId, name: pendingMember?.name ?? null }
            : null,
      visitor: { name: visitor?.name ?? null, email: visitor?.email ?? null },
      language: call.language === 'bn' || call.language === 'en' ? call.language : null,
      startedAt: call.startedAt.toISOString(),
      answeredAt: call.answeredAt?.toISOString() ?? null,
      endedAt: call.endedAt?.toISOString() ?? null,
      endReason: call.endReason,
      durationSeconds: call.durationSeconds,
    };
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`;
}

export type { CallLegKind };
