import { autoScheduleWarehousePosts } from "./social.js";
import { automaticPostRetry } from "./meta-errors.js";
import { publishedVideo, returnPostToWarehouse } from './post-lifecycle.js';

export class SocialScheduler {
  constructor(store, publishReel, { intervalMs = 15_000, now = Date.now } = {}) {
    this.store = store;
    this.publishReel = publishReel;
    this.now = now;
    this.running = new Set();
    this.pending = new Set();
    this.closed = false;
    this.timer = intervalMs > 0 ? setInterval(() => this.tick(), intervalMs) : null;
    this.timer?.unref();
    this.tick();
  }

  duePosts() {
    const current = this.now();
    return (this.store.state.socialPosts || []).filter((post) => {
      if (post.status !== "scheduled" || !post.scheduledAt || this.running.has(post.id) || post.automationRetryBlocked || post.deletedAt || post.archivedAt) return false;
      // Upgrade old queued errors without sending another request to Meta.
      if (post.automationError) {
        const error = { message: post.automationError, metaError: post.automationErrorDetails };
        const decision = automaticPostRetry(error, Number(post.automationAttempts || 0), current);
        if (decision.blocked) {
          this.recordFailure(post, error, false);
          return false;
        }
      }
      if (post.automationNextAttemptAt && Date.parse(post.automationNextAttemptAt) > current) return false;
      return Date.parse(post.scheduledAt) <= current;
    });
  }

  process(post) {
    if (this.closed || this.running.has(post.id) || post.automationRetryBlocked || post.deletedAt || post.archivedAt) return null;
    this.running.add(post.id);
    const task = this.processPost(post);
    this.pending.add(task);
    task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }

  async processPost(post) {
    const key = `schedule:${post.id}:${post.revision}`;
    try {
      if (this.store.state.socialPosts.some((item) => item.id === post.id)) {
        Object.assign(post, { automationStatus: "publishing", automationError: null, updatedAt: new Date().toISOString() });
        this.store.save();
      }
      const result = await this.publishReel({ postId: post.id, idempotencyKey: key });
      const current = this.store.state.socialPosts.find((item) => item.id === post.id);
      if (!current) return;
      if (result?.status === "published_comment_error") {
        this.recordFailure(current, { message: result.firstCommentError || "First comment failed.", metaError: result.firstCommentErrorDetails }, true, false);
      }
    } catch (error) {
      const current = this.store.state.socialPosts.find((item) => item.id === post.id);
      if (current) {
        this.recordFailure(current, error);
      }
    } finally {
      this.running.delete(post.id);
    }
  }

  recordFailure(post, error, increment = true, allowWarehouseReturn = true) {
    const attempts = Number(post.automationAttempts || 0) + (increment ? 1 : 0);
    const decision = automaticPostRetry(error, attempts, this.now());
    Object.assign(post, {
      automationStatus: "meta_error",
      automationError: String(error?.message || error),
      automationErrorDetails: decision.details,
      automationAttempts: attempts,
      automationRetryBlocked: decision.blocked,
      automationBlockedReason: decision.reason,
      automationNextAttemptAt: decision.nextAttemptAt,
      updatedAt: new Date(this.now()).toISOString(),
    });
    if (decision.blocked && allowWarehouseReturn && !publishedVideo(this.store, post)) returnPostToWarehouse(this.store, post, { automatic:true, at:new Date(this.now()).toISOString() });
    this.store.save();
  }

  async tick() {
    if (this.closed) return;
    for (const group of this.store.state.settings?.meta?.pageGroups || []) {
      try {
        autoScheduleWarehousePosts(this.store, group.id, {
          tokenGroupId: group.scheduleConfig?.tokenGroupId || "",
        });
      } catch {
        // A group with incomplete Page/token mapping remains visible in the
        // workspace and can be fixed there; it must not stop other groups.
      }
    }
    await Promise.all(this.duePosts().map((post) => this.process(post)));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.pending]);
  }
}
