import {
  buildTriggerFacts,
  loadVisitorFactBase,
  type TriggerRunResult,
  type VisitorFactBase,
  type VisitorIdentity,
} from '@smartchat/core';
import { parseWidgetConfig } from '@smartchat/validation';
import type { RealtimeContainer } from '../container.js';

/**
 * How many pending time-on-site rules one socket may hold.
 *
 * Each is a timer, and a socket is something anybody on the internet can open. An account with
 * more than this many time rules gets the earliest ones, which is also the order they would have
 * fired in.
 */
const MAX_PENDING_TIMERS = 20;

export interface AutomationSessionOptions {
  container: RealtimeContainer;
  identity: VisitorIdentity;
  /** Deliver a fired message to this visitor's own socket. */
  onFired: (result: TriggerRunResult) => void | Promise<void>;
}

/**
 * Automation for one connected visitor.
 *
 * Everything time-based is held here, on the socket, rather than in a queue. That is the whole
 * point: a delayed job would happily message somebody who closed the tab twenty seconds ago, and
 * "we noticed you have been reading for a minute" is only true while they are still reading. When
 * the socket goes, the pending rules go with it.
 */
export class AutomationSession {
  private base: VisitorFactBase | null = null;
  private page: { url: string | null; title: string | null; referrer: string | null } = {
    url: null,
    title: null,
    referrer: null,
  };
  private pageViews = 0;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private botName: string | null | undefined;

  constructor(private readonly options: AutomationSessionOptions) {}

  /**
   * Load the snapshot and consider the rules that fire on arrival.
   *
   * Failures are swallowed on purpose. Automation is an enhancement to a conversation; a visitor
   * whose greeting could not be computed must still be able to chat.
   */
  async start(page: { url: string | null; title: string | null } | null): Promise<void> {
    const { container, identity } = this.options;
    const now = container.clock.now();

    if (page) this.page = { url: page.url, title: page.title, referrer: this.page.referrer };

    try {
      this.base = await loadVisitorFactBase(container.db, identity, now);
    } catch (error) {
      container.logger.error({ err: error }, 'could not load automation facts');
      return;
    }
    if (this.stopped) return;

    this.pageViews = Math.max(this.pageViews, this.base.pageViewCount);
    await this.evaluate('visitor_arrived');
    await this.scheduleTimeRules();
  }

  async onPage(page: { url: string; title: string | null }): Promise<void> {
    this.page = { url: page.url, title: page.title, referrer: this.page.referrer };
    this.pageViews += 1;
    await this.evaluate('page_viewed');
  }

  async onConversationStarted(): Promise<void> {
    await this.evaluate('conversation_started');
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /**
   * Arm a timer for every time rule that has not already come due.
   *
   * The delay is measured from when the session actually started, not from when this socket
   * connected - otherwise a visitor who reloads the page resets every clock and a thirty-second
   * rule never fires for anyone who navigates.
   */
  private async scheduleTimeRules(): Promise<void> {
    const { container, identity } = this.options;
    if (!this.base) return;

    let candidates;
    try {
      candidates = await container.automation.listCandidates(
        identity.accountId,
        identity.propertyId,
        'time_on_site',
      );
    } catch (error) {
      container.logger.error({ err: error }, 'could not read time-based triggers');
      return;
    }
    if (this.stopped) return;

    const elapsed = Math.floor(
      (container.clock.now().getTime() - this.base.sessionStartedAt.getTime()) / 1000,
    );

    // Distinct waits only: two rules due at the same second need one timer, and the evaluation it
    // runs considers both.
    const waits = [
      ...new Set(
        candidates.map((trigger) => trigger.afterSeconds - elapsed).filter((wait) => wait > -3_600),
      ),
    ]
      .sort((a, b) => a - b)
      .slice(0, MAX_PENDING_TIMERS);

    for (const wait of waits) {
      if (wait <= 0) {
        void this.evaluate('time_on_site');
        continue;
      }
      const timer = setTimeout(() => {
        void this.evaluate('time_on_site');
      }, wait * 1000);
      // Never hold the process open for a pending greeting during a shutdown.
      timer.unref();
      this.timers.push(timer);
    }
  }

  private async evaluate(
    event: 'visitor_arrived' | 'page_viewed' | 'time_on_site' | 'conversation_started',
  ): Promise<void> {
    const { container, identity, onFired } = this.options;
    if (this.stopped || !this.base) return;

    try {
      const agentsAvailable = await container.presence
        .hasAvailableAgent(identity.accountId)
        .catch(() => false);

      const facts = buildTriggerFacts({
        base: this.base,
        page: this.page,
        pageViewCount: this.pageViews,
        agentsAvailable,
        now: container.clock.now(),
      });

      const result = await container.automation.run(identity, event, facts, {
        agentDisplayName: await this.resolveBotName(),
      });
      if (result && !this.stopped) await onFired(result);
    } catch (error) {
      container.logger.error({ err: error, event }, 'trigger evaluation failed');
    }
  }

  /**
   * What a proactive message is signed with.
   *
   * The widget's own configured display name, so the visitor sees the same sender they would see
   * from a person on that site - not "SmartChat", and not a blank.
   */
  private async resolveBotName(): Promise<string | null> {
    if (this.botName !== undefined) return this.botName;
    const { container, identity } = this.options;
    try {
      const widget = await container.db.widget.findFirst({
        where: { accountId: identity.accountId, propertyId: identity.propertyId },
        select: { config: true },
      });
      this.botName = widget ? parseWidgetConfig(widget.config).content.agentDisplayName : null;
    } catch {
      this.botName = null;
    }
    return this.botName;
  }
}
