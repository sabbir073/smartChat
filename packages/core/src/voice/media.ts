import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import type { CallJoinGrant } from '@smartchat/types';

/**
 * The media server, behind the one interface the call service needs.
 *
 * LiveKit carries the audio; everything about who may be in a room comes from here, as a token
 * minted per party. A token opens exactly one room for exactly one identity, lets it publish a
 * microphone and nothing else, and dies within minutes - it is a key to one call, not a login.
 * The call service never sees the API secret, and a test never needs a media server.
 */

export interface MediaRooms {
  /** Create the room for a call. Idempotent: creating a room that exists returns it. */
  createRoom(input: {
    name: string;
    emptyTimeoutSeconds: number;
    maxParticipants: number;
  }): Promise<void>;
  /** A key for one party to join one room. */
  grant(input: {
    roomName: string;
    identity: string;
    displayName: string;
    ttlSeconds: number;
    metadata?: Record<string, unknown>;
  }): Promise<CallJoinGrant>;
  /** Throw a party out: the person who transferred the call, or the AI when a person takes over. */
  removeParticipant(roomName: string, identity: string): Promise<void>;
  /** Close the room, disconnecting whoever is left. */
  deleteRoom(roomName: string): Promise<void>;
  /** Who is in the room right now, by identity. */
  participants(roomName: string): Promise<string[]>;
  /** Check a webhook's signature and read the event it carries. Throws on a bad signature. */
  readWebhook(body: string, authorization: string | undefined): Promise<MediaWebhook>;
}

export interface MediaWebhook {
  event: string;
  roomName: string | null;
  participantIdentity: string | null;
  /** The server's event id, for de-duplication. */
  id: string;
}

export interface LiveKitRoomsOptions {
  /** Where the API reaches the server (inside the network): http(s)://livekit:7880. */
  apiUrl: string;
  /** Where browsers reach it: wss://lk.example.com. */
  publicUrl: string;
  apiKey: string;
  apiSecret: string;
}

export class LiveKitRooms implements MediaRooms {
  private readonly rooms: RoomServiceClient;
  private readonly receiver: WebhookReceiver;

  constructor(private readonly options: LiveKitRoomsOptions) {
    this.rooms = new RoomServiceClient(options.apiUrl, options.apiKey, options.apiSecret);
    this.receiver = new WebhookReceiver(options.apiKey, options.apiSecret);
  }

  async createRoom(input: {
    name: string;
    emptyTimeoutSeconds: number;
    maxParticipants: number;
  }): Promise<void> {
    await this.rooms.createRoom({
      name: input.name,
      emptyTimeout: input.emptyTimeoutSeconds,
      // A short grace after the last person leaves: a transfer swaps parties, and the room must
      // not vanish between one leaving and the next arriving.
      departureTimeout: 30,
      maxParticipants: input.maxParticipants,
    });
  }

  async grant(input: {
    roomName: string;
    identity: string;
    displayName: string;
    ttlSeconds: number;
    metadata?: Record<string, unknown>;
  }): Promise<CallJoinGrant> {
    const token = new AccessToken(this.options.apiKey, this.options.apiSecret, {
      identity: input.identity,
      name: input.displayName,
      ttl: input.ttlSeconds,
      ...(input.metadata ? { metadata: JSON.stringify(input.metadata) } : {}),
    });
    token.addGrant({
      room: input.roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: [TrackSource.MICROPHONE],
    });
    return {
      url: this.options.publicUrl,
      token: await token.toJwt(),
      roomName: input.roomName,
      identity: input.identity,
    };
  }

  async removeParticipant(roomName: string, identity: string): Promise<void> {
    try {
      await this.rooms.removeParticipant(roomName, identity);
    } catch (error) {
      // Already gone is the outcome wanted. Anything else is reported.
      if (!isNotFound(error)) throw error;
    }
  }

  async deleteRoom(roomName: string): Promise<void> {
    try {
      await this.rooms.deleteRoom(roomName);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async participants(roomName: string): Promise<string[]> {
    try {
      const list = await this.rooms.listParticipants(roomName);
      return list.map((participant) => participant.identity);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async readWebhook(body: string, authorization: string | undefined): Promise<MediaWebhook> {
    const event = await this.receiver.receive(body, authorization);
    return {
      event: event.event,
      roomName: event.room?.name ?? null,
      participantIdentity: event.participant?.identity ?? null,
      id: event.id,
    };
  }
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|does not exist|404/i.test(message);
}

/** Identities inside a room. The prefix says what kind of party it is without a lookup. */
export const identity = {
  visitor: (visitorId: string) => `visitor:${visitorId}`,
  member: (memberId: string) => `member:${memberId}`,
  ai: (callId: string) => `ai:${callId}`,
  kindOf(value: string): 'visitor' | 'member' | 'ai' | null {
    if (value.startsWith('visitor:')) return 'visitor';
    if (value.startsWith('member:')) return 'member';
    if (value.startsWith('ai:')) return 'ai';
    return null;
  },
} as const;
