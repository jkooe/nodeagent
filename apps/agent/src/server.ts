import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  Methods,
  PROTOCOL_VERSION,
  ipInAllowlist,
  generateNonce,
  verifyHmac,
  verifyNonce,
  authorize,
  authorizedCapabilities,
  ipAllowed,
  inTimeWindow,
  rateLimitFor,
  normalizeIp,
  ErrorCodes,
  ErrorNames,
  makeError,
  CapabilityError,
  CAPABILITY_MANIFEST,
  findCapability,
  validate,
  applyDefaults,
  type RpcRequest,
  type HelloParams,
  type AuthParams,
  type InvokeParams,
} from '@nodeagent/protocol';
import { buildInfo } from './capabilities/system.js';
import { createCapabilityRegistry } from './capabilities/index.js';
import { audit, describeArgs } from './audit.js';
import { disposeWatchesByOwner, watchCount } from './events.js';
import { runningTaskCount } from './capabilities/task.js';
import type { AgentConfig } from './config.js';
import type { TlsMaterial } from './certs.js';

const NONCE_TTL_MS = 30_000;

interface ConnState {
  authenticated: boolean;
  nonce: string | null;
  nonceExpiresAt: number;
  clientId: string | null;
  /** ed25519 模式：本次调用方被授权的能力清单；psk 模式为 null（不限制） */
  authorized: string[] | null;
  /** 来源地址（审计用） */
  remote: string;
  /** v12：连接标识，用于清理该连接创建的事件订阅 */
  connId: string;
  /** v2.0.0：末次活跃时间（任何入站消息），空闲断开的依据 */
  lastActiveAt: number;
}

export interface AgentServer {
  close(): Promise<void>;
  url: string;
}

type LogLevel = 'debug' | 'info' | 'warn';

/** 创建并启动被控端 WebSocket 服务。 */
/** 连接级 RPC 处理 —— 监听模式与 Hub 模式共用同一套鉴权 / ACL / 能力分发。 */
export interface AgentCore {
  /** 在给定连接上提供被控端服务（连接已建立）。 */
  attach(ws: WebSocket, remote: string): void;
  /** v2.0.0：该来源封禁剩余毫秒（0 = 不挡）。连接入口在业务握手前调用。 */
  banRemainingMs(remote: string): number;
  /** v2.0.0：连接表（并发上限 / 空闲清扫判据；key 为 WebSocket）。 */
  states: Map<WebSocket, ConnState>;
}

