import { methodProxy } from "./proxy"

function belongsToChannelSimple(message: unknown, channel: string): message is { channel: string, type: string } {
    if (typeof message != "object")
        return false

    if (!message)
        return false

    if (!("channel" in message))
        return false

    if (!("type" in message))
        return false

    return message.channel === channel
}

function isRequest<T extends {}>(message: T): message is T & SimpleRequest<any[]> {
    if (!message) return false
    return typeof message === "object" && "type" in message
        && message.type === "request"
        && "method" in message
        && (typeof message.method == "string")
        && "args" in message
        && Array.isArray(message.args)
}


function isError<T extends {}>(message: T): message is T & SimpleError {
    if (!message) return false

    return typeof message === "object" && "type" in message
        && message.type === "error"
        && "error" in message
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
    handlers: Partial<HandlerMap<IncomingMessages>> = {}

    universalHandlers: UniversalHandler<IncomingMessages>[] = []

    channel: string;

    constructor(
        channel: string,
        config: { external: boolean } = { external: false }
    ) {
        this.channel = channel;
        chrome.runtime.onMessage.addListener(this.onMessageEvent)
        if (config.external) {
            chrome.runtime.onMessageExternal.addListener(this.onMessageEvent)
        }
    }
    onMessageEvent = (msg: SimpleRequest<any[]>, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
        if (!belongsToChannelSimple(msg, this.channel))
            return
        if (isRequest(msg))
            this.handleRequest(msg, sender, sendResponse)
        return true
    }
    async handleRequest(msg: SimpleRequest<any[]>, _: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) {
        try {
            let response
            for (let handler of this.universalHandlers)
                response = await handler(msg.method, msg.args as MethodArgs<IncomingMessages, string>)

            let handlers = this.handlers[msg.method]
            if (handlers)
                for (let handler of (handlers || []))
                    response = await handler(...msg.args as MethodArgs<IncomingMessages, string>)
            else if (!this.universalHandlers.length)
                return
            sendResponse(response)
        }
        catch (e) {
            console.error(`Responder.handleRequest[${this.channel}]: error in handler for`, msg.method, e)
            sendResponse({
                type: "error",
                channel: this.channel,
                error: {
                    message: (e as Error)?.message,
                    stack: (e as Error)?.stack
                }
            } as SimpleError)
        }
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

export class Requester<OutgoingMessages extends MethodMapGeneric> {
    channel: string;
    queryInfo?: chrome.tabs.QueryInfo;

    proxy = methodProxy<OutgoingMessages>((name, ...args) => this.call(name, ...args))

    constructor(channel: string, queryInfo?: chrome.tabs.QueryInfo) {
        this.channel = channel;
        this.queryInfo = queryInfo;
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
            return this.broadcastToQueriedTabs(this.queryInfo, name, ...args) as any
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
