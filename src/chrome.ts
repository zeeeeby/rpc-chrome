import { broadcastMethodProxy, methodProxy } from "./proxy"
import {
  ReceiverTransferManager,
  sendV1Call,
  shouldHandleV1Message,
  extractCallerIdentity,
  sanitizeErrorPayload,
  validateMetadataString,
  validateDescriptorLimits,
  V1ReplyInline,
  V1ReplyStream,
  V1AckUpload,
  V1AckChunk,
  V1ChunkReply,
  V1ErrorReply,
  RPC_V1_PROTOCOL,
  ResponderConfig,
  RequesterOptions,
  LargePayloadOptions,
  TransportOptions,
  CallerIdentity,
} from "./transport"
import { encodePayload, PayloadDecoder } from "./codec"

export type {
  ResponderConfig,
  RequesterOptions,
  LargePayloadOptions,
  TransportOptions,
}

function belongsToChannelSimple(message: unknown, channel: string): message is { channel: string; type: string } {
    if (typeof message !== "object" || message === null)
        return false

    if (!("channel" in message) || !("type" in message))
        return false

    return (message as { channel: unknown }).channel === channel
}

function isRequest<T extends {}>(message: T): message is T & SimpleRequest<any[]> {
    if (!message || typeof message !== "object") return false
    const msg = message as Record<string, unknown>
    return msg.type === "request"
        && typeof msg.method === "string"
        && Array.isArray(msg.args)
}

function isError<T extends {}>(message: T): message is T & SimpleError {
    if (!message || typeof message !== "object") return false
    const msg = message as Record<string, unknown>
    return msg.type === "error" && typeof msg.error === "object" && msg.error !== null
}

type SimpleRequest<Args extends any[]> = {
    type: "request"
    method: string
    args: Args
    channel: string
}

type SimpleError = {
    channel: string
    type: "error"
    error: {
        message: string
        stack?: string
    }
}

const isInvalidTabId = (tabId: number | undefined): tabId is undefined => {
    return !tabId || tabId === chrome.tabs.TAB_ID_NONE
}

type MethodMapGeneric = Record<string, (...args: any[]) => any>

type Method<Map extends MethodMapGeneric, Name extends keyof Map> = Map[Name]
type Promisify<Method extends (...args: any[]) => any> = (...args: Parameters<Method>) => ReturnType<Method> | Promise<Awaited<ReturnType<Method>>>

type HandlerMap<Map extends MethodMapGeneric> = {
    [Name in keyof Map]: Promisify<Method<Map, Name>>[]
}

type UniversalHandler<Map extends MethodMapGeneric> = (name: keyof Map, args: MethodArgs<Map, typeof name>) => ReturnTypeOfMethod<Map, keyof Map>

type MethodArgs<Map extends MethodMapGeneric, Name extends keyof Map> = Parameters<Method<Map, Name>>
type ReturnTypeOfMethod<Map extends MethodMapGeneric, Name extends keyof Map> = ReturnType<Method<Map, Name>>

export class Responder<IncomingMessages extends MethodMapGeneric> {
    readonly responderId = crypto.randomUUID();
    handlers: Partial<HandlerMap<IncomingMessages>> = {}
    universalHandlers: UniversalHandler<IncomingMessages>[] = []
    channel: string;
    private transferManager: ReceiverTransferManager | null = null;
    private externalListener?: (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => boolean | undefined;

    constructor(
        channel: string,
        config: ResponderConfig = { external: false }
    ) {
        this.channel = channel;
        if (config.largePayloads) {
            this.transferManager = new ReceiverTransferManager(config.largePayloads);
        }
        chrome.runtime.onMessage.addListener(this.onMessageEvent);
        if (config.external) {
            this.externalListener = this.onMessageExternalEvent;
            chrome.runtime.onMessageExternal.addListener(this.externalListener);
        }
    }

    onMessageEvent = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void): boolean | undefined => {
        if (!belongsToChannelSimple(msg, this.channel))
            return;
        if (isRequest(msg)) {
            this.handleRequest(msg, sender, sendResponse);
            return true;
        }

        // Synchronous targeting check: ignore messages for other responders or foreign protocols
        const inspection = shouldHandleV1Message(msg, this.channel, this.responderId);
        if (!inspection.handle) {
            return;
        }

        if (inspection.reason === 'unsupported_protocol') {
            const rawProtocol = (msg as Record<string, unknown>).protocol;
            sendResponse({
                protocol: RPC_V1_PROTOCOL,
                type: "rpc:v1:error",
                channel: this.channel,
                error: sanitizeErrorPayload(new Error(`Unsupported protocol version '${String(rawProtocol).slice(0, 128)}'`))
            } satisfies V1ErrorReply);
            return true;
        }

        this.handleV1Message(msg, sender, sendResponse);
        return true;
    }

