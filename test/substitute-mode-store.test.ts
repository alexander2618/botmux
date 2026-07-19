import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
    }
  }
  return { Client: FakeClient };
});

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/substitute-mode-store.js');
  return { registry, store };
}

describe('substitute-mode store', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-substitute-mode-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.BOTS_CONFIG;
  });

  function writeConfig(entry: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_default',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      ...entry,
    }], null, 2), 'utf-8');
  }

  function readConfig(): any {
    return JSON.parse(readFileSync(configPath, 'utf-8'))[0];
  }

  it('persists substituteMode and syncs in-memory config', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      disclosure: 'none',
      targets: [
        { userId: 'u_alice', name: 'Alice' },
        { openId: 'ou_bob', email: 'bob@example.com' },
      ],
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.substituteMode).toEqual({
        enabled: true,
        disclosure: 'none',
        topicGroups: true,
        topicActiveSessionTrigger: true,
        senderPolicy: 'whitelist',
        targets: [
          { userId: 'u_alice', name: 'Alice' },
          { openId: 'ou_bob', email: 'bob@example.com' },
        ],
      });
    }
    expect(readConfig().substituteMode).toEqual(registry.getBot('app_default').config.substituteMode);
  });

  it('persists a disabled config with its targets and reloads it', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: false,
      targets: [{ openId: 'ou_bob', name: 'Bob' }],
    });
    expect(r).toEqual({
      ok: true,
      substituteMode: { enabled: false, disclosure: 'prefix', topicGroups: true, topicActiveSessionTrigger: true, senderPolicy: 'whitelist', targets: [{ openId: 'ou_bob', name: 'Bob' }] },
    });
    expect(readConfig().substituteMode.enabled).toBe(false);

    // Loader keeps the disabled config (so the dashboard toggle can flip on
    // without re-entering the list) instead of dropping it.
    const reloaded = await freshModules();
    reloaded.registry.loadBotConfigs().forEach(c => reloaded.registry.registerBot(c));
    expect(reloaded.registry.getBot('app_default').config.substituteMode).toEqual({
      enabled: false,
      disclosure: 'prefix',
      topicGroups: true,
      topicActiveSessionTrigger: true,
      senderPolicy: 'whitelist',
      targets: [{ openId: 'ou_bob', name: 'Bob' }],
    });
  });

  it('turns substituteMode off by deleting the key', async () => {
    writeConfig({
      substituteMode: {
        enabled: true,
        targets: [{ userId: 'u_alice', name: 'Alice' }],
      },
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', { enabled: false, targets: [] });

    expect(r).toEqual({ ok: true, substituteMode: null });
    expect(readConfig().substituteMode).toBeUndefined();
    expect(registry.getBot('app_default').config.substituteMode).toBeUndefined();
  });

  it('persists and normalizes allowed chat whitelist', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      disclosure: 'prefix',
      targets: [{ openId: 'ou_alice', name: 'Alice' }],
      chats: ['oc_a', ' oc_b ', '', 'oc_a'],
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.substituteMode).toMatchObject({
        enabled: true,
        disclosure: 'prefix',
        targets: [{ openId: 'ou_alice', name: 'Alice' }],
        chats: ['oc_a', 'oc_b'],
      });
    }
    expect(registry.getBot('app_default').config.substituteMode?.chats).toEqual(['oc_a', 'oc_b']);
    expect(readConfig().substituteMode.chats).toEqual(['oc_a', 'oc_b']);
  });

  it('rejects enabled mode without a matchable target', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // name-only → not even stored → rejected.
    expect(await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ name: 'No id' }],
    })).toEqual({ ok: false, reason: 'targets_required' });

    // email-only target set → rejected (targets_required), nothing persisted.
    // email is preserved only when it rides alongside a matchable id
    // (openId/userId/unionId); on its own it never matches at runtime, so it
    // must not be able to enable a silently-dead mode.
    expect(await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ email: 'ghost@example.com', name: 'Email only' }],
    })).toEqual({ ok: false, reason: 'targets_required' });

    expect(readConfig().substituteMode).toBeUndefined();
  });

  it('话题群开关：显式 false 才关，缺省/其它值一律落回开', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // 显式关：持久化并在重载后保持 false。
    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ openId: 'ou_bob', name: 'Bob' }],
      topicGroups: false,
      topicActiveSessionTrigger: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.substituteMode?.topicGroups).toBe(false);
      expect(r.substituteMode?.topicActiveSessionTrigger).toBe(false);
    }
    const reloaded = await freshModules();
    reloaded.registry.loadBotConfigs().forEach(c => reloaded.registry.registerBot(c));
    expect(reloaded.registry.getBot('app_default').config.substituteMode).toMatchObject({
      topicGroups: false,
      topicActiveSessionTrigger: false,
    });

    // 旧客户端 PUT（不带字段）→ 缺省开，不残留旧 false。
    const r2 = await reloaded.store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ openId: 'ou_bob', name: 'Bob' }],
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.substituteMode?.topicGroups).toBe(true);
      expect(r2.substituteMode?.topicActiveSessionTrigger).toBe(true);
    }
  });

  it('trustChat 模式 + 空 chats 被拒收（避免任意应用在所有群触发）', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ openId: 'ou_bob', name: 'Bob' }],
      senderPolicy: 'trustChat',
      // chats 缺省 → 空
    });
    expect(r).toEqual({ ok: false, reason: 'trustchat_requires_chats' });
    expect(readConfig().substituteMode).toBeUndefined();
  });

  it('trustChat + 非空 chats 通过并持久化', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ openId: 'ou_bob', name: 'Bob' }],
      senderPolicy: 'trustChat',
      chats: ['oc_trusted'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.substituteMode).toMatchObject({ senderPolicy: 'trustChat', chats: ['oc_trusted'] });
    }
    expect(readConfig().substituteMode.senderPolicy).toBe('trustChat');
  });

  it('allowedSenders 往返：归一化、去重、持久化、重载', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ openId: 'ou_bob', name: 'Bob' }],
      senderPolicy: 'whitelist',
      allowedSenders: [
        { openId: 'ou_wh1', name: 'webhook A' },
        { openId: 'ou_wh1' },        // dup → dropped
        { unionId: 'u_wh2' },
        { openId: ' ' },              // empty → dropped
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.substituteMode?.allowedSenders).toEqual([
        { openId: 'ou_wh1', name: 'webhook A' },
        { unionId: 'u_wh2' },
      ]);
      expect(r.substituteMode?.senderPolicy).toBe('whitelist');
    }
    expect(readConfig().substituteMode.allowedSenders).toEqual([
      { openId: 'ou_wh1', name: 'webhook A' },
      { unionId: 'u_wh2' },
    ]);

    // 重载后保留。
    const reloaded = await freshModules();
    reloaded.registry.loadBotConfigs().forEach(c => reloaded.registry.registerBot(c));
    const cfg = reloaded.registry.getBot('app_default').config.substituteMode;
    expect(cfg?.allowedSenders).toEqual([
      { openId: 'ou_wh1', name: 'webhook A' },
      { unionId: 'u_wh2' },
    ]);
  });

  it('cascadeConflictWarning: 同 chat 重叠的其它 bot 命中告警', async () => {
    writeConfig({
      // 预置一个已注册的「其它 bot」也在 oc_shared 开替身
      // （本测试用 writeConfig 只写一个 app_default，这里靠 store 给同 bot
      // 设配置后改 appId 模拟第二个 bot——简化：直接注册两个 bot）。
    });
    // 写两个 bot 的配置文件
    writeFileSync(configPath, JSON.stringify([
      { larkAppId: 'app_default', larkAppSecret: 's', cliId: 'claude-code' },
      { larkAppId: 'app_other', larkAppSecret: 's', cliId: 'claude-code',
        displayName: 'OtherBot',
        substituteMode: {
          enabled: true,
          targets: [{ openId: 'ou_bob' }],
          chats: ['oc_shared'],
          senderPolicy: 'whitelist',
        } },
    ], null, 2), 'utf-8');
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // app_default 也开替身、chats 含 oc_shared → 与 app_other 重叠
    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ openId: 'ou_bob' }],
      chats: ['oc_shared', 'oc_mine'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const warn = store.cascadeConflictWarning('app_default', r.substituteMode);
      expect(warn).toBeTruthy();
      expect(warn).toContain('OtherBot');
    }
  });

  it('cascadeConflictWarning: 无重叠 / 自身 disabled 时返回 null', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ openId: 'ou_bob' }],
      chats: ['oc_only_mine'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(store.cascadeConflictWarning('app_default', r.substituteMode)).toBeNull();
      expect(store.cascadeConflictWarning('app_default', null)).toBeNull();
    }
  });
});
