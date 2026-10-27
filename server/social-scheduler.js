import { autoScheduleWarehousePosts } from "./social.js";

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
      if (post.status !== "scheduled" || !post.scheduledAt || this.running.has(post.id)) return false;
      if (post.automationNextAttemptAt && Date.parse(post.automationNextAttemptAt) > current) return false;
      return Date.parse(post.scheduledAt) <= current;
    });
  }

  process(post) {
    if (this.closed || this.running.has(post.id)) return null;
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
        const attempts = Number(current.automationAttempts || 0) + 1;
        Object.assign(current, {
          automationStatus: "meta_error",
          automationError: result.firstCommentError || "First comment failed.",
          automationAttempts: attempts,
          automationNextAttemptAt: new Date(this.now() + Math.min(15 * 60_000, 30_000 * attempts)).toISOString(),
          updatedAt: new Date().toISOString(),
        });
        this.store.save();
      }
    } catch (error) {
      const current = this.store.state.socialPosts.find((item) => item.id === post.id);
      if (current) {
        const attempts = Number(current.automationAttempts || 0) + 1;
        Object.assign(current, {
          automationStatus: "meta_error",
          automationError: String(error?.message || error),
          automationAttempts: attempts,
          automationNextAttemptAt: new Date(this.now() + Math.min(30 * 60_000, 30_000 * attempts)).toISOString(),
          updatedAt: new Date().toISOString(),
        });
        this.store.save();
      }
    } finally {
      this.running.delete(post.id);
    }
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