    onMessageExternalEvent = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void): boolean | undefined => {
        if (!belongsToChannelSimple(msg, this.channel))
            return;

        const inspection = shouldHandleV1Message(msg, this.channel, this.responderId);
        if (inspection.handle) {
            // External v1 chunked transfers are explicitly unsupported in v1
            sendResponse({
                protocol: RPC_V1_PROTOCOL,
                type: "rpc:v1:error",
                channel: this.channel,
                error: { message: "External chunked transfers are not supported in rpc-chrome/v1" }
            } satisfies V1ErrorReply);
            return true;
        }

        if (isRequest(msg)) {
            this.handleRequest(msg, sender, sendResponse);
            return true;
        }
        return;
    }

    private async executeHandlers(name: string, args: unknown[]): Promise<any> {
        let handlers = this.handlers[name];
        if ((!handlers || handlers.length === 0) && !this.universalHandlers.length) {
            throw new Error(`Method '${name}' not found on channel '${this.channel}'`);
        }

        let response: any;
        for (let handler of this.universalHandlers) {
            response = await handler(name as any, args as any);
        }

        if (handlers && handlers.length > 0) {
            for (let handler of handlers) {
                response = await handler(...args as any);
            }
        }
        return response;
    }

    async handleRequest(msg: SimpleRequest<any[]>, _: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) {
        try {
            let handlers = this.handlers[msg.method];
            if ((!handlers || handlers.length === 0) && !this.universalHandlers.length) {
                return;
            }
            sendResponse(await this.executeHandlers(msg.method, msg.args));
        }
        catch (e) {
            console.error(`Responder.handleRequest[${this.channel}]: error in handler for`, msg.method, e);
            sendResponse({
                type: "error",
                channel: this.channel,
                error: {
                    message: (e as Error)?.message,
                    stack: (e as Error)?.stack
                }
            } as SimpleError);
        }
    }

    // Shared response encoding helper for inline and uploaded calls
    private async respondWithResult(
        result: unknown,
        correlationId: string,
        caller: CallerIdentity,
        sendResponse: (response?: any) => void
    ) {
        if (!this.transferManager) return;
        const source = encodePayload(result, { chunkSize: this.transferManager.options.chunkSize });
        let retained = false;
        try {
            validateDescriptorLimits(source.descriptor, this.transferManager.options);
            const firstChunk = await source.readChunk(0);
            const reply = { protocol: RPC_V1_PROTOCOL, channel: this.channel, callId: correlationId, descriptor: source.descriptor } as const;
            if (source.descriptor.totalChunks === 1 && source.descriptor.totalBlobs === 0) {
                sendResponse({ ...reply, type: 'rpc:v1:reply-inline', chunk: firstChunk } satisfies V1ReplyInline);
            } else {
                const transferId = crypto.randomUUID();
                this.transferManager.createDownloadSession(transferId, source, caller);
                retained = true;
                sendResponse({
                    ...reply, type: 'rpc:v1:reply-stream', transferId,
                    responderId: this.responderId, firstChunk,
                } satisfies V1ReplyStream);
            }
        } finally {
            if (!retained) source.dispose();
        }
    }

    private async handleV1Message(msg: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) {
        if (!this.transferManager) {
            sendResponse({
                protocol: RPC_V1_PROTOCOL,
                type: "rpc:v1:error",
                channel: this.channel,
                error: { message: `Large payloads are disabled on responder for channel '${this.channel}'` }
            } satisfies V1ErrorReply);
            return;
        }

        const caller = extractCallerIdentity(sender);

        try {
            validateMetadataString(msg.channel, 'channel');
            if (['rpc:v1:upload-chunk', 'rpc:v1:complete-upload', 'rpc:v1:pull-chunk', 'rpc:v1:release', 'rpc:v1:abort'].includes(msg.type)) {
                validateMetadataString(msg.targetResponderId, 'targetResponderId');
            }
            switch (msg.type) {
                case "rpc:v1:call-inline": {
                    const method = validateMetadataString(msg.method, 'method');
                    const callId = validateMetadataString(msg.callId, 'callId');
                    validateDescriptorLimits(msg.descriptor, this.transferManager.options);

                    const decoder = new PayloadDecoder(msg.descriptor, this.transferManager.options);
                    let rawArgs: unknown;
                    try {
                        decoder.acceptChunk(msg.chunk);
                        rawArgs = decoder.finish();
                    } finally {
                        decoder.dispose();
                    }
                    if (!Array.isArray(rawArgs)) throw new TypeError("RPC arguments payload must be an array");

                    const result = await this.executeHandlers(method, rawArgs);
                    await this.respondWithResult(result, callId, caller, sendResponse);
                    break;
                }

                case "rpc:v1:start-upload": {
                    const transferId = validateMetadataString(msg.transferId, 'transferId');
                    const method = validateMetadataString(msg.method, 'method');
                    this.transferManager.createUploadSession(transferId, method, msg.descriptor, caller);
                    sendResponse({
                        protocol: RPC_V1_PROTOCOL,
                        type: "rpc:v1:ack-upload",
                        channel: this.channel,
                        transferId,
                        responderId: this.responderId,
                    } satisfies V1AckUpload);
                    break;
                }

                case "rpc:v1:upload-chunk": {
                    const transferId = validateMetadataString(msg.transferId, 'transferId');
                    this.transferManager.acceptUploadChunk(transferId, msg.chunk, caller);
                    sendResponse({
                        protocol: RPC_V1_PROTOCOL,
                        type: "rpc:v1:ack-chunk",
                        channel: this.channel,
                        transferId,
                        seq: msg.chunk.seq,
                    } satisfies V1AckChunk);
                    break;
                }

                case "rpc:v1:complete-upload": {
                    const transferId = validateMetadataString(msg.transferId, 'transferId');
                    const { method, args } = this.transferManager.finishUploadSession(transferId, caller);
                    const result = await this.executeHandlers(method, args);
                    await this.respondWithResult(result, transferId, caller, sendResponse);
                    break;
                }

                case "rpc:v1:pull-chunk": {
                    const transferId = validateMetadataString(msg.transferId, 'transferId');
                    const chunk = await this.transferManager.readDownloadChunk(transferId, msg.seq, caller);
                    sendResponse({
                        protocol: RPC_V1_PROTOCOL,
                        type: "rpc:v1:chunk",
                        channel: this.channel,
                        transferId,
                        chunk,
                    } satisfies V1ChunkReply);
                    break;
                }

                case "rpc:v1:release": {
                    const transferId = validateMetadataString(msg.transferId, 'transferId');
                    this.transferManager.releaseDownloadSession(transferId, caller);
                    sendResponse({ protocol: RPC_V1_PROTOCOL, type: "rpc:v1:ack-release" });
                    break;
                }

                case "rpc:v1:abort": {
                    const transferId = validateMetadataString(msg.transferId, 'transferId');
                    this.transferManager.abortUploadSession(transferId, caller, new Error('Aborted by requester'));
                    this.transferManager.releaseDownloadSession(transferId, caller);
                    sendResponse({ protocol: RPC_V1_PROTOCOL, type: "rpc:v1:ack-abort" });
                    break;
                }

                default: {
                    sendResponse({
                        protocol: RPC_V1_PROTOCOL,
                        type: "rpc:v1:error",
                        channel: this.channel,
                        error: sanitizeErrorPayload(new Error(`Unrecognized v1 message type '${String(msg.type).slice(0, 128)}'`))
                    } satisfies V1ErrorReply);
                }
            }
        } catch (e: any) {
            const sanitized = sanitizeErrorPayload(e);
            sendResponse({
                protocol: RPC_V1_PROTOCOL,
                type: "rpc:v1:error",
                channel: this.channel,
                callId: typeof msg.callId === 'string' ? msg.callId.slice(0, 1024) : undefined,
                transferId: typeof msg.transferId === 'string' ? msg.transferId.slice(0, 1024) : undefined,
                error: sanitized,
            } satisfies V1ErrorReply);
        }
    }

    dispose(): void {
        chrome.runtime.onMessage.removeListener(this.onMessageEvent);
        if (this.externalListener) {
            chrome.runtime.onMessageExternal?.removeListener(this.externalListener);
        }
        this.transferManager?.dispose();
    }

    subscribe<Name extends keyof IncomingMessages>(name: Name, handler: Promisify<Method<IncomingMessages, Name>>) {
        let handlers = (this.handlers[name] ||= [])
        handlers.push(handler)
        return () => removeFromArray(handlers, handler)
    }
    unsubscribe<Name extends keyof IncomingMessages>(name: Name, handler: Promisify<Method<IncomingMessages, Name>>) {
        let handlers = this.handlers[name]
        if (!handlers)
            return

        removeFromArray(handlers, handler)
    }
    subscribeUniversal(handler: UniversalHandler<IncomingMessages>) {
        this.universalHandlers.push(handler)

        return () => removeFromArray(this.universalHandlers, handler)
    }
    unsubscribeUniversal(handler: UniversalHandler<IncomingMessages>) {
        removeFromArray(this.universalHandlers, handler)
    }
}