export function createAgentCore(cfg: AgentConfig): AgentCore {
  const capabilityRegistry = createCapabilityRegistry(cfg);
  /** v3：本次实例采用的认证模式（psk 向后兼容 / ed25519 零信任） */
  const authMode: 'psk' | 'ed25519' = cfg.auth_mode === 'ed25519' ? 'ed25519' : 'psk';
  /**
   * ACL 策略归一化。
   *
   * ⚠️ A-01（真机实测，P0）：`clients` 必须在**这里**补齐成数组。
   *    原实现只写 `cfg.acl ?? {…, clients: []}` —— 当用户配置 `{"acl":{"default_effect":"deny"}}`
   *    （很自然的写法，省略空的 clients）时，`cfg.acl` 非空 → `??` 不兜底 →
   *    `aclPolicy.clients` 为 `undefined` → 后面无条件执行 `.find()` → **每次 invoke 都崩掉被控端进程**。
   */
  const aclPolicy = {
    default_effect: cfg.acl?.default_effect === 'allow' ? ('allow' as const) : ('deny' as const),
    clients: Array.isArray(cfg.acl?.clients) ? cfg.acl.clients : [],
  };
  /**
   * 只要**配置了 ACL 对象**就启用能力级授权（无论 psk 还是 ed25519）。
   *
   * ⚠️ A-02（真机实测，P1）：判据必须是「对象是否存在」，**不能**用 `clients.length`。
   *    原实现 `Boolean(cfg.acl?.clients?.length)` 在 `{"acl":{"default_effect":"deny","clients":[]}}`
   *    时得到 `false` → 整段 ACL 校验被跳过 → **fail-open 全放行**（配置写着默认拒绝却全通）。
   *    空 clients 的正确语义是「没有任何调用方被授权」，即拒绝一切（由 default_effect 决定）。
   */
  const hasAcl = Boolean(cfg.acl);

  /** 按调用方的滑动窗口限速（每分钟）。 */
  const rateBuckets = new Map<string, number[]>();
  function allowByRate(clientId: string, limitPerMin?: number, bucket?: string): boolean {
    if (!limitPerMin || limitPerMin <= 0) return true;
    const key = bucket ? `${clientId}|${bucket}` : clientId;
    const now = Date.now();
    const recent = (rateBuckets.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limitPerMin) {
      rateBuckets.set(key, recent);
      return false;
    }
    recent.push(now);
    rateBuckets.set(key, recent);
    return true;
  }
  const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2 };
  const log = (level: LogLevel, msg: string): void => {
    if (levelOrder[level] >= levelOrder[cfg.log_level]) {
      console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
    }
  };

  // v2.0.0：用 Map 而非 WeakMap —— 连接层需要 size（并发上限）与遍历（空闲清扫）。
  // 代价是必须手动清理：close 时 delete，否则断开的连接会一直留在表里。
  const states = new Map<WebSocket, ConnState>();

  const send = (ws: WebSocket, msg: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const sendResult = (ws: WebSocket, id: string, result: unknown): void =>
    send(ws, { jsonrpc: '2.0', id, result });
  const sendError = (ws: WebSocket, id: string | null, code: number, message: string, data?: unknown): void =>
    send(ws, { jsonrpc: '2.0', id, error: makeError(code, message, data) });

  function handleHello(ws: WebSocket, state: ConnState, req: RpcRequest): void {
    const params = req.params as HelloParams | undefined;
    // ⚠️ B-01（真机实测，P1）：`protocol` 必须先做**类型**校验再 `.split()`。
    //    原实现 `params?.protocol ?? ''` 对 `protocol: 123` 得到数字 → `proto.split` 抛
    //    TypeError → 未捕获的 rejection → Node ≥22 直接终止被控端进程（**免认证即可打崩**）。
    const rawProto = params?.protocol;
    if (typeof rawProto !== 'string' || rawProto === '') {
      log('warn', `握手失败：protocol 非法（${typeof rawProto}）`);
      audit({
        type: 'request.rejected',
        remote: state.remote,
        status: 'denied',
        reason: `hello.protocol 类型非法: ${typeof rawProto}`,
      });
      sendError(ws, req.id, ErrorCodes.PARAM_INVALID, 'hello 的 protocol 必须是形如 "1.0" 的字符串', {
        got: typeof rawProto,
      });
      return;
    }
    const proto = rawProto;
    if (proto.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) {
      audit({
        type: 'request.rejected',
        remote: state.remote,
        status: 'denied',
        reason: `协议版本不兼容: 客户端 ${proto}`,
      });
      sendError(ws, req.id, ErrorCodes.PROTOCOL_MISMATCH, `协议版本不兼容: 客户端 ${proto}，服务端 ${PROTOCOL_VERSION}`);
      return;
    }
    state.nonce = generateNonce();
    state.nonceExpiresAt = Date.now() + NONCE_TTL_MS;
    state.clientId = typeof params?.client_id === 'string' ? params.client_id : null;
    // 新一轮握手开始：清除上一轮的认证态与授权
    // （Hub 模式下同一连接会被不同控制端先后复用，必须重置，否则存在越权风险）
    state.authenticated = false;
    state.authorized = null;
    sendResult(ws, req.id, { nonce: state.nonce, expires_at: state.nonceExpiresAt });
  }

  function handleAuth(ws: WebSocket, state: ConnState, req: RpcRequest): void {
    const params = req.params as AuthParams | undefined;
    const failOut = (msg: string, hint?: string): void => {
      const ban = recordAuthFailure(state.remote);
      audit({ type: 'auth.failure', client_id: params?.client_id ?? '?', remote: state.remote, reason: msg });
      sendError(ws, req.id, ErrorCodes.AUTH_FAILED, msg, {
        ...(hint ? { hint } : {}),
        ...(ban.banned ? { retry_after_ms: ban.waitMs } : {}),
      });
      // 稍作延迟再关闭，确保错误响应先送达控制端
      setTimeout(() => ws.close(), 100);
    };

    if (!state.nonce || Date.now() > state.nonceExpiresAt) {
      log('warn', '握手失败：挑战已过期');
      failOut('挑战已过期，请重新握手');
      return;
    }
    // ⚠️ B-02（真机实测，P1）：nonce / hmac / signature 都要先做类型校验。
    //    `params?.nonce !== state.nonce` 对数字、对象等都只会走「不匹配」分支 —— 这步安全；
    //    真正致命的是下一段：把 `hmac:1` 交给 `verifyHmac` → `Buffer.from(1, 'hex')` 抛
    //    `ERR_INVALID_ARG_TYPE` → 未捕获 rejection → 进程终止（免认证即可打崩）。
    if (params?.nonce !== state.nonce) {
      log('warn', '握手失败：nonce 不匹配');
      failOut('nonce 不匹配', '请用 hello 返回的 nonce 计算签名');
      return;
    }
    const clientId = typeof params.client_id === 'string' ? params.client_id : '?';
    let authorized: string[] | null = null;
    let keyKindUsed = 'ed25519';

    if (authMode === 'ed25519') {
      const client = aclPolicy.clients.find((c) => c.client_id === clientId);
      if (!client?.pubkey) {
        log('warn', `鉴权失败（调用方未注册）client_id=${clientId}`);
        failOut(`调用方未在 ACL 中注册: ${clientId}`, '在被控端 acl.clients 中加入该 client_id 与公钥');
        return;
      }
      if (!verifyNonce(client.pubkey, state.nonce, typeof params.signature === 'string' ? params.signature : '')) {
        log('warn', `鉴权失败（Ed25519 验签不通过）client_id=${clientId}`);
        failOut('Ed25519 签名校验失败', '确认用的是该 client_id 对应的私钥');
        return;
      }
      authorized = authorizedCapabilities(
        aclPolicy,
        clientId,
        CAPABILITY_MANIFEST.map((c) => c.name),
      );
    } else {
      // v22：优先用「该 client_id 专属的钥匙」，未登记才回落到共享 key。
      // 这样「知道 key A」就只能以 A 的身份进来 —— ACL 的身份维度在 psk 模式下才有意义。
      //
      // ⚠️ B-03（真机实测，P1）：必须用 **own-property** 判断，不能直接 `cfg.keys?.[clientId]`。
      //    `client_id:"constructor"` 会沿原型链取到 `Object.prototype.constructor`（一个函数）
      //    并被当作 HMAC 密钥 → `Buffer.from(function…)` 抛错 → 进程终止。
      const hasScopedKey = Boolean(cfg.keys && Object.prototype.hasOwnProperty.call(cfg.keys, clientId));
      const scopedKey = hasScopedKey ? cfg.keys![clientId] : undefined;
      const keyForClient = scopedKey ?? cfg.key;
      const keyKind = scopedKey ? 'scoped' : cfg.keys ? 'shared-fallback' : 'shared';
      // ⚠️ B-02：hmac 同样要做类型校验 + verifyHmac 自身不得把异常泄漏到顶层
      const hmac = typeof params.hmac === 'string' ? params.hmac : '';
      let hmacOk = false;
      try {
        hmacOk = Boolean(keyForClient) && hmac !== '' && verifyHmac(keyForClient as string, state.nonce, hmac);
      } catch (err) {
        log('warn', `鉴权失败（HMAC 计算异常）：${err instanceof Error ? err.message : String(err)}`);
        hmacOk = false;
      }
      if (!hmacOk) {
        log('warn', `鉴权失败 client_id=${clientId} key=${keyKind}`);
        failOut('预共享密钥校验失败', scopedKey
          ? '该 client_id 有专属密钥，需用那把 key'
          : '用错了 key，或该 client_id 应登记到 keys{}');
        return;
      }
      keyKindUsed = keyKind;
    }

    state.nonce = null; // 一次性，用后即废
    state.nonceExpiresAt = 0;
    recordAuthSuccess(state.remote); // v2.0.0：握手成功即清零失败计数（避免误伤手滑的控制端）
    state.authenticated = true;
    state.clientId = clientId;
    state.authorized = authorized;
    log(
      'info',
      `鉴权通过 client_id=${clientId} mode=${authMode} key=${keyKindUsed}` +
        (authorized ? `，授权 ${authorized.length}/${CAPABILITY_MANIFEST.length} 项能力` : ''),
    );
    audit({
      type: 'auth.success',
      client_id: clientId,
      remote: state.remote,
      reason: `mode=${authMode}` + (authorized ? `, authorized=${authorized.length}` : ''),
    });
    const bi = buildInfo();
    sendResult(ws, req.id, {
      capabilities: CAPABILITY_MANIFEST,
      authorized,
      auth_mode: authMode,
      // v20：把版本/构建信息交给控制端，便于做新旧兼容提示
      agent_version: bi.version,
      build: { hash: bi.hash, commit: bi.commit, built_at: bi.built_at },
      protocol: PROTOCOL_VERSION,
    });
  }

  async function handleInvoke(ws: WebSocket, state: ConnState, req: RpcRequest): Promise<void> {
    if (!state.authenticated) {
      audit({
        type: 'request.rejected',
        remote: state.remote,
        status: 'denied',
        reason: '未完成认证即调用能力',
      });
      sendError(ws, req.id, ErrorCodes.AUTH_REQUIRED, '未完成认证，请先握手');
      return;
    }
    const params = req.params as InvokeParams | undefined;
    const name = typeof params?.capability === 'string' ? params.capability : '';

    // 能力级 ACL：只要被控端配置了 ACL 即执行（deny 优先 → allow → 默认拒绝）。
    // 注：psk 模式下 client_id 由客户端自报，此为「配置级约束」；对抗恶意调用方仍需 ed25519 绑定身份。
    if (hasAcl) {
      const authz = authorize(aclPolicy, state.clientId ?? '', name);
      if (!authz.allowed) {
        log('warn', `ACL 拒绝 client_id=${state.clientId} capability=${name} — ${authz.reason}`);
        audit({
          type: 'acl.denied',
          client_id: state.clientId ?? undefined,
          remote: state.remote,
          capability: name,
          status: 'denied',
          reason: authz.reason,
        });
        sendError(ws, req.id, ErrorCodes.ACL_DENIED, `无权限调用 ${name}`, {
          capability: name,
          client_id: state.clientId,
          reason: authz.reason,
          matched: authz.matched,
          pattern: authz.pattern,
        });
        return;
      }
    }

    // v3+：按调用方滑动窗口限速（ACL 的 rate_limits 按能力覆盖，未命中回退 max_calls_per_min）
    // 注：aclPolicy.clients 已在 createAgentCore 里归一成数组（A-01），这里取不到就是 undefined。
    const clientRule = aclPolicy.clients.find((c) => c.client_id === state.clientId);

    // v11：来源 IP 白/黑名单 + 生效时段（仅在已配置该 client 规则时生效）
    if (hasAcl && clientRule) {
      const remoteIp = normalizeIp(state.remote);
      const ipCheck = ipAllowed(clientRule, remoteIp);
      if (!ipCheck.allowed) {
        log('warn', `IP 拒绝 client_id=${state.clientId} remote=${remoteIp} — ${ipCheck.reason}`);
        audit({
          type: 'acl.denied',
          client_id: state.clientId ?? undefined,
          remote: state.remote,
          capability: name,
          status: 'denied',
          reason: ipCheck.reason,
        });
        sendError(ws, req.id, ErrorCodes.ACL_DENIED, '来源 IP 不被允许', {
          capability: name,
          remote: remoteIp,
          reason: ipCheck.reason,
        });
        return;
      }
      const twCheck = inTimeWindow(clientRule.allow_window, new Date());
      if (!twCheck.allowed) {
        log('warn', `时段拒绝 client_id=${state.clientId} — ${twCheck.reason}`);
        audit({
          type: 'acl.denied',
          client_id: state.clientId ?? undefined,
          remote: state.remote,
          capability: name,
          status: 'denied',
          reason: twCheck.reason,
        });
        sendError(ws, req.id, ErrorCodes.ACL_DENIED, '当前不在允许的生效时段', {
          capability: name,
          reason: twCheck.reason,
        });
        return;
      }
    }

    const rateLimit = clientRule ? rateLimitFor(clientRule, name) : undefined;
    if (!allowByRate(state.clientId ?? '', rateLimit, String(rateLimit ?? ''))) {
      log('warn', `限速拒绝 client_id=${state.clientId} capability=${name}`);
      audit({
        type: 'rate.limited',
        client_id: state.clientId ?? undefined,
        remote: state.remote,
        capability: name,
        status: 'denied',
        reason: `超过 ${rateLimit}/分钟（能力 ${name}）`,
      });
      sendError(ws, req.id, ErrorCodes.RATE_LIMITED, `调用频率超限（${name} 上限 ${rateLimit}/分钟）`, {
        capability: name,
        limit_per_min: rateLimit,
      });
      return;
    }

    const cap = findCapability(name);
    const handler = capabilityRegistry[name];
    if (!cap || !handler) {
      audit({
        type: 'request.rejected',
        client_id: state.clientId ?? undefined,
        remote: state.remote,
        capability: name,
        status: 'denied',
        reason: `不支持的能力: ${name}`,
      });
      sendError(ws, req.id, ErrorCodes.CAPABILITY_NOT_FOUND, `不支持的能力: ${name}`, { capability: name });
      return;
    }

    const args = (params?.args ?? {}) as Record<string, unknown>;
    const errors = validate(args, cap.params_schema);
    if (errors.length > 0) {
      // ⚠️ U-01：拒绝必须留痕（探测行为若不留审计，事后无法复盘被谁、用什么参数试过）
      audit({
        type: 'request.rejected',
        client_id: state.clientId ?? undefined,
        remote: state.remote,
        capability: name,
        status: 'denied',
        reason: `参数校验失败: ${errors.slice(0, 3).join('; ')}`,
      });
      sendError(ws, req.id, ErrorCodes.PARAM_INVALID, '参数校验失败', { errors });
      return;
    }

    const finalArgs = applyDefaults(args, cap.params_schema);
    const started = Date.now();
    const argsInfo = describeArgs(finalArgs);
    try {
      // v12：把连接上下文交给能力处理器（事件订阅需要「谁订阅的」与「往哪推」）
      const data = await handler(finalArgs, {
        owner: state.connId,
        clientId: state.clientId ?? '',
        emit: (evt: unknown) => send(ws, { jsonrpc: '2.0', method: 'event', params: evt }),
      });
      const duration = Date.now() - started;
      log('info', `invoke ${name} → ok (${duration}ms)`);
      audit({
        type: 'invoke',
        client_id: state.clientId ?? undefined,
        remote: state.remote,
        capability: name,
        status: 'ok',
        duration_ms: duration,
        ...argsInfo,
      });
      sendResult(ws, req.id, { status: 'ok', data });
    } catch (err) {
      const duration = Date.now() - started;
      const isBiz = err instanceof CapabilityError;
      const errName = isBiz ? err.name : ErrorNames[ErrorCodes.EXECUTION_FAILED];
      const errMsg = err instanceof Error ? err.message : String(err);
      log('warn', `invoke ${name} → ${isBiz ? 'failed' : 'execution failed'}: ${errMsg}`);
      audit({
        type: 'invoke',
        client_id: state.clientId ?? undefined,
        remote: state.remote,
        capability: name,
        status: 'failed',
        duration_ms: duration,
        error: errName,
        ...argsInfo,
      });
      sendResult(ws, req.id, {
        status: 'failed',
        error: {
          name: errName,
          message: errMsg,
          ...(isBiz && (err as CapabilityError).data !== undefined ? { data: (err as CapabilityError).data } : {}),
        },
      });
    }
  }

  async function handleMessage(ws: WebSocket, text: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(text) as RpcRequest;
    } catch {
      audit({ type: 'request.rejected', remote: states.get(ws)?.remote, status: 'denied', reason: '无法解析 JSON' });
      sendError(ws, null, ErrorCodes.PARSE_ERROR, '无法解析 JSON');
      return;
    }
    if (req?.jsonrpc !== '2.0' || typeof req.id !== 'string' || typeof req.method !== 'string') {
      // 信封非法：可能是扫描器/协议错误，也留一条痕（原实现完全静默）
      audit({
        type: 'request.rejected',
        remote: states.get(ws)?.remote,
        status: 'denied',
        reason: `请求信封无效（jsonrpc=${typeof req?.jsonrpc} id=${typeof req?.id} method=${typeof req?.method}）`,
      });
      sendError(ws, typeof req?.id === 'string' ? req.id : null, ErrorCodes.INVALID_REQUEST, '请求信封无效');
      return;
    }
    const state = states.get(ws);
    if (!state) return;

    switch (req.method) {
      case Methods.Hello:
        handleHello(ws, state, req);
        return;
      case Methods.Auth:
        handleAuth(ws, state, req);
        return;
      case Methods.Invoke:
        await handleInvoke(ws, state, req);
        return;
      case Methods.Capabilities:
        if (!state.authenticated) {
          audit({
            type: 'request.rejected',
            remote: state.remote,
            status: 'denied',
            reason: '未认证即拉取能力清单',
          });
          sendError(ws, req.id, ErrorCodes.AUTH_REQUIRED, '未完成认证');
          return;
        }
        sendResult(ws, req.id, { capabilities: CAPABILITY_MANIFEST });
        return;
      case Methods.Ping:
        sendResult(ws, req.id, { pong: true, ts: Date.now() });
        return;
      default:
        audit({
          type: 'request.rejected',
          client_id: state.clientId ?? undefined,
          remote: state.remote,
          status: 'denied',
          reason: `未知方法: ${req.method}`,
        });
        sendError(ws, req.id, ErrorCodes.METHOD_NOT_FOUND, `未知方法: ${req.method}`);
    }
  }

  // ---------- v2.0.0 连接层防护：握手失败封禁 ----------
  // 状态放在 core：handleAuth 在此函数内，且 server 侧连接入口也要查它。
  interface BanState { fails: number; bannedUntil: number }
  const authBan = new Map<string, BanState>();
  const banMax = Math.max(1, cfg.security?.auth_ban?.max_attempts ?? 5);
  const banBaseMs = Math.max(1000, cfg.security?.auth_ban?.ban_ms ?? 600_000);
  const banWhitelist = (cfg.security?.auth_ban?.whitelist ?? []).map((x) => x.trim()).filter(Boolean);

  /** 归一化来源 IP：剥离 IPv4-mapped 前缀（::ffff:1.2.3.4 → 1.2.3.4），否则同一来源会被当成两个键。 */
  const normIp = (addr: string): string => addr.replace(/^::ffff:/i, '');

  /** 该来源还有多久解封（0 = 不在封禁期）。白名单来源永不封禁。 */
  function banRemainingMs(remote: string): number {
    const ip = normIp(remote);
    if (banWhitelist.includes(ip)) return 0;
    const st = authBan.get(ip);
    if (!st) return 0;
    const left = st.bannedUntil - Date.now();
    return left > 0 ? left : 0; // 已过期则不挡（计数保留，继续指数退避）
  }

  /** 记录一次握手失败；返回本次是否**新触发**封禁（好让错误响应带上 retry_after_ms）。 */
  function recordAuthFailure(remote: string): { banned: boolean; waitMs: number } {
    const ip = normIp(remote);
    if (banWhitelist.includes(ip)) return { banned: false, waitMs: 0 };
    const prev = authBan.get(ip) ?? { fails: 0, bannedUntil: 0 };
    const fails = prev.fails + 1;
    if (fails < banMax) {
      authBan.set(ip, { fails, bannedUntil: 0 });
      return { banned: false, waitMs: 0 };
    }
    // 第 N 次失败起：ban = base × 2^(N - max)，封顶 24h
    const power = Math.min(10, fails - banMax);
    const waitMs = Math.min(86_400_000, banBaseMs * 2 ** power);
    authBan.set(ip, { fails, bannedUntil: Date.now() + waitMs });
    return { banned: true, waitMs };
  }

  function recordAuthSuccess(remote: string): void {
    const ip = normIp(remote);
    if (authBan.delete(ip)) log('info', `握手失败计数已清零（来源 ${ip} 本次认证成功）`);
  }

  function attachConnection(ws: WebSocket, remote: string): void {
    log('info', `新连接: ${remote}`);
    const connId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    states.set(ws, {
      authenticated: false,
      nonce: null,
      nonceExpiresAt: 0,
      clientId: null,
      authorized: null,
      remote,
      connId,
      lastActiveAt: Date.now(),
    });
    // v2.0.0 修正：**客户端对 ping 的 pong 回应也算活跃**。
    // 之前只更新 message 的活跃时间 → 僵尸连接（TCP 未断但客户端已死）不会被判空闲，
    // 会被永久算进 states.size → 并发上限虚高 → **可能把正常控制端挡在外面**。
    ws.on('pong', () => {
      const st = states.get(ws);
      if (st) st.lastActiveAt = Date.now();
    });
    ws.on('message', (raw: RawData) => {
      // v2.0.0：任何入站消息都算活跃（空闲断开以"完全静默"为准，不是"没有调用能力"）
      const st = states.get(ws);
      if (st) st.lastActiveAt = Date.now();
      // ⚠️ 崩溃链根因（P0/P1 多条共用）：原来这里是 `void handleMessage(...)` ——
      //    Promise 一旦 reject 就成为 unhandled rejection，Node ≥22 默认**终止进程**。
      //    「畸形 hello」「畸形 auth」之所以能把被控端打崩，靠的就是这条路径。
      //    这里显式兜底：任何处理异常只记日志 + 回一个错误响应，绝不冒泡到进程级。
      void handleMessage(ws, raw.toString()).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log('warn', `处理消息时发生未预期异常（已拦截，不影响进程）：${msg}`);
        try {
          sendError(ws, null, ErrorCodes.EXECUTION_FAILED, '服务端处理消息时发生未预期异常', { detail: msg });
        } catch {
          /* 连接可能已关闭 */
        }
      });
    });
    ws.on('close', () => {
      log('info', `连接关闭: ${remote}`);
      // v12：连接断开即释放其事件订阅，避免 watcher 泄漏
      const n = disposeWatchesByOwner(connId);
      if (n > 0) log('debug', `已清理 ${n} 个事件订阅（连接 ${connId}）`);
      states.delete(ws); // v2.0.0：Map 需手动清理（WeakMap 时代靠 GC）
    });
    ws.on('error', (err: Error) => log('warn', `连接错误: ${err.message}`));
  }

  return {
    attach: attachConnection,
    /** v2.0.0：连接入口用 —— 该来源是否在封禁期（返回剩余毫秒，0=不挡）。 */
    banRemainingMs,
    /** v2.0.0：连接表（空闲清扫与并发上限判据）。 */
    states,
  };
}

