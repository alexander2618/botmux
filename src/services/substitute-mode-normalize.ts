import type { SubstituteModeConfig, SubstituteTarget, SubstituteAllowedSender } from '../bot-registry.js';

/**
 * Pure normalizer for a raw substituteMode object (from bots.json OR a dashboard
 * PUT body) into a `SubstituteModeConfig`. Shared by `bot-registry` (load path)
 * and `substitute-mode-store` (write path) so the two never drift.
 *
 * Rules:
 *  - Each target keeps openId / userId / unionId / email / name; a target with
 *    none of those is dropped.
 *  - `email` rides along as a label but never matches at runtime (mentions carry
 *    openId/userId/unionId, not email) — it is resolved to an openId at save
 *    time by `resolveSubstituteTargets`, so a persisted email-only target only
 *    happens for an entry that failed resolution.
 *  - ENABLING requires at least one matchable id (openId/userId/unionId);
 *    otherwise the ON state would be silently dead → return undefined so the
 *    caller can reject it.
 *  - A DISABLED config still persists its target list (as long as it has ≥1
 *    target), so the dashboard toggle can flip on/off without re-entering
 *    everyone. Only an empty disabled config collapses to undefined (delete).
 */
export function normalizeSubstituteMode(raw: unknown): SubstituteModeConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const targets = Array.isArray(rec.targets)
    ? rec.targets.flatMap((item): SubstituteTarget[] => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const src = item as Record<string, unknown>;
        const target: SubstituteTarget = {};
        if (typeof src.openId === 'string' && src.openId.trim()) target.openId = src.openId.trim();
        if (typeof src.userId === 'string' && src.userId.trim()) target.userId = src.userId.trim();
        if (typeof src.unionId === 'string' && src.unionId.trim()) target.unionId = src.unionId.trim();
        if (typeof src.email === 'string' && src.email.trim()) target.email = src.email.trim();
        if (typeof src.name === 'string' && src.name.trim()) target.name = src.name.trim();
        if (typeof src.avatarUrl === 'string' && src.avatarUrl.trim()) target.avatarUrl = src.avatarUrl.trim();
        return target.openId || target.userId || target.unionId || target.email ? [target] : [];
      })
    : [];
  if (targets.length === 0) return undefined;
  const enabled = rec.enabled === true;
  const hasMatchableTarget = targets.some(t => t.openId || t.userId || t.unionId);
  // Enabling with no matchable id is a dead ON state — reject (undefined).
  if (enabled && !hasMatchableTarget) return undefined;
  const chats = Array.isArray(rec.chats)
    ? [...new Set(rec.chats.map(String).map(s => s.trim()).filter(Boolean))]
    : [];
  const out: SubstituteModeConfig = {
    enabled,
    targets,
    disclosure: rec.disclosure === 'none' ? 'none' : 'prefix',
    // 话题群相关开关都是「显式 false 才关」——缺省（旧配置 / 旧客户端 PUT）落在开。
    topicGroups: rec.topicGroups !== false,
    topicActiveSessionTrigger: rec.topicActiveSessionTrigger !== false,
  };
  if (chats.length) out.chats = chats;
  const replyMode = rec.replyMode === 'quote' ? 'quote' : 'thread';
  if (replyMode === 'quote') out.replyMode = 'quote';
  if (rec.disableControlCard === true) out.disableControlCard = true;
  // 发送方策略：缺省 whitelist；只接受 'trustChat'，其余一律兜底回 whitelist。
  // whitelist 模式下空白名单 = 不放开（既有行为）；trustChat 的「必须 chats 非空」
  // 跨字段校验由 updateBotSubstituteMode 在保存层做（normalize 只管单字段形状）。
  out.senderPolicy = rec.senderPolicy === 'trustChat' ? 'trustChat' : 'whitelist';
  // allowedSenders：只保留 openId/unionId/name（sender 侧无 app_id）；两者皆空的条目丢弃。
  // 去重按 openId/unionId 任一非空键；trustChat 模式下也保留，方便来回切换不丢配置。
  const senders: SubstituteAllowedSender[] = [];
  if (Array.isArray(rec.allowedSenders)) {
    const seen = new Set<string>();
    for (const item of rec.allowedSenders) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const src = item as Record<string, unknown>;
      const openId = typeof src.openId === 'string' ? src.openId.trim() : '';
      const unionId = typeof src.unionId === 'string' ? src.unionId.trim() : '';
      if (!openId && !unionId) continue;
      const key = openId || unionId!;
      if (seen.has(key)) continue;
      seen.add(key);
      const s: SubstituteAllowedSender = {};
      if (openId) s.openId = openId;
      if (unionId) s.unionId = unionId;
      if (typeof src.name === 'string' && src.name.trim()) s.name = src.name.trim();
      senders.push(s);
    }
  }
  if (senders.length) out.allowedSenders = senders;
  return out;
}