function removeFromArray<T>(array: T[], item: T) {
    let index = array.indexOf(item)
    if (index == -1)
        return

    array.splice(index, 1)
}

export class RuntimeRequester<OutgoingMessages extends MethodMapGeneric> {
    channel: string;
    options?: RequesterOptions;
    proxy = methodProxy<OutgoingMessages>((name, ...args) => this.call(name, ...args));

    constructor(channel: string, options?: RequesterOptions) {
        this.channel = channel;
        this.options = options;
    }

    call<Name extends Extract<keyof OutgoingMessages, string>>(name: Name, ...args: MethodArgs<OutgoingMessages, Name>) {
        if (this.options?.largePayloads) {
            return sendV1Call(
                (msg) => chrome.runtime.sendMessage(msg),
                this.channel,
                name,
                args,
                this.options.largePayloads
            ) as Promise<Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>>;
        }

        return chrome.runtime.sendMessage({
            type: "request",
            channel: this.channel,
            method: name,
            args
        } satisfies SimpleRequest<any>).then(response => {
            if (isError(response)) {
                let error = new Error(`Error in method ${name}: ${response.error?.message || "Unknown error"}`)
                error.stack = response.error?.stack
                throw error
            }
            return response as Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>
        })
    }
}

export class ContentScriptRequester<OutgoingMessages extends MethodMapGeneric> {
    channel: string;
    queryInfo: chrome.tabs.QueryInfo;
    options?: RequesterOptions;