/** 监听模式：被控端在本地起 HTTP(S) + WebSocket 服务。 */
export function createAgentServer(cfg: AgentConfig, tls: TlsMaterial | null): Promise<AgentServer> {
  const core = createAgentCore(cfg);
  const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2 };
  const log = (level: LogLevel, msg: string): void => {
    if (levelOrder[level] >= levelOrder[cfg.log_level]) {
      console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
    }
  };

  // TLS 必须由 https server 承载：ws 的 WebSocketServer 不识别 cert/key 选项，
  // 直接传入会被静默忽略，导致「自称 wss、实为明文」的降级。
  const httpServer = tls
    ? createHttpsServer({ cert: tls.cert, key: tls.key })
    : createHttpServer();
  const wss = new WebSocketServer({ server: httpServer });

  // v23②：连接数上限（判定放在连接入口，见下方 wss.on('connection')）
  const maxConnections = Math.max(1, cfg.security?.max_connections ?? 8);
  // v23③：空闲断开阈值（0 = 关闭）
  const idleTimeoutMs = Math.max(0, cfg.security?.idle_timeout_ms ?? 1_800_000);

  // v21 第一批加固：来源网段白名单 —— **在业务握手之前**就断开。
  // 放在这里而不是等认证失败，是因为拒绝得更早、开销更低（不必做 TLS/挑战应答）。
  wss.on('connection', (ws, req) => {
    const remote = req.socket.remoteAddress ?? '?';
    if (!ipInAllowlist(remote, cfg.allow_from)) {
      log('warn', `连接被拒绝：来源不在 allow_from（remote=${remote}，允许=${JSON.stringify(cfg.allow_from ?? null)}）`);
      audit({ type: 'net.deny', remote, reason: `source not in allow_from: ${JSON.stringify(cfg.allow_from ?? null)}` });
      ws.close(1008, 'source not allowed');
      return;
    }
    // v23①：封禁中的来源直接拒（在 TLS 之后、业务握手之前）
    const bannedLeft = core.banRemainingMs(remote);
    if (bannedLeft > 0) {
      log('warn', `连接被拒绝：来源处于封禁期（remote=${remote}，剩余 ${Math.ceil(bannedLeft / 1000)}s）`);
      audit({ type: 'net.deny', remote, reason: `auth banned, ${bannedLeft}ms left` });
      ws.close(1008, `too many failed attempts, retry in ${Math.ceil(bannedLeft / 1000)}s`);
      return;
    }
    // v23②：连接数上限
    if (core.states.size >= maxConnections) {
      log('warn', `连接被拒绝：已达并发上限 ${maxConnections}（current=${wss.clients.size}）`);
      audit({ type: 'net.deny', remote, reason: `max connections reached: ${maxConnections}` });
      ws.close(1013, 'too many connections');
      return;
    }
    core.attach(ws, remote);
  });

  // WebSocket 层保活：30s ping，探测死连接；v23③ 同时做空闲连接清扫
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // v2.0.0 修正（真机踩到）：**pong 缺失必须主动 terminate**。
      // ws 库默认不会因「ping 无 pong」而断开 —— 客户端进程已死（TCP 未发 FIN）时，
      // 连接会一直挂在 states 里，占用 max_connections 名额。
      // 判据用与空闲清扫同一个 lastActiveAt（pong 已在上方更新它）。
      const st = core.states.get(ws);
      if (st && idleTimeoutMs > 0 && Date.now() - st.lastActiveAt > idleTimeoutMs * 2) {
        log('warn', `连接无响应（ping 未回 pong 且静默超 ${Math.round((Date.now() - st.lastActiveAt) / 1000)}s）→ 强制断开 ${st.connId}`);
        audit({ type: 'session.idle_close', client_id: st.clientId ?? undefined, remote: st.remote, reason: 'unresponsive (no pong)' });
        ws.terminate();
        continue;
      }
      ws.ping();
    }
    if (idleTimeoutMs <= 0) return;
    // 保守策略：只要还有任务在跑 / 还有事件订阅，就不断任何连接 ——
    // 宁可少断，也不能把"挂着长任务等结果"的控制端踢下线。
    if (runningTaskCount() > 0 || watchCount() > 0) return;
    const now = Date.now();
    for (const [ws, st] of core.states) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const idleFor = now - st.lastActiveAt;
      if (idleFor < idleTimeoutMs) continue;
      log('info', `空闲断开：连接 ${st.connId}（${st.remote}）已静默 ${Math.round(idleFor / 1000)}s`);
      audit({ type: 'session.idle_close', client_id: st.clientId ?? undefined, remote: st.remote, reason: `idle ${idleFor}ms` });
      ws.close(1000, 'idle timeout');
    }
  }, 30_000);
  heartbeat.unref();

  const scheme = tls ? 'wss' : 'ws';
  const url = `${scheme}://${cfg.host === '0.0.0.0' ? '<本机IP>' : cfg.host}:${cfg.port}`;

  return new Promise<AgentServer>((resolve, reject) => {
    httpServer.once('listening', () => {
      log('info', `Agent 已监听 ${scheme}://${cfg.host}:${cfg.port}`);
      resolve({
        url,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
    httpServer.once('error', reject);
    httpServer.listen(cfg.port, cfg.host);
  });
}
