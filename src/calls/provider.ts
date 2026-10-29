/**
 * Voice rooms for "Talk to a person" calls.
 *
 *   DailyCallProvider - Daily.co (https://docs.daily.co/reference/rest-api):
 *     a PRIVATE room per call (only people with a token can join), voice only,
 *     at most 2 people, closed automatically when it expires.
 *   FakeCallProvider  - for tests and local development without a Daily key
 *     (no real audio; the panel shows "test mode").
 *
 * Tokens are short-lived and made for one room and one person. The browser
 * gets only its own token, never the Daily API key.
 */

export interface CallRoom {
  name: string;
  url: string;
}

export interface CallProvider {
  readonly name: "daily" | "fake";
  createRoom(input: { name: string; expiresAt: Date }): Promise<CallRoom>;
  createToken(input: { roomName: string; userName: string; expiresAt: Date; isAgent: boolean }): Promise<string>;
  deleteRoom(name: string): Promise<void>;
}

export class CallProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CallProviderError";
  }
}

export class DailyCallProvider implements CallProvider {
  readonly name = "daily" as const;
  private readonly base = "https://api.daily.co/v1";

  constructor(private readonly apiKey: string, private readonly timeoutMs = 10_000) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new CallProviderError("Daily request failed", { cause: err });
    }
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      // Daily's error text can include request details; keep only the status for our logs.
      throw new CallProviderError(`Daily request failed (status ${res.status})`);
    }
    return (res.status === 204 ? {} : await res.json()) as T;
  }

  async createRoom(input: { name: string; expiresAt: Date }): Promise<CallRoom> {
    const room = await this.call<{ name: string; url: string }>("POST", "/rooms", {
      name: input.name,
      privacy: "private",
      properties: {
        exp: Math.floor(input.expiresAt.getTime() / 1000),
        eject_at_room_exp: true,
        max_participants: 2,
        start_video_off: true,
        enable_screenshare: false,
        enable_chat: false,
        enable_recording: false,
      },
    });
    return { name: room.name, url: room.url };
  }

  async createToken(input: { roomName: string; userName: string; expiresAt: Date; isAgent: boolean }): Promise<string> {
    const res = await this.call<{ token: string }>("POST", "/meeting-tokens", {
      properties: {
        room_name: input.roomName,
        user_name: input.userName.slice(0, 60),
        exp: Math.floor(input.expiresAt.getTime() / 1000),
        is_owner: input.isAgent,
        start_video_off: true,
        enable_screenshare: false,
      },
    });
    return res.token;
  }

  async deleteRoom(name: string): Promise<void> {
    await this.call("DELETE", `/rooms/${encodeURIComponent(name)}`);
  }
}

export class FakeCallProvider implements CallProvider {
  readonly name = "fake" as const;
  readonly rooms = new Set<string>();

  async createRoom(input: { name: string }): Promise<CallRoom> {
    this.rooms.add(input.name);
    return { name: input.name, url: `https://fake.daily.test/${input.name}` };
  }

  async createToken(input: { roomName: string; isAgent: boolean }): Promise<string> {
    return `fake-token-${input.isAgent ? "agent" : "caller"}-${input.roomName}`;
  }

  async deleteRoom(name: string): Promise<void> {
    this.rooms.delete(name);
  }
}