    proxy = broadcastMethodProxy<OutgoingMessages>((name, ...args) => this.call(name, ...args));

    constructor(channel: string, queryInfo: chrome.tabs.QueryInfo, options?: RequesterOptions) {
        this.channel = channel;
        this.queryInfo = queryInfo;
        this.options = options;
    }

    async call<Name extends Extract<keyof OutgoingMessages, string>>(
        name: Name,
        ...args: MethodArgs<OutgoingMessages, Name>
    ): Promise<Array<{ tabId: number, response: Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>> }>> {
        const tabs = await chrome.tabs.query(this.queryInfo);

        const results: Array<{ tabId: number, response: Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>> }> = [];

        const promises = tabs.map(async (tab) => {
            const targetTabId = tab.id;
            if (isInvalidTabId(targetTabId)) return;

            try {
                let response: Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>;
                if (this.options?.largePayloads) {
                    response = await sendV1Call(
                        (msg) => chrome.tabs.sendMessage(targetTabId, msg),
                        this.channel,
                        name,
                        args,
                        this.options.largePayloads
                    ) as Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>;
                } else {
                    const rawResponse = await chrome.tabs.sendMessage(targetTabId, {
                        type: "request",
                        channel: this.channel,
                        method: name,
                        args
                    } satisfies SimpleRequest<any>);

                    if (isError(rawResponse)) {
                        let error = new Error(`Error in method ${name} (tab ${targetTabId}): ${rawResponse.error?.message || "Unknown error"}`);
                        error.stack = rawResponse.error?.stack;
                        throw error;
                    }
                    response = rawResponse as Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>;
                }

                results.push({
                    tabId: targetTabId,
                    response
                });
            } catch (e) {
                console.debug(`ContentScriptRequester: Tab ${targetTabId} did not respond to ${name}`, e);
            }
        });

        await Promise.all(promises);
        return results;
    }
}

