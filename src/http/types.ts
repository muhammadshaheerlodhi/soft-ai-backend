import type { Logger } from "../logger.js";
import type { VerifiedUser } from "../auth/verify-token.js";
import type { MemberContext } from "../auth/member-context.js";

/** Values each request carries through the middleware chain. */
export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
    user: VerifiedUser;
    member: MemberContext;
  };
}