export class Requester<OutgoingMessages extends MethodMapGeneric> {
    channel: string;
    queryInfo?: chrome.tabs.QueryInfo;
    options?: RequesterOptions;

    proxy = methodProxy<OutgoingMessages>((name, ...args) => this.call(name, ...args))

    constructor(channel: string, queryInfo?: chrome.tabs.QueryInfo, options?: RequesterOptions) {
        this.channel = channel;
        this.queryInfo = queryInfo;
        this.options = options;
    }

    private async broadcastToQueriedTabs<Name extends Extract<keyof OutgoingMessages, string>>(
        queryInfo: chrome.tabs.QueryInfo,
        name: Name,
        ...args: MethodArgs<OutgoingMessages, Name>
    ) {
        chrome.tabs.query(queryInfo, (tabs) => {
            tabs.forEach(tab => {
                if (isInvalidTabId(tab.id))
                    return
                return this.callTab(tab.id, name, ...args)
            });
        });
    }

    call<Name extends Extract<keyof OutgoingMessages, string>>(name: Name, ...args: MethodArgs<OutgoingMessages, Name>): Promise<Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>> {
        if (this.queryInfo) {
            this.broadcastToQueriedTabs(this.queryInfo, name, ...args)
        }
        if (this.options?.largePayloads) {
            return sendV1Call(
                (msg) => chrome.runtime.sendMessage(msg),
                this.channel,
                name,
                args,
                this.options.largePayloads
            ) as Promise<Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>>;
        }

        return chrome.runtime.sendMessage({
            type: "request",
            channel: this.channel,
            method: name,
            args
        } satisfies SimpleRequest<any>).then(response => {
            if (isError(response)) {
                let error = new Error(`Error in method ${name}: ${response.error?.message || "Unknown error"}`)
                error.stack = response.error?.stack
                throw error
            }
            return response as Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>
        })
    }

    callTab<Name extends Extract<keyof OutgoingMessages, string>>(
        tabId: number,
        name: Name,
        ...args: MethodArgs<OutgoingMessages, Name>
    ): Promise<Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>> {
        if (this.options?.largePayloads) {
            return sendV1Call(
                (msg) => chrome.tabs.sendMessage(tabId, msg),
                this.channel,
                name,
                args,
                this.options.largePayloads
            ) as Promise<Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>>;
        }

        return chrome.tabs.sendMessage(tabId, {
            type: "request",
            channel: this.channel,
            method: name,
            args
        } satisfies SimpleRequest<any>).then(response => {
            if (isError(response)) {
                let error = new Error(`Error in method ${name}: ${response.error?.message || "Unknown error"}`)
                error.stack = response.error?.stack
                throw error
            }
            return response as Awaited<ReturnTypeOfMethod<OutgoingMessages, Name>>
        })
    }
}
